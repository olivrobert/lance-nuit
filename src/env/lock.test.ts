import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import {
  chmodSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  linkSync,
  openSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, defaultIsAlive, heldByThisProcess, isLockPathError, releaseLock } from "./lock.ts";

// Regression coverage for the lock protocol is deterministic: the interleavings
// that matter are two syscalls wide, so they are produced here by interposing on
// the detach step rather than by racing processes. A multi-process harness was
// written and dropped: hammering N children did not reproduce a TOCTOU window,
// and it failed to reliably catch even a deliberately broken check-then-write
// lock, so it proved nothing while costing a second on every run. Cross-process
// behaviour is covered by `state/stores/run-storage.test.ts`, which has eight
// child processes reclaim one stale lock and asserts a single winner.

const lf = () => join(mkdtempSync(join(tmpdir(), "lock-")), "runner.lock");
const info = (pid: number, port = 5174) => ({ pid, port, startedAt: "T" });

test("acquires a free lock", () => {
  const r = acquireLock(lf(), info(123), () => true);
  expect(r.ok).toBe(true);
});

test("refuses when the holder is alive", () => {
  const f = lf();
  acquireLock(f, info(123), () => true);
  const r = acquireLock(f, info(456), () => true);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.holder?.pid).toBe(123);
});

test("resumes a stale lock (dead holder)", () => {
  const f = lf();
  acquireLock(f, info(123), () => false); // 123 considered dead
  const r = acquireLock(f, info(456), () => false);
  expect(r.ok).toBe(true);
  expect(JSON.parse(readFileSync(f, "utf-8")).pid).toBe(456);
  expect(existsSync(`${f}.reclaim`)).toBe(false);
});

test("release frees the lock", () => {
  const f = lf();
  acquireLock(f, info(123), () => true);
  releaseLock(f, 123);
  expect(acquireLock(f, info(456), () => true).ok).toBe(true);
});

test("release leaves a lock reclaimed by another pid untouched", () => {
  const f = lf();
  acquireLock(f, info(123), () => false); // 123 dies...
  acquireLock(f, info(456), () => false); // ...456 reclaims the lock
  releaseLock(f, 123); // late exit handler of 123
  expect(existsSync(f)).toBe(true);
  expect(JSON.parse(readFileSync(f, "utf-8")).pid).toBe(456);
});

test("release of a missing lock is idempotent", () => {
  expect(() => releaseLock(lf(), 123)).not.toThrow();
});

test("defaultIsAlive: EPERM means the owner exists (other user), ESRCH means dead", () => {
  const kill = spyOn(process, "kill");
  try {
    kill.mockImplementation(() => {
      throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    });
    expect(defaultIsAlive(4242)).toBe(true);
    kill.mockImplementation(() => {
      throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    });
    expect(defaultIsAlive(4242)).toBe(false);
  } finally {
    kill.mockRestore();
  }
});

test("corrupt lock treated as stale (no crash)", () => {
  const f = lf();
  require("node:fs").writeFileSync(f, "{pas du json");
  expect(acquireLock(f, info(456), () => true).ok).toBe(true);
});

test("two concurrent acquisitions: exclusive creation leaves one winner", () => {
  const f = lf();
  const first = acquireLock(f, info(123), () => true);
  const second = acquireLock(f, info(456), () => true);
  expect(first.ok).toBe(true);
  expect(second.ok).toBe(false);
  if (!second.ok) expect(second.holder?.pid).toBe(123);
});

test("a live reclaim with no lock waits and then refuses without throwing", () => {
  const f = lf();
  writeFileSync(`${f}.reclaim`, JSON.stringify({ pid: 4242, token: "x" }));
  const started = Date.now();
  const r = acquireLock(f, info(456), (pid) => pid === 4242, { retries: 2, retryDelayMs: 2 });

  expect(r.ok).toBe(false);
  // The marker is not a holder: reporting it as one would attribute this
  // process's own ticket and timestamps to a stranger's pid.
  if (!r.ok) {
    expect(r.holder).toBeUndefined();
    expect(r.reclaiming).toEqual({ pid: 4242 });
  }
  expect(Date.now() - started).toBeGreaterThanOrEqual(4);
});

