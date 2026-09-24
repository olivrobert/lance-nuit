// runner/env/worktree.ts
// --worktree mode: the run executes in a dedicated git worktree; the main clone
// remains free during the run, and two runs can execute in parallel (runlock is per
// cwd). Setup hooks are entirely optional and belong to the project under `.lance-nuit/`.
//
// Idempotent setup: an already registered worktree is reused as-is (run resume).
// Provisioning copies only settings/artifacts explicitly requested under `.lance-nuit`.
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { runSupervisedCommand } from "../exec/process-runner.js";
import { log } from "../runtime/logging.js";

/** Number of raw output lines shown when setup fails. */
const SETUP_FAILURE_TAIL = 20;
const GIT_ASYNC_TIMEOUT_MS = 120_000;
const INIT_ASYNC_TIMEOUT_MS = 120_000;
const SETUP_ASYNC_TIMEOUT_MS = 900_000;

function firstExistingPath(paths: readonly string[]): string | null {
  return paths.find((path) => existsSync(path)) ?? null;
}

function setupHookNames(mode: WorktreeMode): readonly string[] {
  return mode === "light" ? ["worktree-setup-light.sh", "worktree-setup.sh"] : ["worktree-setup.sh"];
}

/** Setup script output: everything goes to a temporary log (tee), while only marker
 *  lines (→ ⚠ ✓ ✗ from step()/warn()) are shown live (line-buffered grep; a buffered
 *  Node spawnSync would print everything only at the end). Tool noise is emitted
 *  only on failure through the log. `|| true`: grep exits 1 on no match, which
 *  would hide the real status under pipefail. */
const SETUP_PIPE = `set -o pipefail
bash "$1" "$2" 2>&1 | tee "$3" | { grep --line-buffered -E '^[[:space:]]*(→|⚠|✓|✗)' | sed -u 's/^[[:space:]]*/  /' >&2 || true; }`;

export function tailLines(output: string, n: number): string[] {
  const lines = output
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l !== "");
  return lines.slice(-n);
}

export interface WorktreeSpec {
  /** Worktree directory: <root>/<project>/<dir>. */
  path: string;
  /** Directory name (= ticket slug). */
  dir: string;
  /** Worktree scaffold branch (the pipeline then creates its own branches). */
  branch: string;
  mainRepo: string;
}

export interface WorktreeSetupOptions {
  baseBranch: string;
  /** Relative ticket path under `specPath` (copied when gitignored). */
  ticketDir?: string;
  /** Relative ticket root from pipeline.config.json. */
  specPath?: string;
  /** "auto": run the optional project hook. "skip": do not. */
  stack?: "auto" | "skip";
  /** Optional hook mode; the runner infers no service from it. */
  mode?: WorktreeMode;
}

export type WorktreeMode = "light" | "full";

export interface WorktreeSetupResult {
  reused: boolean;
  warnings: string[];
}

export function worktreesRoot(): string {
  return process.env.WORKTREES_ROOT || join(homedir(), ".lance-nuit", "worktrees");
}

