import { expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunJournalEvent } from "../../model/journal.js";
import { FileRunEventStore } from "./file-run-event-store.js";

/**
 * These tests exercise byte-level windowing, not the event contract, so the
 * payloads stay deliberately outside it. Two shapes result, and the tests below
 * distinguish them: an uncontracted type comes back `unknown` (exactly like the
 * live-feed lines sharing this file), while a contracted type with no payload
 * comes back `invalid`. Both are kept in `entries`, which is what a windowed
 * reader follows; neither reaches `events`.
 */
function event(type: string, extra: Record<string, unknown> = {}): RunJournalEvent {
  return { ts: "2026-08-01T10:00:00.000Z", type, ...extra } as unknown as RunJournalEvent;
}

function types(page: { entries: { event: { type: string } }[] }): string[] {
  return page.entries.map((entry) => entry.event.type);
}

function kinds(page: { entries: { kind: string }[] }): string[] {
  return page.entries.map((entry) => entry.kind);
}

test("file-run-event-store: validates the integration contract", () => {
  const root = mkdtempSync(join(tmpdir(), "file-run-event-store-"));
  const firstDir = join(root, "first");
  const secondDir = join(root, "second");
  const store = new FileRunEventStore({
    runDirs: new Map([
      ["run-1", firstDir],
      ["run-2", secondDir],
    ]),
  });

  const started = { pipeline: "quality", ticket: null };
  store.append("run-1", event("run.started", { ...started, unknownField: "kept", nested: { value: 42 } }));
  // A live-feed line, written to the same file and outside the journal contract.
  store.append("run-1", event("step.started", { stepId: "quality" }));
  store.append("run-2", event("run.started", started));

  // A field a later release added must survive the read unchanged.
  expect(store.read("run-1")).toEqual([
    event("run.started", { ...started, unknownField: "kept", nested: { value: 42 } }),
  ]);
  expect(store.readJournal("run-1")).toMatchObject({ skipped: 0, invalid: 0, unknown: 1 });
  expect(store.read("run-2").map((item) => item.type)).toEqual(["run.started"]);
  expect(store.read("unknown")).toEqual([]);
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

test("readFrom paginates by offset without partial lines: validates the contract", () => {
  const runDir = mkdtempSync(join(tmpdir(), "file-run-event-store-offset-"));
  const store = new FileRunEventStore({ runDir });

  store.appendAt(runDir, event("run.started"));
  store.appendAt(runDir, event("step.started", { stepId: "plan" }));

  const first = store.readFromAt(runDir, 0);
  expect(types(first)).toEqual(["run.started", "step.started"]);
  // A contracted type with no payload is `invalid`; an uncontracted one is
  // `unknown`. Both stay in the window a follower reads.
  expect(kinds(first)).toEqual(["invalid", "unknown"]);
  expect({ invalid: first.invalid, unknown: first.unknown }).toEqual({ invalid: 1, unknown: 1 });
  expect(first.events).toEqual([]);
  expect(first.eof).toBe(true);
  expect(first.nextOffset).toBe(first.size);

  // Nothing new: the cursor remains stable and no duplicate is returned.
  expect(store.readFromAt(runDir, first.nextOffset).entries).toEqual([]);

  store.appendAt(runDir, event("run.finished", { status: "PASS" }));
  const second = store.readFromAt(runDir, first.nextOffset);
  expect(types(second)).toEqual(["run.finished"]);
  expect(kinds(second)).toEqual(["known"]);

  // Line currently being written: ignored, and its offset is not consumed.
  appendFileSync(join(runDir, "events.jsonl"), '{"ts":"2026-08-01T10:00:00.000Z","type":"partial"');
  const third = store.readFromAt(runDir, second.nextOffset);
  expect(third.entries).toEqual([]);
  expect(third.nextOffset).toBe(second.nextOffset);
});

test("file-run-event-store: validates the integration contract", () => {
  const runDir = mkdtempSync(join(tmpdir(), "file-run-event-store-window-"));
  const store = new FileRunEventStore({ runDir });

  store.appendAt(runDir, event("first"));
  store.appendAt(runDir, event("second"));

  const page = store.readFromAt(runDir, 0, { maxBytes: 60 });
  expect(types(page)).toEqual(["first"]);
  expect(page.eof).toBe(false);
  expect(types(store.readFromAt(runDir, page.nextOffset))).toEqual(["second"]);

  // Window too small for even one line: no progress and no loss.
  const stuck = store.readFromAt(runDir, 0, { maxBytes: 4 });
  expect(stuck.entries).toEqual([]);
  expect(stuck.nextOffset).toBe(0);
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

  const page = store.readFromAt(runDir, 0);
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

  expect(store.readFromAt(runDir, 12)).toEqual({
    events: [],
    entries: [],
    nextOffset: 12,
    size: 0,
    eof: true,
    skipped: 0,
    invalid: 0,
    unknown: 0,
  });
  expect(store.readTailAt(runDir).entries).toEqual([]);
  expect(store.sizeAt(runDir)).toBe(0);
  expect(store.readFrom("unknown-run", 0).entries).toEqual([]);
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
