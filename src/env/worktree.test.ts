import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { log } from "../runtime/logging.ts";
import {
  gitToplevelAsync,
  isLinkedWorktreeAsync,
  setupScriptFor,
  setupWorktreeAsync,
  slugifyTicket,
  tailLines,
  worktreeSpecFor,
} from "./worktree.ts";

function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "wt-repo-"));
  const git = (...args: string[]) => spawnSync("git", args, { cwd: dir });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "t");
  writeFileSync(join(dir, "a.txt"), "x\n");
  git("add", ".");
  git("commit", "-qm", "init");
  return dir;
}

test("tailLines: last n non-empty lines", () => {
  const out = "a\nb\n\nc\nd\n";
  expect(tailLines(out, 2)).toEqual(["c", "d"]);
});

test("slugifyTicket: ticket simple", () => {
  expect(slugifyTicket("PROJ-62")).toBe("proj-62");
});

test("slugifyTicket: work-item path", () => {
  expect(slugifyTicket("exports/PROJ-1478")).toBe("exports-proj-1478");
});

test("slugifyTicket: already-clean feature slug", () => {
  expect(slugifyTicket("refactoring-assets")).toBe("refactoring-assets");
});

test("worktreeSpecFor: derived paths and names", () => {
  const spec = worktreeSpecFor("PROJ-62", "/home/x/www/myapp", "/tmp/wt");
  expect(spec.path).toBe("/tmp/wt/myapp/proj-62");
  expect(spec.branch).toBe("wt/proj-62");
  expect(spec.dir).toBe("proj-62");
});

test("setupScriptFor: project hook under .lance-nuit", () => {
  const dir = mkdtempSync(join(tmpdir(), "wt-stack-"));
  mkdirSync(join(dir, ".lance-nuit"), { recursive: true });
  writeFileSync(join(dir, ".lance-nuit", "worktree-setup.sh"), "true\n");
  expect(setupScriptFor(dir)).toBe(join(dir, ".lance-nuit", "worktree-setup.sh"));
});

test("setupScriptFor returns null without a project hook", () => {
  const dir = mkdtempSync(join(tmpdir(), "wt-stack-"));
  expect(setupScriptFor(dir)).toBe(null);
});

test("setupScriptFor: a missing directory → null", () => {
  const dir = mkdtempSync(join(tmpdir(), "wt-stack-"));
  expect(setupScriptFor(dir)).toBe(null);
});

test("setupScriptFor: light mode prefers the suffixed hook", () => {
  const dir = mkdtempSync(join(tmpdir(), "wt-stack-"));
  mkdirSync(join(dir, ".lance-nuit"), { recursive: true });
  writeFileSync(join(dir, ".lance-nuit", "worktree-setup-light.sh"), "true\n");
  expect(setupScriptFor(dir, "light")).toBe(join(dir, ".lance-nuit", "worktree-setup-light.sh"));
});

test("setupScriptFor: hook projet prioritaire aussi en mode light", () => {
  const dir = mkdtempSync(join(tmpdir(), "wt-stack-"));
  mkdirSync(join(dir, ".lance-nuit"), { recursive: true });
  writeFileSync(join(dir, ".lance-nuit", "worktree-setup.sh"), "true\n");
  expect(setupScriptFor(dir, "light")).toBe(join(dir, ".lance-nuit", "worktree-setup.sh"));
});

test("isLinkedWorktreeAsync is false in the main clone and true in a worktree", async () => {
  const repo = gitRepo();
  expect(await isLinkedWorktreeAsync(repo)).toBe(false);
  const spec = freshSpec(repo, "PROJ-7");
  await setupWorktreeAsync(spec, setupOpts());
  expect(await isLinkedWorktreeAsync(spec.path)).toBe(true);
});

test("gitToplevelAsync: returns the repo root, null outside a repo", async () => {
  const repo = gitRepo();
  expect(await gitToplevelAsync(repo)).toBe(spawnSync("realpath", [repo], { encoding: "utf-8" }).stdout.trim());
  expect(await gitToplevelAsync(mkdtempSync(join(tmpdir(), "notgit-")))).toBe(null);
});

