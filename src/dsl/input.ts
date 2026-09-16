import { errorMessage } from "../lib/errors.js";
import type { Artifact } from "../model/artifact.js";
import type { AsyncTemplated, PipelineContext } from "../model/context.js";
import type {
  FunctionInputCondition,
  InputAction,
  InputPolicy,
  InputPredicate,
  InputPredicateResult,
  StepInputCondition,
  When,
  WhenOutcome,
} from "../model/input.js";
import type { RunStopState } from "../model/persisted.js";

export type {
  CommandInputCondition,
  FrozenOnStart,
  FunctionInputCondition,
  InputAction,
  InputDecision,
  InputPolicy,
  InputPredicate,
  InputPredicateResult,
  StepInputCondition,
  When,
  WhenOutcome,
} from "../model/input.js";

function inputPolicy(action: InputAction, reason?: string): InputPolicy {
  return { action, reason };
}

export const skip = (reason?: string): InputPolicy => inputPolicy("skip", reason);
export const fail = (reason?: string): InputPolicy => inputPolicy("fail", reason);
export const stop = (reason?: string): InputPolicy => inputPolicy("stop", reason);

/** Fallback reasons the DSL supplies itself. They say nothing about WHICH guard
 *  refused, so — and only for them — the predicate is named alongside. An author
 *  who passes their own reason has already said what matters. */
const ENTRY_CONDITION = "entry condition not satisfied";
const NON_EXECUTION_CONDITION = "non-execution condition satisfied";
const SKIP_CONDITION = "skip condition satisfied";
const ENTRY_CONTRACT = "entry contract not satisfied";
const STOP_CONDITION = "stop condition satisfied";
const GENERIC_REASONS: ReadonlySet<string> = new Set([
  ENTRY_CONDITION,
  NON_EXECUTION_CONDITION,
  SKIP_CONDITION,
  ENTRY_CONTRACT,
  STOP_CONDITION,
]);

function isWhenOutcome(value: unknown): value is WhenOutcome {
  return value === "skip" || value === "fail" || value === "stop";
}

function normalizeSingleWhen(value: When, index: number): StepInputCondition {
  if (typeof value === "function") return unlessCondition("skip", value);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`when[${index}] must be a predicate or an object { if | unless | command, else? }`);
  }

  const record = value as Record<string, unknown>;
  const outcome = record.else ?? "skip";
  if (!isWhenOutcome(outcome)) {
    throw new Error(`when[${index}].else is invalid (expected: skip, fail, or stop)`);
  }
  const fields = (["if", "unless", "command"] as const).filter((field) => Object.hasOwn(record, field));
  if (fields.length !== 1) {
    throw new Error(`when[${index}] must define exactly one of if, unless, or command`);
  }
  const [field] = fields as [(typeof fields)[number]];
  if (field === "command") {
    if (typeof record.command !== "string" && typeof record.command !== "function") {
      throw new Error(`when[${index}].command must be a string or function`);
    }
    return {
      kind: "command",
      command: record.command as AsyncTemplated<PipelineContext>,
      onFailure: outcome,
    };
  }
  if (typeof record[field] !== "function") {
    throw new Error(`when[${index}].${field} must be a function`);
  }
  return field === "if"
    ? unlessCondition(outcome, record.if as InputPredicate)
    : decisionIf(outcome, record.unless as InputPredicate, NON_EXECUTION_CONDITION);
}

/** Normalize an admission or ordered list to the runtime `StepInputCondition` format. */
export function normalizeWhen(value: When | readonly When[] | undefined): StepInputCondition[] {
  if (value === undefined) return [];
  const values = Array.isArray(value) ? value : [value];
  return values.map((entry, index) => normalizeSingleWhen(entry as When, index));
}

/** Mark an admission as frozen on the step's first materialization. */
export function freezeOnStart(condition: StepInputCondition): StepInputCondition {
  return { ...condition, frozenOnStart: true };
}

function normalizePredicateResult(result: InputPredicateResult): { ok: boolean; reason?: string; stop?: RunStopState } {
  return typeof result === "boolean" ? { ok: result } : result;
}

/** Max source length of an inline lambda rendered in a skip reason. Beyond it the
 *  console line stops being readable and the journal gains nothing. */
const MAX_PREDICATE_SOURCE = 120;

/** Names that designate nothing: an inline lambda inherits the name of the property
 *  carrying it (`when`, `if`, `unless`), which does not say which guard refused. */
const ANONYMOUS_PREDICATE_NAMES = new Set(["", "when", "if", "unless", "predicate", "anonymous"]);

