// runner/model/config.ts
//
// Normalized runner configuration: the shape every layer reads. Reading and
// validating the configuration files stays in `env/config.ts`.

import type { PipelineLabels, WorkItemConfig } from "../contracts/work-items.js";
import type { ProfileOverrides, StepOverride } from "./profiles.js";

export const DEFAULT_SENSITIVE_PATHS = [
  "**/Security/**, **/security/**, **/auth/**",
  "migrations/** (except the latest undeployed migration)",
  "config/**/security.* , **/*.env*",
  "any payment / credentials / secrets / GDPR path",
];

/** Explicit extension module loaded from the project or its dependencies. */
export interface ExtensionsConfig {
  /** Relative/absolute file path or package specifier. Empty = built-ins only. */
  module?: string;
}

/**
 * Docker stack preflight, run by the runner BEFORE the first step.
 *
 * Rationale: without it, the first step's agent runs the stack start command and
 * waits; that wait is charged to the step timeout budget, which may be killed during
 * boot after wasting its budget.
 *
 * Opt-in: the kit also serves projects without Docker. Without `services`, no probe
 * is run.
 */
export interface StackPreflightConfig {
  /** Docker Compose services that must be `running` and healthy. Empty = disabled. */
  services: string[];
  /** Startup command run when the stack is not ready. */
  startCommand: string;
  /** TOTAL preflight budget (startup + readiness), excluding step timeouts. */
  readinessTimeoutMs: number;
}

export const DEFAULT_STACK_START_COMMAND = "docker compose up -d";
export const DEFAULT_STACK_READINESS_TIMEOUT_MS = 300_000;

/** Normalized runner configuration. All defaults live here. */
export interface PipelineConfig {
  workItem: WorkItemConfig;
  extensions?: ExtensionsConfig;
  labels: PipelineLabels;
  baseBranch: string;
  worktreeMode: "light" | "full";
  sensitivePaths: string[];
  /** Relative root for ticket specs and artifacts. */
  specPath: string;
  usTokenBudget: number;
  /** Per-step model/effort overrides: `*`, `<pipeline>:*`, `<pipeline>:<stepId>`.
   *  Tune a step without changing pipeline code. */
  steps: Record<string, StepOverride>;
  /** Central retuning of model/effort roles. */
  profiles: ProfileOverrides;
  testSkills: Record<string, string>;
  mrCompareUrlTemplate?: string;
  /** Local application URL supplied to browser environment guards. */
  appUrl?: string;
  /** Red-team plan audit (`plan-audit` step of the `default` pipeline), run before
   *  any code. **Disabled by default**: a ~10-minute reviewer turn per sub-US for
   *  findings already caught by the `spec-to-plan` gate and post-code reviews.
   *  `"planAudit": true` enables it without changing code. */
  planAudit: boolean;
  /** Absent = no stack to guarantee (project without Docker or no preflight wanted). */
  stackPreflight?: StackPreflightConfig;
}
