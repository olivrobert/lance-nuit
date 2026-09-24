import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearCapabilityCache } from "../../../env/capability-frontmatter.js";
import { verdictInstruction, verdictSchema } from "../verdict-instruction.js";
import { buildClaudeArgs, isForkedSlashCommand, JSON_VERDICT_INSTRUCTION, VERDICT_SCHEMA } from "./args.js";

function capabilityRoot(context = "fork"): string {
  const root = mkdtempSync(join(tmpdir(), "claude-args-capability-"));
  const skill = join(root, "lance-nuit", "skills", "probe");
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), `---\ncontext: ${context}\n---\n`);
  clearCapabilityCache();
  return root;
}

describe("Claude backend args", () => {
  test("keeps the verdict instruction as actual newlines", () => {
    expect(JSON_VERDICT_INSTRUCTION).toContain("\n```json:verdict\n");
    expect(JSON_VERDICT_INSTRUCTION).not.toContain("\\n");
  });

  test("grants the work item as add-dir when it lives outside cwd (worktree)", () => {
    const scope = {
      artifactsDir: "/main/.lance-nuit/work-items/P-1/artifacts",
      workItemDir: "/main/.lance-nuit/work-items/P-1",
    };
    const outside = buildClaudeArgs("work", { cwd: "/wt", outputFormat: "text", artifactScope: scope });
    expect(outside.join(" ")).toContain("--add-dir /main/.lance-nuit/work-items/P-1");
    const inside = buildClaudeArgs("work", { cwd: "/main", outputFormat: "text", artifactScope: scope });
    expect(inside.filter((a) => a === "--add-dir")).toHaveLength(1);
  });

  test("passes cwd as add-dir and never sets an allowed-tools option", () => {
    const args = buildClaudeArgs("work", { cwd: "/repo", outputFormat: "text" });
    expect(args).toContain("/repo");
    expect(args).not.toContain("--allowedTools");
  });

  test("honors RUNNER_VERDICT_MODE=text", () => {
    const previous = process.env.RUNNER_VERDICT_MODE;
    process.env.RUNNER_VERDICT_MODE = "text";
    try {
      const args = buildClaudeArgs("work", { outputFormat: "json" });
      expect(args.join(" ")).toContain(JSON_VERDICT_INSTRUCTION);
      expect(args).not.toContain("--json-schema");
    } finally {
      if (previous === undefined) delete process.env.RUNNER_VERDICT_MODE;
      else process.env.RUNNER_VERDICT_MODE = previous;
    }
  });

  test("detects forked slash commands from capability frontmatter", () => {
    const root = capabilityRoot();
    expect(isForkedSlashCommand("/probe --ticket=X", [root])).toBe(true);
    expect(isForkedSlashCommand("/lance-nuit:probe --ticket=X", [root])).toBe(true);
    expect(isForkedSlashCommand("/probe --ticket=X", [capabilityRoot("inline")])).toBe(false);
    expect(isForkedSlashCommand("relay /probe --ticket=X", [root])).toBe(false);
  });

  test("appends one relay prompt for a forked slash command", () => {
    const root = capabilityRoot();
    const args = buildClaudeArgs("  /lance-nuit:probe --ticket=X", {
      outputFormat: "json",
      verdictMode: "text",
      capabilityRoots: [root],
    });
    const prompt = args[args.indexOf("-p") + 1];
    const appended = args[args.indexOf("--append-system-prompt") + 1];

    expect(prompt).toBe("  /lance-nuit:probe --ticket=X");
    expect(appended).toContain("Invoke skill `/lance-nuit:probe`");
    expect(appended).toContain("json:verdict");
    // The relay already carries the verdict format, so text mode must not add
    // the generic instruction as a second appended block.
    expect(appended!.match(/json:verdict/g)).toHaveLength(1);
  });

  test("does not append a relay for a non-forked slash command", () => {
    const root = capabilityRoot("inline");
    const args = buildClaudeArgs("/lance-nuit:probe", {
      outputFormat: "json",
      verdictMode: "text",
      capabilityRoots: [root],
    });
    const appended = args[args.indexOf("--append-system-prompt") + 1];
    expect(appended).toBe(JSON_VERDICT_INSTRUCTION);
    expect(appended).not.toContain("Invoke skill");
  });
});

test("Claude verdict schema requires every declared response property", () => {
  // Same rule as the Codex schema: `required` is derived from `properties`, and
  // optionality goes through the null union the verdict parser reads as absent.
  expect([...VERDICT_SCHEMA.required].sort()).toEqual(
    Object.keys(VERDICT_SCHEMA.properties).sort() as (keyof typeof VERDICT_SCHEMA.properties)[],
  );
  expect(VERDICT_SCHEMA.properties.blocked).toEqual({ type: ["boolean", "null"] });
});

test("Claude verdict schema keeps the strict-mode invariant with captured fields", () => {
  const schema = verdictSchema({
    branch: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
  });
  expect([...schema.required].sort()).toEqual(Object.keys(schema.properties).sort());
  expect(schema.properties.blocked).toEqual({ type: ["boolean", "null"] });
  expect(schema.required).toContain("branch");
});

describe("Claude backend args: captured fields", () => {
  const fields = { commit: { type: "string" } } as const;

  test("schema mode declares them in --json-schema", () => {
    const args = buildClaudeArgs("work", { outputFormat: "json", verdictMode: "schema", outputFields: fields });
    const schema = JSON.parse(args[args.indexOf("--json-schema") + 1]!);
    expect(schema).toEqual(verdictSchema(fields));
    expect(schema.required).toEqual(["success", "reason", "blocked", "commit"]);
  });

  test("without captures the --json-schema is exactly the historical one", () => {
    const args = buildClaudeArgs("work", { outputFormat: "json", verdictMode: "schema" });
    expect(JSON.parse(args[args.indexOf("--json-schema") + 1]!)).toEqual(VERDICT_SCHEMA);
  });

  test("text mode names them in the appended instruction, prompt and system-prompt paths alike", () => {
    const prompt = buildClaudeArgs("work", { outputFormat: "json", verdictMode: "text", outputFields: fields });
    const injected = prompt[prompt.indexOf("-p") + 1]!;
    expect(injected).toBe(`work\n\n${verdictInstruction(fields)}`);
    expect(injected).toContain('"commit": ...');
    expect(injected).toContain('"commit" (required): {"type":"string"}');

    const slash = buildClaudeArgs("/probe", { outputFormat: "json", verdictMode: "text", outputFields: fields });
    expect(slash[slash.indexOf("--append-system-prompt") + 1]).toBe(verdictInstruction(fields));
  });

  test("a bare verdictInstruction is the historical constant", () => {
    expect(verdictInstruction()).toBe(JSON_VERDICT_INSTRUCTION);
    expect(verdictInstruction({})).toBe(JSON_VERDICT_INSTRUCTION);
  });
});
