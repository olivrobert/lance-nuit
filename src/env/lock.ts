// runner/env/lock.ts
// Stale-safe single-instance lock, generic over the payload (pid required): a
// dead owner (or corrupted lock) is reclaimed. Used by the runner
// (runlock.ts, one lock per project cwd) and by the run-directory guard.
//
// Protocol
// --------
// Two files carry the whole state, both in the lock's own directory:
//   `<lock>`          the lock itself; its content is the holder payload plus
//                     the publisher's nonce (see below).
//   `<lock>.reclaim`  the reclamation election: whoever publishes it is the one
//                     process allowed to replace a lock whose holder is dead.
//
// Only two atomic operations are trusted:
//   * publish  — `link(temp, path)` succeeds for exactly one process while
//                `path` is free (`createExclusive`). This is what makes lock
//                ownership exclusive; nothing else grants it.
//   * detach   — `rename(path, temp)` hands the file at `path` to exactly one
//                process. Two processes racing on the same file: one gets the
//                inode, the other gets `ENOENT` or a different inode.
//
// Invariants
// ----------
// I1. A process returns `{ ok: true }` only after a successful `createExclusive`
//     on the lock file. Publication, not any prior observation, is what grants
//     ownership.
// I2. A published file is identified by `dev` + `ino` + its exact bytes, and
//     every removal goes through `takeIfSame`: an atomic detach followed by that
//     identity check, so a file that does not match is put back under its own
//     name. `dev` + `ino` alone would not do — inode numbers are recycled within
//     a directory, deterministically so on ext4 and tmpfs — which is what I3 is
//     for. Timestamps are deliberately not part of the identity: their
//     resolution is coarser than a reclaim window on the filesystems that have
//     nanoseconds, and not bit-stable across two `fstat` calls on those that do
//     not, which would make a stale lock permanently unreclaimable.
// I3. The bytes are made unique per process incarnation by `LOCK_NONCE`, a
//     random value generated once per process and injected into every payload
//     this module publishes. Without it a payload as thin as `{"pid":1234}`
//     would be reproduced byte-for-byte by a new process that recycled pid
//     1234, and a recycled inode would then make a live lock look like the dead
//     one it replaced.
// I4. Only a pid that is a positive integer is probed for liveness
//     (`isValidPid`): `process.kill(0, 0)` targets the caller's own process
//     group and `process.kill(-n, 0)` group `n`, so a corrupted `{"pid":0}` or a
//     negative pid would read as "alive" forever and block every acquisition.
//     A payload claiming *our own* pid without our nonce is a lock left by a
//     dead process whose pid we recycled: it is stale, not alive.
// I5. Ownership is pid *and* nonce. `releaseLock` removes the lock only when it
//     carries this incarnation's nonce, so a late exit handler — or a fresh
//     process that inherited a recycled pid — cannot free a lock it never took.
// I6. The election winner re-checks, after publishing its lock, that the
//     `.reclaim` marker is still the very file it published. If it is not, the
//     election was broken by the residual race below: it removes its own lock
//     (I2, so only its own) and retries instead of returning a lock it cannot
//     vouch for.
//
// Who may remove a lock file
// --------------------------
//   * its holder, through `releaseLock` (I5 and I2: pid, nonce, and file
//     identity all have to match);
//   * the single election winner, on the exact file it identified as owned by a
//     dead pid — and only on that file: a `.reclaim` marker that does not read
//     back as the one this process published is left alone, or a third process
//     would open a second concurrent election;
//   * an acquirer backing out of its own publication (I6).
// The fast-path acquirer never re-checks its lock afterwards, and does not need
// to: by I2 nobody can remove it on the strength of a stale observation. Its one
// exposure is the residual race below.
//
// Residual race
// -------------
// POSIX has no "remove this file only if it is still that exact file". When
// `takeIfSame` detaches a file that turns out to be a newer one, it puts it back
// with `link`, and that `link` can fail with `EEXIST` if a third process
// published in the two-syscall gap — the newer file is then lost, and its owner
// is dispossessed without knowing. Reaching it requires (a) the observed file to
// have been replaced between the observation and the `rename`, which
// `takeIfSame` re-checks immediately before detaching, and (b) a publication
// inside the following two-syscall window. For the lock file, (a) additionally
// requires the election to have already been broken the same way, since the
// election winner is otherwise the only process allowed to replace a dead lock.
// The window is therefore bounded to two nested syscall-sized races, and I6
// repairs its visible effect on the acquirer that lost its marker.
//
// Errors
// ------
// Only `ENOENT` means "absent". Every other filesystem error — `EACCES`, a lock
// path that is a directory, a dangling symlink or a FIFO — is raised instead of
// being read as a free lock, which would otherwise spin the retry loop forever;
// errno failures on the lock path are reported with the path, the action and the
// code.
// The loop also has a hard round cap. Both `acquireLock` and `releaseLock`
// propagate: an unwritable lock directory makes `releaseLock` throw exactly as it
// makes `acquireLock` throw from `createExclusive`, rather than silently leaving
// a lock behind. Callers that must not fail on it — an exit handler, a run
// directory that can simply be skipped — degrade around it themselves
// (`runlock.ts`, `run-storage.ts`).
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { errnoCode, isErrno } from "../lib/errors.js";

