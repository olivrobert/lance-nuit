// A group of `parallelize`, through the real step loop and the real attempt chain,
// against a real git tree. Only the agent is fake: it answers when the test says so,
// which is what lets a test hold two members in flight at the same time.

import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinRegistries } from "../../../tests/builtin-registries.ts";
import type { PipelineStep } from "../../definition/definition.ts";
import { buildPipelineContext } from "../../definition/pipeline/context.ts";
import type { Run, RunStep } from "../../run/record/run.ts";
import { makeRunStep, type StepStateInput } from "../../run/record/run-step.ts";
import { abortRun, finalizeRun } from "../../run/record/run-transitions.ts";
import type { RunStepView } from "../../run/run.ts";
import { createAbortScope } from "../abort.ts";
import { NULL_RUN_OUTPUT, type RunOutput, type RunOutputEvent } from "../run-output.ts";
import type { StepResult } from "../runners.ts";
import { executionUnits } from "./parallel-group.ts";
import { executeRunSteps, type StepLoopDeps } from "./step-loop.ts";
import { treeChanges } from "./tree-snapshot.ts";

const GROUP = { id: "audits", name: "Audits" };
const created: string[] = [];

afterEach(() => {
  for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true });
});

function tempDir(): string {
  const path = mkdtempSync(join(tmpdir(), "parallel-group-"));
  created.push(path);
  return path;
}

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
}

