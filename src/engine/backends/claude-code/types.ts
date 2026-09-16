import type { ClaudeOptions, ClaudeResumeBaseline } from "../../../contracts/backends/claude-code.js";
import type { BackendSpawnEvent } from "../spawn-event.js";

export type {
  ClaudeBackendOptions,
  ClaudeOptions,
  ClaudeResumeBaseline,
  ClaudeStepOptions,
} from "../../../contracts/backends/claude-code.js";

export interface ClaudeExecutionOptions {
  bin: string;
  args: readonly string[];
  cwd?: string;
  claudeOptions?: ClaudeOptions;
  timeoutMs?: number;
  budgetRemaining?: number;
  stepLogPath?: string;
  /** Cost of the transport attempts this one replaces (overload retries). Folded
   *  into the live estimate so an abort mid-retry charges the whole spawn. */
  priorAttemptsCostUsd?: number;
  /** Dollars the CLI restores from the session ledger on a `--resume` spawn. The
   *  live estimate reads the cumulative `total_cost_usd` off the stream, so it must
   *  net this out or the budget guard kills the attempt for spend it did not make. */
  sessionCostBaselineUsd?: number;
}
export interface RawClaudeExecutionResult {
  output: string;
  code: number | null;
  killed: boolean;
  killReason?: string;
  durationMs: number;
  /** Cost spent by transport attempts discarded before an overload retry. */
  priorAttemptsCostUsd?: number;
  /** Session ledger the LAST executed attempt resumed from, when it resumed one.
   *  The mapper charges the cumulative figures by difference against it. */
  resumeBaseline?: ClaudeResumeBaseline;
}
export type ClaudeSpawnEvent = BackendSpawnEvent<"claude">;
export interface ClaudeBackendHost {
  execute(options: ClaudeExecutionOptions): Promise<RawClaudeExecutionResult>;
  onSpawn?(event: ClaudeSpawnEvent): void;
  capabilityRoots?(runnerDir: string, cwd: string): readonly string[];
  findSessionFile?(sessionId: string): string | null;
  sessionFileSizeKb?(sessionId: string): number;
  isForkedSlashCommand?(prompt: string, roots: readonly string[]): boolean;
  forkRelayPrompt?(slash: string): string;
  onEvent?(event: unknown): void;
  log?(message: string): void;
}
export interface NodeClaudeHostOptions {
  onSpawn?: (event: ClaudeSpawnEvent) => void;
  onEvent?: (event: unknown) => void;
  log?: (message: string) => void;
  capabilityRoots?: (runnerDir: string, cwd: string) => readonly string[];
  isForkedSlashCommand?: (prompt: string, roots: readonly string[]) => boolean;
  forkRelayPrompt?: (slash: string) => string;
}
