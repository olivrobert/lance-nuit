// The invariants of `state.json` as the only execution record (spec §8, S1–S11):
// every transition saves the snapshot before its event, the journal is a trace no
// decision reads, attempts live in the snapshot, a finished run is never written.

import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinRegistries } from "../../../tests/builtin-registries.ts";
import { buildPipelineContext } from "../../definition/pipeline/context.js";
import { startLiveFeed } from "../../entry/composition/feed.js";
import { NULL_RUN_OUTPUT } from "../../execution/run-output.js";
import { loadOrCreateRun } from "../../execution/step/load-or-create-run.js";
import { executeRunSteps, stepLoopDeps } from "../../execution/step/step-loop.js";
import type { PipelineContext } from "../../shared/language/context.js";
import type { RunJournalEvent } from "../journal.js";
import type { PersistedRun } from "../persisted.js";
import type { RunView } from "../run.js";
import { openAttempt, settleAttempt } from "./attempt-lifecycle.js";
import { bindChildRunDir, declareChild, openOrchestration, recordChildStarted } from "./child-transitions.js";
import { openRunLedger, runSpend } from "./cost-accounting.js";
import { writable } from "./run.js";
import { readRunEvents, readRunJournal } from "./run-journal.js";
import { readRun } from "./run-read.js";
import { saveRun } from "./run-repository.js";
import { readRunSnapshot } from "./run-snapshot.js";
import { abortRun, finalizeRun, stopRun, updateStep } from "./run-transitions.js";
import { FileRunEventStore } from "./stores/file-run-event-store.js";
import { FileRunStateStore } from "./stores/file-run-state-store.js";
import { resolveRunDir, runsLocationOf } from "./stores/run-storage.js";

type Write = string;

class RecordingStateStore extends FileRunStateStore {
  constructor(
    context: PipelineContext,
    ticket: string,
    readonly writes: Write[],
  ) {
    super({ context, ticket, pipeline: "p" });
  }

  override saveAt(run: PersistedRun, runDir: string): void {
    this.writes.push("snapshot");
    super.saveAt(run, runDir);
  }
}

class RecordingEventStore extends FileRunEventStore {
  constructor(
    runDir: string,
    readonly writes: Write[],
    private readonly failing = false,
  ) {
    super({ runDir });
  }

  override append(runId: string, event: RunJournalEvent): void {
    if (this.failing) throw new Error("journal unavailable");
    this.writes.push(event.type);
    super.append(runId, event);
  }
}

interface Fixture {
  root: string;
  ctx: PipelineContext;
  path: string;
  dir: string;
  ticket: string;
}

function fixture(body = ""): Fixture {
  const root = mkdtempSync(join(tmpdir(), "run-state-"));
  const ticket = "T-1";
  const ctx = buildPipelineContext({ ...builtinRegistries(), cwd: root, ticket });
  const path = join(root, "p.ts");
  writeFileSync(
    path,
    body ||
      `export default ({ pipeline, actionStep }) => pipeline("p")
  .add(actionStep({ id: "a", name: "a", run: () => {}, describe: "a", rerunOnResume: true }))
  .add(actionStep({ id: "b", name: "b", run: () => {}, describe: "b", rerunOnResume: true }))
  .build();`,
  );
  return { root, ctx, path, ticket, dir: resolveRunDir("p", ticket, undefined, true, ctx) };
}

async function open(
  f: Fixture,
  writes: Write[] = [],
  options: { failingJournal?: boolean; allowUnmetered?: boolean } = {},
) {
  return loadOrCreateRun({
    pipelinePath: f.path,
    ticket: f.ticket,
    runDir: f.dir,
    fresh: false,
    context: f.ctx,
    stateStore: new RecordingStateStore(f.ctx, f.ticket, writes),
    eventStore: new RecordingEventStore(f.dir, writes, options.failingJournal),
    allowUnmetered: options.allowUnmetered,
    worktree: false,
  });
}

const snapshotOf = (dir: string) => readRunSnapshot(join(dir, "state.json"))!;

/** A run whose step `a` has a closed attempt and a fix attempt left `running`, as a
 *  runner killed mid-attempt leaves it. */
