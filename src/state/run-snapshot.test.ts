import { expect, test } from "bun:test";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasRunSnapshotEntry, isRunSnapshot, readRunSnapshot, readRunSnapshotDiagnostic } from "./run-snapshot.js";

test("run snapshot: validates the contract", () => {
  const valid = { schemaVersion: 1, runId: "run-1", name: "feature", pipeline: "feature", steps: [] };
  expect(isRunSnapshot(valid)).toBe(true);
  expect(isRunSnapshot({ ...valid, schemaVersion: 2 })).toBe(false);
  expect(isRunSnapshot({ ...valid, runId: 12 })).toBe(false);
  expect(isRunSnapshot({ ...valid, name: undefined })).toBe(false);
  expect(isRunSnapshot({ ...valid, pipeline: undefined })).toBe(false);
  expect(isRunSnapshot({ ...valid, steps: undefined })).toBe(false);
  expect(isRunSnapshot({ ...valid, status: "BROKEN" })).toBe(false);
});

test("run snapshot: rejects malformed step state without throwing", () => {
  const run = { schemaVersion: 1, runId: "run-1", name: "feature", pipeline: "feature" };
  expect(isRunSnapshot({ ...run, steps: [null] })).toBe(false);
  expect(isRunSnapshot({ ...run, steps: [{ id: "build", status: "pendng" }] })).toBe(false);
  expect(isRunSnapshot({ ...run, steps: [{ id: "", status: "pending" }] })).toBe(false);
  expect(isRunSnapshot({ ...run, steps: [{ id: "build", status: "pending", retries: -1 }] })).toBe(false);
  expect(isRunSnapshot({ ...run, steps: [{ id: "build", status: "pending", last_attempt: -1 }] })).toBe(false);
  expect(
    isRunSnapshot({
      ...run,
      steps: [
        { id: "build", status: "done" },
        { id: "build", status: "pending" },
      ],
    }),
  ).toBe(false);
  // Early snapshots may omit retries; hydration defaults it to zero.
  expect(isRunSnapshot({ ...run, steps: [{ id: "build", status: "pending" }] })).toBe(true);
});

test("run snapshot: validates the contract", () => {
  const dir = mkdtempSync(join(tmpdir(), "run-snapshot-"));
  const valid = join(dir, "valid.json");
  const broken = join(dir, "broken.json");
  writeFileSync(
    valid,
    JSON.stringify({ schemaVersion: 1, runId: "run-1", name: "feature", pipeline: "feature", steps: [] }),
  );
  writeFileSync(broken, "not-json");

  expect(readRunSnapshot(join(dir, "missing.json"))).toBeNull();
  expect(readRunSnapshot(broken)).toBeNull();
  expect(readRunSnapshot(valid)).toMatchObject({ schemaVersion: 1, runId: "run-1", steps: [] });
});

test("readRunSnapshot rejects structurally corrupt JSON", () => {
  const dir = mkdtempSync(join(tmpdir(), "run-snapshot-structure-"));
  const nullStep = join(dir, "null-step.json");
  const invalidStatus = join(dir, "invalid-status.json");
  const base = { schemaVersion: 1, runId: "run-1", name: "feature", pipeline: "feature" };
  writeFileSync(nullStep, JSON.stringify({ ...base, steps: [null] }));
  writeFileSync(invalidStatus, JSON.stringify({ ...base, steps: [{ id: "build", status: "pendng" }] }));

  expect(readRunSnapshot(nullStep)).toBeNull();
  expect(readRunSnapshot(invalidStatus)).toBeNull();
});

test("diagnostic reader distinguishes missing, denied, malformed, incompatible, and valid snapshots", () => {
  const dir = mkdtempSync(join(tmpdir(), "run-snapshot-diagnostic-"));
  const malformed = join(dir, "malformed.json");
  const incompatible = join(dir, "incompatible.json");
  const valid = join(dir, "valid.json");
  writeFileSync(malformed, "{");
  writeFileSync(incompatible, JSON.stringify({ schemaVersion: 2 }));
  writeFileSync(
    valid,
    JSON.stringify({ schemaVersion: 1, runId: "run-1", name: "feature", pipeline: "feature", steps: [] }),
  );

  expect(readRunSnapshotDiagnostic(join(dir, "missing.json"))).toEqual({
    kind: "absent",
    path: join(dir, "missing.json"),
  });
  expect(
    readRunSnapshotDiagnostic(join(dir, "denied.json"), {
      readFile: () => {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      },
    }),
  ).toMatchObject({ kind: "unreadable", reason: "io", diagnostic: "cannot read snapshot (EACCES)" });
  expect(readRunSnapshotDiagnostic(malformed)).toMatchObject({
    kind: "unreadable",
    reason: "json",
    diagnostic: "invalid JSON",
  });
  expect(readRunSnapshotDiagnostic(incompatible)).toMatchObject({
    kind: "incompatible",
    reason: "schema-version",
    diagnostic: "unsupported schema version",
  });
  expect(readRunSnapshotDiagnostic(valid)).toMatchObject({ kind: "valid", snapshot: { runId: "run-1" } });
});

test("a dangling snapshot symlink is an existing damaged entry", () => {
  const dir = mkdtempSync(join(tmpdir(), "run-snapshot-dangling-"));
  const path = join(dir, "state.json");
  symlinkSync("gone.json", path);

  expect(hasRunSnapshotEntry(path)).toBe(true);
  expect(readRunSnapshotDiagnostic(path)).toMatchObject({ kind: "absent" });
});
