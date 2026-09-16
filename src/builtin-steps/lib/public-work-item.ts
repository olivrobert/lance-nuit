import type { WorkItemNote } from "../../contracts/work-items.js";
import type { Artifact } from "../../dsl/artifact.js";
import type { PipelineContext } from "../../model/context.js";

/** Provider-neutral escalation shape for project pipelines. */
export interface ProjectEscalation {
  cause: string;
  details?: Record<string, string>;
  state: string;
  action: string;
}

type ProjectEscalationBase<T> = {
  /** The identifier must remain stable after first use. */
  id?: string;
  name?: string;
  artifact: Artifact<T>;
  /** Default: true. False produces a skip. */
  onlyIf?: (value: T, context: PipelineContext) => boolean | Promise<boolean>;
};

/** Advanced escape hatch: the callback directly provides the public note format. */
export type ProjectEscalationNoteOptions<T> = ProjectEscalationBase<T> & {
  note: (value: T, context: PipelineContext) => WorkItemNote | Promise<WorkItemNote>;
  escalation?: never;
};

/** Recommended simple form: the runner builds the `WorkItemNote`. */
export type ProjectEscalationOptions<T> = ProjectEscalationBase<T> & {
  escalation: (value: T, context: PipelineContext) => ProjectEscalation | Promise<ProjectEscalation>;
  note?: never;
};

/** Exclusive union: exactly one note form is required. */
export type ProjectEscalationStepOptions<T> = ProjectEscalationOptions<T> | ProjectEscalationNoteOptions<T>;
