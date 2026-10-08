// Fixtures shared by the tests of `lib/`: an item, a launch, a tree and a step
// view, each overridable field by field.

import type { Item, ItemDetail, Launch, RunStepsView, WorkItemTree } from "../api/types.js";

export function makeItem(overrides: Partial<Item> = {}): Item {
  return {
    key: "web/ABC-1",
    project: { name: "web", cwd: "/srv/web", provider: "local" },
    ticket: "ABC-1",
    pipeline: "feature",
    pipelineRef: "feature",
    runId: "run-1",
    status: "STOPPED",
    group: "decision",
    cost: { estimated: false },
    updatedAt: "2026-01-10T10:00:00.000Z",
    worktree: false,
    effectiveWorkItemDir: "/srv/web/work-items/ABC-1",
    busy: false,
    verbs: [],
    ...overrides,
  };
}

export function makeLaunch(overrides: Partial<Launch> = {}): Launch {
  return {
    id: "l1",
    at: "2026-01-10T11:00:00.000Z",
    by: "olivier",
    project: "web",
    ticket: "ABC-1",
    verb: "rerun",
    argv: ["run", "ABC-1"],
    cwd: "/srv/web",
    pid: 42,
    alive: false,
    ...overrides,
  };
}

export const TREE: WorkItemTree = {
  root: "/srv/web/work-items/ABC-1",
  pipeline: "feature",
  runId: "run-1",
  runDir: "/srv/web/work-items/ABC-1/runs/run-1",
  children: [],
};

export const STEPS: RunStepsView = {
  pipeline: "feature",
  runId: "run-1",
  runDir: "/srv/web/work-items/ABC-1/runs/run-1",
  status: "STOPPED",
  steps: [],
};

export function detailOf(tree: WorkItemTree | null, steps: RunStepsView | null, item = makeItem()): ItemDetail {
  return { item, tree, steps, recap: null, report: null };
}
