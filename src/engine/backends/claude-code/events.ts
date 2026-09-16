import type { AttemptStats, TokenBreakdown } from "../../../contracts/index.js";
import { jsonRecords } from "../../../lib/json-values.js";
import { parseClaudeEvent, parseClaudeToolInput, parseClaudeUsage } from "./events.schema.js";
import { computeCostUsd, contextWindow } from "./pricing.js";
export interface ClaudeTransportError {
  status?: number;
  terminalReason?: string;
  message: string;
  resetsAt?: number;
}
export interface ClaudeParsedEvents {
  text: string;
  stats: AttemptStats;
  /** Assistant messages THIS process streamed. `num_turns` from the `result` event
   * counts the whole session once it has been resumed, so a resumed attempt reports
   * this instead. */
  turnsInProcess: number;
  structuredOutput?: unknown;
  transportError?: ClaudeTransportError;
  sessionId?: string;
}
/**
 * The CLI labels the messages it fabricates itself (transport errors, refusals,
 * cancellations) with this in place of a model name. It must never become the
 * tracked model: it matches no pricing key — so it would silently bill at the
 * `opus` default — and carries no `[1m]` suffix, so it would shrink the reported
 * context window to 200k mid-stream.
 */
export const SYNTHETIC_MODEL = "<synthetic>";

/**
 * Message identity and text as read off one stream event, for the live step log.
 * The CLI may re-emit an `assistant` message as it streams, so the identity is
 * the message id whenever the CLI provides one. A message ends with a newline in
 * the log so consecutive turns do not run into each other.
 */
export function textFromAssistantEvent(record: unknown): { key: string; text: string } | undefined {
  const event = parseClaudeEvent(record);
  if (event.type !== "assistant" || !event.message) return undefined;
  let text = "";
  for (const content of event.message.content) {
    if (content?.type === "text") text += content.text;
  }
  if (!text) return undefined;
  return { key: event.message.id ?? text, text: text.endsWith("\n") ? text : `${text}\n` };
}

/**
 * MUTABLE token totals for ONE attempt. The live budget gate (execution.ts) and
 * the final parse accumulate through these helpers so a mid-flight estimate can
 * never follow a different rule than the cost reported at the end — and both read
 * the same `usage` field the status line reads for its context occupancy.
 */
export interface ModelUsageTotals {
  input: number;
  output: number;
  read: number;
  cacheTotal: number;
  cache5: number;
  cache1: number;
}

export interface UsageTotals extends ModelUsageTotals {
  /** Context footprint of the LAST turn seen: input + cache read + cache creation. */
  lastTurn: number;
  /**
   * The same counters split by the model that produced each message. A session
   * mixes models — sub-agents on haiku or sonnet inside an opus run — and each
   * message is billed at ITS model's rate, not at the rate of whichever model
   * spoke last. The empty key holds messages that named no model; they are
   * priced at the caller's fallback.
   */
  byModel: Map<string, ModelUsageTotals>;
}

const newModelUsageTotals = (): ModelUsageTotals => ({
  input: 0,
  output: 0,
  read: 0,
  cacheTotal: 0,
  cache5: 0,
  cache1: 0,
});

export const newUsageTotals = (): UsageTotals => ({
  ...newModelUsageTotals(),
  lastTurn: 0,
  byModel: new Map(),
});

/** Add ONE assistant message usage block. The caller owns deduplication by
 * message id: the CLI repeats a message as it streams. `model` is the model that
 * produced the message, when the message names one. */
export function addUsage(totals: UsageTotals, usage: unknown, model?: string): void {
  const block = parseClaudeUsage(usage);
  const i = block.input_tokens ?? 0,
    o = block.output_tokens ?? 0,
    r = block.cache_read_input_tokens ?? 0,
    c = block.cache_creation_input_tokens ?? 0,
    f = block.cache_creation?.ephemeral_5m_input_tokens ?? 0,
    h = block.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const key = model ?? "";
  const bucket = totals.byModel.get(key) ?? newModelUsageTotals();
  totals.byModel.set(key, bucket);
  for (const target of [totals, bucket]) {
    target.input += i;
    target.output += o;
    target.read += r;
    target.cacheTotal += c;
    target.cache5 += f;
    target.cache1 += h;
  }
  totals.lastTurn = i + r + c;
}

