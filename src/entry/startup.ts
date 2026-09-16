// runner/entry/startup.ts
//
// Everything that happens BEFORE the first step runs: argument parsing, the
// no-pipeline commands, run-argument validation, boot, the one-per-process
// pipeline load, the approval decision, and the dispatch decision point.
//
// Each phase RETURNS its outcome instead of calling `process.exit`. The entry
// point owns the single exit, which is what makes these phases testable: a test
// can assert "this argv exits 1 with that message" without a process boundary.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { runBoot } from "../boot/step.js";
import { resolveApprovalArtifact } from "../commands/approval-subject.js";
import { COMMANDS } from "../commands/command.js";
import { runDispatch } from "../dispatch/loop.js";
import { selectDispatch, validateDispatchArgs } from "../dispatch/strategy.js";
import { enclosingKitProjectRoot, KIT_DIR } from "../env/kit-paths.js";
import { errorMessage } from "../lib/errors.js";
import type { PipelineContext } from "../model/context.js";
import type { Pipeline } from "../model/definition.js";
import { loadPipelineDefinition } from "../pipeline/loader.js";
import { CliError, type RunnerArgs } from "../model/cli-options.js";
import { parseRunnerArgs } from "../cli/parse.js";
import { liveFeedFromEnvironment } from "../output/live-feed.js";
import { setRunnerLiveFeed } from "../runtime/live-feed.js";
import { log } from "../runtime/logging.js";
import { type DecisionSubject, recordApproval } from "../state/decisions.js";
import { FileRunStateStore } from "../state/stores/file-run-state-store.js";
import { createDefaultRunnerRegistries } from "./registries.js";

/** A ticket reaches the filesystem (context paths, worktree directory) before any
 *  guard downstream, so its shape is validated before boot, never after. */
const TICKET_SHAPE = /^[\w-]+(\/[\w-]+)*$/;

/** State a normal run needs, once every pre-run phase has succeeded. */
export interface ReadyRun {
  args: RunnerArgs;
  context: PipelineContext;
  pipelineDef: Pipeline;
  pipelinePath: string;
  stateStore: FileRunStateStore;
  worktreeMode: boolean;
  /** Set when `--approve` recorded a decision that the run must journal. */
  approvedSubject?: DecisionSubject;
}

export type StartupOutcome = { kind: "exit"; code: number } | { kind: "run"; ready: ReadyRun };

export type ParseOutcome = { kind: "args"; args: RunnerArgs } | { kind: "error"; message: string };

/** Parse argv, turning the parser's usage errors into a reportable message. */
export function parseArgs(argv: string[]): ParseOutcome {
  try {
    return { kind: "args", args: parseRunnerArgs(argv) };
  } catch (error) {
    if (error instanceof CliError) return { kind: "error", message: error.message };
    throw error;
  }
}

/** Run the first matching no-pipeline command, if any. Returns its exit code. */
export async function runEarlyCommand(args: RunnerArgs): Promise<number | undefined> {
  for (const command of COMMANDS) {
    if (args[command.key] === true) return await command.run(args);
  }
  return undefined;
}

/** Validate the arguments a run (as opposed to a command) requires. */
export function checkRunArgs(args: RunnerArgs): string | undefined {
  const dispatchError = validateDispatchArgs(args);
  if (dispatchError) return dispatchError;
  if (args.ticket && !TICKET_SHAPE.test(args.ticket)) {
    return "Ticket must be a simple identifier (PROJ-28) or work-item path (exports/PROJ-1478) — no spaces; segments [a-zA-Z0-9_-] separated by /.";
  }
  return undefined;
}

/**
 * Refuse a run whose working directory has drifted inside an existing kit.
 *
 * A shell keeps its directory between commands, so a `cd` made for an unrelated
 * lookup can still be in place when the runner is invoked. Since every path the
 * runner owns is resolved from `cwd`, the run would then quietly build a nested
 * kit — its own history, its own lock — rather than reporting the mistake. Named
 * here rather than fixed silently: guessing the intended root would make the same
 * command mean different things depending on where it was typed.
 */
