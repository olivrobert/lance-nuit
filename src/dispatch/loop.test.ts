// Semantics of the single dispatch loop. These cases preserve intentional
// differences in dispatch behavior instead of flattening them accidentally.

import { expect, test } from "bun:test";
import type { Pipeline } from "../model/definition.ts";
import { buildPipelineContext } from "../pipeline/context.ts";
import { classifyPersistedRunOutcome, type DispatchDeps, runDispatch } from "./loop.ts";
import type { DispatchEnv, DispatchOutcome, DispatchStrategy } from "./dispatch-strategy.ts";
import { DispatchAbort } from "./strategy.ts";

const def: Pipeline = { name: "p", steps: [] };

function env(overrides: Partial<DispatchEnv> = {}): DispatchEnv {
  return {
    pipelinePath: "/r/pipelines/p.ts",
    passthrough: [],
    fresh: false,
    watch: false,
    ctx: buildPipelineContext({ ticket: "PROJ-1" }),
    def,
    ...overrides,
  };
}

/** Neutral strategy: each test overrides only what it exercises. */
function strategy(overrides: Partial<DispatchStrategy> = {}): DispatchStrategy {
  return {
    id: "fake",
    flag: null,
    ticket: "required",
    desc: "test strategy",
    onFailure: "continue",
    tickets: () => ["A", "B"],
    onEmpty: () => ({ message: "empty", code: 0 }),
    childArgs: () => [],
    banner: (t) => `## ${t}`,
    skipMessage: (t) => `skip ${t}`,
    report: () => {},
    ...overrides,
  };
}

function deps(overrides: Partial<DispatchDeps> = {}): DispatchDeps {
  return {
    isTicketComplete: () => false,
    classify: (_t, code) => ({ outcome: code === 0 ? "fixed" : "failed", runId: null }),
    spawn: () => 0,
    ...overrides,
  };
}

test("one child per ticket, with passthrough then strategy childArgs", async () => {
  const spawned: string[][] = [];
  const code = await runDispatch(
    strategy({ childArgs: () => ["--base-branch", "dev"] }),
    env({ passthrough: ["--fresh"] }),
    deps({
      spawn: (args) => {
        spawned.push(args);
        return 0;
      },
    }),
  );

  expect(code).toBe(0);
  expect(spawned).toEqual([
    ["A", "--pipeline", "/r/pipelines/p.ts", "--fresh", "--base-branch", "dev"],
    ["B", "--pipeline", "/r/pipelines/p.ts", "--fresh", "--base-branch", "dev"],
  ]);
});

test("empty ticket list: message and exit code come from the strategy", async () => {
  const code = await runDispatch(
    strategy({ tickets: () => [], onEmpty: () => ({ message: "nothing", code: 1 }) }),
    env(),
    deps(),
  );
  expect(code).toBe(1);
});

test("DispatchAbort returns its code without entering the loop", async () => {
  const spawned: string[][] = [];
  const code = await runDispatch(
    strategy({
      tickets: () => {
        throw new DispatchAbort(1);
      },
    }),
    env(),
    deps({
      spawn: (args) => {
        spawned.push(args);
        return 0;
      },
    }),
  );
  expect(code).toBe(1);
  expect(spawned).toEqual([]);
});

test("resume: a complete ticket is not relaunched but counts in the summary", async () => {
  const spawned: string[][] = [];
  const reported: DispatchOutcome[] = [];
  const code = await runDispatch(
    strategy({ report: (outcomes) => reported.push(...outcomes) }),
    env(),
    deps({
      isTicketComplete: (t) => t === "A",
      spawn: (args) => {
        spawned.push(args);
        return 0;
      },
    }),
  );

  expect(code).toBe(0);
  expect(spawned.map((a) => a[0])).toEqual(["B"]);
  expect(reported).toEqual([
    { ticket: "A", outcome: "fixed" },
    { ticket: "B", outcome: "fixed" },
  ]);
});

