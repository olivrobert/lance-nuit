// runner/model/artifact.ts
//
// Artifact descriptor: the shape a pipeline author binds a name and a parser to.
// The factories that build one live in `dsl/artifact.ts`.

import type { PipelineContext } from "./context.js";

/** Parser that turns an artifact's raw JSON into a validated domain value. */
export type ArtifactParser<T> = (value: unknown) => T;

/** Reusable artifact descriptor: identity, validation, and typed access. */
export interface Artifact<T> {
  readonly name: string;
  /** Storage encoding: `json` for `artifact()` (value serialized as JSON), `text`
   *  for `textArtifact()` (bytes as-is). Read by `capture`, which accepts the short
   *  form (a bare descriptor) only for text artifacts. Absent on a descriptor
   *  built outside the DSL factories. */
  readonly kind?: "text" | "json";
  read(ctx: PipelineContext): Promise<T | undefined>;
  require(ctx: PipelineContext): Promise<T>;
  /** Rewrite the artifact after validation by the SAME parser as `read`. This is
   *  the deterministic guardrail: an `actionStep` can revise an agent verdict
   *  and publish a value whose shape is guaranteed. */
  write(ctx: PipelineContext, value: T): Promise<void>;
  remove(ctx: PipelineContext): Promise<void>;
  /** Validate RAW content (the file bytes) and return the typed value.
   *  Used by approvals, which must bind a decision to the exact approved content
   *  without duplicating the artifact shape. */
  validate(raw: string): T;
}
