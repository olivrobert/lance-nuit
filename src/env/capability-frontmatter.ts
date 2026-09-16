// runner/env/capability-frontmatter.ts
//
// Resolve frontmatter for a skill or agent invoked by a step.
//
// Why the runner reads it: a `model:` declared in SKILL.md replaces the session
// model at initialization (`--model` is ignored, verified on Claude 2.1.220). A
// profile model or config key on such a step would therefore be inert. `effort:`
// follows the same rule, but only when declared: otherwise the runner's `--effort`
// survives. The granularity is therefore the AXIS, not the step, hence reading
// frontmatter instead of rejecting the whole configuration.
//
// Locations match preflight (see lib/skill-preflight.ts):
//   - roots explicitly configured by PIPELINE_CAPABILITY_ROOTS;
//   - standalone checkout (runner root);
//   - `<project>/.claude`, then `~/.claude`.
// `PIPELINE_CAPABILITY_ROOTS` adds explicit roots, separated by the platform
// delimiter, before inferred roots.

import { type Dirent, existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";

const PRUNED = new Set(["node_modules", "vendor"]);
// Sufficient depth for the deepest case: the versioned plugin cache
// (`~/.claude/plugins/cache/<repo>/<version>/<plugin>/skills/<name>/SKILL.md`, with
// the suffix joined from `<version>`). Do not search deeper: an unbounded walk of
// a large root could cost more than the run itself.
const MAX_DEPTH = 5;

export interface CapabilityAxes {
  /** Name as invoked (`pipeline-spec`, `quality-constraints:...`). */
  name: string;
  kind: "skill" | "agent";
  /** Found file, or undefined when the capability could not be located. */
  file?: string;
  model?: string;
  effort?: string;
  /** `context: fork`: the skill runs in an isolated context. The invoking turn
   *  inherits neither its output nor its axes; see `isForked`. */
  context?: string;
}

/** Search roots, matching bash preflight. */
export function capabilityRoots(
  runnerDir: string,
  cwd: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string[] {
  const runner = resolve(runnerDir);
  const configured = (env.PIPELINE_CAPABILITY_ROOTS ?? "")
    .split(delimiter)
    .map((root) => root.trim())
    .filter(Boolean)
    .map((root) => resolve(root));
  return [...new Set([...configured, runner, resolve(cwd, ".claude"), join(homedir(), ".claude")])];
}

/** Expected relative path: `<plugin>/skills/<name>/SKILL.md` or `<plugin>/agents/<name>.md`. */
export function capabilitySuffix(kind: "skill" | "agent", requested: string): string {
  const [plugin, name] = requested.includes(":")
    ? [requested.slice(0, requested.indexOf(":")), requested.slice(requested.indexOf(":") + 1)]
    : [undefined, requested];
  const tail = kind === "skill" ? join("skills", name, "SKILL.md") : join("agents", `${name}.md`);
  return plugin ? join(plugin, tail) : tail;
}

/** Bounded suffix search under a root (mirror of `find -maxdepth 8 -prune`). */
function findUnder(root: string, suffix: string, depth = 0): string | undefined {
  if (depth === 0) {
    const direct = join(root, suffix);
    if (existsSync(direct)) return direct;
  }
  if (depth >= MAX_DEPTH) return undefined;
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    // Capability discovery is opportunistic: an unreadable root contributes no match.
    return undefined;
  }
  for (const entry of entries) {
    // Skip hidden directories: `.git` and similar contain no capabilities, and
    // `.claude` roots are passed as-is and never traversed.
    if (!entry.isDirectory() || PRUNED.has(entry.name) || entry.name.startsWith(".")) continue;
    const child = join(root, entry.name);
    const candidate = join(child, suffix);
    if (existsSync(candidate)) return candidate;
    const deeper = findUnder(child, suffix, depth + 1);
    if (deeper) return deeper;
  }
  return undefined;
}

type ParsedKey = "model" | "effort" | "context";

/** Extract model / effort / context keys from the leading YAML frontmatter. */
export function parseFrontmatterAxes(content: string): { model?: string; effort?: string; context?: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const axes: { model?: string; effort?: string; context?: string } = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^(model|effort|context)\s*:\s*(.+?)\s*$/);
    if (!kv) continue;
    const value = kv[2].replace(/^["']|["']$/g, "").trim();
    if (value) axes[kv[1] as ParsedKey] = value;
  }
  return axes;
}

/**
 * Does the capability run in a fork?
 *
 * Consequence for the runner: the host turn that invokes it does NOT see its output
 * (the CLI leaves only `<local-command-stdout>Command completed</...>`), so a step
 * requiring a JSON verdict cannot target a fork directly; it needs a relay prompt.
 * Frontmatter `model`/`effort` axes apply to the fork rather than this host, which
 * keeps its own values.
 */
export function isForked(axes: Pick<CapabilityAxes, "context">): boolean {
  return axes.context === "fork";
}

const cache = new Map<string, CapabilityAxes>();

/**
 * Locate a capability and read its axes. Missing capability → empty axes: validation
 * remains permissive instead of rejecting a legitimate setting based on an unresolved
 * installation path (preflight will fail separately if the capability is truly missing).
 */
export function capabilityAxes(kind: "skill" | "agent", name: string, roots: readonly string[]): CapabilityAxes {
  const key = `${kind}|${name}|${roots.join("|")}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const suffix = capabilitySuffix(kind, name);
  let file: string | undefined;
  for (const root of roots) {
    if (!existsSync(root)) continue;
    file = findUnder(root, suffix);
    if (file) break;
  }
  const axes: CapabilityAxes = {
    name,
    kind,
    ...(file ? { file, ...parseFrontmatterAxes(readFileSync(file, "utf-8")) } : {}),
  };
  cache.set(key, axes);
  return axes;
}

/** Clear the cache; tests rewrite SKILL.md files in successive temporary directories. */
export function clearCapabilityCache(): void {
  cache.clear();
}
