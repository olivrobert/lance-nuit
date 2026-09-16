// runner/model/profiles.ts
//
// Identities and shapes of the semantic roles a step can carry, plus the per-step
// override read from configuration. Data only: the built-in policy table and its
// resolution stay in `dsl/profiles.ts`, which names concrete backend models.

import type { EffortLevel } from "../contracts/backends.js";

/** Effort levels accepted by agent backends. Canonical union lives in
 *  `lance-nuit/contracts/backends`; re-exported here for authoring convenience. */
export type { EffortLevel } from "../contracts/backends.js";

/** Declared as a tuple so a schema can build an enum from it without restating
 *  the list; the `satisfies` clause keeps it aligned with `EffortLevel`. */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const satisfies readonly EffortLevel[];

export function isEffort(value: unknown): value is EffortLevel {
  return typeof value === "string" && (EFFORT_LEVELS as readonly string[]).includes(value);
}

/** Closed list of roles. `dsl/profiles.ts` declares one policy per name, and its
 *  `satisfies` clause fails to compile when the two drift apart. */
export const STEP_PROFILE_NAMES = ["coder", "planner", "reviewer", "relay", "triage", "operator", "extractor"] as const;

export type StepProfileName = (typeof STEP_PROFILE_NAMES)[number];

export function isStepProfileName(value: string): value is StepProfileName {
  return (STEP_PROFILE_NAMES as readonly string[]).includes(value);
}

export interface ProfileAxes {
  model?: string;
  effort?: EffortLevel;
}

/**
 * Project configuration for a role.
 *
 * Axes are always provider-specific: a role cannot accidentally send a Claude
 * model or effort setting to another provider.
 */
export interface StepProfile {
  backends?: Record<string, ProfileAxes>;
}

export type ProfileOverrides = Partial<Record<StepProfileName, StepProfile>>;

/** Per-step override read from `.lance-nuit/config.json` (`steps` section).
 *  Covers only axes an inline-prompt step can actually control. */
export interface StepOverride {
  model?: string;
  effort?: EffortLevel;
}
