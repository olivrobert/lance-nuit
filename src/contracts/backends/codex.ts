import type { EffortLevel } from "../backends.js";

export const CODEX_MODEL = {
  GPT_5_CODEX: "gpt-5-codex",
  GPT_5_6_LUNA: "gpt-5.6-luna",
} as const;

export type CodexModel = (typeof CODEX_MODEL)[keyof typeof CODEX_MODEL];

export const CODEX_SANDBOX = {
  READ_ONLY: "read-only",
  WORKSPACE_WRITE: "workspace-write",
  DANGER_FULL_ACCESS: "danger-full-access",
} as const;

export type CodexSandbox = (typeof CODEX_SANDBOX)[keyof typeof CODEX_SANDBOX];

export interface CodexOptions {
  readonly bin?: string;
  readonly model?: string;
  readonly effort?: EffortLevel;
  readonly sandbox?: CodexSandbox;
  readonly codexProfile?: string;
  readonly ephemeral?: boolean;
  readonly ignoreUserConfig?: boolean;
  readonly ignoreRules?: boolean;
  readonly skipGitRepoCheck?: boolean;
  readonly addDirs?: readonly string[];
}

export type CodexBackendOptions = Omit<CodexOptions, "model" | "effort">;
