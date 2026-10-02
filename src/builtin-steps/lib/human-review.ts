// Human review: ONE declaration per automation exit point.
//
// The kit's six exit points (missing documents, assumptions, split, irreproducible
// bug, duplication, sensitive diff) shared the same hand-expanded mechanics: a
// non-blocking escalation step, sometimes branch abandonment, then a gate carrying
// `stop`. Three steps, repeated comments and stop messages, and `--approve` declared
// elsewhere in a map unrelated to the gate reading it.
//
// `humanReview()` takes the exit-point description and builds the steps.
//
// What this module unifies across exit points:
//  - `blocked` describes ONLY the raw artifact verdict. This module adds "and no
//    one approved" whenever `approval` is declared, replacing each `*PendingReview`.
//  - the approval subjects are declared from the gate (`declareApproval`), so the
//    pipeline's `approvals` map need not repeat them. A gate offers either one
//    static subject or, per blocking value, one of a declared list or none.
//  - the stop message is prefixed `escalated:` and suffixed with `--approve`, rather
//    than rewritten in every gate.
//  - a gate declaring `rework` accepts `--reject <subject>`: the named step reruns
//    with the reason, and the gate asks again whatever the reworked verdict says.
//
// Execution still has SEPARATE steps by design. A note-publishing step must not stop
// the run (an admission has one failure policy, and escalation must remain `skip`
// when nothing blocks), and branch abandonment must be replayable alone on resume.
// What is unified here is DECLARATION, not execution.
//
// Only the gate is always built. `note` and `abandonBranch` each add their step when
// declared: a child pipeline owns no work-item queue, so it declares no note and its
// exit point is the gate alone.

import type { WorkItemNote } from "../../contracts/work-items.js";
import type { Artifact } from "../../dsl/artifact.js";
import { type ActionStepBuilder, actionStep, type StepBuilder } from "../../dsl/dsl-steps.js";
import type { InputPredicateResult } from "../../dsl/input.js";
import { reject } from "../../dsl/preconditions.js";
import { declareApproval, inferredPipelineName } from "../../dsl/work-item-assembly.js";
import type { PipelineContext } from "../../model/context.js";
import type { RunStopState } from "../../model/persisted.js";
import { decisionMatchesArtifact, readDecision, rejectionStatus } from "../../state/decisions.js";
import { abandonWorkItemBranch } from "./branch.js";
import { workItemEscalateStep } from "./work-item-steps.js";

/**
 * Expected recovery, in the reader's vocabulary, not the pipeline's. Every
 * escalation removes the work item from its queue, but they do not mean the same:
 *
 *  - `needs-info`     material is missing (document, unsettled decision). Providing
 *                     it is enough: the run resumes automatically. This promise
 *                     holds because derived artifacts are invalidated when material
 *                     changes (see `lib/derived.ts` for specs, `inputs-gate` for
 *                     documents). A `needs-info` point invalidating nothing would lie.
 *  - `needs-decision` material exists; the runner's proposal awaits arbitration
 *                     (`--approve <subject>`).
 *  - `needs-human`    the ticket leaves auto-dev and will not return.
 */
export type ReviewKind = "needs-info" | "needs-decision" | "needs-human";

const KIND_LABEL: Record<ReviewKind, string> = {
  "needs-info": "needs-info — run resumes when missing material is provided",
  "needs-decision": "needs-decision — run resumes when the proposal is approved",
  "needs-human": "needs-human — manual recovery; ticket does not return to auto-dev",
};

/** `--approve` subject that lifts this block, whatever the verdict. */
export interface ReviewApproval {
  subject: string;
}

/**
 * Approval decided per blocking value: `subjectFor` names the subject that lifts
 * this verdict, or `undefined` when approving is not the way out (a split that
 * must become separate tickets). Such a verdict stops with its reason only.
 *
 * `subjects` lists every subject `subjectFor` may return: the CLI resolves
 * `--approve <subject>` before any artifact exists, so the list cannot be derived.
 */
export interface ReviewApprovalChoice<T> {
  subjects: readonly string[];
  subjectFor: (value: T, ctx: PipelineContext) => string | undefined | Promise<string | undefined>;
}

