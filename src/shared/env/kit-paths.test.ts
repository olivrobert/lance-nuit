import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPipelineConfig } from "./config.ts";
import {
  configFileLabel,
  enclosingKitProjectRoot,
  kitFileLayers,
  kitRoots,
  listKitFiles,
  resolveKitFile,
  userKitDir,
} from "./kit-paths.ts";

const originalHome = process.env.PIPELINE_HOME;

afterEach(() => {
  if (originalHome === undefined) delete process.env.PIPELINE_HOME;
  else process.env.PIPELINE_HOME = originalHome;
});

function dir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `kit-paths-${prefix}-`));
}

/** Write a file, creating its parent directories. Return the absolute path. */
function write(root: string, relativePath: string, content = "x"): string {
  const target = join(root, relativePath);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, content);
  return target;
}

/** Disposable user root, pinned for the duration of the test. */
function userRoot(): string {
  const root = dir("home");
  process.env.PIPELINE_HOME = root;
  return root;
}

test("userKitDir: $PIPELINE_HOME names the directory itself, not a home", () => {
  process.env.PIPELINE_HOME = "/tmp/kit-home-explicite";
  expect(userKitDir()).toBe("/tmp/kit-home-explicite");
  delete process.env.PIPELINE_HOME;
  expect(userKitDir()).toMatch(/\/\.lance-nuit$/);
});

test("kitRoots: project takes precedence over user", () => {
  const home = userRoot();
  const project = dir("project");
  expect(kitRoots({ cwd: project })).toEqual([
    { kind: "project", dir: join(project, ".lance-nuit") },
    { kind: "user", dir: home },
  ]);
});

test("resolveKitFile: the project wins over the user", () => {
  const home = userRoot();
  const project = dir("project");
  write(home, "pipelines/deploy.ts");
  const projectFile = write(project, ".lance-nuit/pipelines/deploy.ts");
  expect(resolveKitFile("pipelines/deploy.ts", { cwd: project })).toBe(projectFile);
});

test("resolveKitFile: the user root is used when the project provides nothing", () => {
  const home = userRoot();
  const project = dir("project");
  const shared = write(home, "pipelines/deploy.ts");
  expect(resolveKitFile("pipelines/deploy.ts", { cwd: project })).toBe(shared);
});

test("resolveKitFile: builtin closes the chain, and null when nobody provides it", () => {
  userRoot();
  const project = dir("project");
  const builtin = dir("builtin");
  expect(resolveKitFile("pipelines/default.ts", { cwd: project, builtinDir: builtin })).toBeNull();
  const shipped = write(builtin, "pipelines/default.ts");
  expect(resolveKitFile("pipelines/default.ts", { cwd: project, builtinDir: builtin })).toBe(shipped);
});

test("kitFileLayers: from lowest to highest priority, builtin included", () => {
  const home = userRoot();
  const project = dir("project");
  const builtin = dir("builtin");
  const shipped = write(builtin, "fixtures/checks.yml");
  const shared = write(home, "fixtures/checks.yml");
  const current = write(project, ".lance-nuit/fixtures/checks.yml");
  expect(kitFileLayers("fixtures/checks.yml", { cwd: project, builtinDir: builtin })).toEqual([
    shipped,
    shared,
    current,
  ]);
});

test("listKitFiles: deduplicated union of names across the whole chain", () => {
  const home = userRoot();
  const project = dir("project");
  const builtin = dir("builtin");
  write(builtin, "fixtures/checks.yml");
  write(home, "fixtures/security.yml");
  write(project, ".lance-nuit/fixtures/checks.yml");
  write(project, ".lance-nuit/fixtures/perf.yml");
  write(project, ".lance-nuit/fixtures/notes.md");
  expect(listKitFiles("fixtures", ".yml", { cwd: project, builtinDir: builtin })).toEqual([
    "checks.yml",
    "perf.yml",
    "security.yml",
  ]);
});