/**
 * Name the guard that refused.
 *
 * A predicate returning a `boolean` carries no `reason`: without this complement the
 * reason falls back to a constant (`entry condition not satisfied`) identical for
 * every guard of the pipeline, and the information is destroyed at the point of
 * production — `events.jsonl` knows no more than the terminal.
 *
 * A named predicate (`amendApplies`) gives its name; an inline lambda gives its
 * source, flattened onto one line and truncated.
 */
export function describePredicate(predicate: InputPredicate): string {
  const name = typeof predicate.name === "string" ? predicate.name : "";
  if (!ANONYMOUS_PREDICATE_NAMES.has(name)) return name;
  // `truncate` from `lib/truncate.js` appends a two-line note: unfit for a reason
  // that must fit on the skip line and inside a journal field.
  const source = predicate.toString().replace(/\s+/g, " ").trim();
  return source.length <= MAX_PREDICATE_SOURCE ? source : `${source.slice(0, MAX_PREDICATE_SOURCE)}…`;
}

function predicateCondition(
  action: InputAction,
  predicate: InputPredicate,
  fallbackReason: string,
  passWhen: boolean,
): FunctionInputCondition {
  return {
    kind: "function",
    async evaluate(ctx) {
      try {
        const result = normalizePredicateResult(await predicate(ctx));
        if (passWhen ? result.ok : !result.ok) return { action: "pass" };
        // The predicate did not say why: naming the guard beats the DSL's bare
        // constant, and this very string is what lands in `events.jsonl`. An
        // author-supplied reason is left alone — it already names its guard.
        const reason =
          result.reason ??
          (GENERIC_REASONS.has(fallbackReason) ? `${fallbackReason}: ${describePredicate(predicate)}` : fallbackReason);
        return { action, reason, ...(result.stop ? { stop: result.stop } : {}) };
      } catch (error) {
        return { action, reason: errorMessage(error) };
      }
    },
  };
}

function decisionIf(action: InputAction, predicate: InputPredicate, fallbackReason: string): FunctionInputCondition {
  return predicateCondition(action, predicate, fallbackReason, false);
}

/** Build the positive form of an admission contract. */
export function unlessCondition(
  action: InputAction,
  predicate: InputPredicate,
  fallbackReason = ENTRY_CONDITION,
): FunctionInputCondition {
  return predicateCondition(action, predicate, fallbackReason, true);
}

/** Trigger a skip when the predicate is true (or return its reason). */
export const skipIf = (predicate: InputPredicate, reason = SKIP_CONDITION): FunctionInputCondition =>
  decisionIf("skip", predicate, reason);

/** Trigger an admission failure when the predicate is true (or return its reason). */
export const failIf = (predicate: InputPredicate, reason = ENTRY_CONTRACT): FunctionInputCondition =>
  decisionIf("fail", predicate, reason);

/** Trigger a clean stop when the predicate is true (or return its reason). */
export const stopIf = (predicate: InputPredicate, reason = STOP_CONDITION): FunctionInputCondition =>
  decisionIf("stop", predicate, reason);

/** Require the predicate to be true; otherwise apply a skip policy. */
export const skipUnless = (predicate: InputPredicate, reason = ENTRY_CONDITION): FunctionInputCondition =>
  unlessCondition("skip", predicate, reason);

/** Require the predicate to be true; otherwise apply a failure policy. */
export const failUnless = (predicate: InputPredicate, reason = ENTRY_CONDITION): FunctionInputCondition =>
  unlessCondition("fail", predicate, reason);

/** Require the predicate to be true; otherwise stop the pipeline cleanly. */
export const stopUnless = (predicate: InputPredicate, reason = ENTRY_CONDITION): FunctionInputCondition =>
  unlessCondition("stop", predicate, reason);

/** Require an artifact's presence and shape, with a local policy. */
export function requireArtifact<T>(descriptor: Artifact<T>, policy: InputPolicy = fail()): FunctionInputCondition {
  return {
    kind: "function",
    async evaluate(ctx) {
      try {
        await descriptor.require(ctx);
        return { action: "pass" };
      } catch (error) {
        const reason = policy.reason ?? errorMessage(error);
        return { action: policy.action, reason };
      }
    },
  };
}

/** Bash form for project admission checks: non-zero exit means skip, output is the reason. */
function commandCondition(command: AsyncTemplated<PipelineContext>, onFailure: InputAction): StepInputCondition {
  return { kind: "command", command, onFailure };
}

export function skipUnlessCommand(command: AsyncTemplated<PipelineContext>): StepInputCondition {
  return commandCondition(command, "skip");
}

/** Positive bash form: non-zero exit means admission failure. */
export function failUnlessCommand(command: AsyncTemplated<PipelineContext>): StepInputCondition {
  return commandCondition(command, "fail");
}

/** Positive bash form: non-zero exit means a clean stop. */
export function stopUnlessCommand(command: AsyncTemplated<PipelineContext>): StepInputCondition {
  return commandCondition(command, "stop");
}