/** Payload constraint: a pid, and no field colliding with the nonce this module
 * publishes (I3). `lockNonce` is `NONCE_FIELD`, spelled out because a type
 * cannot compute its keys from a value. */
export type LockPayload = { pid: number; lockNonce?: never };

export interface LockAcquireOptions {
  /** Number of retries after cleaning up a stale lock. */
  retries?: number;
  /** Initial pause between concurrent observations, in milliseconds. */
  retryDelayMs?: number;
}

/** Refusal carries either the live holder, or the pid of the process currently
 * reclaiming a stale lock — never a mix of the two, so a caller cannot report a
 * stranger's pid next to fields taken from its own payload. */
export type LockAcquireResult<T extends LockPayload> =
  | { ok: true }
  | { ok: false; holder: T; reclaiming?: never }
  | { ok: false; holder?: never; reclaiming: { pid: number } };

interface ReclaimInfo {
  pid: number;
  token: string;
}

/** Identity of an observed file (I2). */
interface Observed {
  dev: bigint;
  ino: bigint;
  raw: string;
}

const DEFAULT_RETRY_DELAY_MS = 10;
const MAX_RETRY_DELAY_MS = 100;

/** Nonce of this process incarnation (I3). Regenerated on every start, so no
 * other process — including a later one holding the same pid — can produce the
 * payloads this process publishes. */
const LOCK_NONCE = randomUUID();
/** Payload field carrying the nonce. Callers never set it: `acquireLock` adds it
 * on publication and strips it from the holder it reports back. */
const NONCE_FIELD = "lockNonce";

/** A pid worth probing (I4). */
function isValidPid(pid: unknown): pid is number {
  return typeof pid === "number" && Number.isInteger(pid) && pid > 0;
}

/** Liveness probe used when the caller provides none. Exported for tests. */
export function defaultIsAlive(pid: number): boolean {
  if (!isValidPid(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user, so the owner is
    // alive and keeps the lock. Any other failure (ESRCH) is a dead owner and the
    // stale lock can be reclaimed.
    return isErrno(error, "EPERM");
  }
}

/** Marker property carrying the offending path, so callers can tell an unusable
 * lock path from a programming error without matching on messages. */
const LOCK_PATH_MARKER = "lockPath";

function lockPathError(path: string, message: string, cause?: unknown): Error {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  // Non-enumerable so the brand never shows up in JSON output or inspection.
  Object.defineProperty(error, LOCK_PATH_MARKER, { value: path, enumerable: false });
  return error;
}

/**
 * Whether a thrown value says "this lock path cannot be used": one of the errors
 * raised here, or any errno failure. Callers whose policy is to skip an
 * unlockable target — a run directory that can simply be left alone — narrow
 * their `catch` with this instead of swallowing programming errors too.
 */
export function isLockPathError(error: unknown): boolean {
  if (errnoCode(error) !== undefined) return true;
  if (typeof error !== "object" || error === null) return false;
  return typeof (error as Record<string, unknown>)[LOCK_PATH_MARKER] === "string";
}

/** One wording for every entry that occupies the lock name without being a lock:
 * a directory, a dangling symlink, a socket, a FIFO. */
function notRegularFile(path: string): Error {
  return lockPathError(path, `Lock path ${path} is not a regular file. Remove it so the runner can take the lock.`);
}

/** Errno failures on the lock or marker path are reported with the path, the
 * action and the code, like every other unusable-path case. A value carrying no
 * errno code — including `notRegularFile` — is passed through untouched, so this
 * never repackages an error raised elsewhere. */
function lockPathFailure(path: string, action: string, error: unknown): unknown {
  const code = errnoCode(error);
  if (code === undefined) return error;
  return lockPathError(
    path,
    `Cannot ${action} the lock path ${path} (${code}). Check its permissions and the permissions of its directory.`,
    error,
  );
}

/**
 * Cleanup that must never turn a published lock into a failed acquisition, nor
 * bury an exception on its way out. A marker or lock this process fails to
 * remove dies with it: the next acquirer removes it through the dead-marker
 * branch, or reclaims it as a stale lock. Reports whether the attempt ran to
 * completion.
 */
function bestEffort(cleanup: () => void): boolean {
  try {
    cleanup();
    return true;
  } catch {
    return false;
  }
}

function parseInfo<T>(raw: string | null): T | null {
  if (raw == null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    // Corrupt lock metadata is equivalent to an unowned lock and is reclaimed below.
    return null;
  }
}

/** Inode identity and bytes read through a single descriptor, so both describe
 * the same file even if it is replaced right after. `null` means absent; any
 * other failure is raised, since a lock path that cannot be read is not a free
 * lock. */
function observeFile(path: string): Observed | null {
  let fd: number;
  try {
    // O_NONBLOCK: `open` on a FIFO with no writer blocks inside the syscall,
    // where neither the round cap nor the check below could ever be reached.
    // It changes nothing for a regular file.
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return null;
    throw lockPathFailure(path, "read", error);
  }
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile()) throw notRegularFile(path);
    return { dev: stat.dev, ino: stat.ino, raw: readFileSync(fd, "utf-8") };
  } catch (error) {
    throw lockPathFailure(path, "read", error);
  } finally {
    try {
      closeSync(fd);
    } catch {
      // Closing a descriptor we are done with cannot change the protocol state.
    }
  }
}