export interface HumanReviewOptions<T> {
  /**
   * Root of step identifiers: `escalate-<id>`, `abandon-<id>-branch`, `<id>-gate`.
   * A note's ExecutionKey is `{ ticket, stepId }`; changing an id would make an
   * already published note appear new.
   */
  id: string;
  artifact: Artifact<T>;
  kind: ReviewKind;
  /**
   * RAW verdict read from the artifact, ignoring approval: this module adds "and no
   * one approved" when `approval` is declared. A missing or unreadable artifact is
   * never blocking (see `missing`).
   */
  blocked: (value: T, ctx: PipelineContext) => boolean | Promise<boolean>;
  /**
   * Note published on the work item when the exit point blocks.
   *
   * OMIT it in a CHILD pipeline. Escalation removes the work item from its source
   * queue, which only a pipeline declaring `forEachWorkItem` has; a child run
   * borrows its parent's ticket and owns no queue, so declaring a note there makes
   * the pipeline unloadable. Without a note the exit point is the gate alone: the
   * child run stops, its parent reports the failure, and `--approve <subject>`
   * still lifts the block.
   */
  note?: (value: T, ctx: PipelineContext) => WorkItemNote | Promise<WorkItemNote>;
  /** Stop reason, WITHOUT the `escalated:` prefix or approval command. */
  reason: (value: T, ctx: PipelineContext) => string | Promise<string>;
  /**
   * Complete stop predicate, instead of the one derived from `blocked`.
   *
   * Reserved for exit points whose gate distinguishes more than "blocked / not
   * blocked" — useful when a gate must distinguish an ABSENT from an OUTDATED
   * decision. `reason` remains for the note, not the gate.
   */
  gateCheck?: (ctx: PipelineContext) => InputPredicateResult | Promise<InputPredicateResult>;
  /**
   * Subject that lifts the block. `{ subject }` is offered for every verdict;
   * `{ subjects, subjectFor }` lets each blocking value offer its own subject or
   * none, and `--approve` then refuses a subject the current verdict does not offer.
   */
  approval?: ReviewApproval | ReviewApprovalChoice<T>;
  /**
   * Step that rewrites the artifact when a human rejects it (`--reject <subject>
   * --reason <text>`). It must run before the gate and declare the artifact as an
   * output; its prompt reads the reason through `pendingRejection`. Once rejected,
   * the gate stops until a human approves a new version, even one `blocked` lets
   * through. `maxRounds` (default 3) bounds how many versions can be rejected.
   */
  rework?: { step: string; maxRounds?: number };
  /** Base branch to restore. Absent = no branch created, nothing to undo. */
  abandonBranch?: (ctx: PipelineContext) => string;
  /** Labels shown in run logs. Defaults derive from `id`. */
  names?: { escalate?: string; abandon?: string; gate?: string };
  /** ID overrides for exit points named before this module. */
  ids?: { escalate?: string; abandon?: string; gate?: string };
}

/** Unlock command for the human to type. Derived from the subject actually declared
 *  by the gate, so no escalation template writes it and survives a rename wrongly. */
function approveCommand(subject: string, ticket: string | undefined, pipelineName: string): string {
  return `lancenuit run ${ticket ?? "<ticket>"} --pipeline ${pipelineName} --approve ${subject}`;
}

/** Rejection command for the human to type; the reason placeholder is theirs to write. */
function rejectCommand(subject: string, ticket: string | undefined, pipelineName: string): string {
  return `lancenuit reject ${ticket ?? "<ticket>"} ${subject} --reason "..." --pipeline ${pipelineName}`;
}

/**
 * Complete the template note with what only the exit point knows: recovery type and
 * the command that lifts the block when one exists.
 *
 * `Type` is inserted before the `State` / `Action` pair closing every escalation;
 * `Approve`, then `Reject` when the gate reworks, close it afterward. For an
 * out-of-contract note without `State`, all are appended.
 */
function withReviewFields(
  note: WorkItemNote,
  kind: ReviewKind,
  subject: string | undefined,
  ticket: string | undefined,
  pipelineName: string,
  reworkable: boolean,
): WorkItemNote {
  const at = note.fields.findIndex((existing) => existing.label === "State");
  const fields = [...note.fields];
  fields.splice(at < 0 ? fields.length : at, 0, { label: "Type", value: KIND_LABEL[kind] });
  if (subject) fields.push({ label: "Approve", value: approveCommand(subject, ticket, pipelineName) });
  if (subject && reworkable) fields.push({ label: "Reject", value: rejectCommand(subject, ticket, pipelineName) });
  return { ...note, fields };
}

/**
 * Steps for an exit point: escalation (non-blocking), optional branch abandonment,
 * then stop gate. Insert as-is into a phase.
 */
