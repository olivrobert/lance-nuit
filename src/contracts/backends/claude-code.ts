import type { EffortLevel } from "../backends.js";

export interface ClaudeOptions {
  agent?: string;
  system_prompt?: string;
  tools?: string[];
  allowed_tools?: string[];
  strict_mcp?: boolean;
  setting_sources?: string;
  permission_mode?: "default" | "plan" | "acceptEdits" | "bypassPermissions";
  model?: string;
  effort?: EffortLevel;
}

export type ClaudeBackendOptions = Omit<ClaudeOptions, "model" | "effort">;

export interface ClaudeStepOptions {
  agent?: string;
  systemPrompt?: string;
  tools?: readonly string[];
  allowedTools?: readonly string[];
  strictMcp?: boolean;
  settingSources?: string;
  permissionMode?: ClaudeOptions["permission_mode"];
}

/** Cumulative session ledger a `--resume` spawn inherits. */
export interface ClaudeResumeBaseline {
  /** Dollars already charged for this session before the resumed spawn. */
  costUsd: number;
  /** API time already counted for this session, when the record carries it. */
  apiDurationMs?: number;
}
