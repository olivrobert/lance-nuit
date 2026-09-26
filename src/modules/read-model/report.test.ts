import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { parseRunReport, readReport } from "./report.ts";
import { TEXT_LIMIT_BYTES } from "./explorer.ts";
import {
  cleanupTempDirs,
  makeProject,
  makeTempDir,
  writeArtifact,
  writeProjectsFile,
  writeRun,
} from "./test-harness.ts";

const originalHome = process.env.PIPELINE_HOME;

afterEach(() => {
  if (originalHome === undefined) delete process.env.PIPELINE_HOME;
  else process.env.PIPELINE_HOME = originalHome;
  cleanupTempDirs();
});

function listedProject(name = "demo-app"): string {
  const kit = makeTempDir("read-model-home-");
  process.env.PIPELINE_HOME = kit;
  const project = makeProject(name);
  writeProjectsFile(kit, [project]);
  return project;
}

function passedRun(project: string, runId = "r-2", extra: Record<string, unknown> = {}): void {
  writeRun(project, "DEMO-1", "feature", {
    runId,
    status: "PASS",
    updatedAt: "2026-09-25T15:36:00.000Z",
    ...extra,
  });
}

const VALID = {
  version: 1,
  runId: "r-2",
  links: [{ label: "Open merge request !424", url: "https://git.example.com/mr/424", primary: true }],
  delivered: [{ label: "Branch", value: "feature/DEMO-1", copy: true }],
  criteria: [
    {
      id: "AC1",
      text: "Export a CSV",
      met: true,
      proof: ["test", "screen"],
      captures: ["reports/screens/01-export.png"],
    },
    { id: "AC2", text: "Filter by date", met: true, proof: ["code"], reserve: "Time zones not covered" },
  ],
  followUps: [{ text: "Ask QA to check the export", source: "retrospective" }],
  forReview: { title: "Assumptions", items: [{ ref: "H1", text: "Dates are UTC" }] },
  captures: [{ dir: "reports/screens", files: [{ name: "01-export.png", acs: ["AC1"], caption: "Export" }] }],
  notes: [{ title: "Retrospective", path: "reports/retrospective.md" }],
};

test("parseRunReport: a valid report comes back whole, without warnings", () => {
  expect(parseRunReport(VALID, "r-2")).toEqual({ report: VALID as never });
});

test("parseRunReport: a report of another run is ignored without an error", () => {
  expect(parseRunReport(VALID, "r-3")).toEqual({ report: null });
});

test("parseRunReport: a wrong header rejects the whole file with one reason", () => {
  expect(parseRunReport([], "r-2")).toEqual({ report: null, reportError: "report.json ignored: not a JSON object" });
  expect(parseRunReport({ ...VALID, version: 2 }, "r-2").reportError).toBe("report.json ignored: version is not 1");
  expect(parseRunReport({ version: 1 }, "r-2").reportError).toBe("report.json ignored: runId is not a string");
});

test("parseRunReport: one bad criterion is dropped, named, and the rest kept", () => {
  const criteria = [VALID.criteria[0], { id: "AC2", text: "Filter", met: "yes", proof: [] }, VALID.criteria[1]];
  const read = parseRunReport({ ...VALID, criteria }, "r-2");

  expect(read.report?.criteria?.map((criterion) => criterion.id)).toEqual(["AC1", "AC2"]);
  expect(read.report?.criteria?.[1]?.reserve).toBe("Time zones not covered");
  expect(read.reportWarnings).toEqual(["criteria[1].met is not a boolean"]);
  expect(read.reportError).toBeUndefined();
});

test("parseRunReport: an unknown proof value is dropped, the criterion stays", () => {
  const criteria = [{ id: "AC1", text: "Export", met: true, proof: ["test", "vibes"] }];
  const read = parseRunReport({ ...VALID, criteria }, "r-2");

  expect(read.report?.criteria?.[0]?.proof).toEqual(["test"]);
  expect(read.reportWarnings).toEqual(["criteria[0].proof[1] is not one of test, code, screen"]);
});

test("parseRunReport: a javascript: link is dropped, an https link kept", () => {
  const links = [{ label: "Click", url: "javascript:alert(1)" }, VALID.links[0]];
  const read = parseRunReport({ ...VALID, links }, "r-2");

  expect(read.report?.links).toEqual(VALID.links);
  expect(read.reportWarnings).toEqual(["links[0].url is not an http(s) URL"]);
});