function freshSpec(repo: string, ticket = "PROJ-9") {
  const root = mkdtempSync(join(tmpdir(), "wt-root-"));
  return worktreeSpecFor(ticket, repo, root);
}

const setupOpts = () => ({
  baseBranch: "main",
  stack: "skip" as const,
});

test("setupWorktreeAsync: creates worktree + wt/<slug> branch from base", async () => {
  const repo = gitRepo();
  const spec = freshSpec(repo);
  const res = await setupWorktreeAsync(spec, setupOpts());
  expect(res.reused).toBe(false);
  expect(existsSync(join(spec.path, "a.txt"))).toBe(true);
  const branch = spawnSync("git", ["branch", "--show-current"], { cwd: spec.path, encoding: "utf-8" });
  expect(branch.stdout.trim()).toBe("wt/proj-9");
});

test("setupWorktreeAsync: .lance-nuit/run symlinked to the main clone → local dir, main lock intact", async () => {
  const repo = gitRepo();
  const runMain = join(repo, ".lance-nuit", "run");
  mkdirSync(runMain, { recursive: true });
  writeFileSync(join(runMain, "runner.lock"), '{"pid":1}');
  const spec = freshSpec(repo);
  await setupWorktreeAsync(spec, setupOpts());
  const runWt = join(spec.path, ".lance-nuit", "run");
  rmSync(runWt, { recursive: true, force: true });
  symlinkSync(runMain, runWt); // worktree provisioned by an old skill version

  await setupWorktreeAsync(spec, setupOpts()); // reuse

  expect(lstatSync(runWt).isSymbolicLink()).toBe(false);
  expect(existsSync(join(runWt, "runner.lock"))).toBe(false);
  expect(existsSync(join(runMain, "runner.lock"))).toBe(true);
});

test("setupWorktreeAsync: neither copies nor modifies .env.local", async () => {
  const repo = gitRepo();
  writeFileSync(join(repo, ".env.local"), "APP_SECRET=s3cr3t\n");
  const spec = freshSpec(repo);
  await setupWorktreeAsync(spec, setupOpts());
  expect(existsSync(join(spec.path, ".env.local"))).toBe(false);
});

const itemOpts = () => ({ ...setupOpts(), ticketDir: "PROJ-9", specPath: ".lance-nuit/work-items" });

function captureWarnings<T>(run: () => Promise<T>): Promise<string[]> {
  const warnings: string[] = [];
  const original = log.warn;
  log.warn = (message: string) => {
    warnings.push(message);
  };
  return run()
    .then(() => warnings)
    .finally(() => {
      log.warn = original;
    });
}

test("setupWorktreeAsync: the whole work item is a link to the main clone", async () => {
  const repo = gitRepo();
  const items = join(repo, ".lance-nuit", "work-items", "PROJ-9");
  mkdirSync(join(items, "artifacts"), { recursive: true });
  writeFileSync(join(items, "artifacts", "spec.md"), "# spec\n");
  const spec = freshSpec(repo);
  await setupWorktreeAsync(spec, itemOpts());

  const itemsWt = join(spec.path, ".lance-nuit", "work-items", "PROJ-9");
  expect(lstatSync(itemsWt).isSymbolicLink()).toBe(true);
  expect(readFileSync(join(itemsWt, "artifacts", "spec.md"), "utf-8")).toBe("# spec\n");
  // Whatever the run writes — planned dirs or not — lands in the main clone and
  // survives the worktree's deletion.
  for (const rel of [
    "artifacts/plan.md",
    "decisions/plan.json",
    "reports/c.md",
    "US-01/artifacts/spec.md",
    "notes.md",
  ]) {
    mkdirSync(dirname(join(itemsWt, rel)), { recursive: true });
    writeFileSync(join(itemsWt, rel), rel);
    expect(readFileSync(join(items, rel), "utf-8")).toBe(rel);
  }
});