/** A repository with one committed file, the tree the members read. */
function repo(): string {
  const root = tempDir();
  git(root, "init", "-q");
  writeFileSync(join(root, "tracked.txt"), "committed\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "init");
  return root;
}

function member(id: string, def: Partial<PipelineStep> = {}, state: StepStateInput = {}): RunStep {
  return makeRunStep(
    {
      id: `audits.${id}`,
      name: id,
      command: "read",
      runner: "agent",
      backend: { id: "claude" },
      parallel_group: GROUP,
      ...def,
    },
    state,
  );
}

function lone(id: string, state: StepStateInput = {}): RunStep {
  return makeRunStep({ id, name: id, command: "echo", runner: "bash" }, state);
}

function makeRun(steps: RunStep[], maxCost?: number): Run {
  return { name: "p", pipeline: "p", pipeline_path: "p.ts", run_dir: tempDir(), max_cost_usd: maxCost, steps };
}

type Answer = Partial<StepResult>;
type Script = (step: RunStepView, spawn: { budgetRemaining?: number }) => Answer | Promise<Answer>;

function depsAnswering(script: Script, output: RunOutput = NULL_RUN_OUTPUT): StepLoopDeps & { spawned: string[] } {
  const spawned: string[] = [];
  return {
    spawned,
    executeStep: (async (step: RunStepView, _command: string, spawn: { budgetRemaining?: number }) => {
      spawned.push(step.id);
      const answer = await script(step, spawn);
      return { output: "", ok: true, stats: { duration_ms: 1 }, ...answer };
    }) as StepLoopDeps["executeStep"],
    extractErrors: async () => ({ hasErrors: false, errors: "" }),
    runFixLoop: async () => ({ failed: true }),
    output,
  };
}

/** Each caller waits until `count` callers arrived: sequential execution would never
 *  get there, and the test would time out. */
function barrier(count: number): () => Promise<void> {
  let arrived = 0;
  let open: () => void = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return () => {
    arrived += 1;
    if (arrived === count) open();
    return opened;
  };
}

function run_(run: Run, deps: StepLoopDeps, cwd: string, options: { resuming?: boolean; replay?: boolean } = {}) {
  return executeRunSteps(
    run,
    undefined,
    undefined,
    { resuming: options.resuming ?? false, replayInterrupted: options.replay },
    deps,
    buildPipelineContext({ ...builtinRegistries(), cwd }),
  );
}

function statuses(run: Run): Record<string, string> {
  return Object.fromEntries(run.steps.map((step) => [step.id, step.status]));
}

test("execution units: lone steps stay alone, and a group is one unit", () => {
  const steps = [lone("before"), member("a"), member("b"), lone("after")];

  expect(executionUnits(steps).map((unit) => unit.map((step) => step.id))).toEqual([
    ["before"],
    ["audits.a", "audits.b"],
    ["after"],
  ]);
});

test("execution units: two groups side by side stay two units", () => {
  const other = { id: "other", name: "Other" };
  const steps = [member("a"), member("b"), member("c", { id: "other.c", parallel_group: other })];

  expect(executionUnits(steps).map((unit) => unit.length)).toEqual([2, 1]);
});

test("members overlap for real, and the next step waits for both", async () => {
  const root = repo();
  const bothRunning = barrier(2);
  const run = makeRun([member("a"), member("b"), lone("after")]);
  const deps = depsAnswering(async (step) => {
    if (step.id === "after") return {};
    await bothRunning();
    expect(statuses(run).after).toBe("pending");
    return {};
  });

  const outcome = await run_(run, deps, root);

  expect(outcome.failed).toBe(false);
  expect(deps.spawned).toEqual(["audits.a", "audits.b", "after"]);
  expect(statuses(run)).toEqual({ "audits.a": "done", "audits.b": "done", after: "done" });
});

test("each member is allowed its share of the ceiling, and the next step what is left", async () => {
  const root = repo();
  const bothRunning = barrier(2);
  const after = makeRunStep({
    id: "after",
    name: "after",
    command: "read",
    runner: "agent",
    backend: { id: "claude" },
  });
  const run = makeRun([member("a"), member("b"), after], 8);
  const allowed: Record<string, number | undefined> = {};
  const deps = depsAnswering(async (step, spawn) => {
    allowed[step.id] = spawn.budgetRemaining;
    if (step.id !== "after") await bothRunning();
    return { stats: { duration_ms: 1, total_cost_usd: 1 } };
  });

  await run_(run, deps, root);

  expect(allowed).toEqual({ "audits.a": 4, "audits.b": 4, after: 6 });
});

test("a failing member lets its sibling finish, then stops the run", async () => {
  const root = repo();
  let release: () => void = () => {};
  const siblingHeld = new Promise<void>((resolve) => {
    release = resolve;
  });
  const run = makeRun([member("fails"), member("finishes"), lone("after")]);
  const deps = depsAnswering(async (step) => {
    if (step.id === "audits.fails") {
      setTimeout(release, 5);
      return { ok: false, failReason: "boom" };
    }
    await siblingHeld;
    await Bun.sleep(5);
    expect(statuses(run)["audits.fails"]).toBe("failed");
    return {};
  });

  const outcome = await run_(run, deps, root);
  finalizeRun(run, outcome);

  expect(outcome.failed).toBe(true);
  expect(statuses(run)).toEqual({ "audits.fails": "failed", "audits.finishes": "done", after: "pending" });
  expect(run.status).toBe("FAIL");
  expect(run.outcome?.phase).toBe("audits.fails");
});

test("a sibling retrying after a failure does not hide it in the verdict", async () => {
  const root = repo();
  let attempts = 0;
  const run = makeRun([member("fails"), member("retries", { on_failure: { max_retries: 1 } })]);
  const deps = depsAnswering(async (step) => {
    if (step.id === "audits.fails") return { ok: false, failReason: "boom" };
    await Bun.sleep(5);
    attempts += 1;
    return attempts === 1 ? { ok: false, failReason: "transient" } : {};
  });

  const outcome = await run_(run, deps, root);
  finalizeRun(run, outcome);

  expect(attempts).toBe(2);
  expect(statuses(run)).toEqual({ "audits.fails": "failed", "audits.retries": "done" });
  expect(run.status).toBe("FAIL");
});

test("a non-blocking member absorbs its failure and the run goes on", async () => {
  const root = repo();
  const run = makeRun([member("optional", { blocking: false }), member("b"), lone("after")]);
  const deps = depsAnswering((step) => (step.id === "audits.optional" ? { ok: false, failReason: "boom" } : {}));

  const outcome = await run_(run, deps, root);

  expect(outcome.failed).toBe(false);
  expect(statuses(run).after).toBe("done");
});

test("a member's guard kill stops the run once its sibling has finished, with no retry", async () => {
  const root = repo();
  const bothRunning = barrier(2);
  const run = makeRun([member("killed", { on_failure: { max_retries: 3 } }), member("b"), lone("after")], 4);
  const deps = depsAnswering(async (step) => {
    if (step.id === "after") return {};
    await bothRunning();
    return step.id === "audits.killed"
      ? { ok: false, budgetExceeded: true, failReason: "guard", stats: { duration_ms: 1, total_cost_usd: 1 } }
      : { stats: { duration_ms: 1, total_cost_usd: 1 } };
  });

  const outcome = await run_(run, deps, root);

  expect(outcome.budgetExceeded).toBe(true);
  expect(deps.spawned.filter((id) => id === "audits.killed")).toHaveLength(1);
  expect(statuses(run)["audits.b"]).toBe("done");
  expect(statuses(run).after).toBe("pending");
  expect(run.budget_exceeded).toBe(true);
});

test("a signal closes both members and reports an interruption, not their results", async () => {
  const root = repo();
  const bothRunning = barrier(2);
  const a = member("a");
  const b = member("b");
  const run = makeRun([a, b, lone("after")]);
  const abortAfterBoth = barrier(2);
  const deps = depsAnswering(async () => {
    await bothRunning();
    if (run.status !== "ABORTED") abortRun(run, "SIGINT");
    await abortAfterBoth();
    return { ok: false, failReason: "killed" };
  });

  const outcome = await run_(run, deps, root);

  expect(outcome.failed).toBe(false);
  expect(run.status).toBe("ABORTED");
  expect(statuses(run).after).toBe("pending");
  expect(run.steps.filter((step) => step.status === "failed")).toHaveLength(0);
});

test("an abort requested on the scope alone reports an interruption and checks no write", async () => {
  const root = repo();
  const abort = createAbortScope();
  const bothRunning = barrier(2);
  const run = makeRun([member("a"), member("b"), lone("after")]);
  const deps = depsAnswering(async () => {
    await bothRunning();
    writeFileSync(join(root, "wrote.txt"), "x");
    abort.requestAbort("SIGTERM");
    return { ok: false, failReason: "killed" };
  });

  const outcome = await executeRunSteps(
    run,
    undefined,
    undefined,
    { resuming: false, abort },
    deps,
    buildPipelineContext({ ...builtinRegistries(), cwd: root }),
  );

  expect(outcome).toMatchObject({ failed: false, stopped: false });
  expect(run.outcome?.stop).toBeUndefined();
});

test("an abort while the group reads the tree back reports an interruption, not a write or a failure", async () => {
  const root = repo();
  const abort = createAbortScope();
  const run = makeRun([member("a"), member("b"), lone("after")]);
  let reads = 0;
  const deps = depsAnswering((step) => {
    writeFileSync(join(root, "wrote.txt"), "x");
    return step.id === "audits.a" ? { ok: false, failReason: "boom" } : {};
  });
  const context = buildPipelineContext({ ...builtinRegistries(), cwd: root });
  Object.defineProperty(context, "cwd", {
    enumerable: true,
    get() {
      reads += 1;
      if (run.steps.every((step) => (step.status !== "running" && step.status !== "pending") || step.id === "after")) {
        abort.requestAbort("SIGINT");
      }
      return root;
    },
    configurable: true,
  });

  const outcome = await executeRunSteps(run, undefined, undefined, { resuming: false, abort }, deps, context);

  expect(reads).toBeGreaterThan(1);
  expect(outcome).toMatchObject({ failed: false, stopped: false });
  expect(run.outcome?.stop).toBeUndefined();
});

test("an abort during a later member's admission launches nothing, not even the member already admitted", async () => {
  const root = repo();
  const abort = createAbortScope();
  const requestAbort = {
    kind: "function",
    evaluate: async () => {
      abort.requestAbort("SIGINT");
      return { action: "pass" };
    },
  } as unknown as NonNullable<PipelineStep["inputs"]>[number];
  const run = makeRun([member("a"), member("b", { inputs: [requestAbort] })]);
  const deps = depsAnswering(() => ({}));

  await executeRunSteps(
    run,
    undefined,
    undefined,
    { resuming: false, abort },
    deps,
    buildPipelineContext({ ...builtinRegistries(), cwd: root }),
  );

  expect(deps.spawned).toEqual([]);
});

test("a signal before the launch spawns nothing", async () => {
  const root = repo();
  const abort = createAbortScope();
  const run = makeRun([member("a"), member("b"), lone("after")]);
  const deps = depsAnswering(() => ({}));
  const context = buildPipelineContext({ ...builtinRegistries(), cwd: root });
  // Requested while the group reads the tree: admission is over, nothing has spawned.
  Object.defineProperty(context, "cwd", {
    enumerable: true,
    get() {
      abort.requestAbort("SIGINT");
      return root;
    },
    configurable: true,
  });

  await executeRunSteps(run, undefined, undefined, { resuming: false, abort }, deps, context);

  expect(deps.spawned).toEqual([]);
  expect(statuses(run)["audits.a"]).toBe("pending");
});

test("a pass that rejects still waits for its sibling, then surfaces the error", async () => {
  const root = repo();
  let siblingFinished = false;
  const run = makeRun([member("throws"), member("finishes")]);
  const deps = depsAnswering(async (step) => {
    if (step.id === "audits.throws") throw new Error("spawn failed");
    await Bun.sleep(5);
    siblingFinished = true;
    return {};
  });

  await expect(run_(run, deps, root)).rejects.toThrow("spawn failed");

  expect(siblingFinished).toBe(true);
});

test("a refused admission stops the run with nothing launched, even a member already admitted", async () => {
  const root = repo();
  const refuse = {
    kind: "function",
    evaluate: async () => ({ action: "fail", reason: "nope" }),
  } as unknown as NonNullable<PipelineStep["inputs"]>[number];
  const run = makeRun([member("a"), member("refused", { inputs: [refuse] }), lone("after")]);
  const deps = depsAnswering(() => ({}));

  const outcome = await run_(run, deps, root);

  expect(outcome.failed).toBe(true);
  expect(deps.spawned).toEqual([]);
  expect(statuses(run)).toEqual({ "audits.a": "pending", "audits.refused": "failed", after: "pending" });
});

test("a group reduced to one member by a skip runs it as a lone step", async () => {
  const root = repo();
  const skip = {
    kind: "function",
    evaluate: async () => ({ action: "skip", reason: "not this time" }),
  } as unknown as NonNullable<PipelineStep["inputs"]>[number];
  const run = makeRun([member("skipped", { inputs: [skip] }), member("alone")], 8);
  const allowed: Array<number | undefined> = [];
  const deps = depsAnswering((_step, spawn) => {
    allowed.push(spawn.budgetRemaining);
    // A lone step answers to the guard of no group.
    writeFileSync(join(root, "allowed-alone.txt"), "x");
    return {};
  });

  const outcome = await run_(run, deps, root);

  expect(deps.spawned).toEqual(["audits.alone"]);
  expect(allowed).toEqual([8]);
  expect(outcome.stopped).toBe(false);
});

test("resume after a failure replays only the member that failed", async () => {
  const root = repo();
  const run = makeRun([
    member("failed", {}, { status: "failed" }),
    member("kept", {}, { status: "done" }),
    lone("after"),
  ]);
  const deps = depsAnswering(() => ({}));

  const outcome = await run_(run, deps, root, { resuming: true });

  expect(outcome.failed).toBe(false);
  expect(deps.spawned).toEqual(["audits.failed", "after"]);
  expect(statuses(run)).toEqual({ "audits.failed": "done", "audits.kept": "done", after: "done" });
});

function interrupted(id: string): RunStep {
  const step = member(id, {}, { status: "running" });
  step.attempts = [
    {
      attempt: 1,
      kind: "step",
      status: "aborted",
      started_at: "2026-10-16T00:00:00Z",
      log_path: "x",
      interrupted: true,
    },
  ];
  return step;
}

test("resume after a crash asks before replaying, and launches nothing until it may", async () => {
  const root = repo();
  const run = makeRun([interrupted("a"), interrupted("b"), lone("after")]);
  const deps = depsAnswering(() => ({}));

  const outcome = await run_(run, deps, root, { resuming: true });

  expect(outcome.stopped).toBe(true);
  expect(deps.spawned).toEqual([]);
  expect(run.outcome?.stop?.kind).toBe("needs-decision");
  expect(run.outcome?.stop?.detail).toContain("--replay-interrupted");
});

test("--replay-interrupted replays both interrupted members side by side", async () => {
  const root = repo();
  const bothRunning = barrier(2);
  const run = makeRun([interrupted("a"), interrupted("b"), lone("after")]);
  const deps = depsAnswering(async (step) => {
    if (step.id !== "after") await bothRunning();
    return {};
  });

  const outcome = await run_(run, deps, root, { resuming: true, replay: true });

  expect(outcome.failed).toBe(false);
  expect(statuses(run)).toEqual({ "audits.a": "done", "audits.b": "done", after: "done" });
});

function capturingOutput(): RunOutput & { messages: string[] } {
  const messages: string[] = [];
  return {
    messages,
    emit: (event: RunOutputEvent) => {
      if (event.type === "runner.message") messages.push(event.message);
    },
  };
}

async function groupWriting(root: string, write: () => void, def: Partial<PipelineStep> = {}, runDir?: string) {
  const run = makeRun([member("a", def), member("b"), lone("after")]);
  if (runDir) run.run_dir = runDir;
  const output = capturingOutput();
  const deps = depsAnswering((step) => {
    if (step.id === "audits.a") write();
    return {};
  }, output);
  const outcome = await run_(run, deps, root);
  return { run, outcome, messages: output.messages, deps };
}

test("a new file stops the run after the group, names it, and keeps the verdicts", async () => {
  const root = repo();
  const { run, outcome, messages, deps } = await groupWriting(root, () => writeFileSync(join(root, "wrote.txt"), "x"));
  finalizeRun(run, outcome);

  expect(outcome).toMatchObject({ failed: false, stopped: true });
  expect(run.status).toBe("STOPPED");
  expect(statuses(run)).toEqual({ "audits.a": "done", "audits.b": "done", after: "pending" });
  expect(run.outcome?.stop?.kind).toBe("needs-decision");
  expect(run.outcome?.stop?.detail).toContain("Audits");
  expect(run.outcome?.stop?.detail).toContain("wrote.txt");
  expect(run.outcome?.resumable).toBe(true);
  expect(messages.join("\n")).toContain("wrote.txt");

  // Once a human looked, the resume goes on without paying for the members again.
  const resumed = await run_(run, deps, root, { resuming: true });
  expect(resumed.stopped).toBe(false);
  expect(statuses(run).after).toBe("done");
  expect(deps.spawned).toEqual(["audits.a", "audits.b", "after"]);
});

test("a failure and a write are both reported", async () => {
  const root = repo();
  const run = makeRun([member("a"), member("b")]);
  const deps = depsAnswering((step) => {
    writeFileSync(join(root, "wrote.txt"), "x");
    return step.id === "audits.a" ? { ok: false, failReason: "boom" } : {};
  });

  const outcome = await run_(run, deps, root);

  expect(outcome).toMatchObject({ failed: true, stopped: true });
});

for (const [name, setup, write, path] of [
  [
    "a modified tracked file",
    () => {},
    (root: string) => writeFileSync(join(root, "tracked.txt"), "changed\n"),
    "tracked.txt",
  ],
  ["a deleted tracked file", () => {}, (root: string) => rmSync(join(root, "tracked.txt")), "tracked.txt"],
  [
    "a file already modified, changed again",
    (root: string) => writeFileSync(join(root, "tracked.txt"), "before\n"),
    (root: string) => writeFileSync(join(root, "tracked.txt"), "after\n"),
    "tracked.txt",
  ],
  [
    "a new file in a directory already untracked",
    (root: string) => {
      mkdirSync(join(root, "dir"));
      writeFileSync(join(root, "dir", "old.txt"), "x");
    },
    (root: string) => writeFileSync(join(root, "dir", "new.txt"), "x"),
    "dir/new.txt",
  ],
  [
    "a dirty file staged, its content unchanged",
    (root: string) => writeFileSync(join(root, "tracked.txt"), "before\n"),
    (root: string) => git(root, "add", "tracked.txt"),
    "tracked.txt",
  ],
  [
    "a renamed file, under both names",
    () => {},
    (root: string) => git(root, "mv", "tracked.txt", "moved.txt"),
    "moved.txt, tracked.txt",
  ],
  [
    "a dirty file restored to its committed content",
    (root: string) => writeFileSync(join(root, "tracked.txt"), "before\n"),
    (root: string) => git(root, "checkout", "-q", "--", "tracked.txt"),
    "tracked.txt",
  ],
] as [string, (root: string) => void, (root: string) => void, string][]) {
  test(`the guard sees ${name}`, async () => {
    const root = repo();
    setup(root);

    const { run, outcome } = await groupWriting(root, () => write(root));

    expect(outcome.stopped).toBe(true);
    expect(run.outcome?.stop?.detail).toContain(path);
  });
}

test("the guard runs from the repository root whatever the cwd of the run", async () => {
  const root = repo();
  mkdirSync(join(root, "sub"));
  writeFileSync(join(root, "sub", "dirty.txt"), "before\n");
  const cwd = join(root, "sub");

  const { run, outcome } = await groupWriting(cwd, () => writeFileSync(join(cwd, "dirty.txt"), "after\n"));

  expect(outcome.stopped).toBe(true);
  expect(run.outcome?.stop?.detail).toContain("sub/dirty.txt");
});

test("uncommitted work the members did not touch is not theirs", async () => {
  const root = repo();
  writeFileSync(join(root, "tracked.txt"), "uncommitted\n");
  writeFileSync(join(root, "untracked.txt"), "x");

  const { outcome } = await groupWriting(root, () => {});

  expect(outcome.stopped).toBe(false);
});

test("the run's own records and a member's declared report are not writes", async () => {
  const root = repo();
  // Not under `.lance-nuit`: a machine's git may ignore it, and the guard would see nothing.
  const runDir = join(root, "runs", "r1");
  mkdirSync(runDir, { recursive: true });

  const { outcome } = await groupWriting(
    root,
    () => {
      mkdirSync(join(root, "reports"));
      writeFileSync(join(root, "reports", "out.json"), "{}");
    },
    { report_paths: ["reports/out.json"] },
    runDir,
  );

  expect(outcome.stopped).toBe(false);
});

test("the work item directory is not a write", async () => {
  const root = repo();
  const base = buildPipelineContext({ ...builtinRegistries(), cwd: root });
  const context = buildPipelineContext({
    ...builtinRegistries(),
    cwd: root,
    ticket: "T-1",
    // A default spec path may be ignored by this machine's git: this one is not.
    config: { ...base.config, specPath: "specs" },
  });
  const workItemDir = context.paths.workItemDir as string;
  const run = makeRun([member("a"), member("b")]);
  const deps = depsAnswering(() => {
    mkdirSync(workItemDir, { recursive: true });
    writeFileSync(join(workItemDir, "report.md"), "x");
    return {};
  });

  const outcome = await executeRunSteps(run, "T-1", undefined, { resuming: false }, deps, context);

  expect(outcome.stopped).toBe(false);
});

test("an allowed path covers what lies under it, not what only starts like it", () => {
  const before = { root: "/repo", entries: new Map<string, string>() };
  const after = {
    root: "/repo",
    entries: new Map([
      ["wi/report.md", "?? a"],
      ["wi-nearby.md", "?? b"],
      ["exact.json", "?? c"],
    ]),
  };

  expect(treeChanges(before, after, ["/repo/wi", "/repo/exact.json"])).toEqual(["wi-nearby.md"]);
});

test("a change is any difference in status or content, and the list is sorted", () => {
  const before = {
    root: "/repo",
    entries: new Map([
      ["same", " M 1"],
      ["content", " M 1"],
      ["status", " M 1"],
      ["gone", " M 1"],
    ]),
  };
  const after = {
    root: "/repo",
    entries: new Map([
      ["same", " M 1"],
      ["content", " M 2"],
      ["status", "M  1"],
      ["added", "?? 1"],
    ]),
  };

  expect(treeChanges(before, after, [])).toEqual(["added", "content", "gone", "status"]);
});

test("outside a repository there is no tree to guard", async () => {
  const cwd = tempDir();

  const { outcome, messages } = await groupWriting(cwd, () => writeFileSync(join(cwd, "wrote.txt"), "x"));

  expect(outcome.stopped).toBe(false);
  expect(messages.join("\n")).not.toContain("could not read the git tree");
});

test("a git status that starts failing is said, not read as a clean tree", async () => {
  const root = repo();

  const { outcome, messages } = await groupWriting(root, () => writeFileSync(join(root, ".git", "index"), "garbage"));

  expect(outcome.stopped).toBe(false);
  expect(messages.join("\n")).toContain("could not read the git tree");
});

test("a tree that can no longer be read is said, and stops nothing", async () => {
  const root = repo();

  const { outcome, messages } = await groupWriting(root, () => rmSync(join(root, ".git"), { recursive: true }));

  expect(outcome.stopped).toBe(false);
  expect(messages.join("\n")).toContain("could not read the git tree");
});

test("a member stopped by an obstacle stops the run once its sibling has finished", async () => {
  const root = repo();
  const run = makeRun([member("blocked"), member("b"), lone("after")]);
  const deps = depsAnswering(async (step) => {
    if (step.id === "audits.blocked") return { ok: false, failCause: "blocked", failReason: "no access" };
    await Bun.sleep(5);
    return {};
  });

  const outcome = await run_(run, deps, root);
  finalizeRun(run, outcome);

  expect(outcome.stopped).toBe(true);
  expect(statuses(run)).toEqual({ "audits.blocked": "failed", "audits.b": "done", after: "pending" });
  expect(run.status).toBe("STOPPED");
  expect(run.outcome?.stop?.kind).toBe("blocked");
});

test("an obstacle followed by a sibling's failure still reads as the stop it was", async () => {
  const root = repo();
  const run = makeRun([member("blocked"), member("fails")]);
  const deps = depsAnswering(async (step) => {
    if (step.id === "audits.blocked") return { ok: false, failCause: "blocked", failReason: "no access" };
    await Bun.sleep(5);
    return { ok: false, failReason: "boom" };
  });

  const outcome = await run_(run, deps, root);
  finalizeRun(run, outcome);

  expect(outcome).toMatchObject({ failed: true, stopped: true });
  expect(statuses(run)).toEqual({ "audits.blocked": "failed", "audits.fails": "failed" });
  // The sibling's failure rewrote the outcome after the stop, so `stop.kind` is gone;
  // the verdict, the reason and the cause are what a reader still gets.
  expect(run.status).toBe("STOPPED");
  expect(run.outcome).toMatchObject({ phase: "audits.blocked", reason: "no access", failCause: "blocked" });
});
