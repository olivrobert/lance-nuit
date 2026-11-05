import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureOpencodeConfig, opencodeConfigContent } from "./config.js";
import { OPENCODE_AGENT } from "./types.js";

function readConfig(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, "utf8"));
}

test("opencodeConfigContent: declares the three runner agents with an explicit prompt", () => {
  const config = JSON.parse(opencodeConfigContent());

  expect(Object.keys(config.agent).sort()).toEqual(
    [OPENCODE_AGENT.BARE, OPENCODE_AGENT.READ_ONLY, OPENCODE_AGENT.RUNNER].sort(),
  );
  // An explicit prompt is the only lever that replaces the default system prompt:
  // `--pure`, `instructions: []` and `OPENCODE_CONFIG` alone all leave it in place.
  for (const agent of Object.values(config.agent) as Array<Record<string, unknown>>) {
    expect(typeof agent.prompt).toBe("string");
    expect((agent.prompt as string).length).toBeGreaterThan(0);
  }
  expect(config.instructions).toEqual([]);
});

test("opencodeConfigContent: `tools` carries the per-role permissions opencode has no flag for", () => {
  const config = JSON.parse(opencodeConfigContent());

  // Read-only: measured at ~5712 input tokens against ~6556 with every tool.
  expect(config.agent[OPENCODE_AGENT.READ_ONLY].tools).toEqual({
    write: false,
    edit: false,
    bash: false,
    patch: false,
  });
  // Text-to-JSON roles: 184 input tokens, the only configuration under 1000.
  expect(config.agent[OPENCODE_AGENT.BARE].tools).toEqual({ "*": false });
  expect(config.agent[OPENCODE_AGENT.RUNNER].tools).toBeUndefined();
});

test("ensureOpencodeConfig: writes the file and returns a path stable across calls", () => {
  const base = mkdtempSync(join(tmpdir(), "opencode-config-"));

  const first = ensureOpencodeConfig(base);
  const second = ensureOpencodeConfig(base);

  expect(second).toBe(first);
  expect(first.startsWith(join(base, "lance-nuit-opencode-"))).toBe(true);
  expect(first.endsWith("opencode.json")).toBe(true);
  expect(readConfig(first).agent[OPENCODE_AGENT.BARE].tools).toEqual({ "*": false });
});

test("ensureOpencodeConfig: the path is content-addressed, so a stale config is never reused", () => {
  const base = mkdtempSync(join(tmpdir(), "opencode-config-hash-"));

  const path = ensureOpencodeConfig(base);
  const digest = path.split("/").at(-2)?.replace("lance-nuit-opencode-", "");

  expect(digest).toMatch(/^[0-9a-f]{16}$/);
  expect(readFileSync(path, "utf8")).toBe(opencodeConfigContent());
});
