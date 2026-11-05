import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic, writeFileAtomicAsync } from "./atomic-write.js";

test("both writers replace the file and leave no temporary behind", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atomic-write-"));
  try {
    const path = join(dir, "file.json");
    writeFileAtomic(path, "one");
    await writeFileAtomicAsync(path, "two");
    expect(readFileSync(path, "utf-8")).toBe("two");
    expect(readdirSync(dir)).toEqual(["file.json"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed write removes its temporary and rethrows", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atomic-write-fail-"));
  try {
    // A non-empty directory at the destination: the rename fails once the
    // temporary exists.
    const path = join(dir, "target");
    mkdirSync(path);
    writeFileSync(join(path, "occupied"), "x");
    expect(() => writeFileAtomic(path, "data")).toThrow();
    await expect(writeFileAtomicAsync(path, "data")).rejects.toThrow();
    expect(readdirSync(dir)).toEqual(["target"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