test("defaultIsAlive: an invalid pid is never probed and is not alive", () => {
  const kill = spyOn(process, "kill");
  try {
    kill.mockImplementation(() => {
      throw new Error("process.kill must not be called for an invalid pid");
    });
    for (const pid of [0, -1, -4242, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(defaultIsAlive(pid)).toBe(false);
    }
    expect(kill).not.toHaveBeenCalled();
  } finally {
    kill.mockRestore();
  }
});

// `process.kill(0, 0)` probes the caller's own process group and `process.kill(-n, 0)`
// group n, so a corrupted pid used to read as "alive forever" and to block every
// later acquisition.
test("a lock whose pid is not a positive integer is reclaimed, whatever the probe says", () => {
  for (const pid of [0, -1, -4242, 1.5, "123", null, undefined, { pid: 1 }]) {
    const f = lf();
    writeFileSync(f, JSON.stringify({ pid, startedAt: "T" }));
    const r = acquireLock(f, info(456), () => true);
    expect(r.ok).toBe(true);
    expect(JSON.parse(readFileSync(f, "utf-8")).pid).toBe(456);
    expect(existsSync(`${f}.reclaim`)).toBe(false);
  }
});

test("a reclaim marker whose pid is not a positive integer does not block acquisition", () => {
  for (const pid of [0, -1, 1.5, "123", null]) {
    const f = lf();
    writeFileSync(`${f}.reclaim`, JSON.stringify({ pid, token: "x" }));
    const r = acquireLock(f, info(456), () => true);
    expect(r.ok).toBe(true);
    expect(existsSync(`${f}.reclaim`)).toBe(false);
  }
});

test("a stale lock behind a reclaim marker with pid 0 is reclaimed", () => {
  const f = lf();
  writeFileSync(f, JSON.stringify({ pid: 0, startedAt: "T" }));
  writeFileSync(`${f}.reclaim`, JSON.stringify({ pid: 0, token: "x" }));
  const r = acquireLock(f, info(456), () => true);
  expect(r.ok).toBe(true);
  expect(JSON.parse(readFileSync(f, "utf-8")).pid).toBe(456);
});

/** Replace the file at `path` right before the lock code detaches it, which is the
 * window a plain read-then-unlink cannot see. */
function interposeOnDetach(path: string, replacement: string): { restore: () => void } {
  const real = renameSync;
  const spy = spyOn(fs, "renameSync");
  let armed = true;
  spy.mockImplementation((from, to) => {
    if (armed && from === path) {
      armed = false;
      unlinkSync(path);
      writeFileSync(path, replacement);
    }
    real(from, to);
  });
  return { restore: () => spy.mockRestore() };
}

test("release does not remove a lock published in the removal window", () => {
  const f = lf();
  acquireLock(f, info(123), () => true);
  const intruder = JSON.stringify(info(999));
  const spy = interposeOnDetach(f, intruder);
  try {
    releaseLock(f, 123);
  } finally {
    spy.restore();
  }
  expect(readFileSync(f, "utf-8")).toBe(intruder);
});

test("reclaiming a stale lock does not remove a lock published in the removal window", () => {
  const f = lf();
  writeFileSync(f, JSON.stringify(info(123)));
  const intruder = JSON.stringify(info(999));
  const spy = interposeOnDetach(f, intruder);
  let r: ReturnType<typeof acquireLock>;
  try {
    // 123 is dead, so the lock is reclaimable; 999 appears inside the window.
    r = acquireLock(f, info(456), (pid) => pid === 999, { retries: 1, retryDelayMs: 0 });
  } finally {
    spy.restore();
  }
  expect(readFileSync(f, "utf-8")).toBe(intruder);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.holder?.pid).toBe(999);
  expect(existsSync(`${f}.reclaim`)).toBe(false);
});

