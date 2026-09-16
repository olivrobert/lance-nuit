// Ticket discovery for --scan, now behind the `WorkItemGateway` port. These cases
// lock down what the strategy must keep doing after provider knowledge leaves the
// engine: request the right queue, preserve gateway order, distinguish "nothing to
// do" from "tracker unreachable", and never truncate silently.
//
// The requested queue is tested through RESULTS, not a spy: seed tickets in several
// queues/states and inspect which return. An argument spy would pass despite bad filtering.

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pipeline } from "../model/definition.ts";
import type { ScanRecord } from "../model/scan-record.ts";
import type { ScanReadResult, ScanStore } from "../model/storage-ports.ts";
import {
  createFakeWorkItemGateway,
  type FakeWorkItemSeed,
  type FakeWorkItemSeedItem,
} from "../modules/work-item/fake.ts";
import { buildPipelineContext } from "../pipeline/context.ts";
import { type DispatchDeps, runDispatch } from "./loop.ts";
import { resolveScanLimit, scanStrategy } from "./scan.ts";
import type { DispatchEnv } from "./dispatch-strategy.ts";
import { DispatchAbort } from "./strategy.ts";

/** In-memory `ScanStore`. It keeps EVERY write, not only the last one: the record
 *  is written at each transition, and what a crash leaves behind is one of the
 *  intermediate versions. */
class MemoryScanStore implements ScanStore {
  readonly writes: ScanRecord[] = [];

  write(record: ScanRecord): void {
    this.writes.push(structuredClone(record));
  }

  readAll(): ScanReadResult {
    return { records: this.last ? [this.last] : [], skipped: 0 };
  }

  /** The version a reader would find on disk right now. */
  get last(): ScanRecord | undefined {
    return this.writes.at(-1);
  }
}

/** Disposable project with `workItem.project` set: without it the strategy aborts
 *  before talking to the gateway (see the dedicated test). */
function projectRoot(config: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-scan-"));
  mkdirSync(join(dir, ".lance-nuit"), { recursive: true });
  writeFileSync(join(dir, ".lance-nuit", "config.json"), JSON.stringify({ workItem: { project: "PROJ" }, ...config }));
  return dir;
}

const scanDefinition = (queue: "bugTodo" | "featureTodo", limit?: number): Pipeline["work_item_source"] => ({
  step_id: "ticket",
  queue,
  scan: limit == null ? {} : { limit },
});

const bugfixDef: Pipeline = { name: "bugfix", work_item_source: scanDefinition("bugTodo"), steps: [] };

interface EnvOptions {
  seed?: FakeWorkItemSeed;
  def?: Pipeline;
  limit?: number;
  cwd?: string;
  fresh?: boolean;
}

interface ScanEnv {
  env: DispatchEnv;
  gateway: ReturnType<typeof createFakeWorkItemGateway>;
  store: MemoryScanStore;
}

function scanEnv(opts: EnvOptions = {}): ScanEnv {
  const gateway = createFakeWorkItemGateway(opts.seed ?? {});
  const store = new MemoryScanStore();
  const env: DispatchEnv = {
    pipelinePath: "/r/pipelines/bugfix.ts",
    passthrough: [],
    fresh: opts.fresh ?? true,
    watch: false,
    limit: opts.limit,
    ctx: buildPipelineContext({ cwd: opts.cwd ?? projectRoot(), workItem: gateway }),
    def: opts.def ?? bugfixDef,
    scanStore: store,
  };
  return { env, gateway, store };
}

/** The states of a record, ticket by ticket — the shape most assertions need. */
function states(record: ScanRecord | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(record?.tickets ?? {}).map(([ticket, state]) => [ticket, state.state]));
}

/** Capture strategy stderr output — logs ARE the contract here ("0 tickets" and
 *  "tracker unreachable" must not look alike). */
async function captureLogs<T>(action: () => Promise<T>): Promise<{ result?: T; error?: unknown; output: string }> {
  const previous = process.stderr.write;
  let output = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    output += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    return { result: await action(), output };
  } catch (error) {
    return { error, output };
  } finally {
    process.stderr.write = previous;
  }
}

