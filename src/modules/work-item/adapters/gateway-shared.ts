import type {
  AutomationQueue,
  ExecutionKey,
  MoveTarget,
  PipelineLabels,
  RefValidation,
  WorkItem,
  WorkItemConfig,
  WorkItemGateway,
  WorkItemNote,
  WorkItemQuery,
  WorkItemRef,
  WorkItemState,
} from "../../../contracts/index.js";
import { hasMarker, isPipelineNote } from "../../../contracts/index.js";
import type { ProcessResult } from "../process/runner.js";

export type {
  AutomationQueue,
  ExecutionKey,
  MoveTarget,
  PipelineLabels,
  WorkItem,
  WorkItemConfig,
  WorkItemGateway,
  WorkItemNote,
  WorkItemQuery,
  WorkItemRef,
  WorkItemState,
};
export { hasMarker };

const QUEUE_LABEL_KEYS: Record<AutomationQueue, keyof PipelineLabels> = {
  bugTodo: "bugTodo",
  featureTodo: "featureTodo",
  done: "done",
  escalate: "escalate",
};

const STATE_CONFIG_KEYS: Record<WorkItemState, "todoState" | "reviewState"> = {
  todo: "todoState",
  inReview: "reviewState",
};

const COMMON_SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]"],
  [/\b(authorization|x-api-key|cookie|set-cookie)\s*[:=]\s*\S+/gi, "$1: [redacted]"],
  [/(--?(?:token|password|api[-_]?key|secret)[=\s])\S+/g, "$1[redacted]"],
  [/([?&](?:token|api[-_]?key|apikey|access_token|password|jwt)=)[^&\s]+/gi, "$1[redacted]"],
  [/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1[redacted]@"],
];

const MAX_OUTPUT_CHARS = 400;

export interface MoveOperation {
  kind: "queue-add" | "queue-remove" | "state-set";
  value: string;
}

/** Keep provider metadata out of the human-facing work-item comments. */
export function humanComments(bodies: readonly string[]): string[] {
  return bodies
    .filter((body) => !isPipelineNote(body))
    .map((body) => body.trim())
    .filter((body) => body.length > 0);
}

/** Apply a planned move in order while leaving provider-specific mutations injectable. */
export async function applyMoveOperations<TState>(
  planned: readonly MoveOperation[],
  state: TState,
  handlers: {
    "queue-add": (value: string, state: TState) => Promise<void>;
    "queue-remove": (value: string, state: TState) => Promise<void>;
    "state-set": (value: string, state: TState) => Promise<void>;
  },
): Promise<void> {
  for (const operation of planned) await handlers[operation.kind](operation.value, state);
}

/** Plan, skip, load, and apply a move through one provider-neutral sequence. */
export async function performMove<TState>(
  target: MoveTarget,
  valueForQueue: (queue: AutomationQueue) => string,
  valueForState: (state: WorkItemState) => string,
  readState: () => Promise<TState>,
  handlers: Parameters<typeof applyMoveOperations<TState>>[2],
): Promise<void> {
  const planned = planMove(target, valueForQueue, valueForState);
  if (planned.length === 0) return;
  await applyMoveOperations(planned, await readState(), handlers);
}

/** Reconcile a failed write against fresh provider state before reporting failure. */
export async function reconcileMutation<TState>(
  action: () => Promise<ProcessResult>,
  readState: () => Promise<TState>,
  isApplied: (state: TState) => boolean,
  applyFreshState: (state: TState) => void,
  failure: (result: ProcessResult) => Error,
): Promise<boolean> {
  const result = await action();
  if (result.code === 0) return false;
  const fresh = await readState();
  if (!isApplied(fresh)) throw failure(result);
  applyFreshState(fresh);
  return true;
}

export function queueLabel(labels: PipelineLabels, queue: AutomationQueue): string {
  return labels[QUEUE_LABEL_KEYS[queue]];
}

export function configuredState(workItem: WorkItemConfig, state: WorkItemState): string {
  return workItem[STATE_CONFIG_KEYS[state]];
}

export function planMove(
  target: MoveTarget,
  valueForQueue: (queue: AutomationQueue) => string,
  valueForState: (state: WorkItemState) => string,
): MoveOperation[] {
  const planned: MoveOperation[] = [];
  if (target.queue) planned.push({ kind: "queue-add", value: valueForQueue(target.queue) });
  if (target.from) planned.push({ kind: "queue-remove", value: valueForQueue(target.from) });
  if (target.state) planned.push({ kind: "state-set", value: valueForState(target.state) });
  return planned;
}

export function refValidator(pattern: RegExp, invalidReason: (ref: string) => string): (ref: string) => RefValidation {
  return (ref) => (pattern.test(ref) ? { ok: true } : { ok: false, reason: invalidReason(ref) });
}

export function requireValidRef(validate: (ref: string) => RefValidation, ref: string): void {
  const check = validate(ref);
  if (!check.ok) throw new Error(check.reason);
}

export function redactProviderOutput(
  raw: string,
  providerSecretPatterns: ReadonlyArray<readonly [RegExp, string]>,
): string {
  let text = raw.trim();
  for (const [pattern, replacement] of [...providerSecretPatterns, ...COMMON_SECRET_PATTERNS]) {
    text = text.replace(pattern, replacement);
  }
  text = text.replace(/\s+/g, " ").trim();
  return text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}…` : text;
}

export function providerOutput(result: ProcessResult, unavailable: string, redact: (raw: string) => string): string {
  return result.code === 127 ? unavailable : redact(result.stderr || result.stdout || "");
}
