// pipelines/lib/work-item-steps.ts
//
// Deterministic tracker-control steps. They replaced escalation and delivery
// prompts run by a haiku agent: same effect, but decided by code, so replayable and
// testable without a model. The properties below come from those prompts and are
// documented here because no other record of their intent remains.
//
// Two properties inherited from the prompts must not be lost:
//
//  1. IDEMPOTENCE. A run can be retried and a step replayed on resume. The
//     `{ ticket, stepId }` execution key lets the adapter recognize an already
//     published note; it must therefore never include a run or attempt number.
//
//  2. FAILURE TOLERANCE. Every prompt ended with “if a command fails, continue
//     without crashing”: an unreachable tracker must not fail a run whose code is
//     already pushed. We keep that behavior WITHOUT making it silent: steps are
//     `blocking(false)` and throw on failure; the runner persists the message in
//     `step.errors`, displays a warning (`⚠`), and includes it in run stats while
//     continuing (see `step-loop.ts`). Swallowing the exception would make a silent
//     tracker indistinguishable from an up-to-date one.
//
// Every port operation is attempted even when the previous one failed: this is the
// original prompt's “continue” behavior and prevents a failed note from keeping a
// ticket in the work queue.

import type { ExecutionKey, MoveTarget, WorkItemNote } from "../../contracts/work-items.js";
// Focused imports on purpose: the `../../dsl.js` barrel re-exports this module
// (via human-review), and importing it back here would evaluate the class
// hierarchy before `ActionStepBuilder` is initialized (circular-import TDZ).
import { ActionStepBuilder } from "../../dsl/dsl-steps.js";
import { skipUnless } from "../../dsl/input.js";
import { inferredPipelineWorkItemSource } from "../../dsl/work-item-assembly.js";
import { errorMessage } from "../../lib/errors.js";
import type { PipelineContext } from "../../model/context.js";
import type { ProjectEscalation, ProjectEscalationStepOptions } from "./public-work-item.js";
import { deliveryNote } from "./work-item-notes.js";

/** Readable movement description for logs and the step summary. */
function describeMove(target: MoveTarget): string {
  const parts: string[] = [];
  if (target.queue) parts.push(`queue ${target.queue}`);
  if (target.from) parts.push(`leaving ${target.from}`);
  if (target.state) parts.push(`state ${target.state}`);
  return parts.join(" + ");
}

interface OperationOutcome {
  label: string;
  error?: string;
}

/**
 * Applies the note (when provided) and then the move to the current ticket, attempting both whatever
 * happens. Returns a readable summary on success; otherwise throws with details of
 * what succeeded and failed. Since the step is `blocking(false)`, the exception is
 * persisted as a warning rather than making the run red.
 */
async function applyWorkItemEffects(
  ctx: PipelineContext,
  stepId: string,
  effects: { note?: WorkItemNote; move: MoveTarget; extraFailures?: string[] },
): Promise<string> {
  const ticket = ctx.ticket;
  if (!ticket) throw new Error(`${stepId}: ticket missing — no work item to update`);

  const gateway = ctx.workItem;
  const key: ExecutionKey = { ticket, stepId };
  const outcomes: OperationOutcome[] = (effects.extraFailures ?? []).map((error) => ({
    label: "note data resolution",
    error,
  }));

  const attempt = async (label: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
      outcomes.push({ label });
    } catch (error) {
      outcomes.push({ label, error: errorMessage(error) });
    }
  };

  const note = effects.note;
  if (note !== undefined) {
    await attempt("note published", () => gateway.comment(ticket, note, key));
  }
  await attempt(describeMove(effects.move), () => gateway.moveTo(ticket, effects.move));

  const failed = outcomes.filter((outcome) => outcome.error);
  const ok = outcomes.filter((outcome) => !outcome.error).map((outcome) => outcome.label);
  if (failed.length === 0) return `${gateway.provider} ${ticket} : ${ok.join(", ")}`;

  const detail = failed.map((outcome) => `${outcome.label} (${outcome.error})`).join("; ");
  throw new Error(
    `${gateway.provider} ${ticket}: ${failed.length} operation(s) failed — ${detail}` +
      (ok.length > 0 ? `; applied: ${ok.join(", ")}` : ""),
  );
}

/** Converts the simple public form into a provider-neutral structured note. */
export function projectEscalationNote(escalation: ProjectEscalation): WorkItemNote {
  if (!escalation || typeof escalation !== "object") {
    throw new Error("escalation must return an object");
  }
  for (const field of ["cause", "state", "action"] as const) {
    if (typeof escalation[field] !== "string" || escalation[field].trim().length === 0) {
      throw new Error(`escalation.${field} must be a non-empty string`);
    }
  }
  const details = escalation.details ?? {};
  if (typeof details !== "object" || details === null || Array.isArray(details)) {
    throw new Error("escalation.details must be an object of strings");
  }
  const fields = Object.entries(details).map(([label, value]) => {
    if (typeof value !== "string") throw new Error(`escalation.details.${label} must be a string`);
    return { label, value };
  });

  return {
    headline: `🤖 Escalation — ${escalation.cause}.`,
    fields: [...fields, { label: "State", value: escalation.state }, { label: "Action", value: escalation.action }],
  };
}