function sameFile(a: Observed | null, b: Observed): boolean {
  return !!a && a.dev === b.dev && a.ino === b.ino && a.raw === b.raw;
}

function discard(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Temporary-file cleanup is best effort; the published files remain authoritative.
  }
}

/**
 * Publish a complete file under its final name without exposing partial JSON.
 * The hard link is atomic and the temporary file is in the same directory.
 */
function createExclusive(path: string, payload: string): boolean {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    try {
      writeFileSync(temp, payload, { flag: "wx" });
    } catch (error) {
      throw lockPathFailure(path, "write next to", error);
    }
    try {
      linkSync(temp, path);
      return true;
    } catch (error) {
      if (isErrno(error, "EEXIST")) return false;
      throw lockPathFailure(path, "publish", error);
    }
  } finally {
    discard(temp);
  }
}

/**
 * Remove `path` only if it still holds the observed file (I2). The detach is
 * atomic, so a single process can win a given file; the identity check after the
 * detach is what makes the removal conditional. A file detached by mistake is
 * put back under its own name.
 */
function takeIfSame(path: string, observed: Observed): boolean {
  // Not a guard — the guard is the check after the detach. Skipping a detach we
  // already know is wrong keeps the restore window from ever opening.
  if (!sameFile(observeFile(path), observed)) return false;

  const temp = `${path}.${process.pid}.${randomUUID()}.taken`;
  try {
    renameSync(path, temp);
  } catch (error) {
    // Gone, or taken by the process that legitimately owns this file. Anything
    // else (EACCES, EXDEV) is an environment problem the caller must see.
    if (isErrno(error, "ENOENT")) return false;
    throw lockPathFailure(path, "replace", error);
  }
  if (sameFile(observeFile(temp), observed)) {
    discard(temp);
    return true;
  }
  // Detached a file published after the observation: it belongs to another
  // process, so give it its name back. `EEXIST` here is the documented residual
  // race in the header.
  try {
    linkSync(temp, path);
  } catch (error) {
    if (!isErrno(error, "EEXIST")) throw lockPathFailure(path, "restore", error);
  }
  discard(temp);
  return false;
}

/** Remove a file this process published, identified by its exact bytes. */
function takeOwn(path: string, payload: string): boolean {
  const observed = observeFile(path);
  if (!observed || observed.raw !== payload) return false;
  return takeIfSame(path, observed);
}

/** Bytes published for `info`: the caller's payload plus this incarnation's
 * nonce (I3). */
function publishedPayload<T extends LockPayload>(info: T): string {
  return JSON.stringify({ ...info, [NONCE_FIELD]: LOCK_NONCE });
}

interface Holder<T> {
  /** The caller's payload, without the nonce this module added. */
  info: T;
  /** Published by this process incarnation. */
  own: boolean;
}

function holderOf<T extends LockPayload>(raw: string | null): Holder<T> | null {
  const parsed = parseInfo<Record<string, unknown>>(raw);
  if (!parsed || typeof parsed !== "object") return null;
  const { [NONCE_FIELD]: nonce, ...info } = parsed;
  return { info: info as T, own: nonce === LOCK_NONCE };
}

