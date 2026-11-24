#!/usr/bin/env bun

// Live formatter for the runner stream JSONL: shows tool calls as they happen
// and the current pipeline step (from `pipeline-step` custom events).
//
// Usage (preferred, reactive through tail -f):
//   tail -F <stream-file> | bun stream-formatter.ts

import { createReadStream, existsSync, statSync, watch } from "node:fs";
import { createInterface } from "node:readline";
import {
  asFiniteNumber as numberValue,
  asRecord as record,
  asString as stringValue,
} from "../../shared/lib/json-values.js";
import { bold, cyan, detectColor, dim, setColorEnabled, yellow } from "./color.js";
import { formatContextShare } from "./format.js";
import { CONTEXT_WARN_PCT } from "./status-line.js";

interface PipelineStep {
  id?: string;
  name: string;
  index?: number;
  total?: number;
}

function displayValue(value: unknown): string {
  return value == null ? "?" : String(value);
}

// This formatter renders to stdout (a tmux pane), not to the runner's stderr:
// its color support has to be decided on the stream it actually writes to.
setColorEnabled(detectColor(process.env, process.stdout));

/** What the formatter remembers between events of one stream. */
interface FormatterState {
  step: PipelineStep | undefined;
  /** Context occupancy per step id; `undefined` for telemetry naming no step. */
  pct: Map<string | undefined, number>;
}

function newFormatterState(): FormatterState {
  return { step: undefined, pct: new Map() };
}

/** The occupancy rides along with the tool call it was measured on. */
function paintShare(pct: number | undefined): string {
  if (pct == null) return "";
  const text = ` · ${formatContextShare(pct)}`;
  return pct >= CONTEXT_WARN_PCT ? yellow(text) : dim(text);
}

function writeLine(s: string): void {
  process.stdout.write(`${s}\n`);
}

function processEvent(state: FormatterState, rawEvent: unknown): void {
  const obj = record(rawEvent);
  if (!obj) return;

  if (obj.type === "pipeline-step") {
    const name = stringValue(obj.name);
    if (!name) return;
    const index = numberValue(obj.index);
    const total = numberValue(obj.total);
    const id = stringValue(obj.id);
    state.step = {
      name,
      ...(id !== undefined ? { id } : {}),
      ...(index !== undefined ? { index } : {}),
      ...(total !== undefined ? { total } : {}),
    };
    // The members of a group start one after the other while their siblings run:
    // the tools in flight stay, keyed by their own ids. A new pass of a step means
    // a new session, so its previous occupancy no longer applies.
    state.pct.delete(id);
    state.pct.delete(undefined);
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

  if (obj.type === "runner-event" && obj.event === "activity") {
    const label = stringValue(obj.label);
    const stepId = stringValue(obj.stepId);
    // A member of a group reports under the header of the last one started.
    const owner = stepId && stepId !== state.step?.id ? `${dim(stepId)} ` : "";
    if (label) writeLine(`  ${cyan("▶")} ${owner}${label}${paintShare(state.pct.get(stepId))}`);
    return;
  }

  if (obj.type === "runner-event" && obj.event === "context") {
    const pct = numberValue(obj.pct);
    if (pct === undefined) return;
    const stepId = stringValue(obj.stepId);
    const previous = state.pct.get(stepId);
    // Only the crossing is worth a line of its own; the value itself rides along
    // with the next tool call.
    if (previous != null && previous < CONTEXT_WARN_PCT && pct >= CONTEXT_WARN_PCT)
      writeLine(
        yellow(`  ⚠ context ${Math.round(pct * 100)}% of ${Math.round((numberValue(obj.window) ?? 0) / 1000)}k`),
      );
    state.pct.set(stepId, pct);
  }
}

function processLine(state: FormatterState, line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    processEvent(state, JSON.parse(trimmed));
  } catch {
    // ignore non-JSON
  }
}

function main(): void {
  const state = newFormatterState();
  const streamFile = process.argv[2];

  if (!streamFile) {
    // Stdin mode (recommended): `tail -F <file> | stream-formatter`
    const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
    rl.on("line", (line) => processLine(state, line));
    rl.on("close", () => process.exit(0));
  } else {
    // File mode: follow the file with fs.watch (inotify) and incremental reads.
    // `read` is a hoisted declaration, so the `!streamFile` narrowing above does
    // not reach it: a local bound inside this branch carries the type.
    const file = streamFile;
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
        size = statSync(file).size;
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
      const stream = createReadStream(file, { start: offset, end: size - 1, encoding: "utf-8" });
      let chunk = "";
      stream.on("data", (c) => {
        chunk += c;
      });
      stream.on("end", () => {
        offset = size;
        const data = leftover + chunk;
        const lines = data.split("\n");
        leftover = lines.pop() ?? "";
        for (const l of lines) processLine(state, l);
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
    if (existsSync(file)) read();

    // Watch through inotify (reactive).
    try {
      watch(file, () => read());
    } catch {
      // Fall back to polling if watch fails.
      setInterval(read, 300);
    }

    process.on("SIGINT", () => process.exit(0));
    process.on("SIGTERM", () => process.exit(0));
  }
}

main();