type PublicArtifactResolution<T> = { ok: true; value: T } | { ok: false; reason: string };

/** Shared resolution for escalation and a human-review gate. */
type ReviewResolution<T> = { kind: "skip"; reason: string } | { kind: "review"; value: T };

type PublicReviewOptions<T> = ProjectEscalationStepOptions<T>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validatePublicEscalationOptions<T>(opts: unknown, fallbackId: string): asserts opts is PublicReviewOptions<T> {
  if (!isRecord(opts)) {
    throw new Error(`Step "${fallbackId}": invalid public escalation options`);
  }

  const artifact = opts.artifact;
  if (
    !isRecord(artifact) ||
    typeof artifact.name !== "string" ||
    artifact.name.trim().length === 0 ||
    typeof artifact.read !== "function" ||
    typeof artifact.require !== "function" ||
    typeof artifact.remove !== "function"
  ) {
    throw new Error(`Step "${fallbackId}": artifact missing or invalid artifact descriptor`);
  }

  if (opts.onlyIf !== undefined && typeof opts.onlyIf !== "function") {
    throw new Error(`Step "${fallbackId}": onlyIf must be a function`);
  }

  const hasEscalation = "escalation" in opts && opts.escalation !== undefined;
  const hasNote = "note" in opts && opts.note !== undefined;
  if (hasEscalation === hasNote) {
    throw new Error(`Step "${fallbackId}": provide exactly one escalation or note callback`);
  }
  if (hasEscalation && typeof opts.escalation !== "function") {
    throw new Error(`Step "${fallbackId}": escalation must be a function`);
  }
  if (hasNote && typeof opts.note !== "function") {
    throw new Error(`Step "${fallbackId}": note must be a function`);
  }
}

function validateWorkItemNote(value: unknown, stepId: string): asserts value is WorkItemNote {
  if (!isRecord(value) || typeof value.headline !== "string" || value.headline.trim().length === 0) {
    throw new Error(`${stepId}: note must have a non-empty headline`);
  }
  if (!Array.isArray(value.fields)) {
    throw new Error(`${stepId}: note.fields must be an array`);
  }
  for (const [index, field] of value.fields.entries()) {
    if (
      !isRecord(field) ||
      typeof field.label !== "string" ||
      field.label.trim().length === 0 ||
      typeof field.value !== "string"
    ) {
      throw new Error(`${stepId}: note.fields[${index}] must contain label and value`);
    }
  }
  if (value.footer !== undefined && typeof value.footer !== "string") {
    throw new Error(`${stepId}: note.footer must be a string`);
  }
}

function createReviewResolver<T>(opts: PublicReviewOptions<T>): {
  resolve(ctx: PipelineContext): Promise<ReviewResolution<T>>;
} {
  const resolutions = new WeakMap<PipelineContext, Promise<ReviewResolution<T>>>();

  return {
    resolve(ctx): Promise<ReviewResolution<T>> {
      const cached = resolutions.get(ctx);
      if (cached) return cached;

      const resolution = (async (): Promise<ReviewResolution<T>> => {
        try {
          const value = await opts.artifact.read(ctx);
          if (value === undefined) {
            return { kind: "skip", reason: `artifact ${opts.artifact.name} not found` };
          }
          if (opts.onlyIf && !(await opts.onlyIf(value, ctx))) {
            return { kind: "skip", reason: "onlyIf=false" };
          }
          return { kind: "review", value };
        } catch (error) {
          return {
            kind: "skip",
            reason: `artifact ${opts.artifact?.name ?? "?"} missing or invalid: ${errorMessage(error)}`,
          };
        }
      })();
      resolutions.set(ctx, resolution);
      return resolution;
    },
  };
}

/** Builder injected into the project DSL. It learns its source queue only after the
 *  PipelineBuilder has gathered every source declaration. */
class PublicWorkItemEscalateStepBuilder<T> extends ActionStepBuilder {
  private readonly reviewResolver: { resolve(ctx: PipelineContext): Promise<ReviewResolution<T>> };

  constructor(private readonly opts: ProjectEscalationStepOptions<T>) {
    super(opts.id ?? "escalate", opts.name ?? "Escalate work item (note + leave queue)");
    this.reviewResolver = createReviewResolver(opts);
  }

  private resolveArtifact(ctx: PipelineContext): Promise<PublicArtifactResolution<T>> {
    return this.reviewResolver
      .resolve(ctx)
      .then((result) =>
        result.kind === "review" ? { ok: true, value: result.value } : { ok: false, reason: result.reason },
      );
  }

