// Filesystem contract of the scan record: one file per scan, rewritten in place
// at every transition, and a read that survives a file it cannot use.

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScanRecord } from "../../model/scan-record.js";
import { FileScanStore, scanRecordFileName, scansDir } from "./file-scan-store.js";

function projRoot(): string {
  return mkdtempSync(join(tmpdir(), "scan-store-"));
}

function record(overrides: Partial<ScanRecord> = {}): ScanRecord {
  return {
    version: 1,
    pipeline: "bugfix",
    provider: "fake",
    project: "PROJ",
    queue: "bugTodo",
    startedAt: "2026-09-07T10:11:12.345Z",
    finishedAt: null,
    limit: null,
    discovered: null,
    tickets: {},
    abort: null,
    ...overrides,
  };
}

test("write: one file under pipeline-history/scans, named by start instant and pipeline", () => {
  const root = projRoot();
  new FileScanStore({ projRoot: root }).write(record());

  const names = readdirSync(scansDir(root));
  expect(names).toHaveLength(1);
  expect(names[0]).toStartWith("20260907T101112345Z-bugfix-");
  expect(names[0]).toEndWith(".json");
  expect(join(scansDir(root), names[0] as string)).toContain(join(".lance-nuit", "pipeline-history", "scans"));
});

test("write: every transition rewrites the same file, and the last one wins", () => {
  const root = projRoot();
  const store = new FileScanStore({ projRoot: root });
  store.write(record());
  store.write(record({ discovered: ["PROJ-1"], tickets: { "PROJ-1": { state: "pending" } } }));
  store.write(record({ discovered: ["PROJ-1"], tickets: { "PROJ-1": { state: "running", startedAt: "t" } } }));

  // A trail of partial records would make "which one is the scan?" unanswerable.
  expect(readdirSync(scansDir(root))).toHaveLength(1);
  const { records, skipped } = store.readAll();
  expect(skipped).toBe(0);
  expect(records).toHaveLength(1);
  expect(records[0]?.tickets["PROJ-1"]).toEqual({ state: "running", startedAt: "t" });
});

test("write: no temporary file is left behind", () => {
  const root = projRoot();
  new FileScanStore({ projRoot: root }).write(record());
  expect(readdirSync(scansDir(root)).filter((name) => name.includes(".tmp"))).toEqual([]);
});

test("write: a full record round-trips through the schema", () => {
  const root = projRoot();
  const store = new FileScanStore({ projRoot: root });
  const full = record({
    finishedAt: "2026-09-07T10:20:00.000Z",
    limit: 2,
    discovered: ["PROJ-1", "PROJ-2", "PROJ-3"],
    tickets: {
      "PROJ-1": {
        state: "done",
        startedAt: "2026-09-07T10:12:00.000Z",
        finishedAt: "2026-09-07T10:15:00.000Z",
        outcome: "escalated",
        runId: "run-1",
      },
      "PROJ-2": { state: "running", startedAt: "2026-09-07T10:15:00.000Z" },
      "PROJ-3": { state: "deferred" },
    },
    abort: { phase: "between-tickets", reason: "git checkout main failed" },
  });
  store.write(full);
  expect(store.readAll().records[0]).toEqual(full);
});

test("readAll: newest scan first", () => {
  const root = projRoot();
  const store = new FileScanStore({ projRoot: root });
  // Two stores so each scan gets its own short id, as two real scans would.
  new FileScanStore({ projRoot: root }).write(record({ startedAt: "2026-09-07T08:00:00.000Z", pipeline: "early" }));
  new FileScanStore({ projRoot: root }).write(record({ startedAt: "2026-09-07T09:00:00.000Z", pipeline: "late" }));

  expect(store.readAll().records.map((entry) => entry.pipeline)).toEqual(["late", "early"]);
});

test("readAll: an unusable file is counted, never fatal", () => {
  const root = projRoot();
  const store = new FileScanStore({ projRoot: root });
  store.write(record());
  const dir = scansDir(root);
  writeFileSync(join(dir, "20260907T110000000Z-truncated-aaaaaaaa.json"), '{"version":1,"pipel');
  writeFileSync(join(dir, "20260907T120000000Z-offschema-bbbbbbbb.json"), '{"version":9,"pipeline":"x"}');

  const { records, skipped } = store.readAll();
  // One truncated write must not hide every other scan.
  expect(records.map((entry) => entry.pipeline)).toEqual(["bugfix"]);
  expect(skipped).toBe(2);
});

test("readAll: files that are not .json are ignored, not counted as skipped", () => {
  const root = projRoot();
  const store = new FileScanStore({ projRoot: root });
  store.write(record());
  writeFileSync(join(scansDir(root), "README.md"), "not a record");

  expect(store.readAll()).toMatchObject({ skipped: 0 });
});

test("readAll: a project that never scanned reads as empty, not as an error", () => {
  const root = projRoot();
  expect(new FileScanStore({ projRoot: root }).readAll()).toEqual({ records: [], skipped: 0 });
});

test("readAll: an unreadable file is skipped", () => {
  const root = projRoot();
  const store = new FileScanStore({ projRoot: root });
  store.write(record());
  // A directory with a record's name: readFileSync fails with EISDIR.
  mkdirSync(join(scansDir(root), "20260907T130000000Z-dir-cccccccc.json"));

  expect(store.readAll()).toMatchObject({ skipped: 1 });
});

test("file name: sortable, and unique across scans starting in the same millisecond", () => {
  const same = record();
  expect(scanRecordFileName(same, "aaaaaaaa")).toBe("20260907T101112345Z-bugfix-aaaaaaaa.json");
  expect(scanRecordFileName(same, "bbbbbbbb")).not.toBe(scanRecordFileName(same, "aaaaaaaa"));
});

test("file name: a pipeline name or start instant with separators stays one safe segment", () => {
  const name = scanRecordFileName(record({ pipeline: "release/eu prod", startedAt: "not an instant" }), "aaaaaaaa");
  expect(name).toBe("not-an-instant-release-eu-prod-aaaaaaaa.json");
});

test("write: the record is stored as readable JSON", () => {
  const root = projRoot();
  new FileScanStore({ projRoot: root }).write(record());
  const [name] = readdirSync(scansDir(root));
  const raw = readFileSync(join(scansDir(root), name as string), "utf-8");
  expect(raw).toEndWith("\n");
  expect(JSON.parse(raw)).toMatchObject({ version: 1, pipeline: "bugfix" });
});