test("setupWorktreeAsync: brand new ticket → linked to a directory created in the main clone", async () => {
  const repo = gitRepo(); // no work-items dir at all: neither in the main clone nor in the worktree
  const spec = freshSpec(repo);
  await setupWorktreeAsync(spec, itemOpts());

  const itemsWt = join(spec.path, ".lance-nuit", "work-items", "PROJ-9");
  expect(lstatSync(itemsWt).isSymbolicLink()).toBe(true);
  mkdirSync(join(itemsWt, "runs", "r1"), { recursive: true });
  writeFileSync(join(itemsWt, "runs", "r1", "run.json"), '{"runId":"r1"}');
  expect(readFileSync(join(repo, ".lance-nuit", "work-items", "PROJ-9", "runs", "r1", "run.json"), "utf-8")).toBe(
    '{"runId":"r1"}',
  );
});

test("setupWorktreeAsync: a sub-US links its parent work item", async () => {
  const repo = gitRepo();
  const spec = freshSpec(repo, "PROJ-9-01");
  await setupWorktreeAsync(spec, { ...setupOpts(), ticketDir: "PROJ-9/US-01", specPath: ".lance-nuit/work-items" });

  expect(lstatSync(join(spec.path, ".lance-nuit", "work-items", "PROJ-9")).isSymbolicLink()).toBe(true);
  expect(existsSync(join(repo, ".lance-nuit", "work-items", "PROJ-9"))).toBe(true);
});

test("setupWorktreeAsync: earlier layout (copy + per-directory links) → replaced by a link, main intact", async () => {
  const repo = gitRepo();
  const items = join(repo, ".lance-nuit", "work-items", "PROJ-9");
  mkdirSync(join(items, "runs"), { recursive: true });
  writeFileSync(join(items, "runs", "r1.json"), "{}");
  writeFileSync(join(items, "ticket.md"), "# t\n");
  const spec = freshSpec(repo);
  await setupWorktreeAsync(spec, { ...itemOpts(), ticketDir: undefined });
  const itemsWt = join(spec.path, ".lance-nuit", "work-items", "PROJ-9");
  mkdirSync(join(itemsWt, "US-01"), { recursive: true });
  writeFileSync(join(itemsWt, "ticket.md"), "# t\n"); // copy identical to the main clone
  symlinkSync(join(items, "runs"), join(itemsWt, "runs"));

  const warnings = await captureWarnings(() => setupWorktreeAsync(spec, itemOpts()));

  expect(warnings).toEqual([]);
  expect(lstatSync(itemsWt).isSymbolicLink()).toBe(true);
  expect(readFileSync(join(items, "runs", "r1.json"), "utf-8")).toBe("{}");
  expect(readFileSync(join(items, "ticket.md"), "utf-8")).toBe("# t\n");
});

test("setupWorktreeAsync: real work item holding what the main clone lacks → kept, warning, never wiped", async () => {
  const repo = gitRepo();
  const spec = freshSpec(repo);
  await setupWorktreeAsync(spec, { ...itemOpts(), ticketDir: undefined });
  const itemsWt = join(spec.path, ".lance-nuit", "work-items", "PROJ-9");
  mkdirSync(join(itemsWt, "artifacts"), { recursive: true });
  writeFileSync(join(itemsWt, "artifacts", "plan.md"), "# local plan\n");

  const warnings = await captureWarnings(() => setupWorktreeAsync(spec, itemOpts()));

  expect(lstatSync(itemsWt).isSymbolicLink()).toBe(false);
  expect(readFileSync(join(itemsWt, "artifacts", "plan.md"), "utf-8")).toBe("# local plan\n");
  expect(warnings.some((w) => w.includes(itemsWt))).toBe(true);
});

test("setupWorktreeAsync: pipeline-history shared with the main clone", async () => {
  const repo = gitRepo();
  const historyMain = join(repo, ".lance-nuit", "pipeline-history");
  mkdirSync(historyMain, { recursive: true });
  writeFileSync(join(historyMain, "pricing.json"), JSON.stringify({ _currency: "$" }));
  const spec = freshSpec(repo);
  await setupWorktreeAsync(spec, setupOpts());

  const historyWt = join(spec.path, ".lance-nuit", "pipeline-history");
  expect(lstatSync(historyWt).isSymbolicLink()).toBe(true);
  // The rate table is readable from the worktree, so costs are not "unknown"...
  expect(existsSync(join(historyWt, "pricing.json"))).toBe(true);
  // ...and the run history written there survives the worktree's deletion.
  writeFileSync(join(historyWt, "runs.jsonl"), '{"runId":"r1"}\n');
  expect(readFileSync(join(historyMain, "runs.jsonl"), "utf-8")).toBe('{"runId":"r1"}\n');
});

