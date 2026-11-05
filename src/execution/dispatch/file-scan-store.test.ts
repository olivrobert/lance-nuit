// Filesystem contract of the scan record: one file per scan, rewritten in place
// at every transition.

import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScanRecord } from "../../run/scan-record.js";
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
  const names = readdirSync(scansDir(root));
  expect(names).toHaveLength(1);
  const written = JSON.parse(readFileSync(join(scansDir(root), names[0] as string), "utf-8")) as ScanRecord;
  expect(written.tickets["PROJ-1"]).toEqual({ state: "running", startedAt: "t" });
});

test("write: no temporary file is left behind", () => {
  const root = projRoot();
  new FileScanStore({ projRoot: root }).write(record());
  expect(readdirSync(scansDir(root)).filter((name) => name.includes(".tmp"))).toEqual([]);
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
