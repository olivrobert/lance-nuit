import { expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunJournalEvent } from "../../journal.js";
import { FileRunEventStore } from "./file-run-event-store.js";

/**
 * These tests exercise byte-level windowing, not the event contract, so the
 * payloads stay deliberately outside it. Two shapes result: an uncontracted type
 * comes back `unknown` (exactly like the live-feed lines sharing this file),
 * while a contracted type with no payload comes back `invalid`. Both are kept in `entries`, which is what a windowed
 * reader follows; neither reaches `events`.
 */
function event(type: string, extra: Record<string, unknown> = {}): RunJournalEvent {
  return { ts: "2026-08-01T10:00:00.000Z", type, ...extra } as unknown as RunJournalEvent;
}

function types(page: { entries: { event: { type: string } }[] }): string[] {
  return page.entries.map((entry) => entry.event.type);
}

test("file-run-event-store: validates the integration contract", () => {
  const runDir = join(mkdtempSync(join(tmpdir(), "file-run-event-store-")), "run");
  const store = new FileRunEventStore({ runDir });

  const started = { pipeline: "quality", ticket: null };
  store.append("run-1", event("run.started", { ...started, unknownField: "kept", nested: { value: 42 } }));
  // A live-feed line, written to the same file and outside the journal contract.
  store.append("run-1", event("step.started", { stepId: "quality" }));

  // A field a later release added must survive the read unchanged.
  expect(store.read("run-1")).toEqual([
    event("run.started", { ...started, unknownField: "kept", nested: { value: 42 } }),
  ]);
  expect(store.readJournal("run-1")).toMatchObject({ skipped: 0, invalid: 0, unknown: 1 });
});

test("file-run-event-store: validates the integration contract", () => {
  const root = mkdtempSync(join(tmpdir(), "file-run-event-store-direct-"));
  const runDir = join(root, "run");
  const store = new FileRunEventStore({ runDir });

  expect(store.read("run-1")).toEqual([]);
  expect(store.readAt(runDir)).toEqual([]);

  const resumed = event("run.resumed", { pipeline: "quality", futureField: true });
  store.appendAt(runDir, resumed);
  expect(store.read("run-1")).toEqual([resumed]);

  // A truncated trailing line (crash mid-append) must not erase the valid history:
  // losing it would restart attempt numbering and overwrite previous logs on resume.
  writeFileSync(join(runDir, "events.jsonl"), `${JSON.stringify(resumed)}\n{broken\n`);
  expect(store.readAt(runDir)).toEqual([resumed]);
});

test("file-run-event-store: validates the integration contract", () => {
  const runDir = mkdtempSync(join(tmpdir(), "file-run-event-store-tail-"));
  const store = new FileRunEventStore({ runDir });

  for (let index = 0; index < 5; index += 1) store.appendAt(runDir, event("step.done", { index }));

  const tail = store.readTailAt(runDir, { maxBytes: 140 });
  expect(tail.entries.length).toBeGreaterThan(0);
  expect(tail.entries.length).toBeLessThan(5);
  expect(tail.entries.at(-1)?.event).toEqual(event("step.done", { index: 4 }));
  expect(tail.nextOffset).toBe(tail.size);
  expect(store.readTailAt(runDir).entries.length).toBe(5);
});

test("file-run-event-store: validates the integration contract", () => {
  const runDir = mkdtempSync(join(tmpdir(), "file-run-event-store-corrupt-"));
  const store = new FileRunEventStore({ runDir });

  store.appendAt(runDir, event("valid"));
  appendFileSync(join(runDir, "events.jsonl"), "{broken\n");
  store.appendAt(runDir, event("after"));

  const page = store.readTailAt(runDir);
  expect(types(page)).toEqual(["valid", "after"]);
  expect(page.skipped).toBe(1);
  expect(page.unknown).toBe(2);
  // The malformed line is skipped and the rest survives; neither payload is a
  // contracted event, so a typed reader sees nothing here.
  expect(store.readAt(runDir)).toEqual([]);
  expect(store.readJournalAt(runDir)).toEqual({ entries: page.entries, skipped: 1, invalid: 0, unknown: 2 });
});

test("file-run-event-store: validates the integration contract", () => {
  const runDir = join(mkdtempSync(join(tmpdir(), "file-run-event-store-missing-")), "run");
  const store = new FileRunEventStore({ runDir });

  expect(store.readTailAt(runDir)).toEqual({
    events: [],
    entries: [],
    nextOffset: 0,
    size: 0,
    eof: true,
    skipped: 0,
    invalid: 0,
    unknown: 0,
  });
});

test("file-run-event-store: validates the integration contract", () => {
  const root = mkdtempSync(join(tmpdir(), "file-run-event-store-best-effort-"));
  const blocker = join(root, "not-a-directory");
  writeFileSync(blocker, "file");
  const store = new FileRunEventStore({ runDir: join(blocker, "run") });

  expect(() => store.append("run-1", event("filesystem.failure"))).not.toThrow();
  expect(() => store.appendAt(root, event("json.failure", { unsupported: 1n }))).not.toThrow();
  expect(existsSync(join(root, "events.jsonl"))).toBe(false);

  const explicit = join(root, "explicit");
  mkdirSync(explicit);
  expect(store.readAt(explicit)).toEqual([]);
});

test("file-run-event-store: an absent journal is empty, an unreadable one throws", () => {
  const runDir = mkdtempSync(join(tmpdir(), "file-run-event-store-unreadable-"));
  const store = new FileRunEventStore({ runDir });

  expect(store.readAt(runDir)).toEqual([]);
  expect(store.readJournalAt(runDir)).toEqual({ entries: [], skipped: 0, invalid: 0, unknown: 0 });

  // A directory where the file should be: EISDIR, not ENOENT. The journal owns
  // the attempts, so this must not read as a run that has not written yet.
  mkdirSync(join(runDir, "events.jsonl"));
  expect(() => store.readAt(runDir)).toThrow(/EISDIR/);
  expect(() => store.readJournalAt(runDir)).toThrow(/EISDIR/);
  expect(() => store.read("run-1")).toThrow(/EISDIR/);
});
