import type { Artifact, ArtifactParser } from "../model/artifact.js";
import { createArtifactRef } from "../model/artifact-ports.js";
import type { AsyncTemplated, PipelineContext } from "../model/context.js";
import type { Source } from "../model/source.js";
import { PROVENANCE_PREFIX, readSource } from "../state/provenance.js";

export type { Artifact, ArtifactParser } from "../model/artifact.js";
export type { Source } from "../model/source.js";

/** `.provenance/` is owned by the runner: it stores the input fingerprints of
 *  every artifact. A descriptor pointing there would let a pipeline overwrite the
 *  record that decides its own freshness. */
function rejectReservedName(factory: string, name: string): void {
  if (name.startsWith(PROVENANCE_PREFIX)) {
    throw new Error(`${factory}: "${PROVENANCE_PREFIX}" is reserved by the runner`);
  }
}

function ref(ctx: PipelineContext, name: string) {
  if (!ctx.ticket) throw new Error(`artifact "${name}" requested without a ticket`);
  return createArtifactRef(ctx.ticket, name);
}

/** Expected location, used only in error messages. The store is logical and
 *  exposes no path, but a bare “plan.md not found” is not actionable: `require()`
 *  specifically targets the failure mode where a skill wrote elsewhere, so the
 *  useful response says where the runner looked. */
function expectedAt(ctx: PipelineContext, name: string): string {
  try {
    return ctx.paths.artifact(name);
  } catch {
    return name;
  }
}

/** Bind an artifact name once to the parser that defines its shape. */
export function artifact<T>(name: string, parse: ArtifactParser<T>): Artifact<T> {
  if (!name.trim()) throw new Error("artifact(): name must be a non-empty string");
  rejectReservedName("artifact()", name);
  return Object.freeze({
    name,
    kind: "json" as const,
    read: (ctx: PipelineContext) => ctx.artifacts.readJson(ref(ctx, name), parse),
    async require(ctx: PipelineContext): Promise<T> {
      const value = await ctx.artifacts.readJson(ref(ctx, name), parse);
      if (value === undefined) throw new Error(`${name} not found (expected at: ${expectedAt(ctx, name)})`);
      return value;
    },
    async write(ctx: PipelineContext, value: T): Promise<void> {
      // Validate BEFORE writing: an artifact rejected by its own parser would
      // make another step's reread fail far from the original culprit.
      parse(value);
      const json = JSON.stringify(value, null, 2);
      if (json === undefined) throw new TypeError(`artifact "${name}" cannot be serialized as JSON`);
      await ctx.artifacts.writeText(ref(ctx, name), `${json}\n`);
    },
    remove: (ctx: PipelineContext) => ctx.artifacts.remove(ref(ctx, name)),
    validate: (raw: string) => parse(JSON.parse(raw)),
  });
}

/** Text variant: the artifact is not JSON (agent-authored Markdown).
 *  The parser receives the bytes as-is and can only reject or return them; text
 *  artifacts have no structured shape to normalize and no inverse serializer. */
export function textArtifact(name: string, parse: (raw: string) => string = (raw) => raw): Artifact<string> {
  if (!name.trim()) throw new Error("textArtifact(): name must be a non-empty string");
  rejectReservedName("textArtifact()", name);
  return Object.freeze({
    name,
    kind: "text" as const,
    read: async (ctx: PipelineContext): Promise<string | undefined> => {
      const raw = await ctx.artifacts.readText(ref(ctx, name));
      return raw === undefined ? undefined : parse(raw);
    },
    async require(ctx: PipelineContext): Promise<string> {
      const raw = await ctx.artifacts.readText(ref(ctx, name));
      if (raw === undefined) throw new Error(`${name} not found (expected at: ${expectedAt(ctx, name)})`);
      return parse(raw);
    },
    write: async (ctx: PipelineContext, value: string): Promise<void> => {
      parse(value);
      await ctx.artifacts.writeText(ref(ctx, name), value);
    },
    remove: (ctx: PipelineContext) => ctx.artifacts.remove(ref(ctx, name)),
    validate: parse,
  });
}

export interface SourceOptions {
  /** Bash command whose stdout is the source's content, run in the working
   *  directory with a 30 s bound. A function receives the pipeline context. It
   *  must be deterministic: a stdout that is empty or constant never makes the
   *  step stale, one that varies on every call makes it run every time. Its
   *  stdout is held in memory whole, with no size bound. */
  command: AsyncTemplated<PipelineContext>;
}

/**
 * State outside the work-item that a step reads, declared through `input` so
 * its freshness covers it: the step is re-admitted when the raw stdout of
 * `command` changes. The fingerprint recorded is read again once the attempt
 * succeeded, so a step that changes its own source is not stale because of it.
 * A source is read, never written: declaring it as `output` is a build error.
 * A command that fails leaves the freshness unknown, so the step runs. Adding a
 * source to a step that already produced its outputs replays it once: their
 * record does not list the new input.
 */
export function source(name: string, options: SourceOptions): Source {
  if (!name.trim()) throw new Error("source(): name must be a non-empty string");
  const command = options?.command;
  if (typeof command !== "function" && (typeof command !== "string" || !command.trim())) {
    throw new Error(`source("${name}"): command must be a non-empty string or a function`);
  }
  const descriptor: Source = Object.freeze({
    kind: "source" as const,
    name,
    command,
    read: (ctx: PipelineContext) => readSource(ctx, descriptor),
  });
  return descriptor;
}
