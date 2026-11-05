//
// The environment variables the runner sets itself, named once.

/** Variables published to steps, so a bash step can start a sub-runner. */
export const RUNNER_STEP_ENV = {
  /** The runner entry point (`process.argv[1]`). */
  bin: "RUNNER_BIN",
  /** The directory of the runner entry point. */
  dir: "RUNNER_DIR",
} as const;

/** Variables carrying the state of a running runner to the runners it relaunches. */
export const RUNNER_STATE_ENV = {
  /** "1" once the project run lock is held upstream. */
  lockHeld: "RUNNER_LOCK_HELD",
  /** "1" once an upstream runner prepared the worktree and changed into it. */
  inWorktree: "RUNNER_IN_WORKTREE",
  /** Path of the run's live feed. */
  liveFeed: "RUNNER_LIVE_FEED",
} as const;

const RUNNER_STATE_ENV_NAMES: readonly string[] = Object.values(RUNNER_STATE_ENV);

/**
 * `env` without the runner's state. Every process the runner spawns gets this
 * environment unless it is a runner the runner relaunches itself: a step, an
 * agent or a project hook seeing the state would start a runner that skips the
 * lock and the worktree guards and writes into this run's feed.
 */
export function withoutRunnerState(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const stripped = { ...env };
  for (const name of RUNNER_STATE_ENV_NAMES) delete stripped[name];
  return stripped;
}
