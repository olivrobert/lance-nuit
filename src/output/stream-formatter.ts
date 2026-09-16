#!/usr/bin/env bun

// Live formatter for the runner stream JSONL: shows tool calls as they happen
// and the current pipeline step (from `pipeline-step` custom events).
//
// Usage (preferred, reactive through tail -f):
//   tail -F <stream-file> | bun stream-formatter.ts

import { createReadStream, existsSync, statSync, watch } from "node:fs";
import { createInterface } from "node:readline";
import { asFiniteNumber as numberValue, asRecord as record, asString as stringValue } from "../lib/json-values.js";
import { toolLabel } from "../lib/tool-label.js";
import { bold, cyan, detectColor, dim, green, setColorEnabled, yellow } from "./color.js";
import { formatCompactDuration, formatContextShare } from "./format.js";
import { CONTEXT_WARN_PCT } from "./status-line.js";

interface PipelineStep {
  name: string;
  index?: number;
  total?: number;
}

interface InflightTool {
  name: string;
  label: string;
  startedAt: number;
}

function displayValue(value: unknown): string {
  return value == null ? "?" : String(value);
}

// This formatter renders to stdout (a tmux pane), not to the runner's stderr:
// its color support has to be decided on the stream it actually writes to.
setColorEnabled(detectColor(process.env, process.stdout));

const state = {
  step: undefined as PipelineStep | undefined,
  inflight: new Map<string, InflightTool>(),
  pct: undefined as number | undefined,
};

/** The occupancy rides along with the tool call it was measured on. */
function paintShare(pct: number | undefined): string {
  if (pct == null) return "";
  const text = ` · ${formatContextShare(pct)}`;
  return pct >= CONTEXT_WARN_PCT ? yellow(text) : dim(text);
}

function writeLine(s: string): void {
  process.stdout.write(`${s}\n`);
}

