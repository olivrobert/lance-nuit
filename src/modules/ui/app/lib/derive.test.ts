import { describe, expect, test } from "bun:test";
import type { Item, ItemDetail, Launch, RunStepsView, TreeNode, WorkItemTree } from "../api/types.js";
import {
  countFiles,
  currentSheetTab,
  defaultSheetTab,
  failedBeforeRun,
  findAssumptions,
  hasAssumptionContent,
  headlineOf,
  isBusy,
  mimeOf,
  queueCount,
  reasonOf,
  splitKey,
  verbLabel,
  unmeteredResumeCommand,
  verbsFor,
  visibleItems,
  waitingCount,
} from "./derive.js";

function makeItem(overrides: Partial<Item> = {}): Item {
  return {
    key: "web/ABC-1",
    project: { name: "web", cwd: "/srv/web", provider: "local" },
    ticket: "ABC-1",
    pipeline: "feature",
    runId: "run-1",
    status: "STOPPED",
    group: "decision",
    cost: { estimated: false },
    updatedAt: "2026-01-10T10:00:00.000Z",
    worktree: false,
    effectiveWorkItemDir: "/srv/web/work-items/ABC-1",
    ...overrides,
  };
}

function makeLaunch(overrides: Partial<Launch> = {}): Launch {
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

const TREE: WorkItemTree = {
  root: "/srv/web/work-items/ABC-1",
  pipeline: "feature",
  runId: "run-1",
  runDir: "/srv/web/work-items/ABC-1/runs/run-1",
  children: [],
};

const STEPS: RunStepsView = {
  pipeline: "feature",
  runId: "run-1",
  runDir: "/srv/web/work-items/ABC-1/runs/run-1",
  status: "STOPPED",
  steps: [],
};

function detailOf(tree: WorkItemTree | null, steps: RunStepsView | null, item = makeItem()): ItemDetail {
  return { item, tree, steps };
}

describe("reasonOf and headlineOf", () => {
  test("an alive launch outranks whatever the disk still says", () => {
    const item = makeItem({ status: "FAIL", group: "failure", launch: makeLaunch({ alive: true, verb: "fresh" }) });
    expect(reasonOf(item)).toBe("launched by olivier (start fresh)");
  });

  test("a decision reads its stop detail, a failure its phase and reason", () => {
    expect(reasonOf(makeItem({ stop: { detail: "needs a call" } }))).toBe("needs a call");
    expect(reasonOf(makeItem({ group: "decision", stop: undefined }))).toBe("stopped");
    expect(
      reasonOf(makeItem({ group: "failure", status: "FAIL", failure: { phase: "build", reason: "exit 1" } })),
    ).toBe("build — exit 1");
    expect(reasonOf(makeItem({ group: "failure", status: "ABORTED" }))).toBe("aborted");
  });

  test("a timeout is called out ahead of the failing phase", () => {
    const item = makeItem({
      group: "failure",
      status: "FAIL",
      failure: { phase: "agent", reason: "Timeout after 5m" },
    });
    expect(headlineOf(item)).toBe("Execution timed out");
    expect(headlineOf(makeItem({ group: "failure", status: "ABORTED" }))).toBe("Execution interrupted");
    expect(headlineOf(makeItem({ group: "decision", stop: { detail: "x", subject: "plan" } }))).toBe("Review plan");
  });
});

describe("verbsFor", () => {
  test("a stop with a subject offers approve-and-rerun, approve only, and start fresh", () => {
    const verbs = verbsFor(makeItem({ status: "STOPPED", stop: { detail: "gate", subject: "plan" } }));
    expect(verbs.map((verb) => verb.verb)).toEqual(["approve-and-rerun", "approve", "fresh"]);
    expect(verbs[0]?.primary).toBe(true);
    expect(verbs[0]?.command).toBe("lancenuit run ABC-1 --pipeline feature --approve plan");
  });

  test("a stop with no subject offers a plain rerun", () => {
    const verbs = verbsFor(makeItem({ status: "STOPPED", stop: { detail: "blocked" } }));
    expect(verbs.map((verb) => verb.verb)).toEqual(["rerun", "fresh"]);
  });

  test("FAIL and ABORTED both rerun from the failure", () => {
    for (const status of ["FAIL", "ABORTED"] as const) {
      const verbs = verbsFor(makeItem({ status, group: "failure" }));
      expect(verbs.map((verb) => verb.verb)).toEqual(["rerun", "fresh"]);
      expect(verbs[0]?.label).toBe("Rerun from failure");
    }
  });

  test("RUNNING offers nothing, not even start fresh", () => {
    expect(verbsFor(makeItem({ status: "RUNNING", group: "running" }))).toEqual([]);
  });

  test("PASS offers only start fresh", () => {
    const verbs = verbsFor(makeItem({ status: "PASS", group: "done" }));
    expect(verbs.map((verb) => verb.verb)).toEqual(["fresh"]);
    expect(verbs[0]?.danger).toBe(true);
  });

  test("a budget ceiling adds its own verb, and a worktree run carries the flag", () => {
    const verbs = verbsFor(makeItem({ status: "FAIL", group: "failure", budgetExceeded: true, worktree: true }));
    expect(verbs.map((verb) => verb.verb)).toEqual(["rerun", "budget", "fresh"]);
    expect(verbs[1]?.command).toBe("lancenuit run ABC-1 --pipeline feature --budget <usd> --worktree");
  });

  test("an accounting stop gets no verb: authorizing unpriced spend is a terminal decision", () => {
    const item = makeItem({ status: "FAIL", group: "failure", costUnaccounted: true, worktree: true });
    const verbs = verbsFor(item);
    // No `unmetered` verb, and no `budget` one either: the run never reached its
    // ceiling, so raising it would answer a question nobody asked.
    expect(verbs.map((verb) => verb.verb)).toEqual(["rerun", "fresh"]);
    expect(verbs.every((verb) => !verb.command.includes("--allow-unmetered"))).toBe(true);
    // The command is shown as text instead, worktree flag included.
    expect(unmeteredResumeCommand(item)).toBe("lancenuit run ABC-1 --pipeline feature --allow-unmetered --worktree");
  });

  test("a verb the browser does not know falls through to its own name", () => {
    expect(verbLabel("approve")).toBe("approve only");
    expect(verbLabel("teleport")).toBe("teleport");
  });
});

describe("isBusy", () => {
  test("a running run or a live launch of ours blocks every button", () => {
    expect(isBusy(makeItem({ status: "RUNNING" }))).toBe(true);
    expect(isBusy(makeItem({ launch: makeLaunch({ alive: true }) }))).toBe(true);
    expect(isBusy(makeItem({ launch: makeLaunch({ exitCode: 0 }) }))).toBe(false);
  });
});

describe("failedBeforeRun", () => {
  test("true when the launch died and the run never moved after it", () => {
    const item = makeItem({
      updatedAt: "2026-01-10T10:00:00.000Z",
      launch: makeLaunch({ at: "2026-01-10T11:00:00.000Z", exitCode: 1 }),
    });
    expect(failedBeforeRun(item)).toBe(true);
  });

  test("false when the run moved after the launch: the failure is the run's", () => {
    const item = makeItem({
      updatedAt: "2026-01-10T11:30:00.000Z",
      launch: makeLaunch({ at: "2026-01-10T11:00:00.000Z", exitCode: 1 }),
    });
    expect(failedBeforeRun(item)).toBe(false);
  });

  test("false with no launch, a live launch, or a clean exit", () => {
    expect(failedBeforeRun(makeItem())).toBe(false);
    expect(failedBeforeRun(makeItem({ launch: makeLaunch({ alive: true }) }))).toBe(false);
    expect(failedBeforeRun(makeItem({ launch: makeLaunch({ exitCode: 0 }) }))).toBe(false);
  });

  test("an aborted launch with no exit code still counts as failed before the run", () => {
    const item = makeItem({
      updatedAt: "2026-01-10T09:00:00.000Z",
      launch: makeLaunch({ exitCode: null }),
    });
    expect(failedBeforeRun(item)).toBe(true);
  });

  test("an unparsable run timestamp does not hide the launch failure", () => {
    const item = makeItem({ updatedAt: "n/a", launch: makeLaunch({ exitCode: 2 }) });
    expect(failedBeforeRun(item)).toBe(true);
  });
});

describe("defaultSheetTab", () => {
  test("each group opens on the tab that answers its question", () => {
    expect(defaultSheetTab(makeItem({ group: "failure" }))).toBe("diagnostic");
    expect(defaultSheetTab(makeItem({ group: "running" }))).toBe("steps");
    expect(defaultSheetTab(makeItem({ group: "decision" }))).toBe("document");
    expect(defaultSheetTab(makeItem({ group: "done" }))).toBe("document");
  });
});

describe("currentSheetTab", () => {
  const withDocument: WorkItemTree = { ...TREE, gatePath: "artifacts/plan.md" };

  test("auto follows the item's default when the content exists", () => {
    const item = makeItem({ group: "decision" });
    expect(currentSheetTab(item, detailOf(withDocument, STEPS), "auto")).toBe("document");
  });

  test("document with no gate and no default falls back to files when a tree exists", () => {
    const item = makeItem({ group: "decision" });
    expect(currentSheetTab(item, detailOf(TREE, null), "document")).toBe("files");
  });

  test("document with no tree at all falls back to diagnostic", () => {
    const item = makeItem({ group: "decision" });
    expect(currentSheetTab(item, detailOf(null, null), "document")).toBe("diagnostic");
    expect(currentSheetTab(item, null, "auto")).toBe("diagnostic");
  });

  test("files with no tree falls back to the item's default", () => {
    expect(currentSheetTab(makeItem({ group: "running" }), detailOf(null, STEPS), "files")).toBe("steps");
  });

  test("steps with no steps falls back to the item's default", () => {
    const item = makeItem({ group: "decision" });
    expect(currentSheetTab(item, detailOf(withDocument, null), "steps")).toBe("document");
  });

  test("diagnostic is refused to an item that neither failed nor was launched", () => {
    const item = makeItem({ group: "decision" });
    expect(currentSheetTab(item, detailOf(withDocument, STEPS), "diagnostic")).toBe("document");
  });

  test("diagnostic is kept for a failure, and for any item carrying a launch", () => {
    const failed = makeItem({ group: "failure", status: "FAIL" });
    expect(currentSheetTab(failed, detailOf(withDocument, STEPS), "diagnostic")).toBe("diagnostic");
    const launched = makeItem({ group: "decision", launch: makeLaunch() });
    expect(currentSheetTab(launched, detailOf(withDocument, STEPS), "diagnostic")).toBe("diagnostic");
  });

  test("a requested tab whose content exists is honoured", () => {
    const item = makeItem({ group: "decision" });
    expect(currentSheetTab(item, detailOf(withDocument, STEPS), "files")).toBe("files");
    expect(currentSheetTab(item, detailOf(withDocument, STEPS), "steps")).toBe("steps");
  });
});

describe("visibleItems", () => {
  const items: Item[] = [
    makeItem({ key: "web/ABC-1", ticket: "ABC-1", group: "decision", stop: { detail: "gate" } }),
    makeItem({
      key: "web/ABC-2",
      ticket: "ABC-2",
      group: "failure",
      status: "FAIL",
      failure: { phase: "build", reason: "npm exploded" },
    }),
    makeItem({
      key: "api/XYZ-9",
      ticket: "XYZ-9",
      group: "running",
      status: "RUNNING",
      pipeline: "hotfix",
      project: { name: "api", cwd: "/srv/api", provider: "jira" },
    }),
    makeItem({
      key: "api/XYZ-8",
      ticket: "XYZ-8",
      group: "done",
      status: "PASS",
      project: { name: "api", cwd: "/srv/api", provider: "jira" },
    }),
  ];
  const all = { filter: null, queue: "attention" as const, query: "" };

  test("the attention queue keeps decisions and failures only", () => {
    expect(visibleItems(items, all).map((item) => item.key)).toEqual(["web/ABC-1", "web/ABC-2"]);
  });

  test("the running and done queues keep their own group", () => {
    expect(visibleItems(items, { ...all, queue: "running" }).map((item) => item.key)).toEqual(["api/XYZ-9"]);
    expect(visibleItems(items, { ...all, queue: "done" }).map((item) => item.key)).toEqual(["api/XYZ-8"]);
  });

  test("the project chip narrows within the queue", () => {
    expect(visibleItems(items, { ...all, filter: "web" }).map((item) => item.key)).toEqual(["web/ABC-1", "web/ABC-2"]);
    expect(visibleItems(items, { ...all, filter: "api" })).toEqual([]);
    expect(visibleItems(items, { ...all, filter: "api", queue: "running" }).map((item) => item.key)).toEqual([
      "api/XYZ-9",
    ]);
  });

  test("the search matches the ticket, the pipeline, the project and the reason", () => {
    expect(visibleItems(items, { ...all, query: "abc-2" }).map((item) => item.key)).toEqual(["web/ABC-2"]);
    expect(visibleItems(items, { ...all, query: "exploded" }).map((item) => item.key)).toEqual(["web/ABC-2"]);
    expect(visibleItems(items, { ...all, queue: "running", query: "hotfix" }).map((item) => item.key)).toEqual([
      "api/XYZ-9",
    ]);
    expect(visibleItems(items, { ...all, queue: "running", query: "api" }).map((item) => item.key)).toEqual([
      "api/XYZ-9",
    ]);
  });

  test("the search is case-insensitive and ignores surrounding blanks", () => {
    expect(visibleItems(items, { ...all, query: "  GATE  " }).map((item) => item.key)).toEqual(["web/ABC-1"]);
  });

  test("filters cross: a project and a search that disagree keep nothing", () => {
    expect(visibleItems(items, { ...all, filter: "web", query: "xyz" })).toEqual([]);
  });
});

describe("queueCount and waitingCount", () => {
  const items: Item[] = [
    makeItem({ key: "web/1", group: "decision" }),
    makeItem({ key: "web/2", group: "failure" }),
    makeItem({ key: "api/3", group: "running", project: { name: "api", cwd: "/srv/api", provider: "jira" } }),
    makeItem({ key: "api/4", group: "done", project: { name: "api", cwd: "/srv/api", provider: "jira" } }),
    makeItem({ key: "api/5", group: "decision", project: { name: "api", cwd: "/srv/api", provider: "jira" } }),
  ];

  test("queue counts span every project, whatever chip is selected", () => {
    expect(queueCount(items, "attention")).toBe(3);
    expect(queueCount(items, "running")).toBe(1);
    expect(queueCount(items, "done")).toBe(1);
  });

  test("waiting counts narrow to one project, or to all of them", () => {
    expect(waitingCount(items, null)).toBe(3);
    expect(waitingCount(items, "web")).toBe(2);
    expect(waitingCount(items, "api")).toBe(1);
  });
});

describe("the explorer helpers", () => {
  const nodes: TreeNode[] = [
    { kind: "file", name: "ticket.md", path: "ticket.md", size: 10, contentKind: "md" },
    {
      kind: "directory",
      name: "artifacts",
      path: "artifacts",
      children: [
        { kind: "file", name: "plan.md", path: "artifacts/plan.md", size: 20, contentKind: "md" },
        {
          kind: "directory",
          name: "deep",
          path: "artifacts/deep",
          children: [
            {
              kind: "file",
              name: "assumptions.json",
              path: "artifacts/deep/assumptions.json",
              size: 5,
              contentKind: "json",
            },
          ],
        },
      ],
    },
  ];

  test("countFiles walks the whole subtree", () => {
    expect(countFiles(nodes[1] as TreeNode)).toBe(2);
    expect(countFiles(nodes[0] as TreeNode)).toBe(1);
  });

  test("findAssumptions reaches a nested file, and answers undefined when there is none", () => {
    expect(findAssumptions(nodes)?.path).toBe("artifacts/deep/assumptions.json");
    expect(findAssumptions([nodes[0] as TreeNode])).toBeUndefined();
  });

  test("hasAssumptionContent is false for an empty or absent file", () => {
    expect(hasAssumptionContent(null)).toBe(false);
    expect(hasAssumptionContent({ blocking: [], resolved: [] })).toBe(false);
    expect(hasAssumptionContent({ resolved: [{ subject: "s" }] })).toBe(true);
  });
});

describe("splitKey and mimeOf", () => {
  test("a key splits on its first separator", () => {
    expect(splitKey("web/ABC-1")).toEqual(["web", "ABC-1"]);
    expect(splitKey("web/nested/ABC-1")).toEqual(["web", "nested/ABC-1"]);
    expect(splitKey("web")).toEqual(["web", ""]);
  });

  test("an image extension picks its type, and anything else is a PNG", () => {
    expect(mimeOf("a/b.JPG")).toBe("image/jpeg");
    expect(mimeOf("a/b.jpeg")).toBe("image/jpeg");
    expect(mimeOf("a/b.gif")).toBe("image/gif");
    expect(mimeOf("a/b.webp")).toBe("image/webp");
    expect(mimeOf("a/b.png")).toBe("image/png");
  });
});
