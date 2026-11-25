//
// Semantic roles for agent steps. A profile fixes the nominal regime; the DSL
// never chooses a model or effort locally: these axes belong to the role's
// provider-specific policy. Project overrides are resolved when the pipeline is
// loaded, before the `steps` section.

import type { AgentBackend, AgentBackendRegistry, AgentConfigAxis, BackendSpec } from "../../contracts/backends.js";
import { CODEX_MODEL } from "../../contracts/backends/codex.js";
import { OPENCODE_MODEL } from "../../contracts/backends/opencode.js";
import type { ProfileAxes, ProfileOverrides, StepProfile, StepProfileName } from "../../shared/language/profiles.js";

export type {
  EffortLevel,
  ProfileAxes,
  ProfileOverrides,
  StepOverride,
  StepProfile,
  StepProfileName,
} from "../../shared/language/profiles.js";
export {
  EFFORT_LEVELS,
  isEffort,
  isStepProfileName,
  STEP_PROFILE_NAMES,
} from "../../shared/language/profiles.js";

interface BuiltinStepProfile {
  readonly backends: Readonly<Record<string, ProfileAxes>>;
}

export const STEP_PROFILES = {
  coder: {
    backends: {
      claude: { model: "opus", effort: "medium" },
      codex: { model: CODEX_MODEL.GPT_5_6_LUNA, effort: "medium" },
    },
  },
  planner: { backends: { claude: { model: "opus", effort: "medium" } } },
  // Codex on `reviewer` runs at `high`: a verdict is a judgement, and a gate that
  // wrongly passes lets false code through. The role also lets the fix loop stay
  // on the backend that wrote the code: an agent step's fix inherits the step's
  // backend (`backendForFix`), and a `bash` gate with `resumeSession` follows
  // the resumed step's session provider (`chooseFixBackend`), so a Codex-authored
  // change is repaired by Codex, in its own session.
  reviewer: {
    backends: {
      claude: { model: "opus", effort: "medium" },
      codex: { model: CODEX_MODEL.GPT_5_6_LUNA, effort: "high" },
    },
  },
  relay: { backends: { claude: { model: "sonnet", effort: "low" } } },
  // opencode starts on the two text-to-JSON roles: no tool, 184 measured input
  // tokens, and a wrong verdict costs a retry rather than a bad edit. `medium`
  // effort maps to no `--variant`, which every model accepts.
  triage: {
    backends: {
      claude: { model: "opus", effort: "high" },
      opencode: { model: OPENCODE_MODEL.NEMOTRON_3_ULTRA, effort: "medium" },
    },
  },
  operator: { backends: { claude: { model: "sonnet", effort: "low" } } },
  // `low` on every backend: the role turns text into JSON, it does not judge.
  extractor: {
    backends: {
      claude: { model: "haiku", effort: "low" },
      codex: { model: CODEX_MODEL.GPT_5_6_LUNA, effort: "low" },
      opencode: { model: OPENCODE_MODEL.NEMOTRON_3_ULTRA, effort: "medium" },
    },
  },
} as const satisfies Record<StepProfileName, BuiltinStepProfile>;

/**
 * Backends added by project configuration in installed DSL declarations. The
 * empty interface is specialized when `.d.ts` files are generated and remains
 * extensible for consumers generating their own declarations.
 */
// The declaration MUST stay an `interface`: `specializeProjectProfileBackends`
// rewrites the emitted `export interface ProjectProfileBackends {}` in place.
// biome-ignore lint/suspicious/noEmptyInterface: specialized when project declarations are generated
export interface ProjectProfileBackends {}

type ProjectBackendFor<P extends StepProfileName> = P extends keyof ProjectProfileBackends
  ? keyof ProjectProfileBackends[P] & string
  : never;

/** Backends known for a profile: builtin policies ∪ project overrides. */
export type BackendFor<P extends StepProfileName> =
  | (keyof (typeof STEP_PROFILES)[P]["backends"] & string)
  | ProjectBackendFor<P>;

function configuredBackendAxes(profile: StepProfile | undefined, backendId: string): ProfileAxes | undefined {
  if (!profile) return undefined;
  const provider = profile.backends?.[backendId];
  return provider === undefined ? undefined : { ...provider };
}

/** Resolve a role's policy for a backend without modifying a step. */
export function resolveProfileForBackend(
  name: StepProfileName,
  backendId: string,
  overrides: ProfileOverrides = {},
): ProfileAxes | undefined {
  const builtinBackends: Readonly<Record<string, ProfileAxes>> = STEP_PROFILES[name].backends;
  const builtin = builtinBackends[backendId];
  const configured = configuredBackendAxes(overrides[name], backendId);
  if (builtin === undefined && configured === undefined) return undefined;
  const model = configured?.model ?? builtin?.model;
  const effort = configured?.effort ?? builtin?.effort;
  return {
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
  };
}

/** Keep only axes that a backend can actually translate. */
function applicableAxes(backend: AgentBackend, axes: ProfileAxes): Partial<Record<AgentConfigAxis, string>> {
  const supported = backend.capabilities.configurationAxes ?? [];
  return Object.fromEntries(
    Object.entries(axes).filter(([axis]) => supported.includes(axis as AgentConfigAxis)),
  ) as Partial<Record<AgentConfigAxis, string>>;
}

/**
 * Fix-pass options for a role on a given backend: `base` with the role's axes
 * applied. `undefined` when the role has no policy for that backend, so the caller
 * decides between falling back (runtime) and relying on the validator (load time).
 */
export function fixProfileOptions(
  role: StepProfileName,
  spec: BackendSpec,
  base: unknown,
  overrides: ProfileOverrides,
  registry: AgentBackendRegistry,
): { options: unknown } | undefined {
  const effective = resolveProfileForBackend(role, spec.id, overrides);
  if (!effective) return undefined;
  const backend = registry.resolve(spec);
  const axes = applicableAxes(backend, effective);
  if (Object.keys(axes).length === 0 || !backend.applyConfigAxes) return { options: base };
  return { options: backend.applyConfigAxes(base, axes) };
}
