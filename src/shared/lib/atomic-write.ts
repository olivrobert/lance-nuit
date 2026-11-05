//
// Publish a whole file atomically: a reader sees the previous content or the new
// one, never a truncated write.

import { randomUUID } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";

/** Writer-owned temporary next to `path`. It shares the destination directory so
 *  the rename stays on one filesystem, where it is atomic, and carries the pid and
 *  a random part because a shared name lets two concurrent writers publish each
 *  other's half-written bytes. */
function temporaryPathFor(path: string): string {
  return `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
}

/** Replace `path` with `content`. The parent directory must exist. */
export function writeFileAtomic(path: string, content: string): void {
  const temporary = temporaryPathFor(path);
  try {
    writeFileSync(temporary, content, "utf-8");
    renameSync(temporary, path);
  } catch (error) {
    // A failed cleanup must not replace the write error the caller has to see.
    try {
      rmSync(temporary, { force: true });
    } catch {}
    throw error;
  }
}

/** Asynchronous `writeFileAtomic`. */
export async function writeFileAtomicAsync(path: string, content: string): Promise<void> {
  const temporary = temporaryPathFor(path);
  try {
    await writeFile(temporary, content, "utf-8");
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