async function crashedRun(f: Fixture): Promise<RunView> {
  const { run } = await open(f);
  const step = run.steps[0]!;
  const budget = openRunLedger(run);
  updateStep(run, step, "running");
  const first = openAttempt(run, step, { kind: "step", command: "a" });
  settleAttempt(run, step, first, { ok: false, stats: { duration_ms: 5, total_cost_usd: 0.25 } }, budget);
  openAttempt(run, step, { kind: "fix", command: "repair" });
  return run;
}

test("S1: every transition saves the snapshot before it journals its event", async () => {
  const f = fixture();
  const writes: Write[] = [];
  const { run } = await open(f, writes);
  const [a, b] = run.steps as [RunView["steps"][number], RunView["steps"][number]];
  const budget = openRunLedger(run);
  writes.length = 0;

  updateStep(run, a, "running");
  const opened = openAttempt(run, a, { kind: "step", command: "a" });
  settleAttempt(run, a, opened, { ok: true, stats: { duration_ms: 1 } }, budget);
  updateStep(run, a, "done");
  stopRun(run, b, "waiting for a human");
  finalizeRun(run, { stopped: true });

  expect(writes).toEqual([
    "snapshot",
    "step.status.changed",
    "snapshot",
    "step.attempt.started",
    "snapshot",
    "step.attempt.finished",
    "snapshot",
    "step.status.changed",
    "snapshot",
    "run.stopped",
    "snapshot",
    "run.finished",
  ]);
});

test("S1: a failing journal fails no transition, and the snapshot holds every transition", async () => {
  const f = fixture();
  const { run } = await open(f, [], { failingJournal: true });
  const step = run.steps[0]!;
  updateStep(run, step, "running");
  const opened = openAttempt(run, step, { kind: "step", command: "a" });
  settleAttempt(run, step, opened, { ok: true, stats: { duration_ms: 1 } }, openRunLedger(run));
  updateStep(run, step, "done");
  finalizeRun(run);

  const snapshot = snapshotOf(f.dir);
  expect(snapshot.steps[0]).toMatchObject({ status: "done", attempts: [{ attempt: 1, status: "done" }] });
  expect(readRunEvents(f.dir)).toEqual([]);
});

test("S2/S8: without its journal, or with an unreadable one, a run reads and resumes the same", async () => {
  const f = fixture();
  await crashedRun(f);
  const reference = readRun(f.dir, runsLocationOf(f.ctx))!;

  rmSync(join(f.dir, "events.jsonl"));
  const withoutJournal = readRun(f.dir, runsLocationOf(f.ctx))!;
  expect(withoutJournal.state).toEqual(reference.state);
  expect(withoutJournal.status).toBe(reference.status);

  mkdirSync(join(f.dir, "events.jsonl"));
  const unreadable = readRun(f.dir, runsLocationOf(f.ctx))!;
  expect(unreadable.state).toEqual(reference.state);
  expect(readRunJournal(f.dir).entries).toEqual([]);

  const { run } = await open(f);
  const step = run.steps[0]!;
  expect(step.attempts.map((entry) => [entry.attempt, entry.kind, entry.status])).toEqual([
    [1, "step", "failed"],
    [2, "fix", "failed"],
  ]);
  expect(runSpend(run).usd).toBe(0.25);
  updateStep(run, step, "running");
  expect(openAttempt(run, step, { kind: "step", command: "a" }).attempt.attempt).toBe(3);
});

test("S3: an attempt is running in the snapshot before its spawn", async () => {
  const f = fixture();
  const { run } = await open(f);
  const step = run.steps[0]!;
  updateStep(run, step, "running");
  openAttempt(run, step, { kind: "step", command: "a" });

  expect(snapshotOf(f.dir).steps[0]?.attempts).toMatchObject([{ attempt: 1, kind: "step", status: "running" }]);
});

test("S3/S11: opening without a holder closes running attempts in one save, journaled after run.resumed", async () => {
  const f = fixture();
  await crashedRun(f);
  const writes: Write[] = [];
  const { run } = await open(f, writes, { allowUnmetered: true });

  expect(writes).toEqual(["snapshot", "run.resumed", "step.attempt.finished", "run.unmetered.authorized"]);
  const fix = run.steps[0]!.attempts[1]!;
  expect(fix).toMatchObject({ attempt: 2, kind: "fix", status: "failed", interrupted: true });
  expect(fix.control?.cost_unknown).toBe(true);
  expect(run.steps[0]!.control?.cost_unknown).toBe(true);
  expect(snapshotOf(f.dir).steps[0]?.attempts?.[1]).toMatchObject({ status: "failed", interrupted: true });
});

