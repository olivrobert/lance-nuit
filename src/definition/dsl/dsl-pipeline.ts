import type { PipelineContext } from "../../shared/language/context.js";
import {
  type Pipeline,
  type PipelineRework,
  type PipelineStep,
  ignoringErrors,
  producerConflicts,
  stepsWithoutDeliverable,
  withoutDeliverableMessage,
} from "../definition.js";
import { budgetError, reworkErrors } from "../step-shape.js";
import { isValidSubjectToken } from "../../work-items/index.js";
import type { Artifact } from "./artifact.js";
import { type StepAssembly, StepBuilder } from "./dsl-steps.js";
import type { ForEachWorkItemOptions, PipelineEntry } from "./dsl-types.js";
import { createInternalWorkItemSourceStep, resolveWorkItemDir } from "./dsl-work-item.js";

type PipelineBuilderMode = "empty" | "simple" | "workItem";
type AddMethod<Mode extends PipelineBuilderMode> = Mode extends "workItem"
  ? never
  : (...entries: PipelineEntry[]) => PipelineBuilder<"simple">;
type WorkItemMethod<Mode extends PipelineBuilderMode> = Mode extends "empty"
  ? (options: ForEachWorkItemOptions) => PipelineBuilder<"workItem">
  : never;
type MaxCostMethod<Mode extends PipelineBuilderMode> = Mode extends "workItem"
  ? never
  : (usd: number) => PipelineBuilder<"simple">;

export function pipeline(name: string): PipelineBuilder<"empty"> {
  return new PipelineBuilder(name);
}

class PipelineBuilder<Mode extends PipelineBuilderMode> {
  private p: Pipeline;

  private readonly approvals = new Map<string, Artifact<unknown>>();

  private readonly approvalGuards = new Map<string, (ctx: PipelineContext) => Promise<string | undefined>>();

  private readonly stepBuilders: StepBuilder[] = [];

  /** Rework loops declared by gates, checked in `build()` once every step is known. */
  private readonly reworkDeclarations: {
    gate: StepBuilder;
    subjects: readonly string[];
    artifact: Artifact<unknown>;
    rework: PipelineRework;
  }[] = [];

  private mode: PipelineBuilderMode = "empty";

  readonly add: AddMethod<Mode>;

  readonly forEachWorkItem: WorkItemMethod<Mode>;

  readonly maxCost: MaxCostMethod<Mode>;

  constructor(name: string) {
    this.p = { name, steps: [] };
    this.maxCost = ((usd: number) => {
      if (this.mode === "workItem")
        throw new Error(`Pipeline "${this.p.name}": maxCost() is incompatible with forEachWorkItem()`);
      const invalid = budgetError("maxCost()", usd);
      if (invalid) throw new Error(`Pipeline "${this.p.name}": ${invalid}`);
      this.p.max_cost_usd = usd;
      this.mode = "simple";
      return this as unknown as PipelineBuilder<"simple">;
    }) as MaxCostMethod<Mode>;
    this.add = ((...entries: PipelineEntry[]) => {
      if (this.mode === "workItem")
        throw new Error(`Pipeline "${this.p.name}": add() is incompatible with forEachWorkItem()`);
      this.appendEntries(normalizePipelineEntries(entries, this.p.name, "add"));
      this.mode = "simple";
      return this as unknown as PipelineBuilder<"simple">;
    }) as AddMethod<Mode>;
    this.forEachWorkItem = ((options: ForEachWorkItemOptions) => {
      if (this.mode === "simple") {
        if (this.p.max_cost_usd !== undefined)
          throw new Error(`Pipeline "${this.p.name}": maxCost() is incompatible with forEachWorkItem()`);
        throw new Error(`Pipeline "${this.p.name}": forEachWorkItem() is incompatible with add()`);
      }
      if (this.mode === "workItem")
        throw new Error(`Pipeline "${this.p.name}": only one forEachWorkItem() loop is allowed`);
      const normalized = normalizeForEachWorkItemOptions(options, this.p.name);
      if (normalized.maxCostPerWorkItemUsd !== undefined)
        this.p.max_cost_per_work_item_usd = normalized.maxCostPerWorkItemUsd;
      this.appendEntries(materializeWorkItemLoop(normalized, this.p.name));
      this.mode = "workItem";
      return this as unknown as PipelineBuilder<"workItem">;
    }) as WorkItemMethod<Mode>;
  }

