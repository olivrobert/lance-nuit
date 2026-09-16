import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileLiveFeed } from "./live-feed.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "live-feed-"));
  dirs.push(dir);
  return dir;
}

test("resolves events.jsonl by default from run dir", () => {
  const runDir = tempDir();
  expect(new FileLiveFeed({ runDir }).path()).toBe(join(runDir, "events.jsonl"));
});

test("accepts injected path, creates file, and appends JSONL in order", () => {
  const path = join(tempDir(), "nested", "custom.jsonl");
  const feed = new FileLiveFeed({ filePath: path });

  feed.ensure();
  feed.append({ n: 1 });
  feed.append({ n: 2 });

  expect(readFileSync(path, "utf-8")).toBe('{"n":1}\n{"n":2}\n');
});

test("preserves existing feed and absorbs unavailable path", () => {
  const dir = tempDir();
  const existing = join(dir, "events.jsonl");
  writeFileSync(existing, "old line\n");
  new FileLiveFeed(existing).ensure();
  expect(readFileSync(existing, "utf-8")).toBe("old line\n");

  const blocker = join(dir, "not-a-directory");
  writeFileSync(blocker, "x");
  const unavailable = new FileLiveFeed(join(blocker, "events.jsonl"));
  expect(() => unavailable.ensure()).not.toThrow();
  expect(() => unavailable.append({ ignored: true })).not.toThrow();
  expect(existsSync(unavailable.path())).toBe(false);
});
