import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve as pathResolve } from "node:path";
import type { InputPredicate } from "../dsl/input.js";
import { resolveBuiltinPipeline } from "../env/builtin-pipeline.js";
import { errorMessage } from "../lib/errors.js";
import type { AsyncTemplated, PipelineContext, PipelineLot } from "../model/context.js";
import { resolveTemplateAsync } from "../model/definition.js";
import type { PipelineLineageEntry } from "../model/persisted.js";
import type { Run } from "../model/run.js";
import { agentBackendRegistryOf, buildPipelineContext, workItemRegistryOf } from "../pipeline/context.js";

export const MAX_PIPELINE_COMPOSITION_DEPTH = 16;

function canonicalPipelinePath(path: string): string {
  return realpathSync(pathResolve(path));
}

export function currentLineage(run: Run): PipelineLineageEntry[] {
  if (run.pipelineLineage?.length) return run.pipelineLineage;
  const lineage: PipelineLineageEntry[] = [
    {
      pipelinePath: canonicalPipelinePath(run.pipeline_path),
      ...(run.ticket !== undefined ? { ticket: run.ticket } : {}),
    },
  ];
  run.pipelineLineage = lineage;
  return lineage;
}

function formatLineage(lineage: readonly PipelineLineageEntry[]): string {
  return lineage
    .map(({ pipelinePath, ticket }) => `${pipelinePath}${ticket === undefined ? "" : ` [${ticket}]`}`)
    .join(" → ");
}

export function lineageForChild(parent: Run, pipelinePath: string, ticket: string | undefined): PipelineLineageEntry[] {
  const lineage = currentLineage(parent);
  const candidate: PipelineLineageEntry = {
    pipelinePath: canonicalPipelinePath(pipelinePath),
    ...(ticket !== undefined ? { ticket } : {}),
  };
  const complete = [...lineage, candidate];
  if (lineage.some((entry) => entry.pipelinePath === candidate.pipelinePath && entry.ticket === candidate.ticket)) {
    throw new Error(
      `Recursive pipeline composition refused (pipeline/ticket pair already present): ${formatLineage(complete)}`,
    );
  }
  if (complete.length > MAX_PIPELINE_COMPOSITION_DEPTH) {
    throw new Error(
      `Maximum composition depth (${MAX_PIPELINE_COMPOSITION_DEPTH}) exceeded: ${formatLineage(complete)}`,
    );
  }
  return complete;
}

export interface PredicateDecision {
  ok: boolean;
  reason?: string;
  threw?: boolean;
}

function normalizePredicateResult(value: unknown): PredicateDecision {
  if (typeof value === "boolean") return { ok: value };
  if (value && typeof value === "object" && "ok" in value && typeof value.ok === "boolean") {
    const record = value as { ok: boolean; reason?: unknown };
    return {
      ok: record.ok,
      ...(typeof record.reason === "string" ? { reason: record.reason } : {}),
    };
  }
  throw new Error("composition predicate must return a boolean or { ok, reason }");
}

export async function evaluatePredicate(
  predicate: InputPredicate | undefined,
  ctx: PipelineContext,
): Promise<PredicateDecision> {
  if (!predicate) return { ok: true };
  try {
    return normalizePredicateResult(await predicate(ctx));
  } catch (error) {
    return { ok: false, reason: errorMessage(error).trim(), threw: true };
  }
}

export async function resolveTicket(
  value: AsyncTemplated<PipelineContext, string | undefined> | undefined,
  ctx: PipelineContext,
  fallback?: string,
): Promise<string | undefined> {
  const resolved = value === undefined ? fallback : await resolveTemplateAsync(value, ctx);
  if (resolved === undefined || resolved === null || resolved === "") return undefined;
  if (typeof resolved !== "string" || !resolved.trim()) {
    throw new Error("Pipeline composition: resolved ticket must be a non-empty string");
  }
  return resolved;
}

export function resolvePipelinePath(reference: string, parentPipelinePath: string, ctx: PipelineContext): string {
  const value = reference.trim();
  if (!value) throw new Error("Pipeline composition: empty pipeline reference");

  // Names follow boot/CLI resolution (project, then builtin). Path references stay
  // anchored to the calling file rather than the implicit cwd.
  const looksLikePath =
    isAbsolute(value) || value.startsWith(".") || value.includes("/") || value.includes("\\") || value.endsWith(".ts");
  if (looksLikePath) {
    const resolved = isAbsolute(value)
      ? pathResolve(value)
      : pathResolve(dirname(pathResolve(parentPipelinePath)), value);
    if (!existsSync(resolved)) throw new Error(`Child pipeline not found: ${value} (${resolved})`);
    return resolved;
  }

  const resolved = resolveBuiltinPipeline(value, ctx.cwd);
  if (!resolved) throw new Error(`Child pipeline not found: ${value}`);
  return resolved;
}

/** Context for a child run. It is BUILT rather than derived (`deriveContext`):
 * `lot` determines `paths.reportsDir`, which derivation does not recalculate. */
export function childContext(parent: PipelineContext, ticket?: string, lot?: PipelineLot): PipelineContext {
  // Do not read parent.workItem while composing the child: it is intentionally lazy
  // in PipelineContext. Reuse its descriptor to preserve injected fakes and gateway
  // memoization without creating an unused provider. buildPipelineContext defines
  // the getter on the object itself, and deriveContext copies descriptors rather
  // than chaining a prototype.
  const descriptor = Object.getOwnPropertyDescriptor(parent, "workItem");
  const injectedWorkItem = descriptor && "value" in descriptor ? descriptor.value : undefined;
  const child = buildPipelineContext({
    cwd: parent.cwd,
    ticket,
    lot,
    baseBranch: parent.baseBranch,
    runnerBin: parent.runnerBin,
    runnerDir: parent.runnerDir,
    config: parent.config,
    workItemRegistry: workItemRegistryOf(parent),
    agentBackendRegistry: agentBackendRegistryOf(parent),
    ...(injectedWorkItem ? { workItem: injectedWorkItem } : {}),
  });
  if (descriptor?.get) {
    Object.defineProperty(child, "workItem", {
      configurable: true,
      enumerable: true,
      get: () => descriptor!.get!.call(parent),
    });
  }
  return child;
}
