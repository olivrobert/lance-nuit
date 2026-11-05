//
// What the runner keeps under a kit directory (`.lance-nuit/`), and where the
// runner itself is installed. `kit-paths.ts` resolves the kit chain; this module
// names the state inside it, so a directory moves in one place.
//
// The functions take the project root and join `KIT_DIR` to it as given, like
// every caller did, rather than resolving it: a relative root stays relative.

import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { KIT_DIR } from "./kit-paths.js";

/** Cross-run telemetry: history, rate table, scan records. A worktree links it
 *  back to the main clone, so it outlives the worktree. */
export const HISTORY_DIR = "pipeline-history";
/** Per-checkout runner state: the project run lock. Never shared with a worktree. */
export const RUNNER_STATE_DIR = "run";
/** Runs started without a ticket. */
export const TICKETLESS_RUNS_DIR = "runs";
/** Default root of the work items, relative to the project root. */
export const WORK_ITEMS_PATH = `${KIT_DIR}/work-items`;
/** Kit-relative path of the rate table, the same under every kit root. */
export const PRICING_FILE = `${HISTORY_DIR}/pricing.json`;

/** `<root>/.lance-nuit/<relativePath>`. */
export function kitPath(root: string, ...relativePath: string[]): string {
  return join(root, KIT_DIR, ...relativePath);
}

/** The project run lock: one top-level runner per checkout. */
export function runnerLockPath(root: string): string {
  return kitPath(root, RUNNER_STATE_DIR, "runner.lock");
}

export function historyDir(root: string): string {
  return kitPath(root, HISTORY_DIR);
}

/** The central run history `lancenuit stats` reads. */
export function historyFilePath(root: string): string {
  return join(historyDir(root), "runs.jsonl");
}

/** Where `--worktree` creates the ticket worktrees: `$WORKTREES_ROOT`, else the
 *  home directory's kit. `$PIPELINE_HOME` does not move it: worktrees are
 *  checkouts, not kit files. */
export function worktreesRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.WORKTREES_ROOT || join(homedir(), KIT_DIR, "worktrees");
}

/** The runner's installation root: `src/` from a checkout, `dist/` from a
 *  package: the directory two levels above this module's own. */
export const RUNNER_ROOT_DIR = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
