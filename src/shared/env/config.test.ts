import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SENSITIVE_PATHS, loadPipelineConfig } from "./config.js";

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), "runner-config-"));
}

/** Write `.lance-nuit/config.json` in a disposable project. */
function projectWithConfig(config: unknown): string {
  const dir = tmpProject();
  mkdirSync(join(dir, ".lance-nuit"), { recursive: true });
  writeFileSync(join(dir, ".lance-nuit", "config.json"), JSON.stringify(config));
  return dir;
}

test("loadPipelineConfig prioritizes a complete project file", () => {
  const dir = projectWithConfig({
    workItem: { provider: "jira", project: "MAR", todoState: "Selected", reviewState: "Review" },
    baseBranch: "develop",
    worktreeMode: "light",
    labels: { bugTodo: "af", featureTodo: "afeat", done: "afd", escalate: "nh" },
    sensitivePaths: ["src/Security/**"],
    profiles: { triage: { backends: { claude: { model: "sonnet" } } } },
  });
  const cfg = loadPipelineConfig(dir);
  expect(cfg).toEqual({
    workItem: { provider: "jira", project: "MAR", todoState: "Selected", reviewState: "Review" },
    baseBranch: "develop",
    worktreeMode: "light",
    labels: { bugTodo: "af", featureTodo: "afeat", done: "afd", escalate: "nh" },
    sensitivePaths: ["src/Security/**"],
    specPath: ".lance-nuit/work-items",
    usTokenBudget: 150000,
    steps: {},
    profiles: { triage: { backends: { claude: { model: "sonnet" } } } },
    testSkills: {},
    planAudit: false,
  });
});

test("loadPipelineConfig: defaults without external integration", () => {
  const dir = tmpProject();
  writeFileSync(join(dir, "CLAUDE.md"), "# Projet\n$JIRA_PREFIX: PROJ\n");
  const cfg = loadPipelineConfig(dir);
  expect(cfg.workItem).toEqual({ provider: "jira", project: "", todoState: "To Do", reviewState: "In Review" });
  expect(cfg.labels.bugTodo).toBe("auto-fix");
  expect(cfg.labels.featureTodo).toBe("auto-feature");
  expect(cfg.labels.done).toBe("auto-fixed");
  expect(cfg.labels.escalate).toBe("needs-human");
  expect(cfg.baseBranch).toBe("main");
  expect(cfg.worktreeMode).toBe("full");
  expect(cfg.profiles).toEqual({});
  expect(cfg.sensitivePaths).toEqual(DEFAULT_SENSITIVE_PATHS);
});

test("loadPipelineConfig: empty config → workItem block defaults, empty project", () => {
  expect(loadPipelineConfig(tmpProject()).workItem).toEqual({
    provider: "jira",
    project: "",
    todoState: "To Do",
    reviewState: "In Review",
  });
});

test("loadPipelineConfig: the workItem-only form", () => {
  const dir = projectWithConfig({
    workItem: {
      project: "NEW",
      todoState: "Selected",
      reviewState: "Review",
      baseUrl: "https://new.atlassian.net/browse",
    },
  });
  expect(loadPipelineConfig(dir).workItem).toEqual({
    provider: "jira",
    project: "NEW",
    todoState: "Selected",
    reviewState: "Review",
    baseUrl: "https://new.atlassian.net/browse",
  });
});

test("loadPipelineConfig: missing provider defaults to jira, unknown provider is preserved", () => {
  expect(loadPipelineConfig(projectWithConfig({ workItem: { project: "X" } })).workItem.provider).toBe("jira");
  expect(
    loadPipelineConfig(projectWithConfig({ workItem: { provider: "redmine", project: "X" } })).workItem.provider,
  ).toBe("redmine");
});

test("loadPipelineConfig: a section of the wrong kind is an error naming the file", () => {
  const dir = projectWithConfig({ workItem: "jira" });
  expect(() => loadPipelineConfig(dir)).toThrow(
    /Invalid configuration \(.*\.lance-nuit\/config\.json\)[\s\S]*workItem/,
  );
});

test("loadPipelineConfig: a misspelled enum value is an error, never a silent default", () => {
  expect(() => loadPipelineConfig(projectWithConfig({ worktreeMode: "ligth" }))).toThrow(/worktreeMode/);
});

test("loadPipelineConfig: an unknown key is an error", () => {
  expect(() => loadPipelineConfig(projectWithConfig({ worktreMode: "light" }))).toThrow(
    /Unrecognized key: "worktreMode"/,
  );
  expect(() => loadPipelineConfig(projectWithConfig({ steps: { "a:b": { timeout: 30 } } }))).toThrow(
    /Unrecognized key: "timeout"/,
  );
});

test("loadPipelineConfig: invalid JSON is an error naming the file", () => {
  const dir = tmpProject();
  mkdirSync(join(dir, ".lance-nuit"), { recursive: true });
  writeFileSync(join(dir, ".lance-nuit", "config.json"), "{ not json");
  expect(() => loadPipelineConfig(dir)).toThrow(/Invalid configuration \(.*config\.json\)/);
});

test("loadPipelineConfig: profiles retunes a role", () => {
  const cfg = loadPipelineConfig(
    projectWithConfig({
      profiles: {
        triage: { backends: { claude: { model: "opus[1m]", effort: "xhigh" } } },
        coder: { backends: { claude: { effort: "high" } } },
      },
    }),
  );
  expect(cfg.profiles).toEqual({
    triage: { backends: { claude: { model: "opus[1m]", effort: "xhigh" } } },
    coder: { backends: { claude: { effort: "high" } } },
  });
});

test("loadPipelineConfig: stackPreflight without services means no preflight", () => {
  expect(loadPipelineConfig(projectWithConfig({ stackPreflight: {} })).stackPreflight).toBeUndefined();
  expect(loadPipelineConfig(projectWithConfig({ stackPreflight: { services: [] } })).stackPreflight).toBeUndefined();
  expect(() => loadPipelineConfig(projectWithConfig({ stackPreflight: { readinessTimeoutMs: 0 } }))).toThrow(
    /readinessTimeoutMs/,
  );
});
