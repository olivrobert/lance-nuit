import { realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { AgentBackendRegistry } from "../contracts/backends.js";
import type { WorkItemGateway } from "../contracts/work-items.js";
import { loadPipelineConfig, type PipelineConfig } from "../env/config.js";
import { resolveTicketDir } from "../env/tickets.js";
import type { WorkItemGatewayRegistry } from "../contracts/registry.js";
import type { WorkItemArtifactStore } from "../model/artifact-ports.js";
import {
  AGENT_BACKEND_REGISTRY,
  type PipelineContext,
  type PipelineLot,
  type PipelinePaths,
  WORK_ITEM_REGISTRY,
} from "../model/context.js";
import { FileWorkItemArtifactStore } from "../state/stores/file-work-item-artifact-store.js";

export { agentBackendRegistryOf, workItemRegistryOf } from "../model/context.js";

type ContextWithWorkItemRegistry = PipelineContext & {
  [WORK_ITEM_REGISTRY]: WorkItemGatewayRegistry;
  [AGENT_BACKEND_REGISTRY]: AgentBackendRegistry;
};

export interface BuildPipelineContextOptions {
  cwd?: string;
  ticket?: string;
  baseBranch?: string;
  runnerBin?: string;
  runnerDir?: string;
  config?: PipelineConfig;
  /** Already-resolved ticket-tracker gateway. This is the injection point for
   *  tests and callers that selected their provider elsewhere. When absent, it is
   *  resolved on first access from `config.workItem.provider`. */
  workItem?: WorkItemGateway;
  /** Provider registry the context carries. Attached by boot, or by the caller
   *  that composes its own registries (`commands/registries.ts`). Without it,
   *  `ctx.workItem` fails loudly rather than falling back to the built-ins. */
  workItemRegistry?: WorkItemGatewayRegistry;
  /** Agent backend registry the context carries, same rule. */
  agentBackendRegistry?: AgentBackendRegistry;
  /** Already-resolved artifact store, primarily for test injection. */
  artifacts?: WorkItemArtifactStore;
  /** Current batch for a feature sub-run. */
  lot?: PipelineLot;
}

/** Batch segment of a reports path. Normalized so it can never escape the
 *  work item: a batch id comes from `lots.json`, hence from a generated artifact. */
function lotSegment(lotId?: string): string | undefined {
  const id = lotId?.trim();
  if (!id) return undefined;
  const safe = id.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "");
  return safe || undefined;
}

/** `path` with every symlink resolved, including when its last segments do not exist
 *  yet (a sub-US created by the run). In a worktree the work item is a link to the
 *  main clone: agents get the real path, because their file search does not follow
 *  links — through the link, a populated work item reads as empty. */
function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(realPath(parent), basename(path));
  }
}

function pathsFor(cwd: string, config: PipelineConfig, ticketDir?: string, lotId?: string): PipelinePaths {
  const root = join(cwd, config.specPath);
  const workItemDir = ticketDir ? realPath(join(root, ticketDir)) : undefined;
  const artifactsDir = workItemDir ? join(workItemDir, "artifacts") : undefined;
  const decisionsDir = workItemDir ? join(workItemDir, "decisions") : undefined;
  // Reports from a batch sub-run are isolated under `reports/<LOT-ID>/`,
  // otherwise `reports/constraints/…` mixes the three batches' reports with no
  // way to tell which one produced which. Outside a batch (spec, plan, triage,
  // finalize), the directory remains flat.
  const lot = lotSegment(lotId);
  const reportsDir = workItemDir ? join(workItemDir, "reports", ...(lot ? [lot] : [])) : undefined;
  const artifact = (name: string): string => {
    if (!workItemDir) throw new Error(`artifact "${name}" requested without a ticket`);
    if (!name || name.startsWith("/") || name.split(/[\\/]/).includes("..")) {
      throw new Error(`invalid artifact name: ${name}`);
    }
    return join(artifactsDir!, name);
  };

  return { workItemDir, artifactsDir, decisionsDir, reportsDir, artifact };
}

