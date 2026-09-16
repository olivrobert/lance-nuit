// Real `config.json` files from existing projects must keep loading with the same
// normalized result: the schema in `config.schema.ts` tightens the shape, not the
// meaning of a valid file.
import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_SENSITIVE_PATHS, loadPipelineConfig } from "./config.js";

const FIXTURES = fileURLToPath(new URL("../../tests/fixtures/config/", import.meta.url));

function projectWithFixture(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "config-fixture-"));
  mkdirSync(join(dir, ".lance-nuit"), { recursive: true });
  copyFileSync(`${FIXTURES}${name}.json`, join(dir, ".lance-nuit", "config.json"));
  return dir;
}

test("config fixtures: a project file using every key", () => {
  expect(loadPipelineConfig(projectWithFixture("project-full"))).toEqual({
    workItem: {
      provider: "jira",
      project: "FOOD",
      todoState: "Selected for Development",
      reviewState: "En attente",
      baseUrl: "https://example.atlassian.net/browse",
    },
    labels: { bugTodo: "auto-fix", featureTodo: "auto-feature", done: "auto-fixed", escalate: "needs-human" },
    baseBranch: "develop",
    worktreeMode: "light",
    sensitivePaths: [],
    specPath: ".lance-nuit/work-items",
    usTokenBudget: 150_000,
    steps: {},
    profiles: {},
    testSkills: { unit: "/symfony-unit-test", functional: "/symfony-functional-test" },
    mrCompareUrlTemplate:
      "https://gitlab.example.com/group/app/-/merge_requests/new?merge_request%5Bsource_branch%5D={branch}&merge_request%5Btarget_branch%5D={base}",
    appUrl: "https://app.example.localhost",
    planAudit: false,
  });
});

test("config fixtures: a minimal project file on another provider", () => {
  const config = loadPipelineConfig(projectWithFixture("project-minimal"));
  expect(config.workItem).toEqual({
    provider: "github",
    project: "acme/demo-repo",
    todoState: "pipeline:todo",
    reviewState: "pipeline:in-review",
    baseUrl: "https://github.com/acme/demo-repo/issues",
  });
  expect(config.labels).toEqual({
    bugTodo: "queue:bug",
    featureTodo: "queue:feature",
    done: "queue:done",
    escalate: "queue:escalate",
  });
  expect(config.worktreeMode).toBe("full");
  expect(config.sensitivePaths).toEqual(DEFAULT_SENSITIVE_PATHS);
  expect(config.appUrl).toBeUndefined();
  expect(config.stackPreflight).toBeUndefined();
});

test("config fixtures: a user file carrying only step overrides", () => {
  const config = loadPipelineConfig(projectWithFixture("user-steps-only"));
  expect(config.steps).toEqual({
    "lot:implement-fast": { effort: "high" },
    "lot:constraints": { effort: "high" },
    "bugfix:constraints": { effort: "high" },
  });
  expect(config.workItem.provider).toBe("jira");
});