export function checkRunCwd(cwd: string = process.cwd()): string | undefined {
  const root = enclosingKitProjectRoot(cwd);
  if (!root) return undefined;
  const known = existsSync(resolve(root, KIT_DIR));
  return (
    `Refusing to run from inside ${KIT_DIR}/ — paths are resolved from the current ` +
    `directory, so this run would create a nested ${KIT_DIR}/ instead of using the real one.\n` +
    `  cwd:      ${resolve(cwd)}\n` +
    (known ? `  run from: ${root}` : `  ${root} is not a project root either — cd to the project first.`)
  );
}

export type ApprovalOutcome =
  | { kind: "ok"; subject?: DecisionSubject }
  | { kind: "done" }
  | { kind: "error"; message: string };

/**
 * Record the `--approve` decision against the already-loaded pipeline, which owns
 * the subject → artifact mapping. `--approve-only` stops there by design.
 */
export async function applyApproval(
  args: RunnerArgs,
  pipelineDef: Pipeline,
  context: PipelineContext,
): Promise<ApprovalOutcome> {
  if (!args.approve) return { kind: "ok" };
  let subject: DecisionSubject;
  try {
    const artifact = resolveApprovalArtifact(pipelineDef, args.approve);
    const decision = await recordApproval(context, args.approve, artifact);
    subject = decision.subject;
    log(
      `Decision ${decision.subject}=approved written to ${context.paths.decisionsDir}/${decision.subject}.json (SHA-256 ${decision.artifactSha256}).`,
    );
  } catch (error) {
    return { kind: "error", message: errorMessage(error) };
  }
  return args.approveOnly ? { kind: "done" } : { kind: "ok", subject };
}

/**
 * Run every pre-run phase in order and report what the entry point must do next:
 * exit with a code, or execute the returned run.
 */
export async function startup(argv: string[]): Promise<StartupOutcome> {
  const parsed = parseArgs(argv);
  if (parsed.kind === "error") {
    log(parsed.message);
    return { kind: "exit", code: 1 };
  }
  const { args } = parsed;

  const commandCode = await runEarlyCommand(args);
  if (commandCode !== undefined) return { kind: "exit", code: commandCode };

  const argsError = checkRunArgs(args);
  if (argsError) {
    log(argsError);
    return { kind: "exit", code: 1 };
  }

  // Before boot: boot itself builds the context from `cwd`, so a drifted directory
  // must be caught while the message can still name the root to use.
  const cwdError = checkRunCwd(process.cwd());
  if (cwdError) {
    log(cwdError);
    return { kind: "exit", code: 1 };
  }

  // The event bus only writes to the feed installed here. A child run inherits its
  // parent's feed through the environment; `entry/feed.ts` replaces it with the
  // run's own feed once `run_dir` is known.
  setRunnerLiveFeed(liveFeedFromEnvironment());

  const boot = await runBoot({
    args,
    cwd: process.cwd(),
    pipelinePath: args.pipelinePath,
    worktreeMode: false,
    baseRegistries: createDefaultRunnerRegistries(),
  });
  const { pipelinePath, worktreeMode, context } = boot;

  // Load the definition once: dispatch strategies and normal runs need the same
  // def.name for resume state. Only a child approval later rebuilds the definition
  // in the parent's context.
  const pipelineDef = await loadPipelineDefinition(pipelinePath, context);
  const stateStore = new FileRunStateStore({ context, pipeline: pipelineDef.name, ticket: args.ticket });

  const approval = await applyApproval(args, pipelineDef, context);
  if (approval.kind === "error") {
    log(approval.message);
    return { kind: "exit", code: 1 };
  }
  if (approval.kind === "done") return { kind: "exit", code: 0 };

  // Dispatch strategies (work-item loops, watch mode) run each ticket in
  // its own durable run directory for per-ticket drill-down.
  const strategy = selectDispatch(args, pipelineDef, context);
  if (strategy) {
    const code = await runDispatch(strategy, {
      pipelinePath,
      passthrough: args.passthrough,
      fresh: args.fresh,
      watch: args.watch,
      watchAutoClose: args.watchAutoClose,
      limit: args.limit,
      ctx: context,
      def: pipelineDef,
      stateStore,
    });
    return { kind: "exit", code };
  }

  return {
    kind: "run",
    ready: { args, context, pipelineDef, pipelinePath, stateStore, worktreeMode, approvedSubject: approval.subject },
  };
}