/** Whether the lock is held by a process that still exists (I4). */
function isHeld<T extends LockPayload>(holder: Holder<T> | null, isAlive: (pid: number) => boolean): boolean {
  if (!holder || !isValidPid(holder.info.pid)) return false;
  // Our own pid on a payload we did not publish: the publisher is dead and we
  // recycled its pid. Probing would answer "alive" — ourselves.
  if (holder.info.pid === process.pid) return holder.own;
  return isAlive(holder.info.pid);
}

/** Ownership, as `releaseLock` and `heldByThisProcess` both understand it: the
 * nonce proves the publishing incarnation (I5), and the pid must be the one the
 * caller claims to hold — a process that published a lock for a pid other than
 * its own does not own it under that pid. */
function ownedBy(observed: Observed | null, ownerPid: number): boolean {
  const holder = holderOf<LockPayload>(observed?.raw ?? null);
  return !!holder?.own && holder.info.pid === ownerPid;
}

/** Whether `lockFile` is currently held by this process incarnation on behalf of
 * `ownerPid`. Callers use it for re-entrance instead of comparing pids, which pid
 * reuse makes unsound. Same predicate as `releaseLock`'s. */
export function heldByThisProcess(lockFile: string, ownerPid: number = process.pid): boolean {
  return ownedBy(observeFile(lockFile), ownerPid);
}

function reclaimPath(lockFile: string): string {
  return `${lockFile}.reclaim`;
}

/** `acquireLock` stays synchronous so callers need no async plumbing. Atomics.wait
 * provides a real pause without a busy loop while another process publishes its lock. */
function waitBeforeRetry(attempt: number, baseDelayMs: number): void {
  if (baseDelayMs <= 0) return;
  const delay = Math.min(MAX_RETRY_DELAY_MS, baseDelayMs * 2 ** Math.min(attempt, 3));
  const cell = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(cell, 0, 0, delay);
}

function liveReclaim(reclaim: ReclaimInfo | null, isAlive: (pid: number) => boolean): reclaim is ReclaimInfo {
  return !!reclaim && isValidPid(reclaim.pid) && isAlive(reclaim.pid);
}

/**
 * `link` refused the lock name while nothing readable is there. A competitor
 * publishing between the two calls explains it once; an entry that is not a
 * regular file — a dangling symlink, a socket — explains it forever, so it is
 * reported instead of retried.
 */
function assertPublishableLockPath(path: string): void {
  let entry: ReturnType<typeof lstatSync>;
  try {
    entry = lstatSync(path);
  } catch {
    // Vanished again: an ordinary race, the loop retries.
    return;
  }
  if (!entry.isFile()) throw notRegularFile(path);
}

/**
 * Publish the election marker and read it back. A read that fails leaves a marker
 * carrying this process's live pid, which every other acquirer would wait behind
 * for as long as this process lives: drop it before propagating.
 */
function publishMarker(reclaimFile: string, claimPayload: string): Observed | null {
  if (!createExclusive(reclaimFile, claimPayload)) return null;
  try {
    return observeFile(reclaimFile);
  } catch (error) {
    bestEffort(() => takeOwn(reclaimFile, claimPayload));
    throw error;
  }
}

/** Whether the marker this process published is still exactly that file. A marker
 * that cannot be read cannot be vouched for, so it counts as broken (I6). */
function markerIsStillOurs(reclaimFile: string, marker: Observed): boolean {
  try {
    return sameFile(observeFile(reclaimFile), marker);
  } catch {
    return false;
  }
}

