import { type JsonRecord, jsonRecords, asRecord as record } from "../../../lib/json-values.js";
import { toolLabel } from "../../../lib/tool-label.js";
import { parseOpencodeEvent } from "./events.schema.js";

/** Message identity and text as read off one stream event, for the live step log. */
export function textFromEvent(event: JsonRecord): { key: string; text: string } | undefined {
  const parsed = parseOpencodeEvent(event);
  if (parsed.type !== "text") return undefined;
  const text = parsed.part?.text;
  if (!text) return undefined;
  return { key: parsed.part?.id ?? text, text };
}

/** opencode names its tools in lowercase and its inputs in camelCase. */
const TOOL_NAMES: Readonly<Record<string, string>> = {
  read: "Read",
  write: "Write",
  edit: "Edit",
  patch: "Edit",
  bash: "Bash",
  grep: "Grep",
  glob: "Glob",
  task: "Agent",
};

/**
 * Renders an opencode tool call with the convention every other surface uses.
 * The payload shape differs from Claude's (`filePath`, nested under
 * `part.state.input`), so it is translated rather than passed through.
 */
export function opencodeToolLabel(tool: string, rawInput: unknown): string {
  const input = record(rawInput);
  const name = TOOL_NAMES[tool];
  if (!name || !input) return name ?? tool;
  return toolLabel(name, {
    file_path: input.filePath ?? input.path,
    command: input.command,
    description: input.description,
    pattern: input.pattern,
    path: input.path,
    subagent_type: input.subagentType ?? input.agent,
  });
}

export interface ParsedOpencodeEvents {
  text: string;
  sessionId?: string;
  structuredOutput?: unknown;
  error?: string;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd?: number;
  /**
   * True when at least one step reported a `cost`. A free model legitimately
   * reports `cost: 0`, which must not be read as "price unknown" — only the
   * absence of the field means that.
   */
  costReported: boolean;
  /** `tokens.total` of the last step: context occupancy, not the model window. */
  lastContextTokens?: number;
  turns: number;
  toolsUsed: string[];
}

/**
 * Aggregates the JSON-lines stream of `opencode run --format json`.
 * Events observed: `step_start`, `text`, `tool_use`, `file`, `step_finish`, `error`.
 */
export function parseOpencodeEvents(raw: string): ParsedOpencodeEvents {
  const messages: string[] = [];
  const tools = new Set<string>();
  let sessionId: string | undefined;
  let structuredOutput: unknown;
  let error: string | undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let costUsd = 0;
  let costReported = false;
  let lastContextTokens: number | undefined;
  let turns = 0;

  for (const record of jsonRecords(raw)) {
    // An event type this release does not know reads as `{ type: null }`: it
    // still contributes its `sessionID`, and nothing else.
    const event = parseOpencodeEvent(record);
    sessionId = event.sessionID ?? sessionId;

    if (event.type === "step_finish") {
      turns++;
      const tokens = event.part?.tokens;
      inputTokens += tokens?.input ?? 0;
      outputTokens += tokens?.output ?? 0;
      reasoningTokens += tokens?.reasoning ?? 0;
      cacheReadTokens += tokens?.cache?.read ?? 0;
      cacheCreationTokens += tokens?.cache?.write ?? 0;
      const total = tokens?.total;
      if (total != null) lastContextTokens = total;
      const cost = event.part?.cost;
      if (cost != null) {
        costUsd += cost;
        costReported = true;
      }
      continue;
    }

    if (event.type === "error") {
      error = unquote(event.error?.data?.message) ?? error ?? "opencode run failed";
      continue;
    }

    if (event.type === "text") {
      const text = event.part?.text;
      if (!text) continue;
      messages.push(text);
      const candidate = text.trim();
      if (candidate.startsWith("{") && candidate.endsWith("}")) {
        try {
          structuredOutput = JSON.parse(candidate);
        } catch {
          /* the verdict parser handles the text fallback */
        }
      }
      continue;
    }

    // `part.type` is "tool" inside a `tool_use` event: the event name and the
    // part name do not match.
    if (event.type === "tool_use") {
      const tool = event.part?.tool;
      if (tool) tools.add(tool);
    }
  }

  return {
    text: messages.join("\n"),
    ...(sessionId ? { sessionId } : {}),
    ...(structuredOutput != null ? { structuredOutput } : {}),
    ...(error ? { error } : {}),
    ...(inputTokens > 0 ? { inputTokens } : {}),
    ...(outputTokens > 0 ? { outputTokens } : {}),
    ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
    ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
    ...(cacheCreationTokens > 0 ? { cacheCreationTokens } : {}),
    ...(costReported ? { costUsd } : {}),
    costReported,
    ...(lastContextTokens != null ? { lastContextTokens } : {}),
    turns,
    toolsUsed: [...tools],
  };
}

/** opencode wraps some provider messages in literal double quotes. */
function unquote(value: string | undefined): string | undefined {
  if (value == null) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 1 && trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : value;
}

/**
 * Reads the `--print-logs` stream on stderr. Mandatory: opencode retries stream
 * errors silently, so a hard failure (billing, auth, upstream 502) can leave
 * stdout completely empty while stderr carries the only explanation.
 */
export function parseOpencodeLogErrors(logs: string): string | undefined {
  for (const line of logs.split("\n")) {
    if (!line.includes("level=ERROR")) continue;
    const detail = line.match(/error\.error="((?:[^"\\]|\\.)*)"/) ?? line.match(/\berror="((?:[^"\\]|\\.)*)"/);
    const message = detail?.[1]?.trim();
    if (message && message !== "undefined") return message;
  }
  return undefined;
}
