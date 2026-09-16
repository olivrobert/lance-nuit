import { jsonRecords } from "../../../lib/json-values.js";
import { type CodexEvent, parseCodexEvent } from "./events.schema.js";

/** Message identity and text as read off one parsed stream event, for the live step log. */
export function agentMessageFromEvent(event: CodexEvent): { key: string; text: string } | undefined {
  const item = event.item;
  if (item?.type !== "agent_message") return undefined;
  const text = item.text ?? item.message;
  if (!text) return undefined;
  return { key: item.id ?? text, text };
}

/** Running usage totals shared by the final parse and the live budget guard. */
export interface CodexUsageTotals {
  turns: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  model?: string;
}

export function newCodexUsageTotals(fallbackModel?: string): CodexUsageTotals {
  return {
    turns: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    ...(fallbackModel ? { model: fallbackModel } : {}),
  };
}

/** Folds one parsed stream event into the totals; true when it completed a
 * turn — the only moment the accumulated cost can change. The caller parses the
 * line once (`parseCodexEvent`) and hands the same event to every consumer. */
export function accumulateCodexUsage(event: CodexEvent, totals: CodexUsageTotals): boolean {
  if (event.type !== "turn.completed") return false;
  totals.turns++;
  const usage = event.usage;
  totals.inputTokens += usage?.input_tokens ?? 0;
  totals.cachedInputTokens += usage?.cached_input_tokens ?? 0;
  totals.outputTokens += usage?.output_tokens ?? 0;
  totals.reasoningTokens += usage?.reasoning_output_tokens ?? 0;
  totals.model = event.model ?? totals.model;
  return true;
}

export interface ParsedCodexEvents {
  text: string;
  sessionId?: string;
  structuredOutput?: unknown;
  error?: string;
  model?: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  turns: number;
  toolsUsed: string[];
}

export function parseCodexEvents(raw: string, fallbackModel?: string): ParsedCodexEvents {
  const messages: string[] = [];
  const tools = new Set<string>();
  let sessionId: string | undefined;
  let structuredOutput: unknown;
  let error: string | undefined;
  const totals = newCodexUsageTotals(fallbackModel);

  for (const record of jsonRecords(raw)) {
    // An event type this release does not know reads as `{ type: null }`: it
    // still carries its `item`, so a message inside a new event kind is not lost.
    const event = parseCodexEvent(record);
    if (event.type === "thread.started") {
      sessionId = event.thread_id ?? sessionId;
      continue;
    }
    if (accumulateCodexUsage(event, totals)) continue;
    if (event.type === "turn.failed" || event.type === "error") {
      error = event.message ?? event.error?.message ?? error ?? "Codex turn failed";
      continue;
    }
    const item = event.item;
    if (!item) continue;
    const itemType = item.type;
    if (itemType === "agent_message") {
      const text = item.text ?? item.message;
      if (text) messages.push(text);
      const maybeJson = text?.trim();
      if (maybeJson?.startsWith("{") && maybeJson.endsWith("}")) {
        try {
          structuredOutput = JSON.parse(maybeJson);
        } catch {
          /* final parser handles text fallback */
        }
      }
    } else if (itemType === "command_execution") tools.add("Bash");
    else if (itemType === "file_change") tools.add("FileChange");
    else if (itemType === "mcp_tool_call") tools.add("MCP");
    else if (itemType === "web_search") tools.add("WebSearch");
  }

  return {
    text: messages.join("\n"),
    ...(sessionId ? { sessionId } : {}),
    ...(structuredOutput != null ? { structuredOutput } : {}),
    ...(error ? { error } : {}),
    ...(totals.model ? { model: totals.model } : {}),
    ...(totals.inputTokens > 0 ? { inputTokens: totals.inputTokens } : {}),
    ...(totals.cachedInputTokens > 0 ? { cachedInputTokens: totals.cachedInputTokens } : {}),
    ...(totals.outputTokens > 0 ? { outputTokens: totals.outputTokens } : {}),
    ...(totals.reasoningTokens > 0 ? { reasoningTokens: totals.reasoningTokens } : {}),
    turns: totals.turns,
    toolsUsed: [...tools],
  };
}
