import { describe, expect, test } from "bun:test";
import type {
  Item,
  ItemDetail,
  Launch,
  RunRecap,
  RunRecapStep,
  RunReport,
  RunStepsView,
  RunStepView,
  SheetTab,
  TreeFile,
  TreeNode,
  WorkItemTree,
} from "../api/types.js";
import {
  captureNumbers,
  capturePath,
  costByModel,
  countFiles,
  currentSheetTab,
  defaultSheetTab,
  deliveryActions,
  failedBeforeRun,
  findAssumptions,
  freshnessOf,
  hasAssumptionContent,
  headlineOf,
  isBusy,
  isDelivered,
  leftForYou,
  mimeOf,
  newlyWaiting,
  reasonOf,
  reviewText,
  rowShowsTag,
  rowTime,
  STALE_AFTER_MS,
  screenshotGroups,
  splitKey,
  type TimelineSection,
  timeline,
  timelineLanes,
  unmeteredResumeCommand,
  updatedLabel,
  verbLabel,
  verbsFor,
  visibleItems,
  waitingCount,
  waitingKeys,
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
  return { item, tree, steps, recap: null, report: null };
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
    expect(verbs.map((verb) => verb.verb)).toEqual(["approve-and-rerun", "approve", "close", "fresh"]);
    expect(verbs[0]?.primary).toBe(true);
    expect(verbs[0]?.command).toBe("lancenuit run ABC-1 --pipeline feature --approve plan");
  });

  test("a stop with no subject offers a plain rerun", () => {
    const verbs = verbsFor(makeItem({ status: "STOPPED", stop: { detail: "blocked" } }));
    expect(verbs.map((verb) => verb.verb)).toEqual(["rerun", "close", "fresh"]);
  });

  test("FAIL and ABORTED both rerun from the failure", () => {
    for (const status of ["FAIL", "ABORTED"] as const) {
      const verbs = verbsFor(makeItem({ status, group: "failure" }));
      expect(verbs.map((verb) => verb.verb)).toEqual(["rerun", "close", "fresh"]);
      expect(verbs[0]?.label).toBe("Rerun from failure");
    }
  });

  test("a closed run offers only reopen and start fresh", () => {
    const item = makeItem({ status: "FAIL", group: "done", closed: { at: "2026-09-06T08:00:00.000Z", by: "Olivier" } });
    const verbs = verbsFor(item);
    expect(verbs.map((verb) => verb.verb)).toEqual(["reopen", "fresh"]);
    expect(verbs[0]?.command).toBe("lancenuit reopen ABC-1 --pipeline feature");
    expect(headlineOf(item)).toBe("Closed by hand");
    expect(reasonOf(item)).toBe("closed by Olivier");
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
    expect(verbs.map((verb) => verb.verb)).toEqual(["rerun", "budget", "close", "fresh"]);
    expect(verbs[1]?.command).toBe("lancenuit run ABC-1 --pipeline feature --budget <usd> --worktree");
  });

  test("an accounting stop gets no verb: authorizing unpriced spend is a terminal decision", () => {
    const item = makeItem({ status: "FAIL", group: "failure", costUnaccounted: true, worktree: true });
    const verbs = verbsFor(item);
    // No `unmetered` verb, and no `budget` one either: the run never reached its
    // ceiling, so raising it would answer a question nobody asked.
    expect(verbs.map((verb) => verb.verb)).toEqual(["rerun", "close", "fresh"]);
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

describe("screenshotGroups", () => {
  function file(path: string, contentKind: TreeFile["contentKind"] = "png"): TreeFile {
    return { kind: "file", name: path.split("/").at(-1) ?? path, path, size: 1, contentKind };
  }

  test("images of reports/ are grouped by directory, with the summary beside them", () => {
    const tree: WorkItemTree = {
      ...TREE,
      children: [
        { kind: "directory", name: "artifacts", path: "artifacts", children: [file("artifacts/mockup.png")] },
        {
          kind: "directory",
          name: "reports",
          path: "reports",
          children: [
            {
              kind: "directory",
              name: "screenshots",
              path: "reports/screenshots",
              children: [
                file("reports/screenshots/01.png"),
                file("reports/screenshots/summary.md", "md"),
                file("reports/screenshots/02.png"),
              ],
            },
            file("reports/constraints.md", "md"),
          ],
        },
      ],
    };

    expect(screenshotGroups(tree)).toEqual([
      {
        dir: "reports/screenshots",
        images: [file("reports/screenshots/01.png"), file("reports/screenshots/02.png")],
        summary: file("reports/screenshots/summary.md", "md"),
      },
    ]);
  });

  test("no tree, or no reports/, means no screenshots", () => {
    expect(screenshotGroups(null)).toEqual([]);
    expect(screenshotGroups(TREE)).toEqual([]);
  });
});

describe("defaultSheetTab", () => {
  test("each group opens on the tab that answers its question", () => {
    expect(defaultSheetTab(makeItem({ group: "failure" }))).toBe("diagnostic");
    expect(defaultSheetTab(makeItem({ group: "running" }))).toBe("run");
    expect(defaultSheetTab(makeItem({ group: "decision" }))).toBe("document");
    expect(defaultSheetTab(makeItem({ group: "done" }))).toBe("run");
  });
});

describe("currentSheetTab", () => {
  const withDocument: WorkItemTree = { ...TREE, gatePath: "artifacts/plan.md" };
  const RECAP: RunRecap = { pipeline: "feature", runId: "run-1", status: "PASS", models: [], steps: [] };

  test("a finished run opens on its Run tab", () => {
    const item = makeItem({ group: "done" });
    expect(currentSheetTab(item, { ...detailOf(withDocument, STEPS, item), recap: RECAP }, "auto")).toBe("run");
  });

  test("run with neither recap nor steps reads as document, and falls back no further than document does", () => {
    const item = makeItem({ group: "done" });
    expect(currentSheetTab(item, detailOf(withDocument, null, item), "auto")).toBe("document");
    expect(currentSheetTab(item, detailOf(TREE, null, item), "run")).toBe("files");
    expect(currentSheetTab(item, detailOf(null, null, item), "run")).toBe("diagnostic");
  });

  test("run with steps but no recap yet is kept", () => {
    const item = makeItem({ group: "running" });
    expect(currentSheetTab(item, detailOf(null, STEPS, item), "auto")).toBe("run");
  });

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
    expect(currentSheetTab(makeItem({ group: "running" }), detailOf(null, STEPS), "files")).toBe("run");
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
    expect(currentSheetTab(item, detailOf(withDocument, STEPS), "run")).toBe("run");
  });

  describe("with a report", () => {
    const REPORT: RunReport = { version: 1, runId: "run-1" };
    const launched = makeLaunch({ alive: false, exitCode: 0 });
    // group → [report present, report absent, report refused]
    const cases: [Item["group"], SheetTab, SheetTab, SheetTab][] = [
      ["done", "report", "run", "run"],
      ["running", "run", "run", "run"],
      ["failure", "diagnostic", "diagnostic", "diagnostic"],
      ["decision", "document", "document", "document"],
    ];
    const detailWith = (item: Item, read: Pick<ItemDetail, "report" | "reportError">): ItemDetail => ({
      ...detailOf(withDocument, STEPS, item),
      recap: RECAP,
      ...read,
    });

    for (const [group, present, absent, refused] of cases) {
      test(`${group}: auto opens on ${present} with a report, ${absent} without, ${refused} when it is refused`, () => {
        const item = makeItem({ group, ...(group === "failure" ? { status: "FAIL" } : {}) });
        expect(currentSheetTab(item, detailWith(item, { report: REPORT }), "auto")).toBe(present);
        expect(currentSheetTab(item, detailWith(item, { report: null }), "auto")).toBe(absent);
        const error = { report: null, reportError: "report.json ignored: version is not 1" };
        expect(currentSheetTab(item, detailWith(item, error), "auto")).toBe(refused);
      });

      test(`${group}: an asked report is shown when it exists, and falls back to the default otherwise`, () => {
        const item = makeItem({ group, ...(group === "failure" ? { status: "FAIL" } : {}) });
        expect(currentSheetTab(item, detailWith(item, { report: REPORT }), "report")).toBe("report");
        expect(currentSheetTab(item, detailWith(item, { report: null }), "report")).toBe(absent);
        const error = { report: null, reportError: "report.json ignored: version is not 1" };
        expect(currentSheetTab(item, detailWith(item, error), "report")).toBe(refused);
      });
    }

    test("a done item with a report keeps a requested Run tab, and a missing tree falls back to the report", () => {
      const item = makeItem({ group: "done" });
      expect(currentSheetTab(item, detailWith(item, { report: REPORT }), "run")).toBe("run");
      const noTree = { ...detailOf(null, STEPS, item), report: REPORT };
      expect(currentSheetTab(item, noTree, "files")).toBe("report");
    });

    test("an unused launch does not change the default", () => {
      const item = makeItem({ group: "done", launch: launched });
      expect(defaultSheetTab(item, { report: REPORT })).toBe("report");
      expect(defaultSheetTab(item, { report: null })).toBe("run");
    });
  });
});

