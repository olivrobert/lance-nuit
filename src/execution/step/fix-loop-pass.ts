import { artifactScopeFor } from "../runners.js";
import { resolveTemplateAsync } from "../../shared/language/context.js";
import { bindSession } from "../../run/index.js";
import { buildFixContext, type FixRun, selectResumedSession } from "./fix-loop-runtime.js";
import { type FixResult, runFixAttempt } from "./step-attempt.js";
import { headCommit, snapshotTree, type TreeSnapshot, treeChanges } from "./tree-snapshot.js";

/** Repair-pass result. */
export interface FixPassResult {
  fix: FixResult;
}

/** One repair pass: prompt, session, repair agent, and persistence of the session
 * forked by `--resume`. The errors it repairs are extracted by the caller, which
 * owns the output they describe. */
export async function performFixAttempt(
  fx: FixRun,
  input: {
    output: string;
    /** Errors extracted from `output`. */
    errors: string;
    lastFailReason?: string;
    /** Labels for the log line (`Fix claude (2/3)`) and separator (`fix 2/3`). */
    label: string;
    banner: string;
    /** Repair-agent spawn options, with escalation already applied. */
    agentOptions: unknown;
  },
): Promise<FixPassResult | undefined> {
  const { run, step, baseCtx, budget, deps, fixSpec, resumeSession } = fx;
  const { useResume, resumedSession } = selectResumedSession(
    run,
    fixSpec,
    fx.fixBackend,
    fx.sizeThresholdKb,
    resumeSession,
    input.label,
    fx.output,
  );
  if (!useResume) {
    fx.output.emit({ type: "runner.message", level: "info", message: `  → Fix ${fixSpec.id} (${input.label})...` });
  }

  const fixCtx = buildFixContext(baseCtx, input.output, input.errors, step.def.report_paths?.[0], input.lastFailReason);
  const prompt = (await resolveTemplateAsync(fx.fixPrompt!, fixCtx))!;
  const fix = await runFixAttempt(run, step, {
    prompt,
    budget,
    fixWithAgent: deps.runWithAgent,
    backendSpec: fixSpec,
    agentOptions: input.agentOptions,
    banner: `${input.banner}${useResume ? ` (resume "${resumeSession}")` : ""}`,
    spawn: {
      cwd: baseCtx.cwd,
      runnerDir: baseCtx.runnerDir,
      role: step.profile,
      artifactScope: artifactScopeFor(baseCtx),
      ...(useResume && resumedSession ? { resumeSession: resumedSession } : {}),
    },
    registry: fx.registry,
  });
  if (fx.abort.isRunAborted(run)) return undefined;

  // The --resume fork contains the repairs; write it back to the resumed step so a
  // following gate does not resume the pristine pre-fix session.
  if (useResume && resumeSession !== undefined) {
    const target = run.steps.find((candidate) => candidate.def.id === resumeSession);
    const resumed = fix.session ?? resumedSession;
    if (target && resumed) bindSession(run, target, resumed);
  }

  return { fix };
}

/** The working tree and head a repair may change. */
export interface WorkState {
  tree: TreeSnapshot;
  head: string | undefined;
}

export async function workState(cwd: string): Promise<WorkState | undefined> {
  const tree = await snapshotTree(cwd);
  return tree && { tree, head: await headCommit(cwd) };
}

/** The run directory holds the runner's own logs and state, written by the fix pass
 *  itself: a change there is not a repair. */
export function workStateChanged(before: WorkState, after: WorkState, runDir: string): boolean {
  return before.head !== after.head || treeChanges(before.tree, after.tree, [runDir]).length > 0;
}