  build(): ReturnType<ActionStepBuilder["build"]> {
    const id = this.opts.id ?? "escalate";
    validatePublicEscalationOptions<T>(this.opts, id);
    const source = inferredPipelineWorkItemSource(this);
    const from = source?.queue;
    if (!from) {
      throw new Error(
        `Step "${this.opts.id ?? "escalate"}": no identifiable work-item source queue — ` +
          `declare forEachWorkItem({ queue: "bugTodo" | "featureTodo", do: [...] }) in the pipeline`,
      );
    }

    this.applyInputs(
      skipUnless(async (ctx) => {
        const result = await this.resolveArtifact(ctx);
        return result.ok ? true : { ok: false, reason: result.reason };
      }, "escalation artifact missing or invalid"),
    );
    this.run(async (ctx) => {
      const result = await this.resolveArtifact(ctx);
      if (!result.ok) return `escalation skipped: ${result.reason}`;

      const note =
        "escalation" in this.opts && this.opts.escalation
          ? projectEscalationNote(await this.opts.escalation(result.value, ctx))
          : await this.opts.note(result.value, ctx);
      validateWorkItemNote(note, id);
      return applyWorkItemEffects(ctx, id, {
        note,
        move: { queue: "escalate", from },
      });
    });
    this.describe((ctx) => `work item ${ctx.ticket ?? "?"}: escalation note + queue ${from}`);
    this.blocking(false);
    return super.build();
  }
}

/**
 * Public escalation for project pipelines.
 *
 * The queue left is derived from the pipeline's work-item source, and the artifact
 * is read once for admission and note construction.
 */
export function workItemEscalateStep<T>(opts: ProjectEscalationStepOptions<T>): ActionStepBuilder {
  return new PublicWorkItemEscalateStepBuilder(opts);
}

/** Public delivery options: the queue left comes from the work-item source linked
 *  to the pipeline builder. */
type PublicWorkItemDeliveryOptions = {
  /** Defaults to `work-item-update`, also the execution-key `stepId`. */
  id?: string;
  name?: string;
  /**
   * Merge-request URL, or an empty string when unavailable—the normal case is noted.
   *
   * READS a URL, it does not PRODUCE one: this step does not push or create a merge
   * request. The author must push the branch and open the merge request first, then
   * return its URL here. Returning `""` remains valid and publishes a note without a link.
   *
   * Omitting the callback entirely skips the delivery note: the step only moves the
   * ticket (queue `done`, state `inReview`).
   */
  mrUrl?: (ctx: PipelineContext) => string | Promise<string>;
};

class PublicWorkItemDeliveryStepBuilder extends ActionStepBuilder {
  constructor(private readonly opts: PublicWorkItemDeliveryOptions) {
    super(opts.id ?? "work-item-update", opts.name ?? "Update work item (MR note + queue + state)");
  }

  build(): ReturnType<ActionStepBuilder["build"]> {
    const mrUrl = this.opts.mrUrl;
    if (mrUrl !== undefined && typeof mrUrl !== "function") {
      throw new Error(`Step "${this.opts.id ?? "work-item-update"}": mrUrl must be a function`);
    }
    const source = inferredPipelineWorkItemSource(this);
    const from = source?.queue;
    if (!from) {
      throw new Error(
        `Step "${this.opts.id ?? "work-item-update"}": no identifiable work-item source queue — ` +
          `declare forEachWorkItem({ queue: "bugTodo" | "featureTodo", do: [...] }) in the pipeline`,
      );
    }
    const id = this.opts.id ?? "work-item-update";
    const move: MoveTarget = { queue: "done", from, state: "inReview" };
    this.run(async (ctx) => {
      if (mrUrl === undefined) return applyWorkItemEffects(ctx, id, { move });
      let url = "";
      const extraFailures: string[] = [];
      try {
        url = (await mrUrl(ctx)) ?? "";
      } catch (error) {
        extraFailures.push(`merge-request URL: ${errorMessage(error)}`);
      }
      return applyWorkItemEffects(ctx, id, { note: deliveryNote(url), move, extraFailures });
    });
    this.describe((ctx) =>
      mrUrl === undefined
        ? `work item ${ctx.ticket ?? "?"}: ${describeMove(move)}`
        : `work item ${ctx.ticket ?? "?"}: delivery note + ${describeMove(move)}`,
    );
    this.blocking(false);
    return super.build();
  }
}

/**
 * Publishes the delivery note on the ticket and moves it (queue `done`, state
 * `inReview`). The queue left is inferred from the pipeline source.
 *
 * Scope: the name promises more than the step does — it only updates the tracker.
 * It does not commit, push, or open a merge request; the URL returned by `mrUrl` is
 * copied into the note, nothing more. A pipeline that did not push before this step
 * publishes a delivery note without a delivery. Without `mrUrl`, no note is
 * published and the step only moves the ticket.
 */
export function workItemDeliveryStep(opts: PublicWorkItemDeliveryOptions): ActionStepBuilder {
  return new PublicWorkItemDeliveryStepBuilder(opts);
}
