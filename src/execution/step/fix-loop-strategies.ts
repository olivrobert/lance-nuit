import { consumeRetry, costGate, refundRetry } from "../../run/index.js";
import { EscalationLatch, escalationLadderFor } from "./escalation.js";
import { performFixAttempt, runStepCommandFresh } from "./fix-loop-pass.js";
import type { FixRun } from "./fix-loop-runtime.js";
import { settleStepFailure } from "./non-blocking.js";
import { headCommit, snapshotTree, type TreeSnapshot, treeChanges } from "./tree-snapshot.js";

interface WorkState {
  tree: TreeSnapshot;
  head: string | undefined;
}

async function workState(cwd: string): Promise<WorkState | undefined> {
  const tree = await snapshotTree(cwd);
  return tree && { tree, head: await headCommit(cwd) };
}

/** The run directory holds the runner's own logs and state, written by the fix pass
 *  itself: a change there is not a repair. */
function workStateChanged(before: WorkState, after: WorkState, runDir: string): boolean {
  return before.head !== after.head || treeChanges(before.tree, after.tree, [runDir]).length > 0;
}

/** Outcome of the repair loop. `blocked` is set, step left unsettled, when a replay
 * declared an obstacle outside the code: the outcome phase stops the run on it as
 * it does for a first attempt. `doneSuffix` is set on a repaired success, which
 * the pass settles `done`. */
export interface FixLoopOutcome {
  failed: boolean;
  blocked?: { failReason?: string };
  doneSuffix?: string;
}

