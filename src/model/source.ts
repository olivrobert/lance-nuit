// runner/model/source.ts
//
// External source: state outside the work-item (the repository tree, a lock
// file, a remote revision) that a step declares as input so its freshness covers
// it. The factory lives in `dsl/artifact.ts`; reading and fingerprinting it is
// owned by `state/provenance.ts`.

import type { Artifact } from "./artifact.js";
import type { AsyncTemplated, PipelineContext } from "./context.js";

export interface Source {
  /** Tells a source apart from an artifact in a step's `input`. */
  readonly kind: "source";
  readonly name: string;
  /** Bash command whose stdout is the source's content. */
  readonly command: AsyncTemplated<PipelineContext>;
  /** Run the command and return its stdout; rejects when it fails. */
  read(ctx: PipelineContext): Promise<string>;
}

/** What a step may declare through `input`: artifacts it reads, and sources. */
export type StepInput = Artifact<unknown> | Source;

export function isSource(input: unknown): input is Source {
  return typeof input === "object" && input !== null && (input as { kind?: unknown }).kind === "source";
}

/** Why a step's sources are declared wrong, or `undefined`. Shared by the
 *  builder and the structure validator, which sees raw definitions. */
export function sourceDeclarationError(step: {
  readonly sources?: readonly unknown[];
  readonly outputs?: readonly unknown[];
}): string | undefined {
  // Nothing may write what the runner fingerprints from a command's stdout.
  const written = (step.outputs ?? []).find(isSource);
  if (written) return `source "${written.name}" cannot be an output: a source is read, never written`;
  // Both would be recorded under the same `source:<name>` key, one silently lost.
  const names = new Set<string>();
  for (const input of (step.sources ?? []).filter(isSource)) {
    if (names.has(input.name)) return `source "${input.name}" is declared twice in input`;
    names.add(input.name);
  }
  return undefined;
}