test("setupWorktreeAsync: the kit node_modules (vendored contracts) shared with the main clone", async () => {
  const repo = gitRepo();
  const packageMain = join(repo, ".lance-nuit", "node_modules", "lance-nuit");
  mkdirSync(packageMain, { recursive: true });
  writeFileSync(join(packageMain, "package.json"), JSON.stringify({ name: "lance-nuit", lanceNuitContracts: {} }));
  const spec = freshSpec(repo);
  await setupWorktreeAsync(spec, setupOpts());

  const nodeModulesWt = join(spec.path, ".lance-nuit", "node_modules");
  expect(lstatSync(nodeModulesWt).isSymbolicLink()).toBe(true);
  // An extension in the worktree kit resolves the package the main clone keeps current...
  expect(existsSync(join(nodeModulesWt, "lance-nuit", "package.json"))).toBe(true);
  // ...and a rewrite from the worktree side lands in the main clone.
  writeFileSync(join(nodeModulesWt, "lance-nuit", "probe"), "x");
  expect(existsSync(join(packageMain, "probe"))).toBe(true);
});

test("setupWorktreeAsync: git-ignored kit pipelines shared with the main clone", async () => {
  const repo = gitRepo();
  const pipelinesMain = join(repo, ".lance-nuit", "pipelines");
  mkdirSync(join(pipelinesMain, "lib"), { recursive: true });
  writeFileSync(join(pipelinesMain, "nightly.ts"), "export default () => ({});\n");
  writeFileSync(join(pipelinesMain, "lib", "git.ts"), "export const branch = 1;\n");
  const spec = freshSpec(repo);
  await setupWorktreeAsync(spec, setupOpts());

  const pipelinesWt = join(spec.path, ".lance-nuit", "pipelines");
  expect(lstatSync(pipelinesWt).isSymbolicLink()).toBe(true);
  // `--pipeline nightly` resolves from the worktree, and so do the modules the
  // pipeline imports beside itself.
  expect(existsSync(join(pipelinesWt, "nightly.ts"))).toBe(true);
  expect(existsSync(join(pipelinesWt, "lib", "git.ts"))).toBe(true);
});

test("setupWorktreeAsync: pipelines tracked by Git → the checkout is left alone, silently", async () => {
  const repo = gitRepo();
  const tracked = join(repo, ".lance-nuit", "pipelines");
  mkdirSync(tracked, { recursive: true });
  writeFileSync(join(tracked, "nightly.ts"), "export default () => ({});\n");
  const git = (...args: string[]) => spawnSync("git", args, { cwd: repo });
  git("add", "-A");
  git("commit", "-qm", "pipelines");

  const warnings: string[] = [];
  const original = log.warn;
  log.warn = (message: string) => {
    warnings.push(message);
  };
  const spec = freshSpec(repo);
  try {
    await setupWorktreeAsync(spec, setupOpts());
  } finally {
    log.warn = original;
  }

  const pipelinesWt = join(spec.path, ".lance-nuit", "pipelines");
  expect(lstatSync(pipelinesWt).isSymbolicLink()).toBe(false);
  expect(existsSync(join(pipelinesWt, "nightly.ts"))).toBe(true);
  // Git checked the branch's own pipelines out: that is the right content, not a
  // leftover to merge by hand, so nothing is reported.
  expect(warnings.some((w) => w.includes(pipelinesWt))).toBe(false);
});

test("setupWorktreeAsync: no kit pipelines at all → none invented in the main clone", async () => {
  const repo = gitRepo();
  const spec = freshSpec(repo);
  await setupWorktreeAsync(spec, setupOpts());

  // The project resolves its pipeline from the user kit or from the builtins; planting
  // an empty pipelines/ in its repository would add a directory it never asked for.
  expect(existsSync(join(repo, ".lance-nuit", "pipelines"))).toBe(false);
  expect(existsSync(join(spec.path, ".lance-nuit", "pipelines"))).toBe(false);
});