/**
 * Estimated dollars for every message counted so far, each model's messages at
 * that model's rate. Messages without a model are priced at `fallbackModel`. Both
 * the live budget gate and the final parse call this, so the two can never
 * disagree on a price.
 */
export function estimateCostUsd(totals: UsageTotals, fallbackModel?: string): number {
  let sum = 0;
  for (const [model, bucket] of totals.byModel) {
    sum += computeCostUsd(usageBreakdown(bucket), model || fallbackModel);
  }
  return sum;
}

/** Priced breakdown. Cache creation without a TTL split is billed as 1h: the
 * conservative reading, and the only one shared by every consumer. The split is
 * per message, so a session can mix messages that carry it and messages that do
 * not: the unsplit remainder is whatever the total holds beyond both TTL buckets. */
export function usageBreakdown(totals: ModelUsageTotals): TokenBreakdown {
  const unsplit = Math.max(0, totals.cacheTotal - totals.cache5 - totals.cache1);
  return {
    input_tokens: totals.input,
    output_tokens: totals.output,
    cache_read_tokens: totals.read,
    cache_creation_5m_tokens: totals.cache5,
    cache_creation_1h_tokens: totals.cache1 + unsplit,
  };
}
export function parseClaudeEvents(raw: string, fallbackModel?: string): ClaudeParsedEvents {
  const tools: string[] = [];
  let text = "",
    structuredOutput: unknown,
    transportError: ClaudeTransportError | undefined,
    reset: number | undefined,
    sessionId: string | undefined;
  const seen = new Set<string>();
  const totals = newUsageTotals();
  let model = fallbackModel,
    // TWO models, because they answer two different questions.
    //
    // `model` is the model that produced the LAST turn, read off the `assistant`
    // messages: it is what actually ran and got billed, so cost follows it — a
    // session that fell back to sonnet must not be priced as opus.
    //
    // `sessionModel` is the model negotiated at startup, read off `system`/`init`.
    // Only that event spells the identifier out in full, `[1m]` suffix included;
    // the `assistant` messages report the BARE name. The context window is a
    // property of the session, so it follows THIS one — reading it off the turn
    // model reports 200k for a 1M session.
    sessionModel: string | undefined,
    resultCost: number | undefined,
    duration = 0,
    api: number | undefined,
    turns: number | undefined;
  for (const record of jsonRecords(raw)) {
    // An event type this release does not know reads as `{ type: null }`: it
    // contributes its `session_id` like any other event, and nothing else.
    const obj = parseClaudeEvent(record);
    if (!sessionId && obj.session_id !== undefined) sessionId = obj.session_id;
    if (obj.type === "system" && obj.model !== undefined) {
      sessionModel = obj.model;
      model = obj.model;
    }
    if (obj.type === "rate_limit_event") {
      const r = obj.rate_limit_info?.resetsAt;
      if (r !== undefined) reset = r * 1000;
    }
    if (obj.type === "assistant") {
      const msg = obj.message;
      if (!msg) continue;
      const messageModel = msg.model !== undefined && msg.model !== SYNTHETIC_MODEL ? msg.model : undefined;
      if (messageModel) model = messageModel;
      for (const content of msg.content) {
        if (!content) continue;
        if (content.type === "tool_use") {
          const inp = parseClaudeToolInput(content.input);
          if (content.name === "StructuredOutput") structuredOutput = content.input;
          else {
            const name =
              content.name === "Skill"
                ? `skill(${String(inp?.skill ?? "?")})`
                : content.name === "Agent"
                  ? `agent(${String(inp?.subagent_type ?? inp?.name ?? "?")})`
                  : content.name;
            if (!tools.includes(name)) tools.push(name);
          }
        }
        if (content.type === "text") text += content.text;
      }
      const usage = msg.usage;
      const id = msg.id ?? `__anon_${seen.size}`;
      if (usage && !seen.has(id)) {
        seen.add(id);
        addUsage(totals, usage, messageModel);
      }
    }
    if (obj.type === "result") {
      if (obj.is_error === true || obj.terminal_reason === "api_error")
        transportError = {
          ...(obj.api_error_status !== undefined ? { status: obj.api_error_status } : {}),
          ...(obj.terminal_reason !== undefined ? { terminalReason: obj.terminal_reason } : {}),
          message: String(obj.result ?? "CLI error without a message"),
        };
      duration = obj.duration_ms ?? 0;
      api = obj.duration_api_ms;
      turns = obj.num_turns;
      resultCost = obj.total_cost_usd;
      if (obj.structured_output != null) structuredOutput = obj.structured_output;
      if (obj.result && structuredOutput == null && !text.trimEnd().endsWith(String(obj.result).trimEnd()))
        text += String(obj.result);
    }
  }
  // A reported `0` over consumed tokens is the CLI admitting it could not price
  // the turn, not a free turn — the same gap `resolveOpencodeCost` handles for
  // opencode. Claude ships its own rate table, so estimate from it instead of
  // recording a free attempt that would make `max_cost_usd` unfirable. A reported
  // `0` with no tokens at all is a real measured zero and stays exact.
  const consumedTokens = totals.input + totals.output + totals.read + totals.cacheTotal;
  const reportedUsable = resultCost != null && (resultCost > 0 || consumedTokens === 0);
  const estimate = seen.size ? estimateCostUsd(totals, model) : undefined;
  const total = reportedUsable ? resultCost : (estimate ?? resultCost);
  const estimated = !reportedUsable && estimate != null;
  const stats: AttemptStats = {
    duration_ms: duration,
    duration_api_ms: api,
    num_turns: turns ?? (seen.size || undefined),
    total_cost_usd: total,
    ...(estimated ? { cost_estimated: true } : {}),
    input_tokens: seen.size ? totals.input : undefined,
    output_tokens: seen.size ? totals.output : undefined,
    cache_read_tokens: seen.size ? totals.read : undefined,
    cache_creation_tokens: seen.size ? totals.cacheTotal : undefined,
    last_turn_context_tokens: totals.lastTurn || undefined,
    context_window: totals.lastTurn ? contextWindow(sessionModel ?? model) : undefined,
    model,
    tools_used: tools.length ? tools : undefined,
  };
  if (transportError && reset != null && isRateLimited(transportError))
    transportError = { ...transportError, resetsAt: reset };
  return {
    text,
    stats,
    turnsInProcess: seen.size,
    ...(structuredOutput != null ? { structuredOutput } : {}),
    ...(transportError ? { transportError } : {}),
    ...(sessionId ? { sessionId } : {}),
  };
}
export function isOverloaded(error: ClaudeTransportError): boolean {
  return error.status != null
    ? new Set([500, 502, 503, 504, 529]).has(error.status)
    : /overloaded/i.test(error.message);
}
export function isRateLimited(error: ClaudeTransportError): boolean {
  return error.status === 429 || /(session|usage|rate) limit/i.test(error.message);
}
/**
 * Missing or rejected credentials. No retry and no fix can repair it: the same CLI
 * would fail the same way. Kept narrow on purpose — a 401/403 status when the CLI
 * reports one, otherwise only the CLI's own login wording — so an unrelated
 * provider message never masquerades as an environment block.
 */
export function isAuthFailure(error: ClaudeTransportError): boolean {
  return error.status != null
    ? error.status === 401 || error.status === 403
    : /not logged in|please run \/login|invalid api key|authentication[_ ]error/i.test(error.message);
}
