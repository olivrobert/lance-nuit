// modules/work-item/fake.ts
//
// In-memory port implementation used as the test reference.
//
// This is not a permissive stub: it applies marker idempotency and decomposes
// `moveTo` into observable primitive operations. It can therefore run the same
// contract suite as a real adapter; a fake that always succeeds would prove
// nothing about the resume contract.
//
// It deliberately accepts both reference formats used by providers; enforcing
// one provider's convention would make the other adapter's tests fail for an
// unrelated reason.

import type {
  AutomationQueue,
  ExecutionKey,
  MoveTarget,
  RefValidation,
  WorkItem,
  WorkItemGateway,
  WorkItemNote,
  WorkItemQuery,
  WorkItemRef,
  WorkItemState,
} from "../../contracts/work-items.js";
import { hasMarker, isPipelineNote, renderMarkdown, renderPlainText } from "../../contracts/work-items.js";

/** Seed ticket. Most tests do not care about content, so title and description
 * default to values derived from the reference. */
export interface FakeWorkItemSeedItem {
  ref: WorkItemRef;
  title?: string;
  description?: string;
  queues?: AutomationQueue[];
  state?: WorkItemState;
  /** Terminal provider state, independent of `state` because WorkItemState only
   * describes states the runner can produce. Defaults to false. */
  closed?: boolean;
  /** Existing human exchanges, oldest first. Gateway notes are added during
   * execution and removed on read, as a real provider would do. */
  comments?: string[];
}

export type FakeOperation = "fetch" | "findCandidates" | "comment" | "moveTo";

/**
 * Simulated failure. `afterOps` applies only to `moveTo`: it fails after a given
 * number of primitive operations, reproducing a crash in a multi-operation move.
 */
export interface FakeFailure {
  op: FakeOperation;
  ref?: WorkItemRef;
  kind?: "timeout" | "error";
  message?: string;
  afterOps?: number;
  /** Consume on first trigger so a successful replay can be tested. Defaults to
   * true because permanent failures are rarely useful in a simulation. */
  once?: boolean;
}

export interface FakeWorkItemSeed {
  items?: FakeWorkItemSeedItem[];
  /** Note rendering. Defaults to `plain`, the stricter no-markup contract. */
  rendering?: "plain" | "markdown";
  failures?: FakeFailure[];
  provider?: string;
}

export interface FakePostedNote {
  ref: WorkItemRef;
  body: string;
}

/** Primitive operation traversed by `moveTo`. `applied: false` means the state was
 * already compliant; it records idempotency rather than failure. */
export interface FakeAppliedOperation {
  ref: WorkItemRef;
  kind: "queue-add" | "queue-remove" | "state-set";
  value: string;
  applied: boolean;
}

/** Gateway calls, in order. */
export interface FakeCall {
  op: FakeOperation;
  ref?: WorkItemRef;
  /** Provider-native query forwarded by a `findCandidates` call, when any. */
  query?: string;
}

export interface FakeWorkItemGateway extends WorkItemGateway {
  /** Stored notes in publication order. */
  readonly notes: readonly FakePostedNote[];
  /** Primitive `moveTo` operation log. */
  readonly ops: readonly FakeAppliedOperation[];
  /** Port call log, including failures. */
  readonly calls: readonly FakeCall[];
  bodiesOf(ref: WorkItemRef): string[];
  queuesOf(ref: WorkItemRef): AutomationQueue[];
  stateOf(ref: WorkItemRef): WorkItemState;
  /** Arm a failure for matching future calls. */
  armFailure(failure: FakeFailure): void;
  clearFailures(): void;
  /** Simulate a human rewriting the ticket description. */
  setDescription(ref: WorkItemRef, description: string): void;
  /** Simulate a human replying with a comment. */
  addComment(ref: WorkItemRef, body: string): void;
}

interface FakeItem {
  ref: WorkItemRef;
  title: string;
  description: string;
  queues: AutomationQueue[];
  state: WorkItemState;
  closed: boolean;
  comments: string[];
  bodies: string[];
}

/** Comments visible through the port. Pipeline notes are removed as a real adapter
 * would do; storing both sources together makes the filter observable. */
function humanComments(item: FakeItem): string[] {
  return [...item.comments, ...item.bodies].filter((body) => !isPipelineNote(body));
}

/** Accept both project-number keys and numeric identifiers; the fake does not
 * choose between provider conventions. */
const REF_KEY = /^[A-Za-z][A-Za-z0-9]*-\d+$/;
const REF_NUMERIC = /^\d+$/;

