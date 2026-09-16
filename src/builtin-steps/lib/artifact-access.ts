import { readFileSync } from "node:fs";
import type { ArtifactParser } from "../../dsl/artifact.js";
import { type ArtifactRef, createArtifactRef } from "../../model/artifact-ports.js";
import type { PipelineContext } from "../../model/context.js";

function artifactRef(ctx: PipelineContext, name: string): ArtifactRef {
  if (!ctx.ticket) throw new Error(`artifact "${name}" requested without a ticket`);
  return createArtifactRef(ctx.ticket, name);
}

/** Test whether an artifact exists through the context-injected store. */
export async function artifactExists(ctx: PipelineContext, name: string): Promise<boolean> {
  return ctx.artifacts.exists(artifactRef(ctx, name));
}

/** Read artifact text through the injected store. */
export async function readArtifactText(ctx: PipelineContext, name: string): Promise<string | undefined> {
  return ctx.artifacts.readText(artifactRef(ctx, name));
}

/** Remove an artifact through the injected store, preserving fs adapter idempotence. */
export async function removeArtifact(ctx: PipelineContext, name: string): Promise<void> {
  await ctx.artifacts.remove(artifactRef(ctx, name));
}

/** Read and validate a JSON artifact. undefined if absent; throw if JSON or shape is invalid. */
export function read<T>(path: string, parse: ArtifactParser<T>): T | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return undefined;
  }
  return parse(JSON.parse(raw));
}