// A lock path that exists but cannot be read as a lock file used to spin the
// retry loop forever: `observeFile` reported "absent" while `link` kept refusing
// the name, so neither branch could make progress.
test("a directory at the lock path is reported, not retried forever", () => {
  const f = lf();
  mkdirSync(f);
  expect(() => acquireLock(f, info(456), () => true, { retryDelayMs: 0 })).toThrow(/not a regular file/);
});

test("a dangling symlink at the lock path is reported, not retried forever", () => {
  const f = lf();
  symlinkSync(`${f}.nowhere`, f);
  expect(() => acquireLock(f, info(456), () => true, { retryDelayMs: 0 })).toThrow(/not a regular file/);
});

test("an unreadable lock file is reported, not read as a free lock", () => {
  const f = lf();
  writeFileSync(f, JSON.stringify(info(123)));
  chmodSync(f, 0o000);
  try {
    expect(() => acquireLock(f, info(456), () => true, { retryDelayMs: 0 })).toThrow(/EACCES/);
  } finally {
    chmodSync(f, 0o600);
  }
});

test("published payloads carry a per-incarnation nonce", () => {
  const f = lf();
  acquireLock(f, info(123), () => true);
  const published = JSON.parse(readFileSync(f, "utf-8"));
  expect(typeof published.lockNonce).toBe("string");
  expect(published.lockNonce.length).toBeGreaterThan(8);
  expect(published.pid).toBe(123);
});

// Inode numbers are recycled inside a directory, and a payload as thin as
// `{"pid":N}` is reproduced byte-for-byte by a new process holding a recycled
// pid N. `fstatSync` is neutralised here so every file looks like the same
// device and inode: what must still tell the two locks apart is the nonce in the
// bytes.
test("a recycled inode with the same pid does not make a live lock removable", () => {
  const f = lf();
  const dead = JSON.stringify({ pid: 4242, lockNonce: "dead-incarnation" });
  const live = JSON.stringify({ pid: 4242, lockNonce: "live-incarnation" });
  writeFileSync(f, dead);

  // Captured before the spy replaces the binding, otherwise the mock recurses.
  const realStat = fstatSync;
  const stat = spyOn(fs, "fstatSync");
  stat.mockImplementation((fd: number, options?: unknown) => {
    const real = realStat(fd, options as never) as unknown as Record<string, unknown>;
    return { ...real, dev: 7n, ino: 7n, isFile: () => true } as never;
  });
  const detach = interposeOnDetach(f, live);
  let r: ReturnType<typeof acquireLock>;
  try {
    // 4242 is dead when observed and alive by the time the lock is detached.
    r = acquireLock(f, info(456), (pid) => readFileSync(f, "utf-8") === live && pid === 4242, {
      retries: 1,
      retryDelayMs: 0,
    });
  } finally {
    detach.restore();
    stat.mockRestore();
  }
  expect(readFileSync(f, "utf-8")).toBe(live);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.holder?.pid).toBe(4242);
});

// pid reuse alone, no race: a fresh process inheriting the pid of a dead holder
// must not be mistaken for that holder.
test("a lock carrying our pid but not our nonce is stale, not ours", () => {
  const f = lf();
  writeFileSync(f, JSON.stringify({ pid: process.pid, startedAt: "T" }));

  expect(heldByThisProcess(f)).toBe(false);
  // The probe would answer "alive" — it would be probing this very process.
  const r = acquireLock(f, info(456), () => true);
  expect(r.ok).toBe(true);
  expect(JSON.parse(readFileSync(f, "utf-8")).pid).toBe(456);
});

test("release does not free a lock this incarnation never published", () => {
  const f = lf();
  const foreign = JSON.stringify({ pid: process.pid, startedAt: "T" });
  writeFileSync(f, foreign);

  releaseLock(f);
  releaseLock(f, process.pid);
  expect(readFileSync(f, "utf-8")).toBe(foreign);
});