test("listKitFiles: missing or non-directory root yields zero files", () => {
  userRoot();
  const project = dir("project");
  writeFileSync(join(project, ".lance-nuit"), "not a directory");
  expect(listKitFiles("fixtures", ".yml", { cwd: project })).toEqual([]);
});

test("configFileLabel: names the file actually read", () => {
  userRoot();
  const absent = dir("project");
  expect(configFileLabel(absent)).toBe(".lance-nuit/config.json");

  const migrated = dir("project");
  write(migrated, ".lance-nuit/config.json", "{}");
  expect(configFileLabel(migrated)).toBe(".lance-nuit/config.json");
});

test("loadPipelineConfig: user config supplies defaults, project decides", () => {
  const home = userRoot();
  const project = dir("project");
  write(
    home,
    "config.json",
    JSON.stringify({
      baseBranch: "develop",
      usTokenBudget: 90_000,
      profiles: {
        coder: { backends: { claude: { model: "opus" } } },
        triage: { backends: { claude: { model: "sonnet" } } },
      },
    }),
  );
  write(
    project,
    ".lance-nuit/config.json",
    JSON.stringify({
      usTokenBudget: 120_000,
      profiles: { coder: { backends: { claude: { model: "haiku" } } } },
    }),
  );

  const config = loadPipelineConfig(project);
  expect(config.baseBranch).toBe("develop");
  expect(config.usTokenBudget).toBe(120_000);
  // Recursive merge: `triage` survives while the project mentions only `coder`.
  expect(config.profiles.coder?.backends?.claude?.model).toBe("haiku");
  expect(config.profiles.triage?.backends?.claude?.model).toBe("sonnet");
});

test("loadPipelineConfig: a project array REPLACES the shared array", () => {
  const home = userRoot();
  const project = dir("project");
  write(home, "config.json", JSON.stringify({ sensitivePaths: ["a/**", "b/**", "c/**"] }));
  write(project, ".lance-nuit/config.json", JSON.stringify({ sensitivePaths: ["a/**"] }));
  expect(loadPipelineConfig(project).sensitivePaths).toEqual(["a/**"]);
});

test("loadPipelineConfig: an unreadable layer is an error naming that layer, not a silent fallback", () => {
  const home = userRoot();
  const project = dir("project");
  write(home, "config.json", JSON.stringify({ baseBranch: "develop" }));
  write(project, ".lance-nuit/config.json", "{ this is not JSON");
  expect(() => loadPipelineConfig(project)).toThrow(/Invalid configuration \(.*project.*config\.json\)/);
});

test("enclosingKitProjectRoot: an artifacts directory reports its project root", () => {
  const project = dir("drift");
  const artifacts = join(project, ".lance-nuit", "work-items", "PROJ-1", "artifacts");
  mkdirSync(artifacts, { recursive: true });
  expect(enclosingKitProjectRoot(artifacts)).toBe(project);
  expect(enclosingKitProjectRoot(join(project, ".lance-nuit"))).toBe(project);
});

test("enclosingKitProjectRoot: a project root passes", () => {
  const project = dir("root");
  mkdirSync(join(project, ".lance-nuit"), { recursive: true });
  expect(enclosingKitProjectRoot(project)).toBeNull();
  mkdirSync(join(project, "src"), { recursive: true });
  expect(enclosingKitProjectRoot(join(project, "src"))).toBeNull();
});

test("enclosingKitProjectRoot: a worktree under the user kit passes", () => {
  const home = dir("wt-home");
  const worktree = join(home, ".lance-nuit", "worktrees", "projet-proj-1");
  mkdirSync(join(worktree, ".lance-nuit"), { recursive: true });
  expect(enclosingKitProjectRoot(worktree)).toBeNull();
  // ... but an artifacts directory INSIDE that worktree is still reported, and
  // the worktree is the root named, not the home holding both markers.
  const artifacts = join(worktree, ".lance-nuit", "work-items", "PROJ-1", "artifacts");
  mkdirSync(artifacts, { recursive: true });
  expect(enclosingKitProjectRoot(artifacts)).toBe(worktree);
});