/** Assemble the single execution context passed to pipelines and steps. */
export function buildPipelineContext(opts: BuildPipelineContextOptions = {}): PipelineContext {
  const cwd = opts.cwd ?? process.cwd();
  const config = opts.config ?? loadPipelineConfig(cwd);
  const ticketDir = opts.ticket ? resolveTicketDir(opts.ticket, config.specPath, cwd) : undefined;
  const runnerBin = opts.runnerBin ?? process.argv[1] ?? "";
  // Both registries are composition: they are attached here by whoever composed
  // them (boot, or a command), never defaulted to the built-in providers. A
  // context built without one stays provider-neutral and fails loudly at the
  // point of use.
  const workItemRegistry = opts.workItemRegistry;
  const agentBackendRegistry = opts.agentBackendRegistry;
  // Gateway memoization: an injected gateway is used as-is; otherwise provider
  // resolution is deferred until first access (see the getter below).
  let workItem = opts.workItem;

  const context = {
    cwd,
    ticket: opts.ticket,
    ticketDir,
    lot: opts.lot,
    baseBranch: opts.baseBranch,
    runnerBin,
    runnerDir: opts.runnerDir ?? dirname(runnerBin),
    config,
    paths: pathsFor(cwd, config, ticketDir, opts.lot?.id),
    artifacts: opts.artifacts ?? new FileWorkItemArtifactStore({ cwd, config, ticket: opts.ticket, ticketDir }),
    // Getter rather than a value: most runs (and nearly all tests) never contact
    // the tracker. Creating the adapter here would make every context construction
    // depend on a valid provider configuration.
    //
    // INVARIANT — every derivation of this context must go through `deriveContext`.
    // A literal `{ ...context }` reads `workItem`, triggering this getter and
    // creating the gateway for good, even when the caller only wants a different
    // `config`. This is harmless until an adapter validates its configuration at
    // construction; the first one to do so (a Redmine plugin, for example) would
    // turn `--lint-config` and a handful of tests into failures involving a tracker
    // nobody needed.
    get workItem(): WorkItemGateway {
      if (!workItem) {
        if (!workItemRegistry) {
          throw new Error("no work-item gateway registry attached to the pipeline context; boot must attach one");
        }
        workItem = workItemRegistry.resolve({ workItem: config.workItem, labels: config.labels });
      }
      return workItem;
    },
  } as unknown as ContextWithWorkItemRegistry;

  if (workItemRegistry) {
    Object.defineProperty(context, WORK_ITEM_REGISTRY, {
      configurable: true,
      enumerable: false,
      value: workItemRegistry,
      writable: false,
    });
  }
  if (agentBackendRegistry) {
    Object.defineProperty(context, AGENT_BACKEND_REGISTRY, {
      configurable: true,
      enumerable: false,
      value: agentBackendRegistry,
      writable: false,
    });
  }
  return context;
}

/** Fields a derivation may replace. Injected dependencies are excluded: they are
 *  injected when the context is BUILT (`buildPipelineContext({ workItem, artifacts })`),
 *  never afterward.
 *
 *  `lot` is excluded as well: it determines `paths.reportsDir`, which a derivation
 *  does not recompute. Build a batch context (`buildPipelineContext({ lot })`),
 *  as `childContext()` does for sub-runs. */
export type DerivableContextFields = Partial<Omit<PipelineContext, "workItem" | "artifacts" | "lot">>;

/**
 * Derive a context by replacing selected fields WITHOUT touching `workItem`.
 *
 * The `workItem` property descriptor is COPIED, never evaluated: the getter
 * remains a getter and its memoization stays in the original context closure,
 * so contexts derived from the same parent share the gateway if it is created.
 *
 * This is the alternative to `{ ...context, … }`, which silently breaks this invariant.
 *
 * KNOWN LIMITATION: the gateway follows the BASE context configuration because
 * the getter reads it from its closure. Replacing `config` here does not change
 * the resolved provider. This is harmless for the two existing derivations
 * (`config.steps` for linting, `config.specPath` for resuming); an adapter reads
 * neither field. A derivation that must change `config.workItem` must use
 * `buildPipelineContext` instead.
 */
export function deriveContext(base: PipelineContext, overrides: DerivableContextFields): PipelineContext {
  const derived = Object.create(
    Object.getPrototypeOf(base) as object | null,
    Object.getOwnPropertyDescriptors(base),
  ) as PipelineContext;
  return Object.assign(derived, overrides);
}