test("heldByThisProcess: true only for a lock we published", () => {
  const f = lf();
  expect(heldByThisProcess(f)).toBe(false);
  acquireLock(f, info(process.pid), () => true);
  expect(heldByThisProcess(f)).toBe(true);
  releaseLock(f, process.pid);
  expect(heldByThisProcess(f)).toBe(false);
});

// `open` on a FIFO with no writer blocks inside the syscall, where no retry cap
// can help: the lock code opens with O_NONBLOCK so the entry can be rejected.
test("a FIFO at the lock path is reported, not waited on", () => {
  const f = lf();
  // mkfifo is POSIX-mandated on every platform this runner supports.
  expect(spawnSync("mkfifo", [f]).status).toBe(0);

  expect(() => acquireLock(f, info(456), () => true, { retryDelayMs: 0 })).toThrow(/not a regular file/);
});

test("an errno failure on the lock path names the path, the action and the code", () => {
  const f = lf();
  writeFileSync(f, JSON.stringify(info(123)));
  chmodSync(f, 0o000);
  try {
    expect(() => acquireLock(f, info(456), () => true, { retryDelayMs: 0 })).toThrow(
      /Cannot read the lock path .*runner\.lock \(EACCES\)/,
    );
  } finally {
    chmodSync(f, 0o600);
  }
});

// Our own marker is gone and a competitor published its own in that window.
// Removing it would let a third process open a second election over the same
// dead lock.
test("a reclaim election that is not ours is left alone", () => {
  const f = lf();
  const foreign = JSON.stringify({ pid: 4242, token: "foreign" });
  writeFileSync(f, JSON.stringify(info(123)));

  const real = linkSync;
  const spy = spyOn(fs, "linkSync");
  let armed = true;
  spy.mockImplementation((from: fs.PathLike, to: fs.PathLike) => {
    real(from, to);
    if (armed && String(to) === `${f}.reclaim`) {
      armed = false;
      // Between our publication and our read-back, our marker is replaced.
      unlinkSync(`${f}.reclaim`);
      writeFileSync(`${f}.reclaim`, foreign);
    }
  });
  try {
    // 123 is dead so the lock is reclaimable, 4242 is the live competitor.
    const r = acquireLock(f, info(456), (pid) => pid === 4242, { retries: 0, retryDelayMs: 0 });
    expect(r.ok).toBe(false);
  } finally {
    spy.mockRestore();
  }
  expect(readFileSync(`${f}.reclaim`, "utf-8")).toBe(foreign);
});

test("heldByThisProcess: reports ownership for the pid the caller claims", () => {
  const f = lf();
  acquireLock(f, info(123), () => true);
  expect(heldByThisProcess(f, 123)).toBe(true);
  expect(heldByThisProcess(f, 456)).toBe(false);
  expect(heldByThisProcess(f)).toBe(false);
  // Same predicate as releaseLock's: a pid we did not publish for frees nothing.
  releaseLock(f, 456);
  expect(existsSync(f)).toBe(true);
  releaseLock(f, 123);
  expect(existsSync(f)).toBe(false);
});

const errno = (code: string) => Object.assign(new Error(`${code}: simulated`), { code });

/** Replace the `.reclaim` marker with an unreadable file the first time this
 * process publishes the lock file, which is the exact point where a cleanup
 * failure could turn a published lock into a reported failure. */
function breakMarkerOnLockPublish(lockFile: string): { restore: () => void; broken: () => boolean } {
  const real = linkSync;
  const spy = spyOn(fs, "linkSync");
  let armed = true;
  spy.mockImplementation((from: fs.PathLike, to: fs.PathLike) => {
    real(from, to);
    if (!armed || String(to) !== lockFile) return;
    armed = false;
    writeFileSync(`${lockFile}.reclaim`, "unreadable");
    chmodSync(`${lockFile}.reclaim`, 0o000);
  });
  return {
    broken: () => !armed,
    restore: () => {
      spy.mockRestore();
      try {
        chmodSync(`${lockFile}.reclaim`, 0o600);
      } catch {
        // Already gone: nothing to restore.
      }
    },
  };
}

