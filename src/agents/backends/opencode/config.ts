// Runner-owned `opencode.json`.
//
// The adapter writes its own config instead of inheriting the user's: an explicit
// agent `prompt` is the only lever that replaces the default system prompt, and
// the per-agent `tools` map is the only per-role permission control opencode
// offers — there is no equivalent of the `--sandbox read-only` flag of codex.
// Measured on opencode 1.17.7: 9549 input tokens with the default agent, 6556
// with a custom agent, 184 with `tools: {"*": false}`.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPENCODE_AGENT } from "./types.js";

const PIPELINE_PROMPT =
  "You are an agent driven by an automated pipeline. There is no interactive user: " +
  "never ask a question, never wait for a confirmation, never propose follow-up work. " +
  "Do exactly what the instruction asks, then stop.";

const READ_ONLY_PROMPT = `${PIPELINE_PROMPT} You inspect the repository and report; you never modify it.`;

const BARE_PROMPT =
  "You transform the text you are given into the exact output the instruction asks for. " +
  "You have no tools and no repository access: answer from the input alone. " +
  "Reply with the requested content only — no preamble, no explanation, no code fence.";

/** The config as it is written on disk, newline-terminated. */
export function opencodeConfigContent(): string {
  const config = {
    $schema: "https://opencode.ai/config.json",
    // Empty on purpose: project `AGENTS.md` and personal rule files are context
    // the runner did not choose. `OPENCODE_DISABLE_CLAUDE_CODE=1` covers the rest.
    instructions: [],
    agent: {
      [OPENCODE_AGENT.RUNNER]: {
        mode: "primary",
        description: "Pipeline agent with every tool enabled.",
        prompt: PIPELINE_PROMPT,
      },
      [OPENCODE_AGENT.READ_ONLY]: {
        mode: "primary",
        description: "Pipeline agent restricted to reading.",
        prompt: READ_ONLY_PROMPT,
        tools: { write: false, edit: false, bash: false, patch: false },
      },
      [OPENCODE_AGENT.BARE]: {
        mode: "primary",
        description: "Text-to-JSON agent, no tool at all.",
        prompt: BARE_PROMPT,
        tools: { "*": false },
      },
    },
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

function readOrEmpty(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/**
 * Materializes the config and returns its path, for `OPENCODE_CONFIG`.
 *
 * The directory is content-addressed: the same config always lands on the same
 * path (no per-run garbage, concurrent runs share it), and any change to the
 * agents moves the path, so a stale file is never read.
 *
 * Not written under `runnerDir`: that is the installation tree, shared by every
 * run and read-only in a packaged kit.
 */
export function ensureOpencodeConfig(baseDir: string = tmpdir()): string {
  const content = opencodeConfigContent();
  const digest = createHash("sha256").update(content).digest("hex").slice(0, 16);
  const dir = join(baseDir, `lance-nuit-opencode-${digest}`);
  const path = join(dir, "opencode.json");
  if (readOrEmpty(path) === content) return path;
  mkdirSync(dir, { recursive: true });
  // Publish atomically: a concurrent run must never read a half-written config.
  const staging = join(dir, `opencode.json.${process.pid}.tmp`);
  writeFileSync(staging, content);
  renameSync(staging, path);
  return path;
}
