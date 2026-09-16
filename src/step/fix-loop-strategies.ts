import { costDecision } from "../state/budget.js";
import { recordCostStop } from "../state/cost-stop-events.js";
import { saveRun } from "../state/run-repository.js";
import { updateStep } from "../state/run-transitions.js";
import { EscalationLatch, escalationLadderFor } from "./escalation.js";
import { performFixAttempt, runStepCommandFresh } from "./fix-loop-pass.js";
import type { FixRun } from "./fix-loop-runtime.js";
import { settleStepFailure } from "./non-blocking.js";

/** Repair pass then command replay, looping up to `max_retries`, with escalation. */
export async function runFixRetryLoop(
  fx: FixRun,
  output: string,
  initialFailReason: string | undefined,
): Promise<{ failed: boolean }> {
  const { run, step, budget, opts } = fx;
  const failure = step.def.on_failure!;
  const maxRetries = failure.max_retries;
  const latch = new EscalationLatch(escalationLadderFor(failure), failure.escalate_after);
  let lastOutput = output;
  let lastFailReason = initialFailReason;
  let fixed = false;
  let announced = false;

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
    const beforeFix = costDecision(run.max_cost_usd, budget);
    if (beforeFix !== "continue") {
      fx.output.emit({
        type: "runner.message",
        level: "warn",
        message:
          beforeFix === "unaccounted"
            ? `  Spending unaccounted, stopping retries`
            : `  Budget exceeded, stopping retries`,
      });
      // A withheld repair pass is withheld work, like a withheld retry.
      recordCostStop(run, budget, beforeFix, { kind: "gate", stepId: step.id });
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

    step.retries++;
    saveRun(run);

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
    const pass = await performFixAttempt(fx, {
      output: lastOutput,
      lastFailReason,
      label,
      banner: `fix ${label}`,
      agentOptions: fx.fixBackend.applyEscalation?.(fx.backendOptions, latch.axes()) ?? fx.backendOptions,
    });
    if (!pass) return { failed: false };

    if (!pass.fix.ok) {
      fx.output.emit({ type: "runner.message", level: "error", message: `  Fix failed, retry cancelled` });
      break;
    }

    const beforeRetry = costDecision(run.max_cost_usd, budget);
    if (beforeRetry !== "continue") {
      fx.output.emit({
        type: "runner.message",
        level: "warn",
        message:
          beforeRetry === "unaccounted"
            ? `  Spending unaccounted, stopping retries`
            : `  Budget exceeded, stopping retries`,
      });
      recordCostStop(run, budget, beforeRetry, { kind: "gate", stepId: step.id });
      break;
    }

    const retry = await runStepCommandFresh(fx, "Retry", `retry ${label}`);
    if (fx.abort.isRunAborted(run)) return { failed: false };

    if (retry.ok) {
      fixed = true;
      break;
    }
    if (retry.failReason) lastFailReason = retry.failReason;

    // Exit status remains authoritative: a silent extractor after a crash cannot
    // turn the retry into success. Full output feeds the next fix.
    lastOutput = retry.output;
  }

  if (fx.abort.isRunAborted(run)) return { failed: false };
  if (fixed) {
    updateStep(run, step, "done");
    fx.output.emit({
      type: "step.done",
      step,
      suffix:
        opts.resumeSession !== undefined ? ` (after ${step.retries} resumed fixes)` : ` (after ${step.retries} fixes)`,
    });
    return { failed: false };
  }
  return settleStepFailure(run, step, fx.output, lastFailReason, {
    absorbDetail: `after ${step.retries} attempt(s)`,
    failSuffix: ` after ${step.retries} attempts`,
  });
}
