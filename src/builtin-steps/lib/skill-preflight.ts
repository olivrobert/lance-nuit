import { type BashStepBuilder, bashStep } from "../../dsl/dsl-steps.js";
import { capabilityRoots, capabilitySuffix } from "../../env/capability-frontmatter.js";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * Skill preflight command. Skills live in the explicit roots of
 * `PIPELINE_CAPABILITY_ROOTS`, the standalone checkout, `<project>/.claude/skills`
 * and `~/.claude/skills`. A missing skill fails BEFORE the first agent instead of
 * letting the backend invent it and return exit 0.
 *
 * Qualification matters: `quality-constraints:quality-constraints-verify`
 * requires `quality-constraints/skills/quality-constraints-verify/SKILL.md`, not a
 * same-named SKILL.md anywhere. Otherwise a wrongly prefixed contract passed
 * preflight and failed at runtime. Unqualified names are still searched everywhere.
 */
export function capabilityPreflightCommand(
  runnerDir: string,
  cwd: string,
  skills: readonly string[],
  agents: readonly string[] = [],
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const roots = capabilityRoots(runnerDir, cwd, env);
  const rootArgs = roots.map(shellQuote).join(" ");
  const capabilityArgs = [
    ...skills.map((name) => ({ kind: "skill" as const, name })),
    ...agents.map((name) => ({ kind: "agent" as const, name })),
  ]
    .map(({ kind, name }) => shellQuote(`${kind}|${name}|${capabilitySuffix(kind, name)}`))
    .join(" ");

  // -prune: without it find descends into the project's node_modules/vendor/.git.
  // -maxdepth 8: covers the deepest path (versioned plugin cache).
  return `missing=0
for capability in ${capabilityArgs}; do
  kind="\${capability%%|*}"
  payload="\${capability#*|}"
  requested="\${payload%%|*}"
  suffix="\${payload#*|}"
  found=0
  for root in ${rootArgs}; do
    test -d "$root" || continue
    hit=$(find "$root" -maxdepth 8 \\( -name node_modules -o -name vendor -o -name .git \\) -prune -o \\
      -type f -path "*/$suffix" -print -quit 2>/dev/null)
    if test -n "$hit"; then
      found=1
      break
    fi
  done
  if test "$found" -eq 0; then
    echo "required $kind not found: $requested" >&2
    missing=1
  fi
done
exit "$missing"`;
}

/** One preflight step per pipeline, with no registry or DSL primitive. */
export interface CapabilityPreflightOptions {
  skills?: readonly string[];
  agents?: readonly string[];
  id?: string;
  name?: string;
}

export function skillPreflightStep(
  skills: readonly string[],
  agents: readonly string[] = [],
  options: Pick<CapabilityPreflightOptions, "id" | "name"> = {},
): BashStepBuilder {
  return bashStep({
    id: options.id ?? "preflight-skills",
    name: options.name ?? (agents.length > 0 ? "Required skills and agents preflight" : "Required skills preflight"),
    command: (ctx) => capabilityPreflightCommand(ctx.runnerDir, ctx.cwd, skills, agents),
  });
}

/** Public surface: a capabilities preflight visible as a pipeline step without
 * exposing the runner's search paths. */
export function requireCapabilitiesStep(opts: CapabilityPreflightOptions): BashStepBuilder {
  if (!opts || typeof opts !== "object") {
    throw new Error("requireCapabilitiesStep(): options are required");
  }
  const skills = opts.skills ?? [];
  const agents = opts.agents ?? [];
  if (!Array.isArray(skills) || !skills.every((name) => typeof name === "string" && name.trim())) {
    throw new Error("requireCapabilitiesStep(): skills must be an array of non-empty strings");
  }
  if (!Array.isArray(agents) || !agents.every((name) => typeof name === "string" && name.trim())) {
    throw new Error("requireCapabilitiesStep(): agents must be an array of non-empty strings");
  }
  if (skills.length === 0 && agents.length === 0) {
    throw new Error("requireCapabilitiesStep(): declare at least one skill or agent");
  }
  return skillPreflightStep(skills, agents, opts);
}