function processEvent(rawEvent: unknown): void {
  const obj = record(rawEvent);
  if (!obj) return;

  if (obj.type === "pipeline-step") {
    const name = stringValue(obj.name);
    if (!name) return;
    const index = numberValue(obj.index);
    const total = numberValue(obj.total);
    state.step = { name, ...(index !== undefined ? { index } : {}), ...(total !== undefined ? { total } : {}) };
    state.inflight.clear();
    // A new step means a new session: the previous occupancy no longer applies.
    state.pct = undefined;
    const pos = index && total ? ` ${index}/${total}` : "";
    writeLine("");
    writeLine(bold(`━━━ step${pos}: ${obj.name} ━━━`));
    return;
  }

  if (obj.type === "runner-event" && obj.event === "agent-spawn") {
    const provider = stringValue(obj.provider);
    if (!provider) return;
    const model = obj.model ? ` (${displayValue(obj.model)})` : "";
    writeLine(`  ${cyan("⏳")} ${provider} started${dim(model)}…`);
    return;
  }

  if (obj.type === "runner-event" && obj.event === "transport-retry") {
    const status = obj.status ? ` ${displayValue(obj.status)}` : "";
    const attempt = numberValue(obj.attempt);
    const of = numberValue(obj.of);
    const delayMs = numberValue(obj.delayMs);
    if (attempt === undefined || of === undefined || delayMs === undefined) return;
    writeLine(yellow(`  ⚠ API overloaded${status} — retry ${attempt}/${of} in ${Math.round(delayMs / 1000)}s`));
    return;
  }

  if (obj.type === "runner-event" && obj.event === "activity") {
    const label = stringValue(obj.label);
    if (label) writeLine(`  ${cyan("▶")} ${label}${paintShare(state.pct)}`);
    return;
  }

  if (obj.type === "runner-event" && obj.event === "context") {
    const pct = numberValue(obj.pct);
    if (pct === undefined) return;
    // Only the crossing is worth a line of its own; the value itself rides along
    // with the next tool call.
    if (state.pct != null && state.pct < CONTEXT_WARN_PCT && pct >= CONTEXT_WARN_PCT)
      writeLine(
        yellow(`  ⚠ context ${Math.round(pct * 100)}% of ${Math.round((numberValue(obj.window) ?? 0) / 1000)}k`),
      );
    state.pct = pct;
    return;
  }

  if (obj.type === "rate_limit_event") {
    writeLine(dim(`  ⏱ rate-limit check OK`));
    return;
  }

  if (obj.type === "system" && obj.subtype === "init" && typeof obj.session_id === "string") {
    writeLine(`  🚀 claude ready ${dim(`(session ${obj.session_id.slice(0, 8)}…)`)}`);
    return;
  }

  if (obj.type === "assistant") {
    const message = record(obj.message);
    for (const rawContent of Array.isArray(message?.content) ? message.content : []) {
      const c = record(rawContent);
      if (c?.type === "tool_use" && typeof c.name === "string") {
        const label = toolLabel(c.name, c.input ?? {});
        const entry: InflightTool = { name: c.name, label, startedAt: Date.now() };
        if (typeof c.id === "string" && c.id) state.inflight.set(c.id, entry);
        writeLine(`  ${cyan("▶")} ${label}`);
      }
    }
    return;
  }

  if (obj.type === "user") {
    const message = record(obj.message);
    for (const rawContent of Array.isArray(message?.content) ? message.content : []) {
      const c = record(rawContent);
      if (c?.type === "tool_result" && typeof c.tool_use_id === "string" && c.tool_use_id) {
        const entry = state.inflight.get(c.tool_use_id);
        if (entry) {
          const dur = formatCompactDuration(Date.now() - entry.startedAt);
          writeLine(`    ${green("✓")} ${entry.label} ${dim(`(${dur})`)}`);
          state.inflight.delete(c.tool_use_id);
        }
      }
    }
    return;
  }

  if (obj.type === "result") {
    const durationMs = numberValue(obj.duration_ms);
    const totalCost = numberValue(obj.total_cost_usd);
    const dur = durationMs ? formatCompactDuration(durationMs) : "?";
    const cost = totalCost != null ? `$${totalCost.toFixed(2)}` : "$?";
    writeLine(dim(`  [DONE: ${dur} | ${cost}]`));
    return;
  }
}

function processLine(line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    processEvent(JSON.parse(trimmed));
  } catch {
    // ignore non-JSON
  }
}

const streamFile = process.argv[2];

if (!streamFile) {
  // Stdin mode (recommended): `tail -F <file> | stream-formatter`
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", processLine);
  rl.on("close", () => process.exit(0));
} else {
  // File mode: follow the file with fs.watch (inotify) and incremental reads.
  let offset = 0;
  let leftover = "";
  let reading = false;
  let pending = false;

  function read(): void {
    if (reading) {
      pending = true;
      return;
    }
    reading = true;
    let size = 0;
    try {
      size = statSync(streamFile).size;
    } catch {
      reading = false;
      return;
    }
    if (size < offset) {
      offset = 0;
      leftover = "";
    }
    if (size === offset) {
      reading = false;
      if (pending) {
        pending = false;
        read();
      }
      return;
    }
    const stream = createReadStream(streamFile, { start: offset, end: size - 1, encoding: "utf-8" });
    let chunk = "";
    stream.on("data", (c) => {
      chunk += c;
    });
    stream.on("end", () => {
      offset = size;
      const data = leftover + chunk;
      const lines = data.split("\n");
      leftover = lines.pop() ?? "";
      for (const l of lines) processLine(l);
      reading = false;
      if (pending) {
        pending = false;
        read();
      }
    });
    stream.on("error", () => {
      reading = false;
    });
  }

  // Initial flush
  if (existsSync(streamFile)) read();

  // Watch through inotify (reactive).
  try {
    watch(streamFile, () => read());
  } catch {
    // Fall back to polling if watch fails.
    setInterval(read, 300);
  }

  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
}
