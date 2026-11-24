//
// Execute `runPipeline` and `forEachPipeline` nodes. A child call is a real run
// with its own snapshot and events, but this loop drives it; pipelines never
// reinvoke the runner binary.

import { errorMessage } from "../../shared/lib/errors.js";
import type { PipelineLot } from "../../shared/language/context.js";
import type { PipelineInvocationDefinition, PipelineOrchestrationDefinition } from "../../definition/index.js";
import { resolveTemplateAsync } from "../../shared/language/context.js";
import type { ChildRefView, OrchestrationView, RunStepView } from "../../run/index.js";
import {
  commitChildCall,
  declareChild,
  failChildLaunch,
  freezeOrchestrationItems,
  isChildSettled,
  openOrchestration,
  recordStepVerdict,
  skipChild,
  updateStep,
} from "../../run/index.js";
import { childLaunchGate, executeChild } from "./pipeline-orchestration-child.js";
import type { PipelineOrchestrationInput } from "./pipeline-orchestration-types.js";
import { DONE, failed, type StepIssue, stopped } from "./step-issue.js";
import { childContext, currentLineage, evaluatePredicate, resolveTicket } from "./pipeline-orchestration-resolution.js";

/** Convert every child failure into the same parent-step transition. */
function childFailure(input: PipelineOrchestrationInput, result: StepIssue): StepIssue | undefined {
  if (result.kind !== "failed" && result.kind !== "stopped") return undefined;
  // The parent step is only the carrier of the child's answer. Recorded before
  // the transition: `updateStep` stamps the run outcome from `fail_kind` and
  // `fail_cause`, which is what the final report reads to choose between
  // "Quality check failed" and "Technical error".
  recordStepVerdict(input.run, input.step, { ok: false, failKind: result.failKind, failCause: result.failCause });
  updateStep(input.run, input.step, "failed", result.reason);
  return result;
}

function invocationForMain(def: PipelineOrchestrationDefinition, ticket?: string): PipelineInvocationDefinition {
  return def.kind === "runPipeline"
    ? { pipeline: def.pipeline, ...(def.ticket !== undefined ? { ticket: def.ticket } : {}) }
    : { pipeline: def.pipeline, ticket };
}

function refTicket(ref: ChildRefView, fallback?: string): string | undefined {
  return ref.ticket ?? fallback;
}

async function executeCallback(
  input: PipelineOrchestrationInput,
  state: OrchestrationView,
  step: RunStepView,
  callback: PipelineInvocationDefinition,
  key: string,
  kind: ChildRefView["kind"],
  defaultTicket: string | undefined,
  defaultLot: PipelineLot | undefined,
): Promise<StepIssue> {
  // Loop callbacks run in the current item context: `ticket: ctx => ctx.ticket`
  // must identify the child, not the work item owning the orchestration node.
  const existing = state.children.find((candidate) => candidate.key === key);
  if (existing && isChildSettled(existing)) return DONE;
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
        return failed({ reason: predicate.reason });
      }
      skipChild(input.run, ref, step.id, predicate.reason ?? "condition not met");
      return DONE;
    }
    commitChildCall(input.run, ref);
  }

  return executeChild(input, ref, callback, defaultTicket, defaultLot);
}

async function executeRunPipeline(
  input: PipelineOrchestrationInput,
  def: Extract<PipelineOrchestrationDefinition, { kind: "runPipeline" }>,
  state: OrchestrationView,
): Promise<StepIssue> {
  const existing = state.children.find((candidate) => candidate.key === "main");
  const ticket = existing?.ticket ?? (await resolveTicket(def.ticket, input.baseCtx, input.baseCtx.ticket));
  const ref = declareChild(input.run, state, { key: "main", kind: "main", pipeline: def.pipeline, ticket });
  const result = await executeChild(input, ref, invocationForMain(def, ticket), ticket, undefined);
  const failure = childFailure(input, result);
  if (failure) return failure;
  updateStep(input.run, input.step, "done");
  return DONE;
}

async function executeForEachPipeline(
  input: PipelineOrchestrationInput,
  def: Extract<PipelineOrchestrationDefinition, { kind: "forEachPipeline" }>,
  state: OrchestrationView,
): Promise<StepIssue> {
  let items = state.items;
  if (!items) {
    const raw = (await resolveTemplateAsync(def.items, input.baseCtx)) as unknown;
    if (!Array.isArray(raw) || !raw.every((item) => typeof item === "string" && item.trim())) {
      updateStep(
        input.run,
        input.step,
        "failed",
        "forEachPipeline().items must return a list of non-empty ticket identifiers",
      );
      return failed();
    }
    items = freezeOrchestrationItems(input.run, state, raw);
  }

  for (const [index, item] of items.entries()) {
    if (input.abort.isRunAborted(input.run)) return stopped();
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
  return DONE;
}

/** Entry point called by step-pass after node admission. */
export async function executePipelineOrchestration(input: PipelineOrchestrationInput): Promise<StepIssue> {
  const def = input.step.def.orchestration;
  if (!def) {
    updateStep(input.run, input.step, "failed", "orchestration definition missing");
    return failed();
  }
  const state = openOrchestration(input.run, input.step, def.kind, currentLineage(input.run));
  try {
    return def.kind === "runPipeline"
      ? await executeRunPipeline(input, def, state)
      : await executeForEachPipeline(input, def, state);
  } catch (error) {
    // Nothing to reconstruct here: each child posts its delta during reconciliation,
    // so already-spent cost is already in the budget.
    if (input.abort.isRunAborted(input.run)) return stopped();
    updateStep(input.run, input.step, "failed", errorMessage(error).trim());
    return failed();
  }
}