test("--fresh relaunches even a complete ticket", async () => {
  const spawned: string[][] = [];
  await runDispatch(
    strategy(),
    env({ fresh: true }),
    deps({
      isTicketComplete: () => true,
      spawn: (args) => {
        spawned.push(args);
        return 0;
      },
    }),
  );
  expect(spawned.map((a) => a[0])).toEqual(["A", "B"]);
});

test("betweenTickets also runs after a skip and knows it was skipped", async () => {
  const seen: Array<{ ticket: string; skipped: boolean }> = [];
  await runDispatch(
    strategy({
      betweenTickets: (ticket, _e, info) => {
        seen.push({ ticket, skipped: info.skipped });
        return true;
      },
    }),
    env(),
    deps({ isTicketComplete: (t) => t === "A" }),
  );
  expect(seen).toEqual([
    { ticket: "A", skipped: true },
    { ticket: "B", skipped: false },
  ]);
});

test('onFailure "continue": failed ticket does not stop loop, report rendered', async () => {
  const reported: DispatchOutcome[] = [];
  const code = await runDispatch(
    strategy({ onFailure: "continue", report: (outcomes) => reported.push(...outcomes) }),
    env(),
    deps({ spawn: (args) => (args[0] === "A" ? 1 : 0) }),
  );

  expect(code).toBe(0); // scan returns 0 even with failed tickets
  expect(reported).toEqual([
    { ticket: "A", outcome: "failed" },
    { ticket: "B", outcome: "fixed" },
  ]);
});

test('onFailure "stop": loop returns child code without report or after', async () => {
  let reportCalls = 0;
  let afterCalls = 0;
  const spawned: string[][] = [];
  const code = await runDispatch(
    strategy({
      onFailure: "stop",
      after: async () => {
        afterCalls++;
        return 0;
      },
      report: () => {
        reportCalls++;
      },
    }),
    env(),
    deps({
      spawn: (args) => {
        spawned.push(args);
        return args[0] === "A" ? 42 : 0;
      },
    }),
  );

  expect(code).toBe(42);
  expect(spawned.map((a) => a[0])).toEqual(["A"]);
  expect(afterCalls).toBe(0);
  expect(reportCalls).toBe(0);
});

test('betweenTickets false + onFailure "stop" → 1, loop stopped', async () => {
  const spawned: string[][] = [];
  const code = await runDispatch(
    strategy({ onFailure: "stop", betweenTickets: (t) => t !== "A" }),
    env(),
    deps({
      spawn: (args) => {
        spawned.push(args);
        return 0;
      },
    }),
  );
  expect(code).toBe(1);
  expect(spawned.map((a) => a[0])).toEqual(["A"]);
});

test('betweenTickets false + onFailure "continue" → 0, report still rendered, after skipped', async () => {
  let afterCalls = 0;
  const reported: DispatchOutcome[] = [];
  const code = await runDispatch(
    strategy({
      onFailure: "continue",
      betweenTickets: (t) => t !== "A",
      after: async () => {
        afterCalls++;
        return 0;
      },
      report: (outcomes) => reported.push(...outcomes),
    }),
    env(),
    deps(),
  );

  expect(code).toBe(0);
  expect(afterCalls).toBe(0);
  expect(reported.map((o) => o.ticket)).toEqual(["A"]);
});

test("failed after: its code propagates and report is skipped", async () => {
  let reportCalls = 0;
  const code = await runDispatch(
    strategy({
      after: async () => 7,
      report: () => {
        reportCalls++;
      },
    }),
    env(),
    deps(),
  );
  expect(code).toBe(7);
  expect(reportCalls).toBe(0);
});

test("report receives the COMPLETE ticket list, not only processed tickets", async () => {
  let seen: string[] = [];
  await runDispatch(
    strategy({
      tickets: () => ["A", "B", "C"],
      onFailure: "continue",
      betweenTickets: (t) => t !== "A",
      report: (_o, tickets) => {
        seen = tickets;
      },
    }),
    env(),
    deps(),
  );
  // Scan displays "Tickets scanned: 3" even after stopping on the first.
  expect(seen).toEqual(["A", "B", "C"]);
});