  desc(description: string): this {
    this.p.description = description;
    return this;
  }

  allowDirty(): this {
    this.p.allow_dirty = true;
    return this;
  }

  approval(subject: string, artifactDescriptor: Artifact<unknown>): this {
    if (!isValidSubjectToken(subject)) {
      throw new Error(
        `Pipeline "${this.p.name}": invalid approval subject "${subject}" (only [\\w-] characters are allowed)`,
      );
    }
    if (
      !artifactDescriptor ||
      typeof artifactDescriptor.name !== "string" ||
      typeof artifactDescriptor.validate !== "function"
    ) {
      throw new Error(`Pipeline "${this.p.name}": approval("${subject}") requires an artifact descriptor`);
    }
    // A second declaration would be refused by the guard whenever the verdict does
    // not offer the subject, contradicting the declaration that accepts it.
    if (this.approvalGuards.has(subject)) throw this.guardedTwice(subject);
    const existing = this.approvals.get(subject);
    if (existing && existing.name !== artifactDescriptor.name) {
      throw new Error(
        `Pipeline "${this.p.name}": approval subject "${subject}" declared on two artifacts ` +
          `("${existing.name}" and "${artifactDescriptor.name}")`,
      );
    }
    this.approvals.set(subject, artifactDescriptor);
    return this;
  }

  private guardedTwice(subject: string): Error {
    return new Error(
      `Pipeline "${this.p.name}": approval subject "${subject}" is guarded by a human review and cannot be declared twice`,
    );
  }

  private appendEntries(steps: readonly StepBuilder[]): void {
    for (const step of steps) this.appendStep(step);
  }

  private appendStep(step: StepBuilder): void {
    const approval = step.approval;
    if (approval) {
      const { artifact, guard, rework } = approval;
      for (const subject of approval.subjects) {
        if (guard && this.approvals.has(subject)) throw this.guardedTwice(subject);
        this.approval(subject, artifact);
        if (guard) this.approvalGuards.set(subject, (ctx) => guard(subject, ctx));
      }
      if (rework) this.reworkDeclarations.push({ gate: step, subjects: approval.subjects, artifact, rework });
    }
    const source = step.workItemSource;
    if (source) {
      if (this.p.work_item_source) {
        throw new Error(
          `Pipeline "${this.p.name}": multiple work-item sources declared ` +
            `("${this.p.work_item_source.step_id}" et "${source.step_id}")`,
        );
      }
      this.p.work_item_source = source;
    }
    this.stepBuilders.push(step);
  }

  /** Build the pipeline without touching the builder: two calls give equal pipelines. */
  build(): Pipeline {
    if (this.stepBuilders.length === 0) throw new Error(`Pipeline "${this.p.name}": no steps declared`);
    const assembly: StepAssembly = { pipelineName: this.p.name, workItemSource: this.p.work_item_source };
    const reworks = this.reworks();
    const built: Pipeline = {
      ...this.p,
      steps: this.withReworkSubjects(this.stepBuilders.map((step) => step.build(assembly))),
      ...(this.approvals.size > 0 ? { approvals: new Map(this.approvals) } : {}),
      ...(this.approvalGuards.size > 0 ? { approvalGuards: new Map(this.approvalGuards) } : {}),
      ...(reworks.size > 0 ? { reworks } : {}),
    };
    const [reworkError] = reworkErrors(built);
    if (reworkError) throw new Error(`Pipeline "${this.p.name}": ${reworkError}`);
    this.assertReworksBeforeGates(built.steps);
    const unclassified = stepsWithoutDeliverable(built);
    if (unclassified.length > 0) {
      throw new Error(`Pipeline "${this.p.name}": ${withoutDeliverableMessage(unclassified)}`);
    }
    const [conflict] = [...producerConflicts(built), ...ignoringErrors(built)];
    if (conflict) throw new Error(`Pipeline "${this.p.name}": ${conflict}`);
    return built;
  }

  private reworks(): Map<string, PipelineRework> {
    return new Map(
      this.reworkDeclarations.flatMap(({ subjects, rework }) => subjects.map((subject) => [subject, rework] as const)),
    );
  }

  private withReworkSubjects(steps: PipelineStep[]): PipelineStep[] {
    return steps.map((step) => {
      const subjects = this.reworkDeclarations
        .filter(({ rework }) => rework.stepId === step.id)
        .flatMap(({ subjects }) => subjects);
      return subjects.length > 0 ? { ...step, rework_for: [...new Set(subjects)] } : step;
    });
  }

