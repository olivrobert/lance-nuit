import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseRunDir, runLockHolder, tryClaimRunDir } from "./run-storage.js";

/** Above `pid_max` on every supported platform: `kill(pid, 0)` reports ESRCH, so
 *  the lock is unambiguously stale. A recently exited child would risk pid reuse. */
const DEAD_PID = 2147483646;

function runDir(): string {
  return mkdtempSync(join(tmpdir(), "run-lock-"));
}

function writeLock(dir: string, payload: string): void {
  writeFileSync(join(dir, "runner.lock"), payload);
}

function lockedPid(dir: string): number {
  return JSON.parse(readFileSync(join(dir, "runner.lock"), "utf-8")).pid;
}

test("tryClaimRunDir: claims a free directory and records the owning pid", () => {
  const dir = runDir();

  expect(tryClaimRunDir(dir)).toBe(true);
  expect(lockedPid(dir)).toBe(process.pid);
  expect(runLockHolder(dir)).toBe(null);
});

test("tryClaimRunDir: re-claiming a directory we already hold succeeds", () => {
  const dir = runDir();
  tryClaimRunDir(dir);

  // `--run` claims the directory, then the same process reaches the lock again.
  expect(tryClaimRunDir(dir)).toBe(true);
  expect(lockedPid(dir)).toBe(process.pid);
});

test("tryClaimRunDir: refuses a directory held by a live foreign process", () => {
  const dir = runDir();
  writeLock(dir, JSON.stringify({ pid: process.ppid }));

  expect(tryClaimRunDir(dir)).toBe(false);
  expect(runLockHolder(dir)).toBe(process.ppid);
  expect(lockedPid(dir)).toBe(process.ppid);
});

test("tryClaimRunDir: reclaims a stale lock left by a dead process", () => {
  const dir = runDir();
  writeLock(dir, JSON.stringify({ pid: DEAD_PID }));

  expect(runLockHolder(dir)).toBe(null);
  expect(tryClaimRunDir(dir)).toBe(true);
  expect(lockedPid(dir)).toBe(process.pid);
});

test("tryClaimRunDir: a live bare-pid lock from an older build still holds", () => {
  const dir = runDir();
  writeLock(dir, String(process.ppid));

  // Reclaiming it would put two writers on the same run: the older format has to
  // stay readable, not merely be treated as corrupt.
  expect(runLockHolder(dir)).toBe(process.ppid);
  expect(tryClaimRunDir(dir)).toBe(false);
});

test("tryClaimRunDir: a stale bare-pid lock from an older build is reclaimed", () => {
  const dir = runDir();
  writeLock(dir, String(DEAD_PID));

  expect(tryClaimRunDir(dir)).toBe(true);
  expect(lockedPid(dir)).toBe(process.pid);
});

// pid reuse alone, no race: a lock left by a dead process whose pid this one now
// holds used to satisfy the re-entrance shortcut, so the directory stayed
// unclaimed and another runner reclaimed it under us.
test("tryClaimRunDir: a stale lock carrying our own recycled pid is claimed, not mistaken for ours", () => {
  const dir = runDir();
  writeLock(dir, JSON.stringify({ pid: process.pid }));

  expect(tryClaimRunDir(dir)).toBe(true);
  expect(lockedPid(dir)).toBe(process.pid);
  // Republished by us: ownership is pid *and* nonce (see env/lock.ts).
  expect(typeof JSON.parse(readFileSync(join(dir, "runner.lock"), "utf-8")).lockNonce).toBe("string");
});

test("tryClaimRunDir: a corrupt lock does not permanently block the directory", () => {
  const dir = runDir();
  writeLock(dir, "not json at all");

  expect(runLockHolder(dir)).toBe(null);
  expect(tryClaimRunDir(dir)).toBe(true);
  expect(lockedPid(dir)).toBe(process.pid);
});

// A run directory is a candidate, not an obligation: an unusable lock there must
// leave the caller free to start a fresh run instead of failing the invocation.
test("tryClaimRunDir: an unusable lock path refuses instead of throwing", () => {
  const dir = runDir();
  mkdirSync(join(dir, "runner.lock"));

  expect(tryClaimRunDir(dir)).toBe(false);
  expect(runLockHolder(dir)).toBe(null);
});

test("tryClaimRunDir: an unreadable lock refuses instead of throwing", () => {
  const dir = runDir();
  writeLock(dir, JSON.stringify({ pid: DEAD_PID }));
  chmodSync(join(dir, "runner.lock"), 0o000);
  try {
    expect(tryClaimRunDir(dir)).toBe(false);
  } finally {
    chmodSync(join(dir, "runner.lock"), 0o600);
  }
});

test("releaseRunDir: an unusable lock path warns instead of throwing", () => {
  const dir = runDir();
  mkdirSync(join(dir, "runner.lock"));

  // Called while unwinding a failed selection: throwing here would replace the
  // real diagnosis with a filesystem error.
  expect(() => releaseRunDir(dir)).not.toThrow();
});

test("tryClaimRunDir: concurrent runners reclaiming the same stale lock, one winner", async () => {
  const dir = runDir();
  writeLock(dir, JSON.stringify({ pid: DEAD_PID }));

  // The old implementation read the dead pid, probed it, then overwrote the file:
  // three syscalls with no atomicity, so every process observing that dead pid
  // claimed the directory. The children start together to land in that window.
  const scriptDir = mkdtempSync(join(tmpdir(), "run-lock-child-"));
  mkdirSync(scriptDir, { recursive: true });
  const script = join(scriptDir, "claim.ts");
  writeFileSync(
    script,
    `import { tryClaimRunDir } from ${JSON.stringify(join(import.meta.dir, "run-storage.ts"))};\n` +
      "const startAt = Number(process.argv[3]);\n" +
      "while (Date.now() < startAt) {}\n" +
      "process.stdout.write(tryClaimRunDir(process.argv[2]) ? '1' : '0');\n" +
      // A winner that exits right away leaves a lock whose owner is dead, which the
      // next claimant legitimately reclaims. Outliving its siblings is what makes
      // this a race over one directory rather than a sequence of stale reclaims.
      "while (Date.now() < startAt + 1500) {}\n",
  );

  const startAt = Date.now() + 750;
  const children = Array.from({ length: 8 }, () =>
    Bun.spawn(["bun", script, dir, String(startAt)], { stdout: "pipe", stderr: "pipe" }),
  );
  const claims = await Promise.all(
    children.map(async (child) => {
      const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(await child.exited).toBe(0);
      expect(err).toBe("");
      return out;
    }),
  );

  expect(claims.filter((claim) => claim === "1")).toHaveLength(1);
  // The single winner is the pid the lock names: no runner writes a run it does
  // not own, and none is left believing it owns one.
  expect(children.map((child) => String(child.pid))).toContain(String(lockedPid(dir)));
}, 30_000);
