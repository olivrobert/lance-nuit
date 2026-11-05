import { expect, test } from "bun:test";
import { verdictInstruction } from "../verdict-instruction.js";
import { buildOpencodeArgs, buildOpencodeEnv, JSON_VERDICT_INSTRUCTION, variantForEffort } from "./args.js";
import { OPENCODE_AGENT, OPENCODE_LOG_LEVEL, OPENCODE_MODEL, OPENCODE_VARIANT } from "./types.js";

test("buildOpencodeArgs: JSON format, model, variant, agent and directory are explicit", () => {
  expect(
    buildOpencodeArgs(
      "inspect repo",
      {
        model: OPENCODE_MODEL.NEMOTRON_3_ULTRA,
        effort: "high",
        agent: OPENCODE_AGENT.READ_ONLY,
      },
      { cwd: "/repo" },
    ),
  ).toEqual([
    "run",
    "--format",
    "json",
    "--model",
    OPENCODE_MODEL.NEMOTRON_3_ULTRA,
    "--variant",
    OPENCODE_VARIANT.HIGH,
    "--agent",
    OPENCODE_AGENT.READ_ONLY,
    "--dir",
    "/repo",
    "--print-logs",
    "--log-level",
    OPENCODE_LOG_LEVEL.ERROR,
    "inspect repo",
  ]);
});

test("buildOpencodeArgs: logs are always on, because a hard failure is otherwise silent", () => {
  // opencode retries stream errors without writing to stdout: a billing or auth
  // failure is indistinguishable from a hang unless stderr is readable.
  expect(buildOpencodeArgs("go")).toContain("--print-logs");
  expect(buildOpencodeArgs("go").join(" ")).toContain(`--log-level ${OPENCODE_LOG_LEVEL.ERROR}`);
  expect(buildOpencodeArgs("go", { logLevel: OPENCODE_LOG_LEVEL.DEBUG }).join(" ")).toContain("--log-level DEBUG");
});

test("buildOpencodeArgs: omits every unset option", () => {
  expect(buildOpencodeArgs("go")).toEqual([
    "run",
    "--format",
    "json",
    "--print-logs",
    "--log-level",
    OPENCODE_LOG_LEVEL.ERROR,
    "go",
  ]);
});

test("buildOpencodeArgs: resume targets a session", () => {
  const args = buildOpencodeArgs("corrige", { model: OPENCODE_MODEL.GLM_52 }, { resumeSessionId: "ses_abc" });
  expect(args.slice(0, 5)).toEqual(["run", "--format", "json", "--session", "ses_abc"]);
  expect(args).not.toContain("--fork");
});

test("buildOpencodeArgs: fork applies only with a resume target", () => {
  expect(buildOpencodeArgs("corrige", {}, { resumeSessionId: "ses_abc", fork: true })).toEqual([
    "run",
    "--format",
    "json",
    "--session",
    "ses_abc",
    "--fork",
    "--print-logs",
    "--log-level",
    OPENCODE_LOG_LEVEL.ERROR,
    "corrige",
  ]);
  expect(buildOpencodeArgs("corrige", {}, { fork: true })).not.toContain("--fork");
});

test("buildOpencodeArgs: --pure is opt-in", () => {
  expect(buildOpencodeArgs("go")).not.toContain("--pure");
  expect(buildOpencodeArgs("go", { pure: true })).toContain("--pure");
});

test("buildOpencodeArgs: injects the verdict contract for JSON steps", () => {
  const args = buildOpencodeArgs("analyse", {}, { outputFormat: "json" });
  expect(args.at(-1)).toBe(`analyse\n\n${JSON_VERDICT_INSTRUCTION}`);
});

