import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bashStep, pipeline } from "../dsl.ts";
import { checkWorkingTree, shouldGuardCleanTree } from "./gitguard.ts";

function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "gitguard-"));
  const git = (...args: string[]) => spawnSync("git", args, { cwd: dir });
  git("init", "-q");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "t");
  writeFileSync(join(dir, "a.txt"), "x\n");
  git("add", ".");
  git("commit", "-qm", "init");
  return dir;
}

const base = { resuming: false, subRunner: false, allowDirty: false, pipelineAllowsDirty: false };

test("shouldGuardCleanTree: run fresh top-level → guard active", () => {
  expect(shouldGuardCleanTree(base)).toBe(true);
});

test("shouldGuardCleanTree: resuming a run → no guard (legitimately dirty tree)", () => {
  expect(shouldGuardCleanTree({ ...base, resuming: true })).toBe(false);
});

test("shouldGuardCleanTree: sub-runner → no guard", () => {
  expect(shouldGuardCleanTree({ ...base, subRunner: true })).toBe(false);
});

test("shouldGuardCleanTree: --allow-dirty → no guard", () => {
  expect(shouldGuardCleanTree({ ...base, allowDirty: true })).toBe(false);
});

test("shouldGuardCleanTree: pipeline allow_dirty (commit, quality) → no guard", () => {
  expect(shouldGuardCleanTree({ ...base, pipelineAllowsDirty: true })).toBe(false);
});

test("checkWorkingTree: outside a git repo → ok (guard not applicable)", () => {
  const dir = mkdtempSync(join(tmpdir(), "notgit-"));
  expect(checkWorkingTree(dir).ok).toBe(true);
});

test("checkWorkingTree: clean repo → ok", () => {
  expect(checkWorkingTree(gitRepo()).ok).toBe(true);
});

test("checkWorkingTree: modified file → rejection with reason", () => {
  const dir = gitRepo();
  writeFileSync(join(dir, "a.txt"), "modif\n");
  const r = checkWorkingTree(dir);
  expect(r.ok).toBe(false);
  expect(r.reason).toContain("a.txt");
});

test("checkWorkingTree rejects an untracked file with a reason", () => {
  const dir = gitRepo();
  writeFileSync(join(dir, "new-file.txt"), "x\n");
  const r = checkWorkingTree(dir);
  expect(r.ok).toBe(false);
  expect(r.reason).toContain("new-file.txt");
});

test("checkWorkingTree ignores an untracked entry Git cannot commit (FIFO, device)", () => {
  const dir = gitRepo();
  spawnSync("mkfifo", [join(dir, ".bashrc")]);
  expect(checkWorkingTree(dir).ok).toBe(true);
});

test("checkWorkingTree still lists a real untracked file next to an uncommittable one", () => {
  const dir = gitRepo();
  spawnSync("mkfifo", [join(dir, ".bashrc")]);
  writeFileSync(join(dir, "new-file.txt"), "x\n");
  const r = checkWorkingTree(dir);
  expect(r.ok).toBe(false);
  expect(r.reason).toContain("dirty Git tree (1 file(s))");
  expect(r.reason).toContain("new-file.txt");
  expect(r.reason).not.toContain(".bashrc");
});

test("DSL: .allowDirty() exposes allow_dirty on the pipeline", () => {
  const p = pipeline("x")
    .allowDirty()
    .add(bashStep({ id: "s", name: "S", command: "true" }))
    .build();
  expect(p.allow_dirty).toBe(true);
});
