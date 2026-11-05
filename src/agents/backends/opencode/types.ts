import type { ProjectPricing } from "../../../contracts/index.js";
import type { BackendSpawnEvent } from "../spawn-event.js";

export {
  OPENCODE_AGENT,
  OPENCODE_LOG_LEVEL,
  OPENCODE_MODEL,
  OPENCODE_VARIANT,
} from "../../../contracts/backends/opencode.js";
export type {
  OpencodeAgent,
  OpencodeBackendOptions,
  OpencodeLogLevel,
  OpencodeModel,
  OpencodeOptions,
  OpencodeVariant,
} from "../../../contracts/backends/opencode.js";

export interface OpencodeExecutionOptions {
  bin: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  cwd?: string;
  model?: string;
  timeoutMs?: number;
  /**
   * Deadline on the FIRST event received, not on total duration: a model never
   * used before can take over 60s to warm up, then answer in 1.4s.
   */
  firstEventTimeoutMs?: number;
  budgetRemaining?: number;
  /** A ceiling governs this attempt and unmetered spend is not authorized: the
   *  guard stops the process as soon as it can prove the usage unpriceable. */
  strictCostAccounting?: boolean;
  stepLogPath?: string;
}

export interface RawOpencodeExecutionResult {
  output: string;
  /** stderr, kept because `stream error` lines only ever appear there. */
  logs: string;
  code: number | null;
  killed: boolean;
  killReason?: string;
  durationMs: number;
}

export type OpencodeSpawnEvent = BackendSpawnEvent<"opencode">;

/** Host seam for process supervision and runner-specific observability. */
export interface OpencodeBackendHost {
  execute(options: OpencodeExecutionOptions): Promise<RawOpencodeExecutionResult>;
  onSpawn?(event: OpencodeSpawnEvent): void;
  /** Stream telemetry (activity, context) built by the backend, consumed elsewhere. */
  onEvent?(event: unknown): void;
}

export interface NodeOpencodeHostOptions {
  appendLiveOutput?: (text: string) => void;
  /** stderr as it arrives. Captured in `logs` regardless of this seam. */
  appendLiveLogs?: (text: string) => void;
  appendAgentMessage?: (text: string, stepLogPath?: string) => void;
  onSpawn?: (event: OpencodeSpawnEvent) => void;
  onEvent?: (event: unknown) => void;
  /**
   * Context window of a model, in tokens. opencode reports occupancy
   * (`tokens.total`) but never the window, and there is no price/window table
   * yet: without this seam a context event can only report an occupancy.
   */
  contextWindow?: (model: string | undefined) => number;
  /** Project rate table for the live estimate when the provider reports no cost.
   *  Defaults to `.lance-nuit/pipeline-history/pricing.json`; a test seam. */
  projectPricing?: ProjectPricing | null;
}