function deps(overrides: Partial<DispatchDeps> = {}): DispatchDeps {
  return {
    isTicketComplete: () => false,
    classify: (_t, code) => ({ outcome: code === 0 ? "fixed" : "failed", runId: null }),
    spawn: () => 0,
    ...overrides,
  };
}

test("discovery: declared bugTodo queue, todo state — other queues and states excluded", async () => {
  const { env } = scanEnv({
    seed: {
      items: [
        { ref: "PROJ-1", queues: ["bugTodo"], state: "todo" },
        { ref: "PROJ-2", queues: ["featureTodo"], state: "todo" },
        { ref: "PROJ-3", queues: ["bugTodo"], state: "inReview" },
        { ref: "PROJ-4", queues: ["done"], state: "todo" },
      ],
    },
  });
  const { result } = await captureLogs(() => Promise.resolve(scanStrategy.tickets(env)));
  expect(result).toEqual(["PROJ-1"]);
});

test("discovery: featureTodo source changes the requested queue", async () => {
  const { env } = scanEnv({
    def: { name: "feature", work_item_source: scanDefinition("featureTodo"), steps: [] },
    seed: {
      items: [
        { ref: "PROJ-1", queues: ["bugTodo"], state: "todo" },
        { ref: "PROJ-2", queues: ["featureTodo"], state: "todo" },
      ],
    },
  });
  const { result } = await captureLogs(() => Promise.resolve(scanStrategy.tickets(env)));
  expect(result).toEqual(["PROJ-2"]);
});

test("discovery: gateway order is preserved exactly", async () => {
  const { env } = scanEnv({
    seed: {
      items: [
        { ref: "PROJ-9", queues: ["bugTodo"] },
        { ref: "PROJ-2", queues: ["bugTodo"] },
        { ref: "PROJ-40", queues: ["bugTodo"] },
      ],
    },
  });
  const { result } = await captureLogs(() => Promise.resolve(scanStrategy.tickets(env)));
  // No sorting: a truncated scan must process the same tickets on each run.
  expect(result).toEqual(["PROJ-9", "PROJ-2", "PROJ-40"]);
});

test("discovery: log reports provider, queue, and state — no query or marker name", async () => {
  const { env } = scanEnv({ seed: { items: [{ ref: "PROJ-1", queues: ["bugTodo"] }], provider: "fake" } });
  const { output } = await captureLogs(() => Promise.resolve(scanStrategy.tickets(env)));
  expect(output).toContain("Scan fake");
  expect(output).toContain("PROJ");
  expect(output).toContain("bugTodo");
  expect(output).toContain("todo");
  expect(output).not.toContain("labels =");
  expect(output).not.toContain("acli");
});

test("no candidates: standard onEmpty message and code 0, and a CLOSED record", async () => {
  const { env, store } = scanEnv({ seed: { items: [{ ref: "PROJ-1", queues: ["escalate"] }] } });
  const { result, output } = await captureLogs(() => runDispatch(scanStrategy, env, deps()));
  expect(result).toBe(0);
  expect(output).toContain("ℹ No tickets to process.");
  // An empty queue is a COMPLETE scan. The loop returns through `onEmpty` and
  // never reaches `report()`, so the record has to be closed on that path too:
  // left open, every idle night would read as a scan interrupted mid-flight.
  expect(store.last?.finishedAt).not.toBeNull();
  expect(store.last?.discovered).toEqual([]);
  expect(store.last?.tickets).toEqual({});
  expect(store.last?.abort).toBeNull();
});

test("gateway failure: abort with error message, never an empty scan", async () => {
  const { env } = scanEnv({
    seed: { failures: [{ op: "findCandidates", kind: "error", message: "fake: tracker unreachable (503)" }] },
  });
  const spawned: string[][] = [];
  const { result, output } = await captureLogs(() =>
    runDispatch(
      scanStrategy,
      env,
      deps({
        spawn: (args) => {
          spawned.push(args);
          return 0;
        },
      }),
    ),
  );
  expect(result).toBe(1);
  expect(output).toContain("tracker unreachable (503)");
  // Failure must not take the empty-scan path.
  expect(output).not.toContain("No tickets to process");
  expect(spawned).toEqual([]);
});