export function createFakeWorkItemGateway(seed: FakeWorkItemSeed = {}): FakeWorkItemGateway {
  const provider = seed.provider ?? "fake";
  const rendering = seed.rendering ?? "plain";
  const items = new Map<WorkItemRef, FakeItem>();
  const notes: FakePostedNote[] = [];
  const ops: FakeAppliedOperation[] = [];
  const calls: FakeCall[] = [];
  let failures: FakeFailure[] = [...(seed.failures ?? [])];

  for (const item of seed.items ?? []) {
    items.set(item.ref, {
      ref: item.ref,
      title: item.title ?? `Ticket ${item.ref}`,
      description: item.description ?? `Description de ${item.ref}`,
      queues: [...(item.queues ?? [])],
      state: item.state ?? "todo",
      closed: item.closed ?? false,
      comments: [...(item.comments ?? [])],
      bodies: [],
    });
  }

  const validateRef = (ref: string): RefValidation =>
    REF_KEY.test(ref) || REF_NUMERIC.test(ref)
      ? { ok: true }
      : { ok: false, reason: `${provider}: invalid reference "${ref}" (expected PROJ-123 or 123)` };

  function takeFailure(op: FakeOperation, ref?: WorkItemRef): FakeFailure | undefined {
    const index = failures.findIndex((f) => f.op === op && (f.ref === undefined || f.ref === ref));
    if (index < 0) return undefined;
    const failure = failures[index]!;
    if (failure.once !== false) failures.splice(index, 1);
    return failure;
  }

  function raise(failure: FakeFailure, op: FakeOperation, ref?: WorkItemRef): never {
    const suffix = ref ? ` on ${ref}` : "";
    throw new Error(
      failure.message ??
        (failure.kind === "error" ? `${provider}: ${op} failed${suffix}` : `${provider}: timeout on ${op}${suffix}`),
    );
  }

  function mustGet(ref: WorkItemRef): FakeItem {
    const check = validateRef(ref);
    if (!check.ok) throw new Error(check.reason);
    const item = items.get(ref);
    if (!item) throw new Error(`${provider}: ticket ${ref} not found`);
    return item;
  }

  /** Plan primitive move operations in a fixed order. Add the target queue first,
   * so an immediate crash never leaves a ticket outside every scan queue. */
  function plan(item: FakeItem, target: MoveTarget): FakeAppliedOperation[] {
    const planned: FakeAppliedOperation[] = [];
    if (target.queue) planned.push({ ref: item.ref, kind: "queue-add", value: target.queue, applied: false });
    if (target.from) planned.push({ ref: item.ref, kind: "queue-remove", value: target.from, applied: false });
    if (target.state) planned.push({ ref: item.ref, kind: "state-set", value: target.state, applied: false });
    return planned;
  }

  /** Apply one primitive operation. Return false for an already-compliant state;
   * each operation is individually idempotent. */
  function apply(item: FakeItem, op: FakeAppliedOperation): boolean {
    if (op.kind === "queue-add") {
      const queue = op.value as AutomationQueue;
      if (item.queues.includes(queue)) return false;
      item.queues.push(queue);
      return true;
    }
    if (op.kind === "queue-remove") {
      const queue = op.value as AutomationQueue;
      if (!item.queues.includes(queue)) return false;
      item.queues = item.queues.filter((q) => q !== queue);
      return true;
    }
    const state = op.value as WorkItemState;
    if (item.state === state) return false;
    item.state = state;
    return true;
  }

  return {
    provider,
    validateRef,

    async fetch(ref: WorkItemRef): Promise<WorkItem> {
      calls.push({ op: "fetch", ref });
      const failure = takeFailure("fetch", ref);
      if (failure) raise(failure, "fetch", ref);
      const item = mustGet(ref);
      return {
        ref: item.ref,
        title: item.title,
        description: item.description,
        closed: item.closed,
        comments: humanComments(item),
      };
    },

    async findCandidates(query: WorkItemQuery): Promise<WorkItemRef[]> {
      // The fake has no query language: it records the forwarded query so the
      // dispatch can be tested, and keeps selecting on queue/state.
      calls.push({ op: "findCandidates", ...(query.query === undefined ? {} : { query: query.query }) });
      const failure = takeFailure("findCandidates");
      if (failure) raise(failure, "findCandidates");
      // Map insertion order is stable, so a limited scan defers the same tickets
      // on every call.
      return [...items.values()]
        .filter((item) => item.queues.includes(query.queue) && item.state === query.state)
        .map((item) => item.ref);
    },

    async comment(ref: WorkItemRef, note: WorkItemNote, key: ExecutionKey): Promise<void> {
      calls.push({ op: "comment", ref });
      const failure = takeFailure("comment", ref);
      if (failure) raise(failure, "comment", ref);
      const item = mustGet(ref);
      // Idempotency checks already-stored notes, not runner-local state: the
      // provider is authoritative.
      if (item.bodies.some((body) => hasMarker(body, key))) return;
      const body = rendering === "markdown" ? renderMarkdown(note, key) : renderPlainText(note, key);
      item.bodies.push(body);
      notes.push({ ref, body });
    },

    async moveTo(ref: WorkItemRef, target: MoveTarget): Promise<void> {
      calls.push({ op: "moveTo", ref });
      const failure = takeFailure("moveTo", ref);
      const item = mustGet(ref);
      const budget = failure ? (failure.afterOps ?? 0) : Number.POSITIVE_INFINITY;
      let done = 0;
      for (const op of plan(item, target)) {
        if (done >= budget) raise(failure!, "moveTo", ref);
        op.applied = apply(item, op);
        ops.push(op);
        done += 1;
      }
      // If the move is shorter than afterOps, fail anyway; otherwise the armed
      // failure would be silently swallowed.
      if (done < budget && failure) raise(failure, "moveTo", ref);
    },

    notes,
    ops,
    calls,
    bodiesOf: (ref: WorkItemRef) => [...(items.get(ref)?.bodies ?? [])],
    queuesOf: (ref: WorkItemRef) => [...(items.get(ref)?.queues ?? [])],
    stateOf: (ref: WorkItemRef) => items.get(ref)?.state ?? "todo",
    armFailure: (failure: FakeFailure) => {
      failures.push(failure);
    },
    clearFailures: () => {
      failures = [];
    },
    setDescription: (ref: WorkItemRef, description: string) => {
      mustGet(ref).description = description;
    },
    addComment: (ref: WorkItemRef, body: string) => {
      mustGet(ref).comments.push(body);
    },
  };
}
