import { expect, test } from "bun:test";
import type { Run } from "../model/run.ts";
import { type AttemptContext, type AttemptMiddleware, type AttemptRecord, compose } from "./attempt-chain.ts";
import { makeRunStep } from "../state/run-step.ts";

const step = makeRunStep({ id: "s", name: "S", command: "make test", runner: "bash" });
const run: Run = { name: "p", pipeline: "p", pipeline_path: "p.ts", run_dir: "/tmp", steps: [step] };

function makeCtx(): AttemptContext {
  const attempt = { attempt: 1, kind: "step" as const, status: "running" as const, started_at: "", log_path: "s.log" };
  return { run, step, attempt, kind: "step", command: "make test", budget: { cumulative: 0 } };
}

const OK: AttemptRecord = { ok: true };

test("compose executes middleware in order", async () => {
  const trace: string[] = [];
  const mark =
    (name: string): AttemptMiddleware =>
    async (ctx, next) => {
      trace.push(`>${name}`);
      const r = await next(ctx);
      trace.push(`<${name}`);
      return r;
    };

  await compose(
    mark("a"),
    mark("b"),
  )(async () => {
    trace.push("spawn");
    return OK;
  })(makeCtx());

  expect(trace).toEqual([">a", ">b", "spawn", "<b", "<a"]);
});

test("middleware throwing BEFORE spawn does not deprive the step of its attempt: validates the contract", async () => {
  let spawned = 0;
  const boom: AttemptMiddleware = async () => {
    throw new Error("boom");
  };
  const result = await compose(boom)(async () => {
    spawned++;
    return OK;
  })(makeCtx());

  expect(spawned).toBe(1);
  expect(result).toBe(OK);
});

test("middleware throwing after spawn preserves a successful result: validates the contract", async () => {
  const lateBoom: AttemptMiddleware = async (ctx, next) => {
    await next(ctx);
    throw new Error("boom");
  };
  const result = await compose(lateBoom)(async () => OK)(makeCtx());
  expect(result).toBe(OK);
});

test("middleware skipping next still executes the attempt: validates the contract", async () => {
  let spawned = 0;
  // Out-of-contract short circuit: typing forbids it, but an untyped JS cast allows it.
  const shortCircuit = (async () => OK) as unknown as AttemptMiddleware;
  const result = await compose(shortCircuit)(async () => {
    spawned++;
    return { ok: false } as AttemptRecord;
  })(makeCtx());

  expect(spawned).toBe(1);
  expect(result.ok).toBe(false);
});

test("attempt-chain: validates the integration contract", async () => {
  let spawned = 0;
  const twice: AttemptMiddleware = async (ctx, next) => {
    await next(ctx);
    return next(ctx);
  };
  await compose(twice)(async () => {
    spawned++;
    return OK;
  })(makeCtx());

  expect(spawned).toBe(1);
});

test("attempt-chain: validates the integration contract", async () => {
  let spawned = 0;
  // Middleware that swallows everything, including runner failure: the chain must
  // neither hide the error nor relaunch a process for the same attempt.
  const swallow = (async (ctx: AttemptContext, next: (c: AttemptContext) => Promise<AttemptRecord>) => {
    try {
      return await next(ctx);
    } catch {
      return OK;
    }
  }) as unknown as AttemptMiddleware;

  const chain = compose(swallow)(async () => {
    spawned++;
    throw new Error("spawn down");
  });

  await expect(chain(makeCtx())).rejects.toThrow("spawn down");
  expect(spawned).toBe(1);
});

test("two concurrent next calls share one spawn: validates the contract", async () => {
  let spawned = 0;
  const concurrent: AttemptMiddleware = async (ctx, next) => {
    const [first, second] = await Promise.all([next(ctx), next(ctx)]);
    expect(second).toBe(first);
    return first;
  };
  const result = await compose(concurrent)(async () => {
    spawned++;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return OK;
  })(makeCtx());

  expect(spawned).toBe(1);
  expect(result).toBe(OK);
});

test("two concurrent next calls share one spawn failure: validates the contract", async () => {
  let spawned = 0;
  // Out-of-contract: the middleware swallows the failure and fabricates a result.
  // The chain must still surface the spawn error and never relaunch a process
  // for the same attempt.
  const concurrent = (async (ctx: AttemptContext, next: (c: AttemptContext) => Promise<AttemptRecord>) => {
    const [first, second] = await Promise.allSettled([next(ctx), next(ctx)]);
    expect(first.status).toBe("rejected");
    expect(second.status).toBe("rejected");
    return OK;
  }) as unknown as AttemptMiddleware;
  const chain = compose(concurrent)(async () => {
    spawned++;
    await new Promise((resolve) => setTimeout(resolve, 5));
    throw new Error("spawn down");
  });

  await expect(chain(makeCtx())).rejects.toThrow("spawn down");
  expect(spawned).toBe(1);
});

test("middleware errors do not stop later handlers: validates the contract", async () => {
  const trace: string[] = [];
  const boom: AttemptMiddleware = async () => {
    throw new Error("boom");
  };
  const seen =
    (name: string): AttemptMiddleware =>
    async (ctx, next) => {
      trace.push(name);
      return next(ctx);
    };

  await compose(
    seen("outer"),
    boom,
    seen("inner"),
  )(async () => {
    trace.push("spawn");
    return OK;
  })(makeCtx());

  expect(trace).toEqual(["outer", "inner", "spawn"]);
});