/** Filesystem/compose-safe slug: "PROJ-62" → "proj-62", "exports/PROJ-1478" → "exports-proj-1478". */
export function slugifyTicket(ticket: string): string {
  return ticket
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function worktreeSpecFor(ticket: string, mainRepo: string, root: string = worktreesRoot()): WorktreeSpec {
  const project = basename(mainRepo);
  const dir = slugifyTicket(ticket);
  return {
    dir,
    path: join(root, project, dir),
    branch: `wt/${dir}`,
    mainRepo,
  };
}

/** Git repository root containing cwd, or null outside a repository. */
export async function gitToplevelAsync(cwd: string): Promise<string | null> {
  const r = await gitCommandAsync(cwd, ["rev-parse", "--show-toplevel"]);
  return r.status === 0 ? r.stdout.trim() || null : null;
}

/** Whether cwd is INSIDE a linked worktree (not the main checkout); nesting is forbidden. */
export async function isLinkedWorktreeAsync(cwd: string): Promise<boolean> {
  const r = await gitCommandAsync(cwd, ["rev-parse", "--git-dir", "--git-common-dir"]);
  if (r.status !== 0) return false;
  const [gitDir, commonDir] = r.stdout.trim().split("\n");
  return !!gitDir && !!commonDir && gitDir !== commonDir;
}

async function isRegisteredWorktreeAsync(mainRepo: string, path: string): Promise<boolean> {
  const r = await gitCommandAsync(mainRepo, ["worktree", "list", "--porcelain"]);
  if (r.status !== 0) return false;
  return r.stdout.split("\n").some((line) => line === `worktree ${path}`);
}

async function branchExistsAsync(mainRepo: string, branch: string): Promise<boolean> {
  const r = await gitCommandAsync(mainRepo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  return r.status === 0;
}

async function gitCommandAsync(cwd: string, args: string[]) {
  return runSupervisedCommand("git", args, { cwd, timeoutMs: GIT_ASYNC_TIMEOUT_MS });
}

async function gitAsync(mainRepo: string, args: string[]): Promise<{ ok: boolean; output: string }> {
  const r = await gitCommandAsync(mainRepo, args);
  return { ok: r.status === 0, output: `${r.stdout}${r.stderr}`.trim() };
}

async function ensureWorktreeAsync(spec: WorktreeSpec, baseBranch: string): Promise<{ reused: boolean }> {
  if (await isRegisteredWorktreeAsync(spec.mainRepo, spec.path)) return { reused: true };
  if (existsSync(spec.path)) {
    throw new Error(`directory exists but is not a worktree for this repository: ${spec.path}`);
  }
  mkdirSync(dirname(spec.path), { recursive: true });
  const args = (await branchExistsAsync(spec.mainRepo, spec.branch))
    ? ["worktree", "add", spec.path, spec.branch]
    : ["worktree", "add", "-b", spec.branch, spec.path, baseBranch];
  const r = await gitAsync(spec.mainRepo, args);
  if (!r.ok) throw new Error(`git ${args.join(" ")}: ${r.output}`);
  return { reused: false };
}

/** Resolve a project hook from the worktree, then the main clone.
 *
 * The second location covers local hooks not tracked by Git. Both paths are
 * explicitly under `.lance-nuit/`; no runner parent path is probed.
 */
function projectHookFor(spec: WorktreeSpec, name: string): string | null {
  return firstExistingPath([join(spec.path, ".lance-nuit", name), join(spec.mainRepo, ".lance-nuit", name)]);
}

/** Optional project hook for worktree initialization. */
async function runInitScriptAsync(spec: WorktreeSpec, warnings: string[]): Promise<void> {
  const script = projectHookFor(spec, "worktree-init.sh");
  if (!script) return;
  const r = await runSupervisedCommand("bash", [script, spec.path], { timeoutMs: INIT_ASYNC_TIMEOUT_MS });
  if (r.status !== 0) {
    const detail = r.stderr.trim();
    warnings.push(`project hook worktree-init failed${detail ? `: ${detail}` : ""}`);
  }
}

/** `.lance-nuit/run` must be local to the worktree to isolate runner.lock. */
function unshareRunDir(worktreePath: string): void {
  const runDir = join(worktreePath, ".lance-nuit", "run");
  try {
    if (lstatSync(runDir).isSymbolicLink()) unlinkSync(runDir);
  } catch {
    // absent: nothing to break
  }
  mkdirSync(runDir, { recursive: true });
}

/** The work item the worktree SHARES with the main clone: its whole directory is a
 * link, never a copy. Everything under it outlives the branch — run state (`runs/`),
 * planning output (`artifacts/`: spec.md, plan.md, lots.json…), approval decisions
 * locked on the SHA-256 of the artifact they approved (`decisions/`), reports and
 * sub-US items (`US-NN/`). It is what the next run, `inspect`, the UI and an
 * `approve` issued from the main clone read back. A copy — or a link on a fixed list
 * of sub-directories — leaves whatever the list forgot inside a worktree deleted
 * right after the MR, and two histories that diverge on the first run.
 *
 * A sub-US (`PROJ-59/US-01`) links its parent, whose artifacts it reads. */
function sharedItemRoot(ticketDir: string): string {
  const subUs = ticketDir.match(/^(.+)\/US-\d{2,}$/);
  return subUs ? subUs[1] : ticketDir;
}

/** Whether a real worktree directory holds nothing the main clone lacks: only links,
 * empty directories and files identical to their main-clone counterpart. That is the
 * leftover of a worktree provisioned with a copy plus per-directory links; replacing
 * it by a link loses nothing. */
function isDisposableShadow(dirWt: string, dirMain: string): boolean {
  for (const name of readdirSync(dirWt)) {
    const wt = join(dirWt, name);
    const main = join(dirMain, name);
    const stat = lstatSync(wt);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      if (!isDisposableShadow(wt, main)) return false;
      continue;
    }
    if (!existsSync(main) || !readFileSync(wt).equals(readFileSync(main))) return false;
  }
  return true;
}

/** Point `dirWt` at `dirMain`, creating the target on the main clone side.
 *
 * `mkdirSync(dirMain, { recursive: true })` also materializes the parent
 * directories, so a brand new ticket gets a real target instead of a dangling link.
 *
 * Three states on the worktree side:
 * - absent → symlink;
 * - already a symlink → nothing to do;
 * - a real directory → it shadows the main clone. Empty — or, with
 *   `options.replaceDisposable`, holding nothing the main clone lacks — it is a
 *   leftover of an earlier layout: it is removed and linked, no data at stake.
 *   Otherwise it holds a history written into the worktree that a blind removal
 *   would destroy: it is kept and reported, migration is manual.
 *
 * `options.sourceRequired` inverts the first line for a directory a project may
 * track in Git: there, a missing main-clone directory means "this project keeps
 * nothing to share here", and creating one would plant an empty `pipelines/` in a
 * repository that never asked for it. `options.shadowIsNormal` silences the report
 * for the same reason — a worktree that checked the directory out holds the right
 * content, not a leftover to migrate by hand. */
function linkSharedDir(
  dirMain: string,
  dirWt: string,
  options: { sourceRequired?: boolean; shadowIsNormal?: boolean; replaceDisposable?: boolean } = {},
): void {
  if (options.sourceRequired) {
    if (!existsSync(dirMain)) return;
  } else mkdirSync(dirMain, { recursive: true });
  let existing: ReturnType<typeof lstatSync> | null = null;
  try {
    existing = lstatSync(dirWt);
  } catch {
    // absent: link it below
  }
  if (existing?.isSymbolicLink()) return;
  if (existing) {
    if (readdirSync(dirWt).length > 0) {
      if (options.shadowIsNormal) return;
      if (!options.replaceDisposable || !isDisposableShadow(dirWt, dirMain)) {
        log.warn(
          `${dirWt} is a real directory in the worktree, not a link to ${dirMain} — ` +
            "what it holds stays invisible from the main clone and dies with the worktree. " +
            "It is kept as-is rather than overwritten: merge it into the main clone by hand " +
            "(worktree provisioned before this directory became shared, or content tracked by Git).",
        );
        return;
      }
    }
    // Links inside are removed, never followed: their main-clone targets stay intact.
    rmSync(dirWt, { recursive: true, force: true });
  }
  mkdirSync(dirname(dirWt), { recursive: true });
  symlinkSync(dirMain, dirWt);
}

/** Kit sub-directories the worktree SHARES with the main clone instead of owning.
 *
 * `pipeline-history/` holds `runs.jsonl` — the single cross-run history read by
 * `lancenuit stats` — and `pricing.json`, the rate table for backends that report
 * no cost. Written inside the worktree, both die with it: the runs disappear from
 * the history, and every run priced from that table reads as `unknown` cost.
 *
 * `node_modules/` holds the vendored `lance-nuit/contracts` package an extension
 * in the kit imports. It is git-ignored, so a fresh worktree has none: linked to
 * the main clone's, the extension resolves the same copy the CLI keeps current.
 *
 * `pipelines/` holds the kit source itself — the pipeline file and whatever it
 * imports beside it (`lib/`, `prompts/`). A project that git-ignores its whole
 * `.lance-nuit/` — the common case, since the directory also holds run state — gets
 * a worktree with no pipeline at all, and `--pipeline <name>` dies on "not found"
 * before the first step. Linked, the worktree reads the pipeline the main clone
 * runs, which is also what makes an edit to it take effect everywhere at once.
 * A project that tracks its pipelines instead is served by Git: the checkout
 * already carries them, and the two flags below leave that copy alone. */
const SHARED_KIT_DIRS = [
  { name: "pipeline-history" },
  { name: "node_modules" },
  { name: "pipelines", sourceRequired: true, shadowIsNormal: true },
] as const;

/** Point the kit sub-directories of the worktree at the main clone's. */
function linkSharedKitDirs(spec: WorktreeSpec): void {
  for (const { name, ...options } of SHARED_KIT_DIRS) {
    linkSharedDir(join(spec.mainRepo, ".lance-nuit", name), join(spec.path, ".lance-nuit", name), options);
  }
}

/** Copy local settings/artifacts explicitly required by the run. */
function provisionLocalFiles(spec: WorktreeSpec, ticketDir: string | undefined, specPath?: string): void {
  unshareRunDir(spec.path);
  linkSharedKitDirs(spec);

  const configMain = join(spec.mainRepo, ".lance-nuit", "config.json");
  const configWt = join(spec.path, ".lance-nuit", "config.json");
  if (existsSync(configMain) && !existsSync(configWt)) {
    mkdirSync(dirname(configWt), { recursive: true });
    cpSync(configMain, configWt);
  }

  if (ticketDir && specPath) {
    const shared = sharedItemRoot(ticketDir);
    linkSharedDir(join(spec.mainRepo, specPath, shared), join(spec.path, specPath, shared), {
      replaceDisposable: true,
    });
  }
}

/** Optional setup hook under `.lance-nuit/`. */
export function setupScriptFor(worktreePath: string, mode: WorktreeMode = "full"): string | null {
  return firstExistingPath(setupHookNames(mode).map((name) => join(worktreePath, ".lance-nuit", name)));
}

/** Run the optional setup hook without probing or starting a stack. */
async function runSetupScriptAsync(spec: WorktreeSpec, mode: WorktreeMode, warnings: string[]): Promise<void> {
  const script =
    setupScriptFor(spec.path, mode) ??
    firstExistingPath(
      setupHookNames(mode)
        .map((name) => projectHookFor(spec, name))
        .filter((path) => path !== null),
    );
  if (!script) return;
  const logFile = join(tmpdir(), `worktree-setup-${process.pid}.log`);
  const r = await runSupervisedCommand("bash", ["-c", SETUP_PIPE, "worktree-setup", script, spec.path, logFile], {
    stdio: "inherit",
    timeoutMs: SETUP_ASYNC_TIMEOUT_MS,
  });
  if (r.status !== 0) {
    warnings.push(`project hook worktree-setup failed (${script})`);
    const raw = existsSync(logFile) ? readFileSync(logFile, "utf-8") : "";
    for (const line of tailLines(raw, SETUP_FAILURE_TAIL)) log(`  │ ${line}`);
  }
  if (existsSync(logFile)) unlinkSync(logFile);
}

/**
 * Prepare (or reuse) the run worktree. Hooks are optional and are the only external
 * scripts executed by this step.
 */
export async function setupWorktreeAsync(spec: WorktreeSpec, opts: WorktreeSetupOptions): Promise<WorktreeSetupResult> {
  const warnings: string[] = [];
  const mode = opts.mode ?? "full";
  const { reused } = await ensureWorktreeAsync(spec, opts.baseBranch);
  if (mode === "full") await runInitScriptAsync(spec, warnings);
  provisionLocalFiles(spec, opts.ticketDir, opts.specPath);
  if ((opts.stack ?? "auto") === "auto") await runSetupScriptAsync(spec, mode, warnings);
  unshareRunDir(spec.path);
  return { reused, warnings };
}
