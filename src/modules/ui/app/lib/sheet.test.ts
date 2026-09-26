import { describe, expect, test } from "bun:test";
import type { Item, ItemDetail, Launch, RunRecap, RunReport, SheetTab, WorkItemTree } from "../api/types.js";
import { isDelivered } from "./items.js";
import { currentSheetTab, defaultSheetTab, deliveryActions } from "./sheet.js";
import { makeItem, makeLaunch, TREE, STEPS, detailOf } from "./testing.js";

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
