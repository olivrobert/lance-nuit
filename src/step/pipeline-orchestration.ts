// runner/step/pipeline-orchestration.ts
//
// Execute `runPipeline` and `forEachPipeline` nodes. A child call is a real run
// with its own snapshot and events, but this loop drives it; pipelines never
// reinvoke the runner binary.

import { errorMessage } from "../lib/errors.js";
import type { PipelineLot } from "../model/context.js";
import type { PipelineInvocationDefinition, PipelineOrchestrationDefinition } from "../model/definition.js";
import { resolveTemplateAsync } from "../model/definition.js";
import type { PersistedPipelineChildRef, PersistedPipelineOrchestrationState } from "../model/persisted.js";
import type { RunStep } from "../model/run.js";
import {
  commitChildCall,
  declareChild,
  failChildLaunch,
  isChildSettled,
  skipChild,
} from "../state/child-transitions.js";
import { saveRun } from "../state/run-repository.js";
import { recordStepVerdict, updateStep } from "../state/run-transitions.js";
import { childLaunchGate, executeChild } from "./pipeline-orchestration-child.js";
import type {
  ChildExecutionResult,
  PipelineOrchestrationInput,
  PipelineOrchestrationResult,
} from "./pipeline-orchestration-types.js";
import { childContext, currentLineage, evaluatePredicate, resolveTicket } from "./pipeline-orchestration-resolution.js";

/** Convert every child failure into the same parent-step transition. */
function childFailure(
  input: PipelineOrchestrationInput,
  result: ChildExecutionResult,
): PipelineOrchestrationResult | undefined {
  if (result.ok) return undefined;
  // The parent step is only the carrier of the child's answer. Recorded before
  // the transition: `updateStep` stamps the run outcome from `fail_kind` and
  // `fail_cause`, which is what the final report reads to choose between
  // "Quality check failed" and "Technical error".
  recordStepVerdict(input.run, input.step, { ok: false, failKind: result.failKind, failCause: result.failCause });
  updateStep(input.run, input.step, "failed", result.reason);
  return {
    action: result.stopped ? "stopped" : "failed",
    budgetExceeded: !!result.budgetExceeded,
    ...(result.costUnaccounted ? { costUnaccounted: true } : {}),
    ...(result.costUnaccountedStop ? { costUnaccountedStop: true } : {}),
  };
}

function ensureState(step: RunStep, def: PipelineOrchestrationDefinition): PersistedPipelineOrchestrationState {
  const current = step.orchestration;
  if (current) {
    if (current.kind !== def.kind) throw new Error(`Step "${step.id}": orchestration type changed during resume`);
    return current;
  }
  const state: PersistedPipelineOrchestrationState = {
    kind: def.kind,
    children: [],
  };
  step.orchestration = state;
  return state;
}

function invocationForMain(def: PipelineOrchestrationDefinition, ticket?: string): PipelineInvocationDefinition {
  return def.kind === "runPipeline"
    ? { pipeline: def.pipeline, ...(def.ticket !== undefined ? { ticket: def.ticket } : {}) }
    : { pipeline: def.pipeline, ticket };
}

function refTicket(ref: PersistedPipelineChildRef, fallback?: string): string | undefined {
  return ref.ticket ?? fallback;
}

async function executeCallback(
  input: PipelineOrchestrationInput,
  state: PersistedPipelineOrchestrationState,
  step: RunStep,
  callback: PipelineInvocationDefinition,
  key: string,
  kind: PersistedPipelineChildRef["kind"],
  defaultTicket: string | undefined,
  defaultLot: PipelineLot | undefined,
): Promise<ChildExecutionResult> {
  // Loop callbacks run in the current item context: `ticket: ctx => ctx.ticket`
  // must identify the child, not the work item owning the orchestration node.
  const existing = state.children.find((candidate) => candidate.key === key);
  if (existing && isChildSettled(existing)) return { ok: true };
  // Same gate as a child launch, and for the same reason: an `afterEach` or
  // `afterAll` pipeline is real spend. Evaluated before the ticket and the child
  // reference exist, so a refused callback leaves nothing behind to resume from.
  const gate = childLaunchGate(input.run, input.budget, `callback ${key}`, input.step.id);
  if (gate) return gate;
  const evaluationCtx = childContext(input.baseCtx, defaultTicket, defaultLot);
  const ticket = existing?.ticket ?? (await resolveTicket(callback.ticket, evaluationCtx, defaultTicket));
  const ref = declareChild(input.run, state, { key, kind, pipeline: callback.pipeline, ticket, lot: defaultLot });

  // The `when` predicate is evaluated once: its answer is persisted as this
  // call's outcome (skipped, failed, or committed), and resume never
  // reinterprets it.
  if (ref.status === "pending") {
    const callbackCtx = childContext(input.baseCtx, ticket, defaultLot);
    const predicate = await evaluatePredicate(callback.when, callbackCtx);
    if (!predicate.ok) {
      if (predicate.threw) {
        failChildLaunch(input.run, ref, step.id, predicate.reason ?? "composition predicate failed");
        return { ok: false, reason: predicate.reason };
      }
      skipChild(input.run, ref, step.id, predicate.reason ?? "condition not met");
      return { ok: true };
    }
    commitChildCall(input.run, ref);
  }

  return executeChild(input, ref, callback, defaultTicket, defaultLot);
}

