import type { StepResult } from "../exec/runners.js";
import { artifactScopeFor } from "../exec/runners.js";
import { resolveTemplateAsync } from "../model/definition.js";
import { saveRun } from "../state/run-repository.js";
import { buildFixContext, type FixRun, selectResumedSession } from "./fix-loop-runtime.js";
import { type FixResult, runAttempt, runFixAttempt, startFreshSession } from "./step-attempt.js";

/** Repair-pass result and the extracted errors that fed it. */
export interface FixPassResult {
  fix: FixResult;
  extractedErrors: string;
}

/** One repair pass: extraction, prompt, session, repair agent, and persistence of
 * the session forked by `--resume`. */
export async function performFixAttempt(
  fx: FixRun,
  input: {
    output: string;
    lastFailReason?: string;
    /** Labels for the log line (`Fix claude (2/3)`) and separator (`fix 2/3`). */
    label: string;
    banner: string;
    /** Repair-agent spawn options, with escalation already applied. */
    agentOptions: unknown;
  },
): Promise<FixPassResult | undefined> {
  const { run, step, baseCtx, budget, opts, deps, fixSpec } = fx;
  const { useResume, resumedSession } = selectResumedSession(
    run,
    fixSpec,
    fx.fixBackend,
    fx.sizeThresholdKb,
    opts.resumeSession,
    input.label,
    fx.output,
  );
  if (!useResume) {
    fx.output.emit({ type: "runner.message", level: "info", message: `  → Fix ${fixSpec.id} (${input.label})...` });
  }

  const extraction = await deps.extractErrors(step, input.output);
  if (fx.abort.isRunAborted(run)) return undefined;
  const fixCtx = buildFixContext(
    baseCtx,
    input.output,
    extraction.errors,
    step.def.report_paths?.[0],
    input.lastFailReason,
  );
  const prompt = (await resolveTemplateAsync(fx.fixPrompt!, fixCtx))!;
  const fix = await runFixAttempt(run, step, {
    prompt,
    budget,
    fixWithAgent: deps.runWithAgent,
    backendSpec: fixSpec,
    agentOptions: input.agentOptions,
    banner: `${input.banner}${useResume ? ` (resume "${opts.resumeSession}")` : ""}`,
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
  if (useResume && opts.resumeSession !== undefined) {
    const target = run.steps.find((candidate) => candidate.def.id === opts.resumeSession);
    const resumed = fix.session ?? resumedSession;
    if (target && resumed) {
      target.session = resumed;
      saveRun(run);
    }
  }

  return { fix, extractedErrors: extraction.errors };
}

/** Rerun the step command in a fresh session for a loop retry. */
export async function runStepCommandFresh(fx: FixRun, label: string, banner: string): Promise<StepResult> {
  const { run, step, budget, deps } = fx;
  fx.output.emit({ type: "runner.message", level: "info", message: `  → ${label} ${step.def.name}...` });
  const session = startFreshSession(step, fx.backend);
  saveRun(run);
  return runAttempt(run, step, {
    command: fx.command,
    context: fx.baseCtx,
    budget,
    executeStep: deps.executeStep,
    banner,
    spawn: { session },
  });
}