test("pipeline without scannable source: abort before any tracker access", async () => {
  const { env, gateway } = scanEnv({
    def: { name: "quality", steps: [] },
    seed: { items: [{ ref: "PROJ-1", queues: ["bugTodo"] }] },
  });
  const { error, output } = await captureLogs(() => Promise.resolve(scanStrategy.tickets(env)));
  expect(error).toBeInstanceOf(DispatchAbort);
  expect((error as DispatchAbort).code).toBe(1);
  expect(output).toContain("quality");
  expect(output).toContain("no scannable work-item source");
  expect(gateway.calls).toEqual([]);
});

test("work-item source without scan: explicit abort", async () => {
  const { env, gateway } = scanEnv({
    def: { name: "manual", work_item_source: { step_id: "ticket", queue: "bugTodo" }, steps: [] },
  });
  const { error } = await captureLogs(() => Promise.resolve(scanStrategy.tickets(env)));
  expect(error).toBeInstanceOf(DispatchAbort);
  expect(gateway.calls).toEqual([]);
});

test("truncation: excluded tickets are logged and named", async () => {
  const { env } = scanEnv({
    def: { name: "bugfix", work_item_source: scanDefinition("bugTodo", 2), steps: [] },
    seed: {
      items: [
        { ref: "PROJ-1", queues: ["bugTodo"] },
        { ref: "PROJ-2", queues: ["bugTodo"] },
        { ref: "PROJ-3", queues: ["bugTodo"] },
        { ref: "PROJ-4", queues: ["bugTodo"] },
      ],
    },
  });
  const { result, output } = await captureLogs(() => Promise.resolve(scanStrategy.tickets(env)));
  expect(result).toEqual(["PROJ-1", "PROJ-2"]);
  expect(output).toContain("Limit 2 reached");
  expect(output).toContain("2 ticket(s) deferred: PROJ-3, PROJ-4");
  expect(output).toContain("--limit <n> to expand the limit");
});

test("--limit overrides the source limit end to end", async () => {
  const { env } = scanEnv({
    def: { name: "bugfix", work_item_source: scanDefinition("bugTodo", 3), steps: [] },
    limit: 1,
    seed: {
      items: [
        { ref: "PROJ-1", queues: ["bugTodo"] },
        { ref: "PROJ-2", queues: ["bugTodo"] },
        { ref: "PROJ-3", queues: ["bugTodo"] },
      ],
    },
  });
  const spawned: string[][] = [];
  const { result, output } = await captureLogs(() =>
    runDispatch(
      scanStrategy,
      env,
      deps({
        spawn: (args) => {
          spawned.push(args);
          return 0;
        },
      }),
    ),
  );
  expect(result).toBe(0);
  expect(spawned.map((args) => args[0])).toEqual(["PROJ-1"]);
  expect(output).toContain("Limit 1 reached");
  expect(output).toContain("deferred: PROJ-2, PROJ-3");
});

test("unconfigured project: abort before any gateway call", async () => {
  const bare = mkdtempSync(join(tmpdir(), "dispatch-scan-bare-"));
  const { env, gateway } = scanEnv({ cwd: bare, seed: { items: [{ ref: "PROJ-1", queues: ["bugTodo"] }] } });
  const { error, output } = await captureLogs(() => Promise.resolve(scanStrategy.tickets(env)));
  expect(error).toBeInstanceOf(DispatchAbort);
  expect((error as DispatchAbort).code).toBe(1);
  expect(output).toContain("workItem.project not found");
  expect(output).toContain(".lance-nuit/config.json");
  expect(gateway.calls).toEqual([]);
});

test("resolveScanLimit: --limit wins over pipeline default", () => {
  expect(resolveScanLimit(1, 3)).toBe(1);
  expect(resolveScanLimit(10, 3)).toBe(10);
});