test("classifyPersistedRunOutcome: exit != 0 → failed", () => {
  expect(classifyPersistedRunOutcome(1, null)).toBe("failed");
});

test("classifyPersistedRunOutcome: present stopped_reason → escalated", () => {
  const run = { schemaVersion: 1, runId: "scan-1", steps: [], stopped_reason: "escalated: sensitive" };
  expect(classifyPersistedRunOutcome(0, run as never)).toBe("escalated");
});

test("classifyPersistedRunOutcome: exit 0 without stopped_reason → fixed", () => {
  expect(classifyPersistedRunOutcome(0, { steps: [] } as never)).toBe("fixed");
  expect(classifyPersistedRunOutcome(0, null)).toBe("fixed");
});

/* ------------------------------------------------------------------------- *
 * Progress hooks
 *
 * They are what lets a strategy keep a durable record without the loop knowing
 * anything about one. Their ORDER is the contract: `onTicketStarted` before the
 * spawn, so an interrupted process still shows the ticket as started.
 * ------------------------------------------------------------------------- */

/** Record every hook call, and the spawns interleaved with them. */
function tracingStrategy(trace: string[], overrides: Partial<DispatchStrategy> = {}): DispatchStrategy {
  return strategy({
    onTicketStarted: (ticket) => {
      trace.push(`started:${ticket}`);
    },
    onTicketFinished: (outcome) => {
      trace.push(`finished:${outcome.ticket}:${outcome.outcome}:${outcome.runId ?? "none"}`);
    },
    onHalted: (reason) => {
      trace.push(`halted:${reason}`);
    },
    ...overrides,
  });
}

test("hooks: started then finished, per ticket, around the spawn", async () => {
  const trace: string[] = [];
  await runDispatch(
    tracingStrategy(trace),
    env(),
    deps({
      spawn: (args) => {
        trace.push(`spawn:${args[0]}`);
        return 0;
      },
    }),
  );

  expect(trace).toEqual([
    "started:A",
    "spawn:A",
    "finished:A:fixed:none",
    "started:B",
    "spawn:B",
    "finished:B:fixed:none",
  ]);
});

test("hooks: a ticket skipped on resume is finished but never started", async () => {
  const trace: string[] = [];
  await runDispatch(
    tracingStrategy(trace),
    env(),
    deps({
      isTicketComplete: (ticket) => ticket === "A",
      classify: () => ({ outcome: "skipped", runId: null }),
    }),
  );

  expect(trace).toEqual(["finished:A:skipped:none", "started:B", "finished:B:skipped:none"]);
});

test("hooks: onTicketFinished carries the runId classify resolved", async () => {
  const trace: string[] = [];
  await runDispatch(
    tracingStrategy(trace),
    env(),
    deps({ classify: (ticket) => ({ outcome: "fixed", runId: `run-${ticket}` }) }),
  );

  expect(trace).toEqual(["started:A", "finished:A:fixed:run-A", "started:B", "finished:B:fixed:run-B"]);
});

test("hooks: onHalted names the refusing hook's ticket, and the loop stops", async () => {
  const trace: string[] = [];
  const code = await runDispatch(tracingStrategy(trace, { betweenTickets: (ticket) => ticket !== "A" }), env(), deps());

  expect(code).toBe(0);
  expect(trace).toEqual(["started:A", "finished:A:fixed:none", "halted:betweenTickets refused to continue after A"]);
});

test("hooks: onHalted runs before a stop-mode loop returns its failure code", async () => {
  const trace: string[] = [];
  const code = await runDispatch(
    tracingStrategy(trace, { onFailure: "stop", betweenTickets: () => false }),
    env(),
    deps(),
  );

  expect(code).toBe(1);
  expect(trace).toEqual(["started:A", "finished:A:fixed:none", "halted:betweenTickets refused to continue after A"]);
});

test("hooks: a strategy declaring none of them still runs", async () => {
  const code = await runDispatch(strategy(), env(), deps());
  expect(code).toBe(0);
});