// Cleanup runs in a `finally` around the `return { ok: true }`: a throw there used
// to report a failure for a lock this process had published and owned, so nobody
// released it. A marker we cannot remove is harmless by comparison — it dies with
// this process and the next acquirer removes it as a dead marker.
test("a marker removal that fails does not turn a taken lock into a failure", () => {
  const f = lf();
  writeFileSync(f, JSON.stringify(info(123)));
  const realRename = renameSync;
  const spy = spyOn(fs, "renameSync");
  spy.mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
    if (String(from) === `${f}.reclaim`) throw errno("EPERM");
    realRename(from, to);
  }) as never);

  let r: ReturnType<typeof acquireLock>;
  try {
    // 123 is dead, so the lock is reclaimed and republished for 456.
    r = acquireLock(f, info(456), () => false, { retries: 0, retryDelayMs: 0 });
  } finally {
    spy.mockRestore();
  }
  expect(r.ok).toBe(true);
  expect(JSON.parse(readFileSync(f, "utf-8")).pid).toBe(456);
});

// Same rule for the I6 back-out: the lock was published exclusively for us, so
// when dropping it fails, holding it is the truthful answer.
test("a back-out that fails reports the lock this process actually holds", () => {
  const f = lf();
  writeFileSync(f, JSON.stringify(info(123)));
  const broken = breakMarkerOnLockPublish(f);
  const realRename = renameSync;
  const rename = spyOn(fs, "renameSync");
  rename.mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
    // Our own lock can be detached to reclaim it, but not to drop it again.
    if (String(from) === f && broken.broken()) throw errno("EPERM");
    realRename(from, to);
  }) as never);

  let r: ReturnType<typeof acquireLock>;
  try {
    r = acquireLock(f, info(456), () => false, { retries: 0, retryDelayMs: 0 });
  } finally {
    rename.mockRestore();
    broken.restore();
  }
  expect(r.ok).toBe(true);
  expect(JSON.parse(readFileSync(f, "utf-8")).pid).toBe(456);
});

// A marker published and then unreadable carries this process's LIVE pid: left
// behind, it makes every other acquirer wait for as long as this process runs.
test("a marker whose read-back fails is dropped before the error propagates", () => {
  const f = lf();
  writeFileSync(f, JSON.stringify(info(123)));
  const markerFds = new Set<number>();
  const realOpen = openSync;
  const realStat = fstatSync;
  const open = spyOn(fs, "openSync");
  open.mockImplementation(((target: fs.PathLike, flags: unknown, mode: unknown) => {
    const fd = realOpen(target, flags as never, mode as never);
    if (String(target) === `${f}.reclaim`) markerFds.add(fd);
    return fd;
  }) as never);
  const stat = spyOn(fs, "fstatSync");
  let armed = true;
  stat.mockImplementation(((fd: number, options: unknown) => {
    // Transient: the read-back of the marker we just published fails once.
    if (armed && markerFds.has(fd)) {
      armed = false;
      throw errno("EIO");
    }
    return realStat(fd, options as never);
  }) as never);

  try {
    expect(() => acquireLock(f, info(456), () => false, { retries: 0, retryDelayMs: 0 })).toThrow(/EIO/);
  } finally {
    stat.mockRestore();
    open.mockRestore();
  }
  expect(existsSync(`${f}.reclaim`)).toBe(false);
});

// Callers whose policy is to skip an unlockable target narrow their `catch` with
// this, so it must not answer "yes" to a programming error.
test("isLockPathError: environment failures only", () => {
  const f = lf();
  mkdirSync(f);
  try {
    acquireLock(f, info(456), () => true, { retryDelayMs: 0 });
    throw new Error("expected a lock path error");
  } catch (error) {
    expect(isLockPathError(error)).toBe(true);
  }
  expect(isLockPathError(errno("EACCES"))).toBe(true);
  expect(isLockPathError(new TypeError("info.pid is not a function"))).toBe(false);
  expect(isLockPathError(new Error("plain"))).toBe(false);
  expect(isLockPathError(undefined)).toBe(false);
});
