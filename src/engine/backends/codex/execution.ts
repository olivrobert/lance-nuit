import { runSupervisedStream, supervisorTimeout } from "../../../exec/process-runner.js";
import { jsonRecords } from "../../../lib/json-values.js";
import { clearLiveAttemptCost, reportLiveAttemptCost } from "../../../runtime/live-cost.js";
import { budgetExceededReason, costUnaccountedReason, lineSplitter, liveMessageSink } from "../host-helpers.js";
import { accumulateCodexUsage, agentMessageFromEvent, newCodexUsageTotals } from "./events.js";
import { parseCodexEvent } from "./events.schema.js";
import { computeCostUsd } from "./pricing.js";
import type {
  CodexBackendHost,
  CodexExecutionOptions,
  NodeCodexHostOptions,
  RawCodexExecutionResult,
} from "./types.js";

// `codex exec` announces on stderr that it is draining stdin whenever stdin is not a
// TTY, which is always the case here: the child is detached and its stdin is
// `ignore`. The runner always passes the prompt as an argument, so the notice
// describes an empty read and is pure noise in the console. It is dropped line by
// line; every other stderr diagnostic is forwarded unchanged.
const CODEX_STDIN_NOTICE = /^\s*Reading additional input from stdin\.\.\.\s*$/;

/** Forwards the child's stderr to ours, minus the empty-stdin notice. */
function stderrForwarder(): { push(text: string): void; flush(): void } {
  let pending = "";
  const writeKept = (lines: string[]): void => {
    const kept = lines.filter((line) => !CODEX_STDIN_NOTICE.test(line));
    if (kept.length > 0) process.stderr.write(`${kept.join("\n")}\n`);
  };
  return {
    push(text: string): void {
      pending += text;
      const lines = pending.split("\n");
      // A chunk rarely ends on a line boundary: the tail waits for the next chunk.
      pending = lines.pop() ?? "";
      writeKept(lines);
    },
    flush(): void {
      if (pending.length === 0) return;
      const tail = pending;
      pending = "";
      if (!CODEX_STDIN_NOTICE.test(tail)) process.stderr.write(tail);
    },
  };
}

/** Node-only fallback host. Applications can replace it with their supervisor. */
export function createNodeCodexHost(hostOptions: NodeCodexHostOptions = {}): CodexBackendHost {
  return {
    async execute(options: CodexExecutionOptions): Promise<RawCodexExecutionResult> {
      clearLiveAttemptCost();
      const { killedForCleanup, ...result } = await runSupervisedStream(
        options.bin,
        options.args,
        {
          cwd: options.cwd,
          env: { ...process.env },
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
          timeoutMs: supervisorTimeout(options.timeoutMs),
        },
        (control) => {
          const stderr = stderrForwarder();
          // Incremental accumulation: each stream line is parsed exactly once.
          // Re-parsing the accumulated output on every chunk made a long run
          // quadratic in its own transcript.
          const totals = newCodexUsageTotals(options.model);
          const appendMessage = liveMessageSink(options.stepLogPath, agentMessageFromEvent);
          const checkBudget = (): void => {
            const spentTokens = totals.inputTokens + totals.cachedInputTokens + totals.outputTokens;
            const estimated = computeCostUsd(
              {
                input_tokens: totals.inputTokens,
                cache_read_tokens: totals.cachedInputTokens,
                output_tokens: totals.outputTokens,
              },
              totals.model,
            );
            reportLiveAttemptCost(estimated ?? undefined);
            if (control.killed) return;
            // Proof, not suspicion: this attempt HAS consumed tokens and no rate
            // covers its model, so its spend can never be compared to the ceiling.
            // An attempt that has not reported usage yet reaches neither branch —
            // `checkBudget` only runs on a usage event, and silence is not proof.
            if (options.strictCostAccounting === true && estimated == null && spentTokens > 0) {
              control.kill(costUnaccountedReason(`${totals.model ?? "unknown model"}: no pricing entry`));
              return;
            }
            if (options.budgetRemaining == null) return;
            if (estimated != null && estimated > options.budgetRemaining) {
              control.kill(budgetExceededReason(estimated, options.budgetRemaining, "estimated"));
            }
          };
          const lines = lineSplitter((line) => {
            for (const record of jsonRecords(line)) {
              const event = parseCodexEvent(record);
              appendMessage(event);
              if (accumulateCodexUsage(event, totals)) checkBudget();
            }
          });
          return {
            onStdout: (text) => {
              lines.push(text);
              hostOptions.appendLiveOutput?.(text);
              if (options.stepLogPath) hostOptions.appendAgentMessage?.(text, options.stepLogPath);
            },
            onStderr: (text) => stderr.push(text),
            onFinalize: () => {
              lines.flush();
              stderr.flush();
            },
          };
        },
      );
      // Unlike the Claude host, a straggler rejects the run: `codex exec` owns its
      // process tree, so a descendant outliving it means the run did not complete
      // as reported.
      return { ...result, killed: result.killed || killedForCleanup };
    },
    onSpawn: hostOptions.onSpawn,
  };
}

export function executeCodex(
  options: CodexExecutionOptions,
  host: CodexBackendHost = createNodeCodexHost(),
): Promise<RawCodexExecutionResult> {
  return host.execute(options);
}