export function humanReview<T>(opts: HumanReviewOptions<T>): StepBuilder[] {
  const escalateId = opts.ids?.escalate ?? `escalate-${opts.id}`;
  const abandonId = opts.ids?.abandon ?? `abandon-${opts.id}-branch`;
  const gateId = opts.ids?.gate ?? `${opts.id}-gate`;
  const approval = opts.approval;
  const choice = approval && "subjects" in approval ? approval : undefined;
  const staticSubject = approval && !("subjects" in approval) ? approval.subject : undefined;
  if (choice && (!Array.isArray(choice.subjects) || choice.subjects.length === 0)) {
    throw new Error(`humanReview("${opts.id}"): approval.subjects must be a non-empty array`);
  }
  if (opts.rework && !approval)
    throw new Error(`humanReview("${opts.id}"): rework needs an approval subject to reject`);
  const maxRounds = opts.rework?.maxRounds ?? 3;
  if (!Number.isInteger(maxRounds) || maxRounds < 1) {
    throw new Error(`humanReview("${opts.id}"): rework.maxRounds must be a positive integer`);
  }
  const reworkable = opts.rework !== undefined;
  const declaredSubjects: readonly string[] = choice ? choice.subjects : staticSubject ? [staticSubject] : [];
  // The builder binds this metadata before building the step. Looking it up at
  // execution time keeps approval notes and stop reasons correct when a pipeline
  // is renamed, without copying the name into every review declaration.
  let gate: ActionStepBuilder;
  const approvalCommand = (subject: string | undefined, ctx: PipelineContext): string | undefined =>
    subject ? approveCommand(subject, ctx.ticket, inferredPipelineName(gate) ?? failPipelineName()) : undefined;
  /** Console hint naming every way out the gate accepts for `subject`. `--approve`
   *  on a run records the decision AND resumes: there is no second command to type. */
  const liftHint = (subject: string | undefined, ctx: PipelineContext): string => {
    const command = approvalCommand(subject, ctx);
    if (!command) return "";
    const rejection =
      subject && reworkable
        ? ` or reject with "${rejectCommand(subject, ctx.ticket, inferredPipelineName(gate) ?? failPipelineName())}"`
        : "";
    return ` — lift with "${command}"${rejection}`;
  };

  function failPipelineName(): never {
    throw new Error(`humanReview("${opts.id}"): pipeline name was not bound during assembly`);
  }

  /** Subject that lifts this blocking value. Gate, note and CLI guard all read it
   *  here, so `--approve` never accepts a subject the gate would ignore. */
  const offeredSubject = async (value: T, ctx: PipelineContext): Promise<string | undefined> => {
    if (!choice) return staticSubject;
    const subject = await choice.subjectFor(value, ctx);
    // The subject becomes a filename under `decisions/`: an undeclared one is a
    // pipeline bug, not a verdict that cannot be approved.
    if (subject !== undefined && !choice.subjects.includes(subject)) {
      throw new Error(
        `humanReview("${opts.id}"): approval.subjectFor returned "${subject}", which is not declared ` +
          `(subjects: ${choice.subjects.join(", ")})`,
      );
    }
    return subject;
  };

  /** Value of a raw blocking verdict; undefined when the artifact is absent,
   *  unreadable (the check did not happen) or does not block. */
  const blockingValue = async (ctx: PipelineContext): Promise<T | undefined> => {
    let value: T | undefined;
    try {
      value = await opts.artifact.read(ctx);
    } catch {
      return undefined;
    }
    if (value === undefined) return undefined;
    return (await opts.blocked(value, ctx)) ? value : undefined;
  };

  /** Block remains: raw verdict AND no valid approval. `decisionMatchesArtifact`
   *  provides the hash lock; approval is invalidated when the artifact changes,
   *  reopening the exit point. */
  const cachedPending = new WeakMap<PipelineContext, Promise<boolean>>();
  const pending = async (ctx: PipelineContext): Promise<boolean> => {
    // A review without approval has a pure verdict and can safely share the
    // artifact read between escalation and its gate. Approval checks remain
    // uncached because a decision may be recorded between those two steps.
    if (!approval) {
      const cached = cachedPending.get(ctx);
      if (cached) return cached;
      const result = computePending(ctx);
      cachedPending.set(ctx, result);
      return result;
    }
    return computePending(ctx);
  };

  const computePending = async (ctx: PipelineContext): Promise<boolean> => {
    const value = await blockingValue(ctx);
    if (value === undefined) return false;
    const subject = await offeredSubject(value, ctx);
    // No subject offered: no decision file lifts it, even one left by an earlier
    // approvable verdict under another declared subject.
    if (subject === undefined) return true;
    return !(await decisionMatchesArtifact(ctx, subject, opts.artifact));
  };

  // No note: no escalation step. The queue lookup that publishes it lives in a
  // pipeline that owns work items, so a child pipeline gets the gate only.
  const escalation = opts.note;
  const steps: StepBuilder[] = escalation
    ? [
        workItemEscalateStep<T>({
          id: escalateId,
          name: opts.names?.escalate ?? `Work item escalation (${opts.id})`,
          artifact: opts.artifact,
          onlyIf: (_value, ctx) => pending(ctx),
          note: async (value, ctx) =>
            withReviewFields(
              await escalation(value, ctx),
              opts.kind,
              await offeredSubject(value, ctx),
              ctx.ticket,
              inferredPipelineName(gate) ?? failPipelineName(),
              reworkable,
            ),
        }),
      ]
    : [];

  if (opts.abandonBranch) {
    const baseOf = opts.abandonBranch;
    steps.push(
      actionStep({
        id: abandonId,
        name: opts.names?.abandon ?? `Abandon work branch (${opts.id})`,
        when: async (ctx) => ((await pending(ctx)) ? true : { ok: false, reason: "no escalation — branch kept" }),
        run: (ctx) => abandonWorkItemBranch(ctx, baseOf(ctx)),
        describe: (ctx) => `restore ${baseOf(ctx)} and delete the branch for ticket ${ctx.ticket ?? "?"}`,
      }),
    );
  }

  /** What the stop is about, for a reader of `state.json` that must not parse the
   *  console sentence: the subject that lifts it, the artifact under review, the
   *  expected recovery, and the reason as the exit point wrote it. */
  const stopInfo = (detail: string, subject: string | undefined): RunStopState => ({
    ...(subject ? { subject } : {}),
    artifact: `artifacts/${opts.artifact.name}`,
    kind: opts.kind,
    detail,
    ...(reworkable ? { reworkable: true } : {}),
  });

  /** A rejection holds the gate until a human approves a new version: the rework
   *  may well produce content `blocked` accepts, but only the person who rejected
   *  the artifact may accept its replacement. */
  const rejectedStop = async (ctx: PipelineContext): Promise<InputPredicateResult | undefined> => {
    for (const subject of declaredSubjects) {
      const status = await rejectionStatus(ctx, subject);
      if (!status) continue;
      const round = status.decision.round ?? 1;
      const detail =
        status.artifact === "absent"
          ? `the rework produced no artifact after rejection round ${round}`
          : status.artifact === "unchanged"
            ? `the rework did not change the artifact rejected in round ${round}`
            : `the artifact was reworked after rejection round ${round} and needs a new decision (approve or reject again)`;
      return reject(`escalated: ${detail}${liftHint(subject, ctx)}`, stopInfo(detail, subject));
    }
    return undefined;
  };

  const verdict = async (ctx: PipelineContext): Promise<InputPredicateResult> => {
    const rejected = await rejectedStop(ctx);
    if (rejected) return rejected;
    if (opts.gateCheck) {
      const result = await opts.gateCheck(ctx);
      // A custom gate owns its reason; it still stops for this exit point, so
      // describe it here unless the author already did.
      if (typeof result === "boolean" || result.ok || result.stop || !result.reason) return result;
      const offered = await blockingValue(ctx);
      const subject = choice ? offered && (await offeredSubject(offered, ctx)) : staticSubject;
      return { ...result, stop: stopInfo(result.reason, subject) };
    }
    if (!(await pending(ctx))) return true;
    const value = await opts.artifact.require(ctx);
    const detail = await opts.reason(value, ctx);
    const subject = await offeredSubject(value, ctx);
    return reject(`escalated: ${detail}${liftHint(subject, ctx)}`, stopInfo(detail, subject));
  };

  gate = actionStep({
    id: gateId,
    name: opts.names?.gate ?? `Gate: stop until human review (${opts.id}) is complete`,
    when: { if: verdict, else: "stop" as const },
    run: () => "human review complete or not required",
    describe: () => `validate human review for exit point "${opts.id}"`,
  });

  // The `--approve <subject> → artifact` mapping comes from the gate that reads it:
  // the CLI needs it without running the pipeline, so the pipeline need not repeat it.
  // A per-verdict approval also hands the CLI the gate's own rule as a guard.
  if (choice) {
    declareApproval(gate, {
      subjects: choice.subjects,
      artifact: opts.artifact as Artifact<unknown>,
      ...(opts.rework ? { rework: { stepId: opts.rework.step, maxRounds } } : {}),
      guard: async (subject, ctx) => {
        // The gate asks again about a rejected subject whatever the reworked
        // verdict offers, so the human must be able to answer under that subject.
        if (readDecision(ctx, subject)?.decision === "rejected") return undefined;
        const value = await blockingValue(ctx);
        const offered = value === undefined ? undefined : await offeredSubject(value, ctx);
        if (offered === subject) return undefined;
        const why =
          value === undefined
            ? "nothing blocks"
            : offered === undefined
              ? "this verdict cannot be approved"
              : `offered: ${offered}`;
        return `Approval subject "${subject}" is not offered by the current verdict of artifacts/${opts.artifact.name} (${why}).`;
      },
    });
  } else if (staticSubject) {
    declareApproval(gate, {
      subjects: [staticSubject],
      artifact: opts.artifact as Artifact<unknown>,
      ...(opts.rework ? { rework: { stepId: opts.rework.step, maxRounds } } : {}),
    });
  }

  steps.push(gate);
  return steps;
}
