import type { EffortLevel } from "../backends.js";

/** Models verified to answer headless on 2026-08-22 (opencode 1.17.7). */
export const OPENCODE_MODEL = {
  NEMOTRON_3_ULTRA: "opencode/nemotron-3-ultra-free",
  NEMOTRON_35_LIGHTNING: "opencode/nemotron-3.5-lightning-free",
  MUSE_SPARK_12: "opencode/muse-spark-1.2-contributor-free",
  GLM_52: "zai-coding-plan/glm-5.2",
} as const;

export type OpencodeModel = (typeof OPENCODE_MODEL)[keyof typeof OPENCODE_MODEL];

/** `--variant` values. Provider-specific: a model may reject any of them. */
export const OPENCODE_VARIANT = {
  MINIMAL: "minimal",
  HIGH: "high",
  MAX: "max",
} as const;

export type OpencodeVariant = (typeof OPENCODE_VARIANT)[keyof typeof OPENCODE_VARIANT];

/**
 * Agents declared by the runner-owned `opencode.json`, never by the user config.
 * `tools` per agent is the only per-role permission control opencode offers —
 * there is no equivalent of the `--sandbox read-only` flag of codex.
 */
export const OPENCODE_AGENT = {
  /** All tools. For `coder`-style roles. */
  RUNNER: "lance-nuit-runner",
  /** Read-only: `write`, `edit`, `bash` and `patch` disabled. */
  READ_ONLY: "lance-nuit-ro",
  /** No tools at all. For text-to-JSON roles (`extractor`, `triage`). */
  BARE: "lance-nuit-bare",
} as const;

export type OpencodeAgent = (typeof OPENCODE_AGENT)[keyof typeof OPENCODE_AGENT];

export const OPENCODE_LOG_LEVEL = {
  DEBUG: "DEBUG",
  INFO: "INFO",
  WARN: "WARN",
  ERROR: "ERROR",
} as const;

export type OpencodeLogLevel = (typeof OPENCODE_LOG_LEVEL)[keyof typeof OPENCODE_LOG_LEVEL];

export interface OpencodeOptions {
  readonly bin?: string;
  readonly model?: string;
  readonly effort?: EffortLevel;
  readonly agent?: string;
  /** `--pure`: skip external plugins. Does NOT reduce injected context. */
  readonly pure?: boolean;
  /**
   * `--fork`: branch the resumed session instead of appending to it. Defaults to
   * true for `intent: "fix"`, which is what the fix loop assumes — it records the
   * returned id as the new coder session and must not lose the pre-fix one.
   * Ignored without a session to resume: opencode rejects a lone `--fork`.
   */
  readonly fork?: boolean;
  /** Path to the runner-owned config, exported as `OPENCODE_CONFIG`. */
  readonly configPath?: string;
  /**
   * Cut the Claude Code compatibility layer (`~/.claude/CLAUDE.md` injection and
   * `.claude/skills`). Defaults to true: personal instructions must not reach a
   * deterministic agent. Measured cost of leaving it on: ~1250 input tokens.
   */
  readonly disableClaudeCodeCompat?: boolean;
  /**
   * `--print-logs --log-level`. Defaults to ERROR because opencode retries
   * stream errors silently: a hard failure (billing, auth) emits nothing on
   * stdout and is otherwise indistinguishable from a hang.
   */
  readonly logLevel?: OpencodeLogLevel;
  /**
   * Deadline on the first event, distinct from the total timeout. A model never
   * called before can take over 60s to warm up: a total-duration deadline kills
   * healthy runs. Defaults to `DEFAULT_FIRST_EVENT_TIMEOUT_MS`.
   */
  readonly firstEventTimeoutMs?: number;
}

export type OpencodeBackendOptions = Omit<OpencodeOptions, "model" | "effort">;
