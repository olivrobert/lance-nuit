import { runSupervisedStream, supervisorTimeout } from "../../../exec/process-runner.js";
import {
  type JsonRecord,
  jsonRecords,
  asFiniteNumber as numberValue,
  asRecord as record,
  asString as stringValue,
} from "../../../lib/json-values.js";
import { activityEvent, contextEvent } from "../../../runtime/context.js";
import { clearLiveAttemptCost, reportLiveAttemptCost } from "../../../runtime/live-cost.js";
import { budgetExceededReason, costUnaccountedReason, lineSplitter, liveMessageSink } from "../host-helpers.js";
import { opencodeToolLabel, textFromEvent } from "./events.js";
import { resolveOpencodeCost } from "./pricing.js";
import type {
  NodeOpencodeHostOptions,
  OpencodeBackendHost,
  OpencodeExecutionOptions,
  RawOpencodeExecutionResult,
} from "./types.js";

/** Node-only fallback host. Applications can replace it with their supervisor. */
export function createNodeOpencodeHost(hostOptions: NodeOpencodeHostOptions = {}): OpencodeBackendHost {
  return {
    async execute(options: OpencodeExecutionOptions): Promise<RawOpencodeExecutionResult> {
      clearLiveAttemptCost();
      let logs = "";
      const { killedForCleanup, ...result } = await runSupervisedStream(
        options.bin,
        options.args,
        {
          cwd: options.cwd,
          // The caller owns the environment; `process.env` is never merged in here.
          // Left to itself, opencode re-injects the user's `~/.claude/CLAUDE.md`:
          // ~1250 measured input tokens of personal instructions inside an agent
          // that is supposed to be deterministic.
          env: { ...options.env },
          // stdin MUST be closed. `opencode run` aggregates stdin into the prompt,
          // so an open pipe makes it wait for an EOF forever: zero byte on stdout
          // AND stderr, then a timeout kill. Measured on opencode 1.17.7.
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
          timeoutMs: supervisorTimeout(options.timeoutMs),
        },
        (control) => {
          const appendMessage = liveMessageSink(options.stepLogPath, textFromEvent);
          let costUsd = 0;
          let costReported = false;
          // Token totals for the estimate path: a provider that reports usage but no
          // `cost` is priced from pricing.json, live, the way the mapper prices it at
          // the end. Otherwise such a model is never stopped by the guard, and a kill
          // leaves `cost_unknown` on a spend that was estimable all along.
          let inputTokens = 0;
          let outputTokens = 0;
          let cacheReadTokens = 0;
          let cacheCreationTokens = 0;
          const projectPricing = hostOptions.projectPricing;

          // A model never called before can take over 60s to warm up and then answer
          // in 1.4s: the deadline watches the first event, not the total duration.
          const firstEventTimeoutMs = options.firstEventTimeoutMs;
          const firstEventTimer =
            firstEventTimeoutMs != null && firstEventTimeoutMs > 0
              ? setTimeout(() => {
                  control.kill(`no first event within ${firstEventTimeoutMs}ms`);
                }, firstEventTimeoutMs)
              : undefined;
          firstEventTimer?.unref();

          const checkBudget = (): void => {
            // A non-zero provider cost is exact and wins. A reported `cost: 0` on a
            // run that spent tokens is opencode failing to price the model, so it
            // falls back to the declared project rate exactly as an absent cost
            // does: with no table, an unknown model must never be billed at the
            // price of the most expensive one — unknown is not free, not costly.
            const breakdown = {
              input_tokens: inputTokens,
              cache_read_tokens: cacheReadTokens,
              cache_creation_tokens: cacheCreationTokens,
              output_tokens: outputTokens,
            };
            const cost =
              projectPricing === undefined
                ? resolveOpencodeCost({ costReported, costUsd }, breakdown, options.model)
                : resolveOpencodeCost({ costReported, costUsd }, breakdown, options.model, projectPricing);
            const spent = cost.costUsd;
            reportLiveAttemptCost(spent);
            if (control.killed) return;
            // `unknown` is opencode's own verdict on this usage: tokens were spent
            // and neither the provider figure nor the project table could price
            // them. Under a ceiling nobody authorized unmetered spend against,
            // that is the stop — not a comparison against a number nobody stands
            // behind. `checkBudget` runs on a usage event only, so an attempt that
            // has reported nothing yet is never killed for it.
            if (cost.unknown && options.strictCostAccounting === true) {
              control.kill(costUnaccountedReason(`${options.model ?? "unknown model"}: no reliable price`));
              return;
            }
            // An unknown spend cannot be compared to a budget: killing on it would
            // stop a run over a number nobody stands behind.
            if (spent == null || cost.unknown || options.budgetRemaining == null) return;
            if (spent <= options.budgetRemaining) return;
            control.kill(
              budgetExceededReason(spent, options.budgetRemaining, cost.estimated ? "estimated" : "reported"),
            );
          };

          const handle = (event: JsonRecord): void => {
            if (firstEventTimer) clearTimeout(firstEventTimer);
            // Each stream line is parsed exactly once; re-parsing the accumulated
            // output on every chunk made a long run quadratic in its own transcript.
            appendMessage(event);
            const part = record(event.part);
            if (event.type === "tool_use") {
              const tool = stringValue(part?.tool);
              const input = record(part?.state)?.input;
              if (tool) hostOptions.onEvent?.(activityEvent(opencodeToolLabel(tool, input), tool, Date.now()));
              return;
            }
            if (event.type !== "step_finish") return;
            const tokens = record(part?.tokens);
            inputTokens += numberValue(tokens?.input) ?? 0;
            outputTokens += numberValue(tokens?.output) ?? 0;
            const cache = record(tokens?.cache);
            cacheReadTokens += numberValue(cache?.read) ?? 0;
            cacheCreationTokens += numberValue(cache?.write) ?? 0;
            const total = numberValue(tokens?.total);
            if (total != null) {
              // `tokens.total` is the occupancy of this step, so it is published per
              // step rather than accumulated.
              hostOptions.onEvent?.(
                contextEvent(total, hostOptions.contextWindow?.(options.model) ?? 0, options.model, Date.now()),
              );
            }
            const cost = numberValue(part?.cost);
            if (cost != null) {
              costUsd += cost;
              costReported = true;
            }
            checkBudget();
          };

          const lines = lineSplitter((line) => {
            for (const event of jsonRecords(line)) handle(event);
          });

          return {
            onStdout: (text) => {
              lines.push(text);
              hostOptions.appendLiveOutput?.(text);
              if (options.stepLogPath) hostOptions.appendAgentMessage?.(text, options.stepLogPath);
            },
            // stderr is kept, not merely forwarded: opencode retries `stream error`
            // silently (~65s backoff, nothing on stdout), so a billing or auth failure
            // is indistinguishable from a hang unless these lines survive the run.
            onStderr: (text) => {
              logs += text;
              hostOptions.appendLiveLogs?.(text);
            },
            onFinalize: () => {
              lines.flush();
              if (firstEventTimer) clearTimeout(firstEventTimer);
            },
          };
        },
      );
      // Same choice as the codex host: a descendant outliving `opencode run` means
      // the run did not complete as reported.
      return { ...result, logs, killed: result.killed || killedForCleanup };
    },
    onSpawn: hostOptions.onSpawn,
    onEvent: hostOptions.onEvent,
  };
}

export function executeOpencode(
  options: OpencodeExecutionOptions,
  host: OpencodeBackendHost = createNodeOpencodeHost(),
): Promise<RawOpencodeExecutionResult> {
  return host.execute(options);
}
