import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capabilitySuffix } from "../../env/capability-frontmatter.ts";
import { capabilityPreflightCommand } from "./skill-preflight.ts";

function fixture(): { root: string; runnerDir: string; cwd: string } {
  const root = mkdtempSync(join(tmpdir(), "skills-preflight-"));
  const runnerDir = join(root, "kit", "lance-nuit", "runner");
  const cwd = join(root, "project");
  mkdirSync(runnerDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  return { root, runnerDir, cwd };
}

function writeSkill(dir: string, name: string): void {
  mkdirSync(join(dir, "skills", name), { recursive: true });
  writeFileSync(join(dir, "skills", name, "SKILL.md"), `---\nname: ${name}\n---\n`);
}

function run(runnerDir: string, cwd: string, skills: string[], configuredRoot?: string) {
  const env = { ...process.env };
  if (configuredRoot) env.PIPELINE_CAPABILITY_ROOTS = configuredRoot;
  else delete env.PIPELINE_CAPABILITY_ROOTS;
  return spawnSync("bash", ["-c", capabilityPreflightCommand(runnerDir, cwd, skills, [], env)], {
    encoding: "utf8",
    env,
  });
}

test("preflight finds a skill in an explicitly configured root", () => {
  const { root, runnerDir, cwd } = fixture();
  writeSkill(join(root, "capabilities", "plugin-test"), "skill-explicite-test");

  expect(run(runnerDir, cwd, ["plugin-test:skill-explicite-test"], join(root, "capabilities")).status).toBe(0);
});

// Real `quality-e2e-tester` case: the skill belongs to no plugin and lives in the
// project's `.claude`. Searching only plugins would fail every project pipeline.
test("preflight finds a project skill in <cwd>/.claude/skills", () => {
  const { runnerDir, cwd } = fixture();
  writeSkill(join(cwd, ".claude"), "quality-e2e-tester");

  expect(run(runnerDir, cwd, ["quality-e2e-tester"]).status).toBe(0);
});

test("preflight explicitly fails when a required skill is missing", () => {
  const { runnerDir, cwd } = fixture();

  const result = run(runnerDir, cwd, ["missing-skill-test"]);

  expect(result.status).toBe(1);
  expect(result.stderr).toContain("missing-skill-test");
});

test("qualified preflight requires the declared plugin, not a same-named skill elsewhere", () => {
  // Deliberately nonexistent names elsewhere: preflight also scans real ~/.claude;
  // a real name would be found by the plugin cache.
  const { root, runnerDir, cwd } = fixture();
  writeSkill(join(root, "kit", "plugin-hosted-test"), "qualified-skill-test");

  // Correct plugin → found.
  expect(run(runnerDir, cwd, ["plugin-hosted-test:qualified-skill-test"], join(root, "kit")).status).toBe(0);

  // Wrong prefix: SKILL.md exists, but not in this plugin. Preflight must fail here,
  // otherwise it certifies a contract that will fail at runtime on
  // /plugin-absent-test:qualified-skill-test.
  const wrong = run(runnerDir, cwd, ["plugin-absent-test:qualified-skill-test"], join(root, "kit"));
  expect(wrong.status).toBe(1);
  expect(wrong.stderr).toContain("plugin-absent-test:qualified-skill-test");
});

test("preflight shares the canonical suffix with runtime resolution", () => {
  const { runnerDir, cwd } = fixture();
  const command = capabilityPreflightCommand(runnerDir, cwd, ["plugin-test:probe"], ["plugin-test:worker"]);
  expect(capabilitySuffix("skill", "plugin-test:probe")).toBe("plugin-test/skills/probe/SKILL.md");
  expect(capabilitySuffix("agent", "plugin-test:worker")).toBe("plugin-test/agents/worker.md");
  expect(command).toContain("skill|plugin-test:probe|plugin-test/skills/probe/SKILL.md");
  expect(command).toContain("agent|plugin-test:worker|plugin-test/agents/worker.md");
});

test("preflight ignores node_modules and vendor", () => {
  const { runnerDir, cwd } = fixture();
  writeSkill(join(cwd, ".claude", "node_modules", "paquet"), "skill-leurre");

  expect(run(runnerDir, cwd, ["skill-leurre"]).status).toBe(1);
});