test("parseRunReport: a capture dir or note path escaping the work item is dropped", () => {
  const captures = [{ dir: "../../etc", files: [{ name: "passwd", acs: [] }] }, VALID.captures[0]];
  const notes = [{ title: "Secrets", path: "/etc/shadow" }, ...VALID.notes];
  const read = parseRunReport({ ...VALID, captures, notes }, "r-2");

  expect(read.report?.captures).toEqual(VALID.captures);
  expect(read.report?.notes).toEqual(VALID.notes);
  expect(read.reportWarnings).toEqual(["captures[0].dir escapes the work item", "notes[0].path escapes the work item"]);
});

test("parseRunReport: nested entries are named by their full path", () => {
  const captures = [{ dir: "reports/screens", files: [{ name: "a.png", acs: "AC1" }] }];
  const forReview = { title: "Assumptions", items: [{ text: 3 }, { text: "Dates are UTC" }] };
  const read = parseRunReport({ ...VALID, captures, forReview }, "r-2");

  expect(read.report?.captures).toEqual([{ dir: "reports/screens", files: [] }]);
  expect(read.report?.forReview).toEqual({ title: "Assumptions", items: [{ text: "Dates are UTC" }] });
  expect(read.reportWarnings).toEqual([
    "forReview.items[0].text is not a non-empty string",
    "captures[0].files[0].acs is not a list of strings",
  ]);
});

test("parseRunReport: a field that is not a list is dropped, the others kept", () => {
  const read = parseRunReport({ ...VALID, followUps: "call QA" }, "r-2");

  expect(read.report?.followUps).toBeUndefined();
  expect(read.report?.criteria).toHaveLength(2);
  expect(read.reportWarnings).toEqual(["followUps is not a list"]);
});

test("readReport: a valid file of the current run is read", () => {
  const project = listedProject();
  passedRun(project);
  writeArtifact(project, "DEMO-1", "report.json", JSON.stringify(VALID));

  expect(readReport("demo-app", "DEMO-1")).toEqual({ report: VALID as never });
});

test("readReport: no file means no report and no error", () => {
  const project = listedProject();
  passedRun(project);

  expect(readReport("demo-app", "DEMO-1")).toEqual({ report: null });
});

test("readReport: last run's report is hidden after a rerun", () => {
  const project = listedProject();
  passedRun(project, "r-3", { status: "FAIL" });
  writeArtifact(project, "DEMO-1", "report.json", JSON.stringify(VALID));

  expect(readReport("demo-app", "DEMO-1")).toEqual({ report: null });
});

test("readReport: invalid JSON yields one line of error", () => {
  const project = listedProject();
  passedRun(project);
  writeArtifact(project, "DEMO-1", "report.json", '{"version": 1, "runId": ');

  expect(readReport("demo-app", "DEMO-1")).toEqual({
    report: null,
    reportError: "report.json ignored: not valid JSON",
  });
});

test("readReport: a file past the text cap is not read", () => {
  const project = listedProject();
  passedRun(project);
  writeArtifact(project, "DEMO-1", "report.json", " ".repeat(TEXT_LIMIT_BYTES + 1));

  expect(readReport("demo-app", "DEMO-1")?.reportError).toBe(
    `report.json ignored: larger than ${TEXT_LIMIT_BYTES} bytes`,
  );
});

test("readReport: a worktree run reads the worktree copy", () => {
  const project = listedProject();
  const worktree = join(makeTempDir("read-model-worktree-"), "demo-app");
  passedRun(project, "r-2", { worktree: true, cwd: worktree });
  writeArtifact(project, "DEMO-1", "report.json", JSON.stringify({ ...VALID, notes: [] }));
  writeArtifact(worktree, "DEMO-1", "report.json", JSON.stringify(VALID));

  expect(readReport("demo-app", "DEMO-1")?.report?.notes).toEqual(VALID.notes);
});

test("readReport: an unknown project or work item has no read", () => {
  const project = listedProject();
  passedRun(project);

  expect(readReport("demo-app", "DEMO-404")).toBeUndefined();
  expect(readReport("unknown", "DEMO-1")).toBeUndefined();
});
