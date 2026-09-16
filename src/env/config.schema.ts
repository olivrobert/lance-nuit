// env/config.schema.ts
//
// Shape of a `config.json` layer (`~/.lance-nuit/config.json`, `.lance-nuit/config.json`).
//
// Strict on the form: an unknown key or a value of the wrong kind is an error,
// never a silent fallback. `"worktreeMode": "ligth"` read as `full` is a trap;
// `"steps": { "x": { "timeout": 30 } }` looking active while ignored is another.
//
// What stays out of the schema (and in code):
// - defaults and empty-string fallbacks (`loadPipelineConfig`);
// - rules that need a loaded pipeline: `checkStepOverrides`, `checkOverrideKeyShapes`
//   (`validation/step-overrides.ts`), profile/backend coherence (`validation/`);
// - rules across two fields of different sections, such as `max_cost_usd` versus
//   `max_cost_per_work_item_usd` on a run.
// Rule of thumb: the schema judges one file on its own; anything needing a second
// source of truth is code.
//
// Types stay hand-written interfaces (`PipelineConfig`, `StepOverride`,
// `ProfileOverrides`): they reach the installed DSL declarations, this module
// must not. See `guide/architecture.md`, section "Persistence and observability".

import * as z from "zod";
import type { EffortLevel } from "../contracts/backends.js";
import type { AssertAssignable } from "../lib/type-assertions.js";
import type { StepOverride } from "../model/profiles.js";
import {
  EFFORT_LEVELS,
  isStepProfileName,
  type ProfileOverrides,
  STEP_PROFILE_NAMES,
  type StepProfile,
} from "../model/profiles.js";

const nonEmptyString = z.string().refine((value) => value.trim() !== "", { error: "must be a non-empty string" });

/** `{ model?, effort? }`, shared by `steps.*` and `profiles.*.backends.*`. */
const AxesSchema = z.strictObject({
  model: nonEmptyString.optional(),
  effort: z.enum(EFFORT_LEVELS).optional(),
});

/** `steps`: `{ "<pipeline>:<step>": { model?, effort? } }`. Key shapes are judged
 * against loaded pipelines, in code. */
export const StepOverridesSchema = z.record(z.string(), AxesSchema);

/** `profiles.<role>`: axes are always per backend, never on the role itself. */
const ProfileSchema = z.strictObject({
  backends: z.record(nonEmptyString, AxesSchema).optional(),
});

/** `profiles`: roles are closed, an unknown name is dead configuration. */
export const ProfileOverridesSchema = z.record(z.string(), ProfileSchema).superRefine((profiles, ctx) => {
  for (const key of Object.keys(profiles)) {
    if (isStepProfileName(key)) continue;
    ctx.addIssue({
      code: "custom",
      path: [key],
      message: `unknown profile (expected: ${STEP_PROFILE_NAMES.join(", ")})`,
    });
  }
});

/** One `config.json` layer, before merging. Every key is optional: a layer may
 * carry a single section. */
export const ConfigFileSchema = z.strictObject({
  workItem: z
    .strictObject({
      provider: z.string().optional(),
      project: z.string().optional(),
      todoState: z.string().optional(),
      reviewState: z.string().optional(),
      baseUrl: z.string().optional(),
    })
    .optional(),
  extensions: z.strictObject({ module: z.string().optional() }).optional(),
  labels: z
    .strictObject({
      bugTodo: z.string().optional(),
      featureTodo: z.string().optional(),
      done: z.string().optional(),
      escalate: z.string().optional(),
    })
    .optional(),
  baseBranch: z.string().optional(),
  worktreeMode: z.enum(["light", "full"]).optional(),
  sensitivePaths: z.array(z.string()).optional(),
  specPath: z.string().optional(),
  usTokenBudget: z.number().positive().optional(),
  steps: StepOverridesSchema.optional(),
  profiles: ProfileOverridesSchema.optional(),
  testSkills: z.record(z.string(), z.string()).optional(),
  mrCompareUrlTemplate: z.string().optional(),
  appUrl: z.string().optional(),
  planAudit: z.boolean().optional(),
  stackPreflight: z
    .strictObject({
      services: z.array(z.string()).optional(),
      startCommand: z.string().optional(),
      readinessTimeoutMs: z.number().positive().optional(),
    })
    .optional(),
});

export type ConfigFile = z.output<typeof ConfigFileSchema>;

/** Throw a readable error for a schema failure, prefixed with where it happened. */
function parseOrThrow<T extends z.ZodType>(schema: T, value: unknown, where: string): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error(`${where}:\n${z.prettifyError(result.error)}`);
  return result.data;
}

/** Validate one configuration file. `where` names it in the error. */
export function parseConfigFile(value: unknown, where: string): ConfigFile {
  return parseOrThrow(ConfigFileSchema, value, `Invalid configuration (${where})`);
}

/** Read the `steps` section on its own (test seam). */
export function parseStepOverrides(raw: unknown): Record<string, StepOverride> {
  if (raw === undefined) return {};
  return parseOrThrow(StepOverridesSchema, raw, 'Invalid configuration ("steps")');
}

/** Read the `profiles` section on its own (test seam). */
export function parseProfileOverrides(raw: unknown): ProfileOverrides {
  if (raw === undefined) return {};
  return parseOrThrow(ProfileOverridesSchema, raw, 'Invalid configuration ("profiles")');
}

// Compile-time proof that the sections describe the hand-written interfaces
// (see `lib/type-assertions.ts`).
type _Axes = AssertAssignable<z.output<typeof AxesSchema>, StepOverride>;
type _Profile = AssertAssignable<z.output<typeof ProfileSchema>, StepProfile>;
type _Profiles = AssertAssignable<z.output<typeof ProfileOverridesSchema>, ProfileOverrides>;
type _EveryEffort = AssertAssignable<EffortLevel, (typeof EFFORT_LEVELS)[number]>;