test("setupWorktreeAsync: .lance-nuit/config.json copied into the worktree", async () => {
  const repo = gitRepo();
  const cfg = join(repo, ".lance-nuit", "config.json");
  mkdirSync(dirname(cfg), { recursive: true });
  writeFileSync(cfg, JSON.stringify({ baseBranch: "develop" }));
  const spec = freshSpec(repo);
  await setupWorktreeAsync(spec, setupOpts());
  const copied = readFileSync(join(spec.path, ".lance-nuit", "config.json"), "utf-8");
  expect(JSON.parse(copied).baseBranch).toBe("develop");
});

test("setupWorktreeAsync: second call → reused, idempotent", async () => {
  const repo = gitRepo();
  const spec = freshSpec(repo);
  expect((await setupWorktreeAsync(spec, setupOpts())).reused).toBe(false);
  expect((await setupWorktreeAsync(spec, setupOpts())).reused).toBe(true);
});

test("setupWorktreeAsync: without hook, generic success without warning", async () => {
  const repo = gitRepo();
  const spec = freshSpec(repo);
  const result = await setupWorktreeAsync(spec, { ...setupOpts(), stack: "auto" });
  expect(result.warnings).toEqual([]);
});

test("setupWorktreeAsync: project .lance-nuit/worktree-init.sh hook executed", async () => {
  const repo = gitRepo();
  mkdirSync(join(repo, ".lance-nuit"), { recursive: true });
  writeFileSync(join(repo, ".lance-nuit", "worktree-init.sh"), 'echo "custom" > "$1/marker.txt"\n');
  const spec = freshSpec(repo);
  await setupWorktreeAsync(spec, setupOpts());
  expect(readFileSync(join(spec.path, "marker.txt"), "utf-8").trim()).toBe("custom");
});

test("setupWorktreeAsync reports an existing directory that is not a worktree", async () => {
  const repo = gitRepo();
  const spec = freshSpec(repo);
  mkdirSync(spec.path, { recursive: true });
  await expect(setupWorktreeAsync(spec, setupOpts())).rejects.toThrow(/is not a worktree/);
});

test("setupWorktreeAsync light: init hook is not called", async () => {
  const repo = gitRepo();
  mkdirSync(join(repo, ".lance-nuit"), { recursive: true });
  writeFileSync(join(repo, ".lance-nuit", "worktree-init.sh"), 'echo "custom" > "$1/marker.txt"\n');
  const spec = freshSpec(repo);
  await setupWorktreeAsync(spec, { ...setupOpts(), mode: "light" as const });
  expect(existsSync(join(spec.path, "marker.txt"))).toBe(false);
});

test("setupWorktreeAsync light: project hook runs on every setup", async () => {
  const repo = gitRepo();
  const git = (...args: string[]) => spawnSync("git", args, { cwd: repo });
  mkdirSync(join(repo, ".lance-nuit"), { recursive: true });
  writeFileSync(join(repo, ".lance-nuit", "worktree-setup.sh"), 'echo run >> "$1/setup.log"\n');
  // -f: .lance-nuit/ may be covered by a global gitignore, as in real projects;
  // the hook must be committed (or provided as a local project file).
  git("add", "-f", ".lance-nuit/worktree-setup.sh");
  git("commit", "-qm", "hook");
  const spec = freshSpec(repo);
  const opts = { baseBranch: "main", mode: "light" as const };
  await setupWorktreeAsync(spec, opts);
  await setupWorktreeAsync(spec, opts);
  const log = readFileSync(join(spec.path, "setup.log"), "utf-8");
  expect(log).toBe("run\nrun\n");
});

test("setupWorktreeAsync: existing wt/ branch (deleted worktree) → reattached without -b", async () => {
  const repo = gitRepo();
  const spec = freshSpec(repo);
  await setupWorktreeAsync(spec, setupOpts());
  spawnSync("git", ["worktree", "remove", "--force", spec.path], { cwd: repo });
  const spec2 = freshSpec(repo); // new root, same wt/proj-9 branch
  const res = await setupWorktreeAsync(spec2, setupOpts());
  expect(res.reused).toBe(false);
  const branch = spawnSync("git", ["branch", "--show-current"], { cwd: spec2.path, encoding: "utf-8" });
  expect(branch.stdout.trim()).toBe("wt/proj-9");
});
