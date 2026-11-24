import { runSupervisedStream } from "../../../shared/process/process-runner.js";
import { type JsonRecord, jsonRecords } from "../../../shared/lib/json-values.js";
import { toolLabel } from "../../../shared/lib/tool-label.js";
import { activityEvent, contextEvent } from "../../../shared/runtime/context.js";
import { guardLiveSpend, lineSplitter, liveMessageSink } from "../host-helpers.js";
import { attemptCostUsd } from "./cost-state.js";
import { createClaudeStreamReader, textFromAssistantEvent } from "./events.js";
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
  options.onLiveCost?.(priorCost > 0 ? priorCost : undefined);
  const env = { ...process.env };
  delete env.CLAUDECODE;
  const reader = createClaudeStreamReader(options.claudeOptions?.model);
  // Agent text reaches the step log as it streams, like codex and opencode:
  // without it `output.log` stays empty for every Claude step and `logs` has
  // nothing to show once the CLI exits.
  const appendMessage = liveMessageSink(options.stepLogPath, textFromAssistantEvent);
  const publish = (event: unknown): void => host.onEvent?.(event);
  // Supervised spawn: tracked for shutdown, SIGTERM→SIGKILL escalation on
  // timeout/budget kill, so an unresponsive CLI cannot hang the step forever.
  const { kill, ...result } = await runSupervisedStream(
    options.bin,
    options.args,
    {
      cwd: options.cwd,
      env,
      stdio: ["ignore", "pipe", "inherit"],
      detached: true,
      timeoutMs: options.timeoutMs,
      drainMs: DRAIN,
    },
    (control) => {
      const consume = (record: JsonRecord): void => {
        appendMessage(record);
        const effect = reader.push(record);
        for (const tool of effect.tools)
          publish(activityEvent(toolLabel(tool.name, tool.input), tool.name, Date.now(), options.stepId));
        if (effect.context) {
          const { tokens, window, model } = effect.context;
          publish(contextEvent(tokens, window, model, Date.now(), options.stepId));
        }
        const cost = reader.cost();
        // No accounting guard here, unlike codex and opencode: `pricingForModel`
        // always resolves — an unlisted Claude model falls back to the opus rate
        // — so this backend can never prove a live attempt unpriceable. The budget
        // stays on this attempt alone: the transport already deducted the
        // discarded attempts from `budgetRemaining`.
        guardLiveSpend(
          control,
          {
            costUsd: attemptCostUsd(cost, costBaseline),
            priorUsd: priorCost,
            model: reader.model(),
            source: cost.estimated ? "estimated" : "reported",
          },
          options,
        );
      };
      const lines = lineSplitter((line) => {
        for (const record of jsonRecords(line)) consume(record);
      });
      return {
        onStdout: (text) => lines.push(text),
        onFinalize: () => lines.flush(),
      };
    },
  );
  if (kill?.cause === "cleanup") host.log?.("  · Group cleaned after CLI exit");
  // A straggler is a hygiene issue, not a verdict: the CLI reported its result and
  // the group has been cleaned. The kill is dropped with it so the mapper does
  // not read a kill where there was none.
  const stream = reader.finish();
  return kill && kill.cause !== "cleanup" ? { ...result, stream, kill } : { ...result, stream };
}

export function createNodeClaudeHost(options: NodeClaudeHostOptions = {}): ClaudeBackendHost {
  return {
    execute: (request) => executeNode(request, options),
    onSpawn: options.onSpawn,
    capabilityRoots: options.capabilityRoots,
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
