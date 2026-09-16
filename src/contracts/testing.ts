/** Reusable conformance API for provider package tests. */
import { hasMarker, markerFor } from "./note.js";
import type {
  AutomationQueue,
  ExecutionKey,
  WorkItemGateway,
  WorkItemNote,
  WorkItemRef,
  WorkItemState,
} from "./types.js";

/**
 * Minimal assertion surface used by the contract. Structurally satisfied by the
 * `expect` of bun:test, vitest and jest, so the contract stays runtime-neutral.
 */
export interface ContractExpectation {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toContain(expected: unknown): void;
  toHaveLength(expected: number): void;
  not: { toContain(expected: unknown): void };
  rejects: { toThrow(expected?: unknown): unknown };
}

/**
 * Test runner primitives supplied by the consumer. The core package must not
 * import a runner itself: an external adapter may run on node with vitest or
 * jest rather than on bun.
 */
export interface ContractHarness {
  describe(label: string, body: () => void): void;
  it(label: string, body: () => void | Promise<void>): void;
  expect(actual: unknown): ContractExpectation;
}

const QUEUES: readonly AutomationQueue[] = ["bugTodo", "featureTodo", "done", "escalate"];
export interface WorkItemGatewayContractRefs {
  known: WorkItemRef;
  second: WorkItemRef;
  closed: WorkItemRef;
  unknown: WorkItemRef;
  invalid: string;
}
export interface WorkItemGatewayContractOptions {
  refs?: Partial<WorkItemGatewayContractRefs>;
  rendering?: "plain" | "markdown";
  emptyQuery?: { queue: AutomationQueue; state: WorkItemState };
  readNotes?: (gateway: WorkItemGateway, ref: WorkItemRef) => string[] | Promise<string[]>;
  armMoveInterrupt?: (gateway: WorkItemGateway, ref: WorkItemRef, afterOps: number) => void | Promise<void>;
  appliedOperations?: (
    gateway: WorkItemGateway,
  ) => ReadonlyArray<{ kind: string; value: string; applied: boolean }> | undefined;
}
const DEFAULT_REFS = {
  known: "PROJ-24",
  second: "PROJ-25",
  closed: "PROJ-26",
  unknown: "PROJ-9999",
  invalid: "not a reference",
};
const NOTE: WorkItemNote = {
  headline: "Pipeline contract note",
  fields: [{ label: "Reason", value: "contract **value**" }],
  footer: "Review",
};

export type WorkItemGatewayContractRunner = (
  label: string,
  factory: () => WorkItemGateway | Promise<WorkItemGateway>,
  opts?: WorkItemGatewayContractOptions,
) => void;

/**
 * Bind the conformance contract to a test runner once per test file, then run
 * it for each gateway implementation.
 */