test("buildOpencodeArgs: captured fields ride in the verdict instruction", () => {
  // No output schema on opencode: the instruction is the only channel, so the
  // field and its schema must be spelled out there.
  const fields = { commit: { type: "string" } } as const;
  const prompt = buildOpencodeArgs("analyse", {}, { outputFormat: "json", outputFields: fields }).at(-1)!;
  expect(prompt).toBe(`analyse\n\n${verdictInstruction(fields)}`);
  expect(prompt).toContain('"commit": ...');
  expect(prompt).toContain('"commit" (required): {"type":"string"}');
});

test("buildOpencodeArgs: leaves the prompt alone for text steps", () => {
  expect(buildOpencodeArgs("analyse", {}, { outputFormat: "text" }).at(-1)).toBe("analyse");
  expect(buildOpencodeArgs("analyse").at(-1)).toBe("analyse");
});

test("buildOpencodeArgs: never duplicates a verdict contract the caller already wrote", () => {
  const prompt = "analyse, then answer in a ```json:verdict block";
  expect(buildOpencodeArgs(prompt, {}, { outputFormat: "json" }).at(-1)).toBe(prompt);
});

test("buildOpencodeArgs: imposes the runner artifact scope", () => {
  const args = buildOpencodeArgs(
    "write the report",
    {},
    {
      artifactScope: {
        artifactsDir: "/repo/.lance-nuit/work-items/PROJ-1/artifacts",
        workItemDir: "/repo/.lance-nuit/work-items/PROJ-1",
      },
    },
  );

  expect(args.at(-1)).toContain("ARTIFACT SCOPE IMPOSED BY THE RUNNER");
  expect(args.at(-1)).toContain("/repo/.lance-nuit/work-items/PROJ-1/artifacts");
});

test("buildOpencodeArgs: artifact scope precedes the verdict contract", () => {
  const prompt = buildOpencodeArgs(
    "write the report",
    {},
    { outputFormat: "json", artifactScope: { artifactsDir: "/repo/artifacts" } },
  ).at(-1)!;

  expect(prompt.indexOf("ARTIFACT SCOPE")).toBeLessThan(prompt.indexOf("json:verdict"));
});

test("variantForEffort: medium stays on the provider default", () => {
  expect(variantForEffort("low")).toBe(OPENCODE_VARIANT.MINIMAL);
  expect(variantForEffort("medium")).toBeUndefined();
  expect(variantForEffort("high")).toBe(OPENCODE_VARIANT.HIGH);
  expect(variantForEffort("xhigh")).toBe(OPENCODE_VARIANT.MAX);
  expect(variantForEffort("max")).toBe(OPENCODE_VARIANT.MAX);
  expect(variantForEffort(undefined)).toBeUndefined();
  expect(buildOpencodeArgs("go", { effort: "medium" })).not.toContain("--variant");
});

test("buildOpencodeEnv: cuts the Claude Code compatibility layer by default", () => {
  // Measured: leaving it on injects ~/.claude/CLAUDE.md, ~1250 input tokens of
  // instructions the runner never asked for.
  expect(buildOpencodeEnv()).toEqual({ OPENCODE_DISABLE_CLAUDE_CODE: "1" });
  expect(buildOpencodeEnv({ disableClaudeCodeCompat: true })).toEqual({ OPENCODE_DISABLE_CLAUDE_CODE: "1" });
});

test("buildOpencodeEnv: an explicit opt-out drops the variable, even when inherited", () => {
  expect(buildOpencodeEnv({ disableClaudeCodeCompat: false }, { OPENCODE_DISABLE_CLAUDE_CODE: "1" })).toEqual({});
});

test("buildOpencodeEnv: points opencode at the runner-owned config", () => {
  expect(buildOpencodeEnv({ configPath: "/run/opencode.json" })).toEqual({
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    OPENCODE_CONFIG: "/run/opencode.json",
  });
});

test("buildOpencodeEnv: keeps the inherited environment and skips undefined entries", () => {
  expect(buildOpencodeEnv({}, { PATH: "/usr/bin", HOME: undefined })).toEqual({
    PATH: "/usr/bin",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
  });
});