test("resolveScanLimit: without --limit → pipeline default, otherwise unlimited", () => {
  expect(resolveScanLimit(undefined, 3)).toBe(3);
  expect(resolveScanLimit(undefined, undefined)).toBeUndefined();
});

test("resolveScanLimit: invalid DSL declaration ignored (scan does not abort)", () => {
  expect(resolveScanLimit(undefined, 0)).toBeUndefined();
  expect(resolveScanLimit(undefined, -1)).toBeUndefined();
  expect(resolveScanLimit(undefined, 2.5)).toBeUndefined();
});

/* ------------------------------------------------------------------------- *
 * Durable scan record
 *
 * The record is what survives the scan; stderr does not. These cases pin the
 * transitions, and above all that the four ticket states stay distinguishable
 * on a record left behind by an interruption.
 * ------------------------------------------------------------------------- */

/** Tickets in the scanned queue, `PROJ-1` … `PROJ-<count>`. */
function bugTodoItems(count: number): FakeWorkItemSeed {
  return {
    items: Array.from(
      { length: count },
      (_, index): FakeWorkItemSeedItem => ({ ref: `PROJ-${index + 1}`, queues: ["bugTodo"] }),
    ),
  };
}

/** Scan without the between-ticket checkout: these tests run in a bare temporary
 *  directory, where a real `git checkout` would halt the loop. */
const scanWithoutCheckout: typeof scanStrategy = { ...scanStrategy, betweenTickets: () => true };

test("record: written before discovery, with discovered null", async () => {
  const { env, store } = scanEnv({ seed: bugTodoItems(1) });
  await captureLogs(() => Promise.resolve(scanStrategy.tickets(env)));

  const first = store.writes[0];
  expect(first?.version).toBe(1);
  expect(first?.pipeline).toBe("bugfix");
  expect(first?.queue).toBe("bugTodo");
  expect(first?.project).toBe("PROJ");
  expect(first?.provider).toBe("fake");
  expect(first?.discovered).toBeNull();
  expect(first?.tickets).toEqual({});
  expect(first?.finishedAt).toBeNull();
  expect(first?.abort).toBeNull();
});

test("record: tickets beyond the limit are deferred, not absent", async () => {
  const { env, store } = scanEnv({
    def: { name: "bugfix", work_item_source: scanDefinition("bugTodo", 2), steps: [] },
    seed: bugTodoItems(4),
  });
  await captureLogs(() => Promise.resolve(scanStrategy.tickets(env)));

  expect(store.last?.limit).toBe(2);
  expect(store.last?.discovered).toEqual(["PROJ-1", "PROJ-2", "PROJ-3", "PROJ-4"]);
  expect(states(store.last)).toEqual({
    "PROJ-1": "pending",
    "PROJ-2": "pending",
    "PROJ-3": "deferred",
    "PROJ-4": "deferred",
  });
});

test("record: a failed discovery aborts in the discovery phase and never finishes", async () => {
  const { env, store } = scanEnv({
    seed: { failures: [{ op: "findCandidates", kind: "error", message: "fake: tracker unreachable (503)" }] },
  });
  await captureLogs(() => Promise.resolve(scanStrategy.tickets(env)));

  expect(store.last?.abort).toEqual({ phase: "discovery", reason: "fake: tracker unreachable (503)" });
  expect(store.last?.discovered).toBeNull();
  expect(store.last?.finishedAt).toBeNull();
});

test("record: a crash mid-scan keeps done, running, and pending distinct", async () => {
  const { env, store } = scanEnv({ seed: bugTodoItems(5) });
  const { error } = await captureLogs(() =>
    runDispatch(
      scanWithoutCheckout,
      env,
      deps({
        spawn: (args) => {
          if (args[0] === "PROJ-4") throw new Error("child spawn exploded");
          return 0;
        },
      }),
    ),
  );

  expect((error as Error).message).toBe("child spawn exploded");
  // Written only at the end, three finished tickets would be indistinguishable
  // from three that never started.
  expect(states(store.last)).toEqual({
    "PROJ-1": "done",
    "PROJ-2": "done",
    "PROJ-3": "done",
    "PROJ-4": "running",
    "PROJ-5": "pending",
  });
  expect(store.last?.finishedAt).toBeNull();
});

