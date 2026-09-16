import type { BackendSpawnEvent } from "../spawn-event.js";

export { CODEX_MODEL, CODEX_SANDBOX } from "../../../contracts/backends/codex.js";
export type {
  CodexBackendOptions,
  CodexModel,
  CodexOptions,
  CodexSandbox,
} from "../../../contracts/backends/codex.js";

export interface CodexExecutionOptions {
  bin: string;
  args: readonly string[];
  cwd?: string;
  model?: string;
  timeoutMs?: number;
  budgetRemaining?: number;
  /** A ceiling governs this attempt and unmetered spend is not authorized: the
   *  guard stops the process as soon as it can prove the usage unpriceable. */
  strictCostAccounting?: boolean;
  stepLogPath?: string;
}

export interface RawCodexExecutionResult {
  output: string;
  code: number | null;
  killed: boolean;
  killReason?: string;
  durationMs: number;
}

export type CodexSpawnEvent = BackendSpawnEvent<"codex">;

/** Host seam for process supervision and runner-specific observability. */
export interface CodexBackendHost {
  execute(options: CodexExecutionOptions): Promise<RawCodexExecutionResult>;
  onSpawn?(event: CodexSpawnEvent): void;
}

export interface NodeCodexHostOptions {
  appendLiveOutput?: (text: string) => void;
  appendAgentMessage?: (text: string, stepLogPath?: string) => void;
  onSpawn?: (event: CodexSpawnEvent) => void;
}