async function executeRunPipeline(
  input: PipelineOrchestrationInput,
  def: Extract<PipelineOrchestrationDefinition, { kind: "runPipeline" }>,
  state: PersistedPipelineOrchestrationState,
): Promise<PipelineOrchestrationResult> {
  const existing = state.children.find((candidate) => candidate.key === "main");
  const ticket = existing?.ticket ?? (await resolveTicket(def.ticket, input.baseCtx, input.baseCtx.ticket));
  const ref = declareChild(input.run, state, { key: "main", kind: "main", pipeline: def.pipeline, ticket });
  const result = await executeChild(input, ref, invocationForMain(def, ticket), ticket, undefined);
  const failure = childFailure(input, result);
  if (failure) return failure;
  updateStep(input.run, input.step, "done");
  return { action: "continue", budgetExceeded: false };
}

async function executeForEachPipeline(
  input: PipelineOrchestrationInput,
  def: Extract<PipelineOrchestrationDefinition, { kind: "forEachPipeline" }>,
  state: PersistedPipelineOrchestrationState,
): Promise<PipelineOrchestrationResult> {
  if (!state.items) {
    const raw = (await resolveTemplateAsync(def.items, input.baseCtx)) as unknown;
    if (!Array.isArray(raw) || !raw.every((item) => typeof item === "string" && item.trim())) {
      updateStep(
        input.run,
        input.step,
        "failed",
        "forEachPipeline().items must return a list of non-empty ticket identifiers",
      );
      return { action: "failed", budgetExceeded: false };
    }
    state.items = [...raw];
    saveRun(input.run);
  }

  for (const [index, item] of state.items.entries()) {
    if (input.abort.isRunAborted(input.run)) return { action: "stopped", budgetExceeded: false };
    const ticket = await resolveTicket(def.ticket, input.baseCtx, item);
    const lot = def.lot ? await def.lot(input.baseCtx, item) : undefined;
    const mainRef = declareChild(input.run, state, {
      key: `main:${index}`,
      kind: "main",
      pipeline: def.pipeline,
      ticket,
      lot,
    });
    const mainResult = await executeChild(input, mainRef, invocationForMain(def, ticket ?? item), ticket ?? item, lot);
    const mainFailure = childFailure(input, mainResult);
    if (mainFailure) return mainFailure;

    if (def.afterEach) {
      const after = await executeCallback(
        input,
        state,
        input.step,
        def.afterEach,
        `afterEach:${index}`,
        "afterEach",
        refTicket(mainRef, ticket ?? item),
        mainRef.lot,
      );
      const afterFailure = childFailure(input, after);
      if (afterFailure) return afterFailure;
    }
  }

  if (def.afterAll) {
    const after = await executeCallback(
      input,
      state,
      input.step,
      def.afterAll,
      "afterAll",
      "afterAll",
      input.baseCtx.ticket,
      undefined,
    );
    const afterFailure = childFailure(input, after);
    if (afterFailure) return afterFailure;
  }

  updateStep(input.run, input.step, "done");
  return { action: "continue", budgetExceeded: false };
}

/** Entry point called by step-loop after node admission. */
export async function executePipelineOrchestration(
  input: PipelineOrchestrationInput,
): Promise<PipelineOrchestrationResult> {
  const def = input.step.def.orchestration;
  if (!def) {
    updateStep(input.run, input.step, "failed", "orchestration definition missing");
    return { action: "failed", budgetExceeded: false };
  }
  const state = ensureState(input.step, def);
  currentLineage(input.run);
  saveRun(input.run);
  try {
    return def.kind === "runPipeline"
      ? await executeRunPipeline(input, def, state)
      : await executeForEachPipeline(input, def, state);
  } catch (error) {
    // Nothing to reconstruct here: each child posts its delta during reconciliation,
    // so already-spent cost is already in the budget.
    if (input.abort.isRunAborted(input.run)) return { action: "stopped", budgetExceeded: false };
    updateStep(input.run, input.step, "failed", errorMessage(error).trim());
    return { action: "failed", budgetExceeded: false };
  }
}