export function createWorkItemGatewayContract(harness: ContractHarness): WorkItemGatewayContractRunner {
  const { describe, it, expect } = harness;
  return function runWorkItemGatewayContract(label, factory, opts = {}): void {
    const refs = { ...DEFAULT_REFS, ...opts.refs };
    const empty = opts.emptyQuery ?? { queue: "done" as AutomationQueue, state: "inReview" as WorkItemState };
    const key = (stepId: string, ticket = refs.known): ExecutionKey => ({ ticket, stepId });
    const find = (gateway: WorkItemGateway, queue: AutomationQueue, state: WorkItemState) =>
      gateway.findCandidates({ queue, state });

    async function place(gateway: WorkItemGateway, ref: WorkItemRef, queue: AutomationQueue, state: WorkItemState) {
      for (const other of QUEUES) if (other !== queue) await gateway.moveTo(ref, { from: other });
      await gateway.moveTo(ref, { queue, state });
    }

    describe(`WorkItemGateway contract — ${label}`, () => {
      it("projects and validates tickets", async () => {
        const gateway = await factory();
        expect((await gateway.fetch(refs.known)).closed).toBe(false);
        expect((await gateway.fetch(refs.closed)).closed).toBe(true);
        expect(gateway.validateRef(refs.known)).toEqual({ ok: true });
        const invalid = gateway.validateRef(refs.invalid);
        expect(invalid.ok).toBe(false);
        await expect(gateway.fetch(refs.unknown)).rejects.toThrow(refs.unknown);
      });
      it("filters queue and state with stable ordering", async () => {
        const gateway = await factory();
        await place(gateway, refs.known, "bugTodo", "todo");
        await place(gateway, refs.second, "featureTodo", "todo");
        expect(await find(gateway, "bugTodo", "todo")).toContain(refs.known);
        expect(await find(gateway, "bugTodo", "todo")).not.toContain(refs.second);
        expect(await find(gateway, empty.queue, empty.state)).toEqual([]);
        const first = await find(gateway, "bugTodo", "todo");
        expect(await find(gateway, "bugTodo", "todo")).toEqual(first);
      });
      it("publishes marker-idempotent comments and excludes pipeline notes", async () => {
        const gateway = await factory();
        const executionKey = key("contract-comment");
        await gateway.comment(refs.known, NOTE, executionKey);
        await gateway.comment(refs.known, NOTE, executionKey);
        expect((await gateway.fetch(refs.known)).comments.some((body) => body.includes(NOTE.headline))).toBe(false);
      });
      // Optional cases are registered only when the adapter supplies the hook
      // they need. Registering them unconditionally would report a green test
      // that never ran an assertion, which reads as verified conformance.
      const readNotes = opts.readNotes;
      if (readNotes) {
        it("deduplicates published notes by execution marker", async () => {
          const gateway = await factory();
          const executionKey = key("contract-marker");
          await gateway.comment(refs.known, NOTE, executionKey);
          await gateway.comment(refs.known, NOTE, executionKey);
          const bodies = await readNotes(gateway, refs.known);
          expect(bodies.filter((body) => hasMarker(body, executionKey))).toHaveLength(1);
          expect(bodies.find((body) => hasMarker(body, executionKey))).toContain(markerFor(executionKey));
        });
      }
      it("moves queues and states idempotently", async () => {
        const gateway = await factory();
        await place(gateway, refs.known, "bugTodo", "todo");
        const target = {
          queue: "done" as AutomationQueue,
          from: "bugTodo" as AutomationQueue,
          state: "inReview" as WorkItemState,
        };
        await gateway.moveTo(refs.known, target);
        const first = await find(gateway, "done", "inReview");
        await gateway.moveTo(refs.known, target);
        expect(await find(gateway, "done", "inReview")).toEqual(first);
        await gateway.moveTo(refs.known, { state: "todo" });
        expect(await find(gateway, "done", "todo")).toContain(refs.known);
      });
      const armMoveInterrupt = opts.armMoveInterrupt;
      if (armMoveInterrupt) {
        it("replays interrupted moves safely", async () => {
          const gateway = await factory();
          await place(gateway, refs.known, "bugTodo", "todo");
          const target = {
            queue: "escalate" as AutomationQueue,
            from: "bugTodo" as AutomationQueue,
            state: "inReview" as WorkItemState,
          };
          await armMoveInterrupt(gateway, refs.known, 1);
          await expect(gateway.moveTo(refs.known, target)).rejects.toThrow();
          const before = opts.appliedOperations?.(gateway)?.filter((op) => op.applied).length ?? 0;
          await gateway.moveTo(refs.known, target);
          expect(await find(gateway, "escalate", "inReview")).toContain(refs.known);
          expect(await find(gateway, "bugTodo", "todo")).not.toContain(refs.known);
          if (!opts.appliedOperations) return;
          const ops = opts.appliedOperations(gateway) ?? [];
          expect(ops.filter((op) => op.applied).length - before).toBe(2);
        });
      }
    });
  };
}
