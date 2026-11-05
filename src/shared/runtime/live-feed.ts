//
// Port of the append-only live feed, plus the process-wide feed the event bus
// writes to. The interface lives here rather than next to its file adapter so
// that the bus, the backends and the step loop can depend on the port without
// pulling the presentation layer (`output/`) into the runtime.

import { RUNNER_STATE_ENV } from "../env/runner-env.js";

/** Minimal port for the append-only live feed. */
export interface LiveFeed {
  path(): string;
  ensure(): void;
  append(event: unknown): void;
}

let currentFeed: LiveFeed | undefined;

/** Inject the feed this process writes to. `entry/` calls it with the run feed
 * once `run_dir` is known. */
export function setRunnerLiveFeed(feed: LiveFeed | undefined): void {
  currentFeed = feed;
}

/** The feed configured for this process, if any. */
export function configuredLiveFeed(): LiveFeed | undefined {
  return currentFeed;
}

/** Feed path advertised by the environment, without building an adapter. */
export function liveFeedPathFromEnvironment(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[RUNNER_STATE_ENV.liveFeed] || undefined;
}

/** Path streaming backends append raw output to. Unlike the event bus, they write
 * to the file directly, so the environment stays a valid source here: the path is
 * all they need, and a child process receives it that way. */
export function liveFeedFilePath(): string {
  return configuredLiveFeed()?.path() ?? liveFeedPathFromEnvironment() ?? `/tmp/runner-live-${process.pid}.jsonl`;
}