test("record: a finished ticket carries its outcome and runId", async () => {
  const { env, store } = scanEnv({ seed: bugTodoItems(2) });
  await captureLogs(() =>
    runDispatch(
      scanWithoutCheckout,
      env,
      deps({
        classify: (ticket) => ({ outcome: "fixed", runId: ticket === "PROJ-1" ? "run-a" : null }),
      }),
    ),
  );

  expect(store.last?.tickets["PROJ-1"]).toMatchObject({ state: "done", outcome: "fixed", runId: "run-a" });
  expect(store.last?.tickets["PROJ-2"]).toMatchObject({ state: "done", outcome: "fixed", runId: null });
  expect(store.last?.finishedAt).not.toBeNull();
});

test("record: a ticket skipped on resume is done without a duration of its own", async () => {
  const { env, store } = scanEnv({ seed: bugTodoItems(1), fresh: false });
  await captureLogs(() =>
    runDispatch(
      scanWithoutCheckout,
      env,
      deps({
        isTicketComplete: () => true,
        classify: () => ({ outcome: "skipped", runId: "run-old" }),
        spawn: () => {
          throw new Error("a skipped ticket must not spawn");
        },
      }),
    ),
  );

  const ticket = store.last?.tickets["PROJ-1"];
  expect(ticket).toMatchObject({ state: "done", outcome: "skipped", runId: "run-old" });
  if (ticket?.state !== "done") throw new Error("expected a done ticket");
  expect(ticket.startedAt).toBe(ticket.finishedAt);
});

test("record: a refused between-ticket hook aborts between tickets", async () => {
  const { env, store } = scanEnv({ seed: bugTodoItems(2) });
  const { result } = await captureLogs(() =>
    runDispatch({ ...scanStrategy, betweenTickets: () => false }, env, deps()),
  );

  expect(result).toBe(0);
  expect(store.last?.abort?.phase).toBe("between-tickets");
  expect(store.last?.abort?.reason).toContain("PROJ-1");
  expect(states(store.last)).toEqual({ "PROJ-1": "done", "PROJ-2": "pending" });
  // The report still runs in continue mode, so the scan did reach its end.
  expect(store.last?.finishedAt).not.toBeNull();
});

test("record: the real between-ticket checkout failure is the recorded reason", async () => {
  // The project root is a bare temporary directory: `git checkout` cannot work there.
  const { env, store } = scanEnv({ seed: bugTodoItems(2) });
  await captureLogs(() => runDispatch(scanStrategy, env, deps()));

  expect(store.last?.abort?.phase).toBe("between-tickets");
  expect(store.last?.abort?.reason).toContain("git checkout");
});

test("a pipeline-owned scan query reaches the gateway verbatim and is logged", async () => {
  const query = "project = PROJ AND assignee = 'Ada Lovelace'";
  const def: Pipeline = {
    ...bugfixDef,
    work_item_source: { step_id: "ticket", queue: "bugTodo", scan: { limit: 2, query } },
  };
  const { env, gateway } = scanEnv({ seed: bugTodoItems(3), def });
  const { result, output } = await captureLogs(() => Promise.resolve(scanStrategy.tickets(env)));

  expect(result).toEqual(["PROJ-1", "PROJ-2"]);
  expect(gateway.calls[0]).toEqual({ op: "findCandidates", query });
  expect(output).toContain(`query: ${query}`);
});

test("without a scan query the gateway request carries none", async () => {
  const { env, gateway } = scanEnv({ seed: bugTodoItems(1) });
  await captureLogs(() => Promise.resolve(scanStrategy.tickets(env)));
  expect(gateway.calls[0]).toEqual({ op: "findCandidates" });
});