test("S4: a failed member of a parallel group leaves the run RUNNING, and Ctrl+C closes its siblings", async () => {
  const f = fixture();
  const { run } = await open(f);
  const [a, b] = run.steps as [RunView["steps"][number], RunView["steps"][number]];
  updateStep(run, a, "running");
  updateStep(run, b, "running");
  openAttempt(run, b, { kind: "step", command: "b" });
  updateStep(run, a, "failed", "boom");

  expect(run.status).toBe("RUNNING");
  expect(snapshotOf(f.dir).status).toBe("RUNNING");

  abortRun(run, "SIGINT");
  const snapshot = snapshotOf(f.dir);
  expect(snapshot.status).toBe("ABORTED");
  expect(snapshot.steps[1]).toMatchObject({ status: "aborted", attempts: [{ attempt: 1, status: "aborted" }] });
});

test("S5: attempt numbers increase strictly and are never reused, even over a hole", async () => {
  const f = fixture();
  const { run } = await open(f);
  const step = run.steps[0]!;
  writable(step).attempts.push(
    { attempt: 1, kind: "step", status: "failed", started_at: "t", log_path: "steps/a/attempt-001/output.log" },
    { attempt: 3, kind: "fix", status: "failed", started_at: "t", log_path: "steps/a/attempt-003/output.log" },
  );
  saveRun(writable(run));

  const { run: reopened } = await open(f);
  const again = reopened.steps[0]!;
  updateStep(reopened, again, "running");
  const numbers = [openAttempt(reopened, again, { kind: "step", command: "a" }).attempt.attempt];
  numbers.push(openAttempt(reopened, again, { kind: "fix", command: "r" }).attempt.attempt);
  expect(numbers).toEqual([4, 5]);
});

test("S6: a child ref with startedAt is resumed strictly, one without it is re-initialized under its runId", async () => {
  const f = fixture();
  const { run: parent } = await open(f);
  const node = parent.steps[0]!;
  const state = openOrchestration(parent, node, "runPipeline", [{ pipelinePath: f.path, ticket: f.ticket }]);
  const ref = declareChild(parent, state, { key: "c", kind: "main", pipeline: "p", ticket: "T-2" });
  const child = { pipeline: "p", ticket: "T-2", context: f.ctx };

  const first = bindChildRunDir(parent, ref, child);
  expect(first.strictSnapshot).toBeUndefined();
  const again = bindChildRunDir(parent, ref, child);
  expect(again.runDir).toBe(first.runDir);
  expect(again.strictSnapshot).toBeUndefined();

  recordChildStarted(parent, ref, node, { ...parent, runId: ref.runId } as RunView);
  expect(snapshotOf(f.dir).steps[0]?.orchestration?.children[0]?.startedAt).toBeString();
  const used = bindChildRunDir(parent, ref, child);
  expect(used.runDir).toBe(first.runDir);
  expect(used.strictSnapshot?.expectedIdentity?.runId).toBe(ref.runId);
});

test("S7/S10: a PASS run is opened read-only, never written, and refuses any save", async () => {
  const f = fixture();
  const { run } = await open(f);
  for (const step of run.steps) updateStep(run, step, "done");
  finalizeRun(run);
  const bytes = readFileSync(join(f.dir, "state.json"), "utf-8");
  const journal = readFileSync(join(f.dir, "events.jsonl"), "utf-8");

  const writes: Write[] = [];
  const reopened = await open(f, writes);
  expect(reopened.run.readOnly).toBe(true);
  expect(reopened.run.status).toBe("PASS");
  expect(writes).toEqual([]);
  expect(() => saveRun(writable(reopened.run))).toThrow(/never written again/);
  expect(() => updateStep(reopened.run, reopened.run.steps[0]!, "running")).toThrow(/never written again/);
  expect(readFileSync(join(f.dir, "state.json"), "utf-8")).toBe(bytes);
  expect(readFileSync(join(f.dir, "events.jsonl"), "utf-8")).toBe(journal);
});