export function acquireLock<T extends LockPayload>(
  lockFile: string,
  info: T,
  isAlive: (pid: number) => boolean = defaultIsAlive,
  options: LockAcquireOptions = {},
): LockAcquireResult<T> {
  const retries = Math.max(0, Math.floor(options.retries ?? 3));
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
  const payload = publishedPayload(info);
  const reclaimFile = reclaimPath(lockFile);
  // Hard stop: every branch below either returns or makes progress, but a
  // pathological environment must fail loudly instead of spinning forever.
  const maxRounds = 8 + 4 * (retries + 1);
  let contentionAttempt = 0;

  for (let round = 0; ; round++) {
    if (round >= maxRounds) {
      throw lockPathError(
        lockFile,
        `Could not acquire or reclaim the lock ${lockFile} after ${maxRounds} rounds. Inspect that path and its .reclaim marker.`,
      );
    }

    // A process cleaning up a stale lock announces its claim. Others must not
    // replace the lock during this window.
    const observedReclaim = observeFile(reclaimFile);
    const reclaim = parseInfo<ReclaimInfo>(observedReclaim?.raw ?? null);
    if (liveReclaim(reclaim, isAlive) && reclaim.pid !== process.pid) {
      const holder = holderOf<T>(observeFile(lockFile)?.raw ?? null);
      if (holder && isHeld(holder, isAlive)) return { ok: false, holder: holder.info };
      // The reclaim owner may be between detaching the dead lock and publishing
      // its own. Exhausting all attempts here makes this transient window
      // indistinguishable from an orphaned lock. After the final wait, the marker
      // itself is the only observable owner.
      if (contentionAttempt >= retries) return { ok: false, reclaiming: { pid: reclaim.pid } };
      waitBeforeRetry(contentionAttempt, retryDelayMs);
      contentionAttempt++;
      continue;
    }
    if (observedReclaim) {
      // Corrupted, dead, or left by an earlier attempt from this process: do not let
      // it block a new claimant. Exactly one process removes that exact marker.
      if (takeIfSame(reclaimFile, observedReclaim)) {
        contentionAttempt = 0;
      } else {
        waitBeforeRetry(contentionAttempt, retryDelayMs);
        contentionAttempt = Math.min(retries, contentionAttempt + 1);
      }
      continue;
    }

    // Free lock: publication alone decides the winner (I1). No back-out is needed
    // against a claimant that appeared meanwhile: it may only replace the dead
    // lock it identified, never this one (I2).
    if (createExclusive(lockFile, payload)) return { ok: true };

    const holder = holderOf<T>(observeFile(lockFile)?.raw ?? null);
    if (holder && isHeld(holder, isAlive)) return { ok: false, holder: holder.info };
    if (!holder) assertPublishableLockPath(lockFile);

    // Only one process publishes the marker. It alone may replace the dead lock.
    const claim: ReclaimInfo = { pid: process.pid, token: randomUUID() };
    const claimPayload = JSON.stringify(claim);
    const marker = publishMarker(reclaimFile, claimPayload);
    if (!marker || marker.raw !== claimPayload) {
      // The election is not ours: either the marker was already taken, or ours
      // was removed and a competitor published its own inside that window. Never
      // remove a marker that is not ours — a third process would then open a
      // second concurrent election. The foreign-marker branches above handle it
      // on the next round.
      waitBeforeRetry(contentionAttempt, retryDelayMs);
      contentionAttempt = Math.min(retries, contentionAttempt + 1);
      continue;
    }

    try {
      const current = observeFile(lockFile);
      const currentHolder = holderOf<T>(current?.raw ?? null);
      if (currentHolder && isHeld(currentHolder, isAlive)) return { ok: false, holder: currentHolder.info };

      // Removing the dead lock and publishing ours are two steps; the marker is
      // what keeps another reclaimer out of that window, and `createExclusive`
      // keeps out a process that took the free lock first.
      if (!current || takeIfSame(lockFile, current)) {
        if (createExclusive(lockFile, payload)) {
          if (markerIsStillOurs(reclaimFile, marker)) return { ok: true };
          // Our election was broken (see the residual race). The lock we just
          // published is exclusively ours all the same — I1 granted it, and by I2
          // no competitor can remove it on the strength of an observation that
          // predates it — so dropping it is hygiene, not correctness: it keeps
          // this process from holding a lock while another believes it is
          // mid-reclamation. When dropping it fails, holding it is the truthful
          // answer; reporting a failure would leave a published lock that nobody
          // releases.
          if (!bestEffort(() => takeOwn(lockFile, payload))) return { ok: true };
        } else if (!current) {
          assertPublishableLockPath(lockFile);
        }
      }
    } finally {
      // Best effort: see `bestEffort`. Our marker carries our live pid, so failing
      // to remove it makes other acquirers wait — but throwing here would replace
      // a successful acquisition, or an in-flight exception, with a cleanup error.
      bestEffort(() => takeIfSame(reclaimFile, marker));
    }
    waitBeforeRetry(contentionAttempt, retryDelayMs);
    contentionAttempt = Math.min(retries, contentionAttempt + 1);
  }
}

/**
 * Release the lock only if this process incarnation still owns it: same pid
 * *and* same nonce (I5). A lock that went stale and was reclaimed by another
 * runner belongs to that runner, and a lock published by a dead process whose
 * pid we inherited was never ours; removing either would let two runners write
 * the same git tree. Releasing an already-removed lock is idempotent.
 */
export function releaseLock(lockFile: string, ownerPid: number = process.pid): void {
  if (!isValidPid(ownerPid)) return;
  const observed = observeFile(lockFile);
  if (!observed || !ownedBy(observed, ownerPid)) return;
  takeIfSame(lockFile, observed);
}
