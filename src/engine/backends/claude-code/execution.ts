import { runSupervisedStream, supervisorTimeout } from "../../../exec/process-runner.js";
import { asFiniteNumber as num, asRecord as rec } from "../../../lib/json-values.js";
import { toolLabel } from "../../../lib/tool-label.js";
import { activityEvent, contextEvent, contextTokensFromUsage } from "../../../runtime/context.js";
import { clearLiveAttemptCost, reportLiveAttemptCost } from "../../../runtime/live-cost.js";
import { budgetExceededReason, lineSplitter, liveMessageSink } from "../host-helpers.js";
import { netCumulative } from "./cost-state.js";
import { addUsage, estimateCostUsd, newUsageTotals, SYNTHETIC_MODEL, textFromAssistantEvent } from "./events.js";
import { contextWindow } from "./pricing.js";
import type {
  ClaudeBackendHost,
  ClaudeExecutionOptions,
  NodeClaudeHostOptions,
  RawClaudeExecutionResult,
} from "./types.js";

const DRAIN = 2000;

async function executeNode(
  options: ClaudeExecutionOptions,
  host: NodeClaudeHostOptions,
): Promise<RawClaudeExecutionResult> {
  // A fresh attempt must not inherit the previous attempt's live estimate — except
  // the spend of the transport attempts it replaces, which is already real.
  const priorCost = options.priorAttemptsCostUsd ?? 0;
  // A resumed spawn streams the session ledger, ancestors included. Netting the
  // restored baseline out keeps the guard measuring THIS attempt: otherwise it
  // kills a cheap fix pass for the coder session it merely inherited.
  const costBaseline = options.sessionCostBaselineUsd ?? 0;
  if (priorCost > 0) reportLiveAttemptCost(priorCost);
  else clearLiveAttemptCost();
  const env = { ...process.env };
  delete env.CLAUDECODE;
  // Supervised spawn: tracked for shutdown, SIGTERM→SIGKILL escalation on
  // timeout/budget kill, so an unresponsive CLI cannot hang the step forever.
  const { killedForCleanup, killReason, ...result } = await runSupervisedStream(
    options.bin,
    options.args,
    {
      cwd: options.cwd,
      env,
      stdio: ["ignore", "pipe", "inherit"],
      detached: true,
      timeoutMs: supervisorTimeout(options.timeoutMs),
      drainMs: DRAIN,
    },
    (control) => {
      let reportedCost: number | undefined,
        streamModel: string | undefined,
        // Same split as `parseClaudeEvents`: `streamModel` is the model that ran the
        // last turn (cost follows it), `sessionModel` the one negotiated at startup.
        // The `[1m]` suffix that lifts the window to 1M appears ONLY on `system`/`init`,
        // so the window follows `sessionModel` — off the turn model a 1M session
        // measures itself against 200k and reports an occupancy 5× too high.
        sessionModel: string | undefined;
      // The CLI may repeat a message as it streams. Telemetry is published once
      // per message id so a tool call is not announced twice — and usage is counted
      // once, or the live estimate would grow with every repeat.
      const announced = new Set<string>();
      // Same accumulation as `parseClaudeEvents`, on the same `usage` blocks the
      // status line reads: the mid-flight estimate and the cost reported at the end
      // follow ONE rule. A CLI-reported cost always wins over the estimate.
      const totals = newUsageTotals();
      // Agent text reaches the step log as it streams, like codex and opencode:
      // without it `output.log` stays empty for every Claude step and `logs` has
      // nothing to show once the CLI exits.
      const appendMessage = liveMessageSink(options.stepLogPath, textFromAssistantEvent);
      const estimate = () =>
        reportedCost != null
          ? netCumulative(reportedCost, costBaseline)
          : estimateCostUsd(totals, streamModel ?? options.claudeOptions?.model);
      const consume = (line: string) => {
        try {
          const o = rec(JSON.parse(line));
          if (!o) return;
          appendMessage(o);
          const cost = num(o.total_cost_usd);
          if (cost !== undefined) reportedCost = cost;
          if (o.type === "system" && typeof o.model === "string") {
            sessionModel = o.model;
            streamModel ??= o.model;
          }
          if (o.type === "assistant") {
            const m = rec(o.message);
            if (m) {
              const messageModel = typeof m.model === "string" && m.model !== SYNTHETIC_MODEL ? m.model : undefined;
              if (messageModel) streamModel = messageModel;
              const id = typeof m.id === "string" ? m.id : undefined;
              const fresh = !id || !announced.has(id);
              if (id) announced.add(id);
              for (const c of Array.isArray(m.content) ? m.content : []) {
                const x = rec(c);
                if (fresh && x?.type === "tool_use" && typeof x.name === "string" && x.name !== "StructuredOutput")
                  host.onEvent?.(activityEvent(toolLabel(x.name, x.input), x.name, Date.now()));
              }
              const usage = rec(m.usage);
              if (fresh && usage) {
                addUsage(totals, usage, messageModel);
                // Context occupancy is the footprint of THIS turn, so it is read per
                // message rather than accumulated: it goes down after a compaction.
                host.onEvent?.(
                  contextEvent(
                    contextTokensFromUsage(usage),
                    contextWindow(sessionModel ?? streamModel),
                    sessionModel ?? streamModel,
                    Date.now(),
                  ),
                );
              }
            }
          }
          const estimated = estimate();
          // Publish the running estimate so an abort (SIGINT) can persist the
          // killed attempt's spend into the budget ledger. The budget gate below
          // stays on this attempt alone: the transport already deducted the
          // discarded attempts from `budgetRemaining`.
          reportLiveAttemptCost(priorCost + estimated);
          // No accounting guard here, unlike codex and opencode: `pricingForModel`
          // always resolves — an unlisted Claude model falls back to the opus rate
          // — so this backend can never prove a live attempt unpriceable. Its
          // estimate is always usable for the ceiling, and `strictCostAccounting`
          // would have nothing to fire on.
          if (options.budgetRemaining != null && estimated > options.budgetRemaining && !control.killed) {
            control.kill(budgetExceededReason(estimated, options.budgetRemaining, "estimated"));
          }
        } catch {}
      };
      const lines = lineSplitter(consume);
      return {
        onStdout: (text) => lines.push(text),
        onFinalize: () => lines.flush(),
      };
    },
  );
  if (killedForCleanup) host.log?.("  · Group cleaned after CLI exit");
  // A straggler is a hygiene issue, not a verdict: the CLI reported its result and
  // the group has been cleaned. `killReason` is dropped with it so the mapper does
  // not read a kill where there was none.
  return result.killed && killReason ? { ...result, killReason } : result;
}

export function createNodeClaudeHost(options: NodeClaudeHostOptions = {}): ClaudeBackendHost {
  return {
    execute: (request) => executeNode(request, options),
    onSpawn: options.onSpawn,
    capabilityRoots: options.capabilityRoots,
    isForkedSlashCommand: options.isForkedSlashCommand,
    forkRelayPrompt: options.forkRelayPrompt,
    onEvent: options.onEvent,
    log: options.log,
  };
}
export function executeClaude(
  options: ClaudeExecutionOptions,
  host: ClaudeBackendHost = createNodeClaudeHost(),
): Promise<RawClaudeExecutionResult> {
  return host.execute(options);
}