test("S9: the journal holds contract events only; the run's feed is feed.jsonl", async () => {
  const f = fixture(`export default ({ pipeline, bashStep }) => pipeline("p")
  .add(bashStep({ id: "a", name: "a", command: "echo hello", rerunOnResume: true }))
  .build();`);
  const { run } = await open(f);
  const feed = startLiveFeed(run.run_dir, false);
  expect(feed.path()).toBe(join(f.dir, "feed.jsonl"));
  const outcome = await executeRunSteps(run, { resuming: false }, stepLoopDeps(NULL_RUN_OUTPUT), f.ctx);
  finalizeRun(run, outcome);

  const journal = readRunJournal(f.dir);
  expect(journal.entries.length).toBeGreaterThan(0);
  expect(journal.entries.every((entry) => entry.kind === "known")).toBe(true);
  expect(readFileSync(join(f.dir, "feed.jsonl"), "utf-8")).toContain("hello");
});

test("S9: a real backend stream reaches the feed alone; the journal reads without a skipped, unknown or invalid line", async () => {
  const f = fixture(`export default ({ pipeline, llmStep }) => pipeline("p")
  .add(llmStep({ id: "a", name: "a", backend: "claude", profile: "coder", command: "a", rerunOnResume: true }))
  .build();`);
  f.ctx = buildPipelineContext({
    ...builtinRegistries(),
    cwd: f.root,
    ticket: f.ticket,
    config: { ...f.ctx.config, profiles: { ...f.ctx.config.profiles, coder: { backends: { claude: {} } } } },
  });
  const replay = join(f.root, "replay.jsonl");
  const fake = join(f.root, "claude");
  const stream = [
    { type: "system", subtype: "init", model: "claude-sonnet-5", session_id: "s-1" },
    {
      type: "assistant",
      message: {
        id: "m1",
        model: "claude-sonnet-5",
        content: [
          { type: "text", text: "Reading the order." },
          { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/src/Order.php" } },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "<?php" }] } },
    {
      type: "assistant",
      message: {
        id: "m2",
        model: "claude-sonnet-5",
        content: [{ type: "tool_use", id: "t2", name: "StructuredOutput", input: { success: true } }],
        usage: { input_tokens: 20, output_tokens: 5 },
      },
    },
    {
      type: "result",
      subtype: "success",
      duration_ms: 3,
      total_cost_usd: 0.01,
      session_id: "s-1",
      structured_output: { success: true },
      result: '{"success":true}',
    },
  ];
  writeFileSync(replay, `${stream.map((line) => JSON.stringify(line)).join("\n")}\n`);
  writeFileSync(fake, `#!/bin/sh\ncat '${replay}'\n`);
  chmodSync(fake, 0o755);
  const previous = process.env.CLAUDE_BIN;
  process.env.CLAUDE_BIN = fake;
  try {
    const { run } = await open(f);
    startLiveFeed(run.run_dir, false);
    const outcome = await executeRunSteps(run, { resuming: false }, stepLoopDeps(NULL_RUN_OUTPUT), f.ctx);
    finalizeRun(run, outcome);
    expect(run.status).toBe("PASS");
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = previous;
  }

  const journal = readRunJournal(f.dir);
  expect(journal.entries.length).toBeGreaterThan(0);
  expect({ skipped: journal.skipped, invalid: journal.invalid, unknown: journal.unknown }).toEqual({
    skipped: 0,
    invalid: 0,
    unknown: 0,
  });
  expect(readFileSync(join(f.dir, "feed.jsonl"), "utf-8")).toContain("Order.php");
  expect(readFileSync(join(f.dir, "events.jsonl"), "utf-8")).not.toContain("Order.php");
});

test("A3: a step the selection set aside, aborted earlier, neither decides the verdict nor drops the stop", async () => {
  const f = fixture();
  const { run } = await open(f);
  const [a, b] = run.steps as [RunView["steps"][number], RunView["steps"][number]];
  writable(a).status = "aborted";
  stopRun(run, b, "until b", { kind: "until", detail: "stopped at --until b" });
  finalizeRun(run, { stopped: true, untilStop: true, setAside: ["a"] });

  const snapshot = snapshotOf(f.dir);
  expect(snapshot.status).toBe("STOPPED");
  expect(snapshot.outcome).toMatchObject({ phase: "b", stop: { kind: "until" } });
});