describe("report helpers", () => {
  const report: RunReport = {
    version: 1,
    runId: "run-1",
    followUps: [{ text: "Run quality-push", detail: "full mutation still to play", source: "retrospective.md" }],
    criteria: [
      { id: "AC-1", text: "grouped", met: true, proof: ["test"], captures: ["reports/a/02.png"] },
      { id: "AC-3", text: "last action", met: true, proof: ["test"], reserve: "only one upload played" },
      { id: "AC-4", text: "creation date", met: false, proof: [], reserve: "not proved" },
    ],
    captures: [
      {
        dir: "reports/a",
        files: [
          { name: "01.png", acs: ["AC-2"] },
          { name: "02.png", acs: ["AC-1"] },
        ],
      },
      {
        dir: "reports/b",
        files: [
          { name: "01.png", acs: [] },
          { name: "03.png", acs: ["AC-6"] },
        ],
      },
    ],
  };

  test("left for you lists the follow-ups, then every reserve with its criterion", () => {
    expect(leftForYou(report)).toEqual([
      { text: "Run quality-push", detail: "full mutation still to play", source: "retrospective.md" },
      { text: "Reserve on AC-3", detail: "only one upload played", criterion: "AC-3" },
      { text: "Reserve on AC-4", detail: "not proved", criterion: "AC-4" },
    ]);
    expect(leftForYou({ version: 1, runId: "run-1" })).toEqual([]);
  });

  test("captures are numbered in report order by path, so two lots' same file name stay distinct", () => {
    expect([...captureNumbers(report)]).toEqual([
      ["reports/a/01.png", "01"],
      ["reports/a/02.png", "02"],
      ["reports/b/01.png", "03"],
      ["reports/b/03.png", "04"],
    ]);
    expect(captureNumbers({ version: 1, runId: "run-1" }).size).toBe(0);
    expect(
      captureNumbers({
        version: 1,
        runId: "run-1",
        captures: [
          { dir: "shots/", files: [{ name: "a.png", acs: [] }] },
          { dir: "shots", files: [{ name: "a.png", acs: [] }] },
        ],
      }),
    ).toEqual(new Map([["shots/a.png", "01"]]));
  });

  test("a capture path joins the directory and the name", () => {
    expect(capturePath("reports/screens/", "01.png")).toBe("reports/screens/01.png");
    expect(capturePath("", "01.png")).toBe("01.png");
  });

  test("the review list copies as plain text", () => {
    const text = reviewText({
      title: "Assumptions for the PO",
      items: [{ ref: "AC-1", text: "kept" }, { text: "tie" }],
    });
    expect(text).toBe("Assumptions for the PO\n\n- AC-1: kept\n- tie");
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
  const all = { filter: null, query: "" };

  test("without a filter, every item is listed whatever its group", () => {
    expect(visibleItems(items, all).map((item) => item.key)).toEqual([
      "web/ABC-1",
      "web/ABC-2",
      "api/XYZ-9",
      "api/XYZ-8",
    ]);
  });

  test("the project chip narrows to one project", () => {
    expect(visibleItems(items, { ...all, filter: "web" }).map((item) => item.key)).toEqual(["web/ABC-1", "web/ABC-2"]);
    expect(visibleItems(items, { ...all, filter: "api" }).map((item) => item.key)).toEqual(["api/XYZ-9", "api/XYZ-8"]);
  });

  test("the search matches the ticket, the title, the pipeline, the project and the reason", () => {
    expect(visibleItems(items, { ...all, query: "abc-2" }).map((item) => item.key)).toEqual(["web/ABC-2"]);
    expect(visibleItems(items, { ...all, query: "exploded" }).map((item) => item.key)).toEqual(["web/ABC-2"]);
    expect(visibleItems(items, { ...all, query: "hotfix" }).map((item) => item.key)).toEqual(["api/XYZ-9"]);
    expect(visibleItems(items, { ...all, query: "api" }).map((item) => item.key)).toEqual(["api/XYZ-9", "api/XYZ-8"]);
    const titled = [makeItem({ key: "web/T-1", title: "Export CSV of members" })];
    expect(visibleItems(titled, { ...all, query: "csv" }).map((item) => item.key)).toEqual(["web/T-1"]);
  });

  test("the search is case-insensitive and ignores surrounding blanks", () => {
    expect(visibleItems(items, { ...all, query: "  GATE  " }).map((item) => item.key)).toEqual(["web/ABC-1"]);
  });

  test("filters cross: a project and a search that disagree keep nothing", () => {
    expect(visibleItems(items, { ...all, filter: "web", query: "xyz" })).toEqual([]);
  });
});

describe("waitingCount", () => {
  const items: Item[] = [
    makeItem({ key: "web/1", group: "decision" }),
    makeItem({ key: "web/2", group: "failure" }),
    makeItem({ key: "api/3", group: "running", project: { name: "api", cwd: "/srv/api", provider: "jira" } }),
    makeItem({ key: "api/4", group: "done", project: { name: "api", cwd: "/srv/api", provider: "jira" } }),
    makeItem({ key: "api/5", group: "decision", project: { name: "api", cwd: "/srv/api", provider: "jira" } }),
  ];

  test("waiting counts narrow to one project, or to all of them", () => {
    expect(waitingCount(items, null)).toBe(3);
    expect(waitingCount(items, "web")).toBe(2);
    expect(waitingCount(items, "api")).toBe(1);
  });
});

describe("timeline", () => {
  // Local time throughout: the night boundary is a local hour. 25 Sep 2026 is a Friday.
  const local = (day: number, hour: number, minute = 0): Date => new Date(2026, 8, day, hour, minute);
  const done = (key: string, at: Date | string, overrides: Partial<Item> = {}): Item =>
    makeItem({
      key,
      group: "done",
      status: "PASS",
      updatedAt: typeof at === "string" ? at : at.toISOString(),
      ...overrides,
    });
  const shape = (sections: TimelineSection[]): [string, string, string[]][] =>
    sections.map((section) => [section.id, section.label, section.items.map((item) => item.key)]);

  test("in the morning, runs since yesterday evening are last night", () => {
    const sections = timeline([done("web/a", local(24, 23)), done("web/b", local(25, 3))], local(25, 8));
    expect(shape(sections)).toEqual([["night-0", "Last night", ["web/b", "web/a"]]]);
    expect(sections[0]?.range).toBe("Thu 24 → Fri 25");
  });

  test("in the morning, yesterday's daytime run is yesterday", () => {
    expect(shape(timeline([done("web/a", local(24, 10))], local(25, 8)))).toEqual([
      ["night-1", "Yesterday", ["web/a"]],
    ]);
  });

  test("in the evening, the labels shift by one night", () => {
    const items = [done("web/a", local(25, 19)), done("web/b", local(25, 3)), done("web/c", local(24, 10))];
    expect(shape(timeline(items, local(25, 20)))).toEqual([
      ["night-0", "Tonight", ["web/a"]],
      ["night-1", "Last night", ["web/b"]],
      ["week", "This week", ["web/c"]],
    ]);
  });

  test("a run at exactly the start hour opens the new night", () => {
    const items = [done("web/a", local(24, 18)), done("web/b", local(24, 17, 59))];
    expect(shape(timeline(items, local(25, 8)))).toEqual([
      ["night-0", "Last night", ["web/a"]],
      ["night-1", "Yesterday", ["web/b"]],
    ]);
  });

  test("a run eight days old is earlier, and collapsed", () => {
    const [section] = timeline([done("web/a", local(17, 8))], local(25, 8));
    expect(section).toMatchObject({ id: "earlier", label: "Earlier", collapsed: true });
    const [week] = timeline([done("web/b", local(18, 10))], local(25, 8));
    expect(week).toMatchObject({ id: "week", collapsed: false, range: "Thu 17 → Fri 18" });
  });

  test("waiting and running items never land in a night", () => {
    const items = [
      done("web/a", local(25, 3)),
      makeItem({ key: "web/b", group: "running", status: "RUNNING", updatedAt: local(25, 2).toISOString() }),
      makeItem({ key: "web/c", group: "failure", status: "FAIL", updatedAt: local(25, 7).toISOString() }),
      makeItem({ key: "web/d", group: "decision", updatedAt: local(25, 1).toISOString() }),
    ];
    expect(shape(timeline(items, local(25, 8)))).toEqual([
      ["needs", "Needs you", ["web/d", "web/c"]],
      ["running", "Running", ["web/b"]],
      ["night-0", "Last night", ["web/a"]],
    ]);
  });

  test("empty sections are omitted", () => {
    expect(timeline([], local(25, 8))).toEqual([]);
  });

  test("a date that does not parse lands in earlier and never throws", () => {
    expect(shape(timeline([done("web/a", "not a date")], local(25, 8)))).toEqual([["earlier", "Earlier", ["web/a"]]]);
  });

  test("the header cost sums the rows, and one unpriced row makes it a floor", () => {
    const items = [
      done("web/a", local(25, 1), { cost: { usd: 1.5, estimated: false } }),
      done("web/b", local(25, 2), { cost: { usd: 2, estimated: false, unknown: true } }),
    ];
    expect(timeline(items, local(25, 8))[0]?.cost).toEqual({ usd: 3.5, estimated: false, unknown: true });
  });

  test("a row is tagged only for an exception", () => {
    expect(rowShowsTag(done("web/a", local(25, 1)))).toBe(false);
    expect(rowShowsTag(done("web/a", local(25, 1), { closed: { at: "x", by: "olivier" }, status: "FAIL" }))).toBe(true);
    expect(rowShowsTag(makeItem({ status: "STOPPED" }))).toBe(true);
    expect(rowShowsTag(done("web/a", local(25, 1), { launch: makeLaunch({ alive: true }) }))).toBe(true);
  });

  test("the row time follows its section", () => {
    const now = local(25, 8);
    const item = done("web/a", local(23, 3, 55));
    expect(rowTime(item, "night-0", now)).toBe("03:55");
    expect(rowTime(item, "week", now)).toBe("Wed 03:55");
    expect(rowTime(item, "earlier", now)).toBe("23 Sep");
    expect(rowTime(item, "needs", now)).toBe("2d ago");
    expect(rowTime(done("web/b", "nope"), "night-1", now)).toBe("—");
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

describe("newlyWaiting", () => {
  const stopped = makeItem({ key: "web/ABC-1" });
  const failed = makeItem({ key: "web/ABC-2", ticket: "ABC-2", status: "FAIL", group: "failure" });
  const done = makeItem({ key: "web/ABC-3", ticket: "ABC-3", status: "PASS", group: "done" });

  test("announces nothing on the first poll: what waits is already on screen", () => {
    expect(newlyWaiting(null, [stopped, failed])).toEqual([]);
  });

  test("announces an item that started waiting since the previous poll", () => {
    expect(newlyWaiting(waitingKeys([stopped, done]), [stopped, failed, done])).toEqual([failed]);
  });

  test("announces again an item that left the queue and came back", () => {
    const rerunning = { ...stopped, status: "RUNNING" as const, group: "running" as const };
    const previous = waitingKeys([rerunning]);
    expect(newlyWaiting(previous, [stopped])).toEqual([stopped]);
  });

  test("never announces a completed run", () => {
    expect(newlyWaiting(new Set(), [done])).toEqual([]);
  });
});

describe("freshness", () => {
  const now = Date.parse("2026-01-10T10:00:00.000Z");

  test("a failed read is lost, whatever its age", () => {
    expect(freshnessOf(now, "fetch failed", now)).toBe("lost");
  });

  test("a screen whose reads stopped landing is stale", () => {
    expect(freshnessOf(now - STALE_AFTER_MS - 1, null, now)).toBe("stale");
    expect(freshnessOf(now - 20_000, null, now)).toBe("ok");
  });

  test("the label says how old the screen is", () => {
    expect(updatedLabel(null, now)).toBe("Not updated yet");
    expect(updatedLabel(now - 5_000, now)).toBe("Updated just now");
    expect(updatedLabel(now - 4 * 60_000, now)).toBe("Updated 4m ago");
  });
});

describe("timelineLanes", () => {
  const T0 = "2026-09-25T14:00:00.000Z";
  const at = (minutes: number): string => new Date(Date.parse(T0) + minutes * 60_000).toISOString();
  const recapOf = (steps: RunRecapStep[], overrides: Partial<RunRecap> = {}): RunRecap => ({
    pipeline: "feature",
    runId: "run-1",
    status: "PASS",
    startedAt: T0,
    endedAt: at(100),
    activeMs: 30 * 60_000,
    models: [],
    steps,
    ...overrides,
  });
  const viewOf = (steps: RunStepView[]): RunStepsView => ({ ...STEPS, status: "PASS", steps });

  test("a bar is placed in % of the run span", () => {
    const recap = recapOf([{ id: "implement", status: "done", durationMs: 20 * 60_000, costUsd: 7, model: "opus" }]);
    const steps = viewOf([{ id: "implement", status: "done", startedAt: at(10), finishedAt: at(85) }]);
    const [lane] = timelineLanes(steps, recap).lanes;
    expect(lane?.bar).toEqual({ left: 10, width: 75 });
    expect(lane?.wallMs).toBe(75 * 60_000);
    expect(lane?.agent).toBe(true);
  });

  test("a command step is not drawn as an agent step", () => {
    const recap = recapOf([{ id: "db-reset", status: "done", durationMs: 5 * 60_000 }]);
    const steps = viewOf([{ id: "db-reset", status: "done", startedAt: at(0), finishedAt: at(5) }]);
    const [lane] = timelineLanes(steps, recap).lanes;
    expect(lane?.agent).toBe(false);
  });

  test("short steps merge into one lane of ticks, skipped steps are listed apart", () => {
    const recap = recapOf([
      { id: "gate", status: "done", durationMs: 2 },
      { id: "guard", status: "done", durationMs: 40 },
      { id: "plan-revise", status: "skipped" },
      { id: "plan", status: "done", durationMs: 120_000, costUsd: 1 },
    ]);
    const steps = viewOf([
      { id: "gate", status: "done", startedAt: at(0), finishedAt: at(0) },
      { id: "guard", status: "done", startedAt: at(50), finishedAt: at(50) },
      { id: "plan", status: "done", startedAt: at(50), finishedAt: at(52) },
    ]);
    const result = timelineLanes(steps, recap);
    expect(result.lanes.map((lane) => lane.step.id)).toEqual(["plan"]);
    expect(result.short).toEqual({ count: 2, ticks: [0, 50] });
    expect(result.skipped).toEqual(["plan-revise"]);
  });

  test("a step without timestamps keeps its lane but has no bar", () => {
    const recap = recapOf([{ id: "plan", status: "done", durationMs: 120_000, costUsd: 1 }]);
    const [lane] = timelineLanes(viewOf([{ id: "plan", status: "done", startedAt: at(1) }]), recap).lanes;
    expect(lane?.bar).toBeUndefined();
    expect(lane?.wallMs).toBeUndefined();
    expect(timelineLanes(null, recap).lanes[0]?.bar).toBeUndefined();
  });

  test("a zero-length or unknown span places nothing and never divides by zero", () => {
    const steps = viewOf([{ id: "plan", status: "done", startedAt: T0, finishedAt: T0 }]);
    const recap = recapOf([{ id: "plan", status: "done", durationMs: 120_000, costUsd: 1 }], { endedAt: T0 });
    const result = timelineLanes(steps, recap);
    expect(result.spanMs).toBe(0);
    expect(result.startMs).toBeUndefined();
    expect(result.lanes[0]?.bar).toBeUndefined();
    expect(result.totals.wallMs).toBeUndefined();
    const unknown = timelineLanes(null, recapOf([], { startedAt: undefined, endedAt: undefined }));
    expect(unknown.spanMs).toBe(0);
  });

  test("the steps' own timestamps stand in for a span the snapshot lacks", () => {
    const recap = recapOf([{ id: "plan", status: "done", durationMs: 120_000, costUsd: 1 }], {
      startedAt: undefined,
      endedAt: undefined,
    });
    const steps = viewOf([{ id: "plan", status: "done", startedAt: at(0), finishedAt: at(10) }]);
    expect(timelineLanes(steps, recap).lanes[0]?.bar).toEqual({ left: 0, width: 100 });
  });

  test("a very short notable step still gets a visible bar, kept inside the track", () => {
    const recap = recapOf([{ id: "push", status: "done", durationMs: 1500 }]);
    const steps = viewOf([{ id: "push", status: "done", startedAt: at(100), finishedAt: at(100) }]);
    const bar = timelineLanes(steps, recap).lanes[0]?.bar;
    expect(bar?.width).toBeGreaterThan(0);
    expect((bar?.left ?? 0) + (bar?.width ?? 0)).toBeLessThanOrEqual(100);
  });

  test("a step still running gets a lane that ends at the span's end", () => {
    const recap = recapOf([{ id: "implement", status: "running" }], { status: "RUNNING" });
    const steps = viewOf([{ id: "implement", status: "running", startedAt: at(50) }]);
    expect(timelineLanes(steps, recap).lanes[0]?.bar).toEqual({ left: 50, width: 50 });
  });

  test("the total is the run span", () => {
    expect(timelineLanes(null, recapOf([])).totals).toEqual({ wallMs: 100 * 60_000 });
  });
});

describe("costByModel", () => {
  test("adds a step's own model and a composed node's split, costliest first", () => {
    const recap: RunRecap = {
      pipeline: "feature",
      runId: "run-1",
      status: "PASS",
      models: [],
      steps: [
        { id: "triage", status: "done", model: "opus", costUsd: 1 },
        {
          id: "implement-lots",
          status: "done",
          costUsd: 8,
          models: [
            { model: "opus", costUsd: 7.5 },
            { model: "haiku", costUsd: 0.5 },
          ],
        },
        { id: "mystery", status: "done", costUsd: 0.2 },
        { id: "db-reset", status: "done", durationMs: 30_000 },
      ],
    };
    expect(costByModel(recap)).toEqual([
      { model: "opus", costUsd: 8.5 },
      { model: "haiku", costUsd: 0.5 },
      { model: "unknown", costUsd: 0.2 },
    ]);
  });

  test("a model no step priced keeps an absent cost", () => {
    const recap: RunRecap = {
      pipeline: "feature",
      runId: "run-1",
      status: "PASS",
      models: [],
      steps: [{ id: "triage", status: "done", model: "local" }],
    };
    expect(costByModel(recap)).toEqual([{ model: "local" }]);
  });
});

describe("deliveryActions", () => {
  const done = (overrides: Partial<Item> = {}): Item => makeItem({ status: "PASS", group: "done", ...overrides });
  const report = (overrides: Partial<RunReport> = {}): RunReport => ({
    version: 1,
    runId: "run-1",
    links: [
      { label: "Pipeline", url: "https://ci.example/1" },
      { label: "Open merge request !424", url: "https://git.example/mr/424", primary: true },
    ],
    delivered: [
      { label: "Lots", value: "3" },
      { label: "Branch", value: "feat/abc-1", copy: true },
    ],
    ...overrides,
  });

  test("offers the primary link and the copyable entry of a delivered run", () => {
    expect(deliveryActions(done(), report())).toEqual({
      link: { label: "Open merge request !424", url: "https://git.example/mr/424" },
      copy: { label: "Copy branch", value: "feat/abc-1" },
    });
  });

  test("has none without a report, as today", () => {
    expect(deliveryActions(done(), null)).toBeNull();
    expect(deliveryActions(done(), undefined)).toBeNull();
  });

  test("has none for a run that did not deliver", () => {
    expect(deliveryActions(makeItem(), report())).toBeNull();
    expect(deliveryActions(done({ status: "FAIL" }), report())).toBeNull();
    expect(deliveryActions(done({ closed: { by: "ana", at: "2026-01-10T11:00:00.000Z" } }), report())).toBeNull();
    const relaunched = done({ launch: { alive: true } as Launch });
    expect(isDelivered(relaunched)).toBe(false);
    expect(deliveryActions(relaunched, report())).toBeNull();
  });

  test("keeps the copy button when no link is primary or linkable", () => {
    expect(
      deliveryActions(done(), report({ links: [{ label: "MR", url: "javascript:alert(1)", primary: true }] })),
    ).toEqual({
      copy: { label: "Copy branch", value: "feat/abc-1" },
    });
  });

  test("has none when the report offers neither", () => {
    expect(deliveryActions(done(), report({ links: [], delivered: [{ label: "Lots", value: "3" }] }))).toBeNull();
  });
});