/** Repair pass then command replay, looping up to `max_retries`, with escalation. */
export async function runFixRetryLoop(
  fx: FixRun,
  output: string,
  initialFailReason: string | undefined,
): Promise<FixLoopOutcome> {
  const { run, step, budget, opts } = fx;
  const failure = step.def.on_failure!;
  const maxRetries = failure.max_retries;
  const latch = new EscalationLatch(escalationLadderFor(failure), failure.escalate_after);
  let lastOutput = output;
  let lastFailReason = initialFailReason;
  let fixed = false;
  let announced = false;
  // Set whenever the loop ends because spend was withheld or cut short, so the
  // epilogue keeps the step resumable instead of absorbing it as non-blocking.
  let costStopped = false;

  // `step.retries` is persisted across run segments on purpose, so a resumed step
  // readmitted by `rerun_on_resume` can reach the loop with its quota already
  // spent. Say so explicitly: the loop body never runs, and silence would read as
  // a repair that happened.
  if (!fx.abort.isRunAborted(run) && step.retries >= maxRetries) {
    fx.output.emit({
      type: "runner.message",
      level: "warn",
      message: `  Fix quota already consumed (${step.retries}/${maxRetries} retries), no repair launched`,
    });
  }

  while (!fx.abort.isRunAborted(run) && step.retries < maxRetries) {
    // A cost stop ends repair as it ends rerun: an unaccountable spend is not a
    // defect a fix pass could repair, so no attempt is paid for trying.
    // A withheld repair pass is withheld work, recorded by the gate like a
    // withheld retry.
    const beforeFix = costGate(run, budget, step.id);
    if (beforeFix) {
      fx.output.emit({
        type: "runner.message",
        level: "warn",
        message:
          beforeFix === "cost-unaccounted"
            ? `  Spending unaccounted, stopping retries`
            : `  Budget exceeded, stopping retries`,
      });
      costStopped = true;
      break;
    }

    // The backend choice is announced here and not at preparation time: past the
    // budget gate, a repair is about to run, so the line describes a real action.
    if (!announced) {
      announced = true;
      fx.output.emit({
        type: "runner.message",
        level: "info",
        message: `  → Fix backend ${fx.fixSpec.id} — ${fx.fixReason}`,
      });
    }

    // Before incrementing, like the rerun loop: retries are attempts already made.
    // A fix never times out on its own, so only the threshold can move the rung.
    const escalated = latch.advance({ timedOut: false, retries: step.retries });

    consumeRetry(run, step, "retries");

    // Increase effort before model: a failed fix may need more thinking rather than
    // a higher tier.
    if (escalated) {
      fx.output.emit({
        type: "runner.message",
        level: "info",
        message: `  ↑ Escalate fix → ${latch.label()} (retry ${step.retries}/${maxRetries})`,
      });
    }
    const label = `${step.retries}/${maxRetries}`;
    const stateBeforeFix = failure.stop_if_unchanged ? await workState(fx.baseCtx.cwd) : undefined;
    if (fx.abort.isRunAborted(run)) return { failed: false };
    const pass = await performFixAttempt(fx, {
      output: lastOutput,
      lastFailReason,
      label,
      banner: `fix ${label}`,
      agentOptions: fx.fixBackend.applyEscalation?.(fx.backendOptions, latch.axes()) ?? fx.backendOptions,
    });
    if (!pass || fx.abort.isRunAborted(run)) return { failed: false };

    if (refundRetry(run, step, "retries", pass.fix)) {
      costStopped = true;
      fx.output.emit({ type: "runner.message", level: "warn", message: `  Fix stopped by the cost guard` });
      break;
    }

    if (!pass.fix.ok) {
      fx.output.emit({ type: "runner.message", level: "error", message: `  Fix failed, retry cancelled` });
      break;
    }

    // The original failure is kept as the step's reason: nothing re-checked the
    // code, so reports must not read the repair as a verified success.
    if (failure.replay_after_fix === false) {
      fx.output.emit({ type: "runner.message", level: "info", message: `  Fix applied, command not replayed` });
      lastFailReason = `${lastFailReason ?? "failure"} (fix applied, not replayed)`;
      break;
    }

    // A replay after a repair that touched nothing would pay for the same verdict.
    if (stateBeforeFix) {
      const stateAfterFix = await workState(fx.baseCtx.cwd);
      if (fx.abort.isRunAborted(run)) return { failed: false };
      if (stateAfterFix && !workStateChanged(stateBeforeFix, stateAfterFix, run.run_dir)) {
        fx.output.emit({ type: "runner.message", level: "info", message: `  Fix changed nothing, replay skipped` });
        return { failed: false, blocked: { failReason: `${lastFailReason ?? "failure"} (fix changed nothing)` } };
      }
    }

    const beforeRetry = costGate(run, budget, step.id);
    if (beforeRetry) {
      fx.output.emit({
        type: "runner.message",
        level: "warn",
        message:
          beforeRetry === "cost-unaccounted"
            ? `  Spending unaccounted, stopping retries`
            : `  Budget exceeded, stopping retries`,
      });
      costStopped = true;
      break;
    }

    const retry = await runStepCommandFresh(fx, "Retry", `retry ${label}`);
    if (fx.abort.isRunAborted(run)) return { failed: false };

    if (retry.ok) {
      fixed = true;
      break;
    }
    if (retry.failReason) lastFailReason = retry.failReason;
    // The replay was cut short, not refuted: its verdict is unknown.
    if (retry.budgetExceeded || retry.costUnaccounted) {
      costStopped = true;
      break;
    }
    if (retry.failCause === "blocked") return { failed: false, blocked: { failReason: retry.failReason } };

    // Exit status remains authoritative: a silent extractor after a crash cannot
    // turn the retry into success. Full output feeds the next fix.
    lastOutput = retry.output;
  }

  if (fx.abort.isRunAborted(run)) return { failed: false };
  if (fixed) {
    return {
      failed: false,
      doneSuffix:
        opts.resumeSession !== undefined ? ` (after ${step.retries} resumed fixes)` : ` (after ${step.retries} fixes)`,
    };
  }
  return settleStepFailure(
    run,
    step,
    fx.output,
    lastFailReason,
    {
      absorbDetail: `after ${step.retries} attempt(s)`,
      failSuffix: ` after ${step.retries} attempts`,
    },
    costStopped,
  );
}