  /** Only the builder knows which gate declared a rework: replaying a step that
   *  runs after its gate would never answer the rejection. */
  private assertReworksBeforeGates(steps: readonly PipelineStep[]): void {
    for (const { gate, subjects, rework } of this.reworkDeclarations) {
      const index = steps.findIndex((step) => step.id === rework.stepId);
      if (index > this.stepBuilders.indexOf(gate)) {
        throw new Error(
          `Pipeline "${this.p.name}": rework step "${rework.stepId}" of subject "${subjects.join(", ")}" must run before its gate`,
        );
      }
    }
  }
}

interface NormalizedForEachWorkItemOptions extends ForEachWorkItemOptions {
  load: { allowClosed: boolean; retries: number };
}

function normalizeForEachWorkItemOptions(
  options: ForEachWorkItemOptions,
  pipelineName: string,
): NormalizedForEachWorkItemOptions {
  if (!options || typeof options !== "object" || Array.isArray(options))
    throw new Error(`Pipeline "${pipelineName}": forEachWorkItem() expects an options object`);
  if (!Array.isArray(options.do)) throw new Error(`Pipeline "${pipelineName}": forEachWorkItem().do must be an array`);
  if (options.before !== undefined && !Array.isArray(options.before))
    throw new Error(`Pipeline "${pipelineName}": forEachWorkItem().before must be an array`);
  const budget =
    options.maxCostPerWorkItemUsd === undefined
      ? undefined
      : budgetError("maxCostPerWorkItemUsd", options.maxCostPerWorkItemUsd);
  if (budget) throw new Error(`Pipeline "${pipelineName}": ${budget}`);
  if (options.dir !== undefined && typeof options.dir !== "string")
    throw new Error(`Pipeline "${pipelineName}": forEachWorkItem().dir must be a string`);
  if (options.scan?.query !== undefined && (typeof options.scan.query !== "string" || !options.scan.query.trim()))
    throw new Error(`Pipeline "${pipelineName}": forEachWorkItem().scan.query must be a non-empty string`);
  if (options.load !== undefined && (!options.load || typeof options.load !== "object" || Array.isArray(options.load)))
    throw new Error(`Pipeline "${pipelineName}": forEachWorkItem().load must be an object`);
  if (options.load?.allowClosed !== undefined && typeof options.load.allowClosed !== "boolean")
    throw new Error(`Pipeline "${pipelineName}": forEachWorkItem().load.allowClosed must be a boolean`);
  const retries = options.load?.retries ?? 0;
  if (!Number.isInteger(retries) || retries < 0)
    throw new Error(`Pipeline "${pipelineName}": forEachWorkItem().load.retries must be a non-negative integer`);
  return { ...options, load: { allowClosed: options.load?.allowClosed ?? false, retries } };
}

function materializeWorkItemLoop(options: NormalizedForEachWorkItemOptions, pipelineName: string): StepBuilder[] {
  const before = normalizePipelineEntries(options.before ?? [], pipelineName, "before");
  const body = normalizePipelineEntries(options.do, pipelineName, "do");
  const source = createInternalWorkItemSourceStep({
    queue: options.queue,
    scan: options.scan,
    dir: (ctx) => resolveWorkItemDir(ctx, options.dir),
    refuseClosed: !options.load.allowClosed,
  });
  if (options.load.retries > 0) source.onFail({ retries: options.load.retries });
  return [...before, source, ...body];
}

function normalizePipelineEntries(
  entries: readonly unknown[],
  pipelineName: string,
  location: "add" | "before" | "do",
): StepBuilder[] {
  const normalized: StepBuilder[] = [];
  let flattenedIndex = 0;
  for (const [index, entry] of entries.entries()) {
    const candidates = Array.isArray(entry) ? entry : [entry];
    for (const [nestedIndex, candidate] of candidates.entries()) {
      if (!(candidate instanceof StepBuilder)) {
        const position = Array.isArray(entry) ? `${index}[${nestedIndex}]` : `${index}`;
        const flattened = Array.isArray(entry) ? ` (index ${flattenedIndex} after flattening)` : "";
        throw new Error(`Pipeline "${pipelineName}": invalid entry in ${location} at index ${position}${flattened}`);
      }
      normalized.push(candidate);
      flattenedIndex += 1;
    }
  }
  return normalized;
}
