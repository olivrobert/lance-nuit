// runner/output/watcher.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileLiveFeed } from "./live-feed.js";
import { buildWatcherCommand, ensureLiveFeed } from "./watcher.ts";

let saved: Record<string, string | undefined>;
let runDir: string;

beforeEach(() => {
  saved = {
    RUNNER_EVENTS_FILE: process.env.RUNNER_EVENTS_FILE,
    RUNNER_LIVE_FEED: process.env.RUNNER_LIVE_FEED,
  };
  runDir = mkdtempSync(join(tmpdir(), "watcher-"));
  // Each runner explicitly sets its own feed path.
  delete process.env.RUNNER_EVENTS_FILE;
  process.env.RUNNER_LIVE_FEED = join(runDir, "live.jsonl");
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(runDir, { recursive: true, force: true });
});

const live = () => join(runDir, "live.jsonl");

test("preserves existing log on top-level relaunch", () => {
  writeFileSync(live(), "previous attempt\n");
  ensureLiveFeed();
  expect(readFileSync(live(), "utf-8")).toBe("previous attempt\n");
});

test("preserves existing feed", () => {
  writeFileSync(live(), "feed parent\n");
  ensureLiveFeed();
  expect(readFileSync(live(), "utf-8")).toBe("feed parent\n");
});

test("creates empty feed when absent (both modes)", () => {
  expect(existsSync(live())).toBe(false);
  ensureLiveFeed();
  expect(existsSync(live())).toBe(true);
  expect(readFileSync(live(), "utf-8")).toBe("");
});

test("sets RUNNER_LIVE_FEED on the run dir", () => {
  ensureLiveFeed();
  expect(process.env.RUNNER_LIVE_FEED).toBe(live());
});

test("uses injected feed path before environment fallback", () => {
  const injected = join(runDir, "nested", "events.jsonl");
  ensureLiveFeed(new FileLiveFeed(injected));
  expect(existsSync(injected)).toBe(true);
  expect(existsSync(live())).toBe(false);
  expect(process.env.RUNNER_EVENTS_FILE).toBe(injected);
  expect(process.env.RUNNER_LIVE_FEED).toBe(injected);
});

test("missing injected or configured feed is silent", () => {
  delete process.env.RUNNER_EVENTS_FILE;
  delete process.env.RUNNER_LIVE_FEED;
  expect(() => ensureLiveFeed()).not.toThrow();
});

test("watcher remains persistent by default and closes only with the option", () => {
  const regular = buildWatcherCommand("/tmp/live feed", "/tmp/state.json", "formatter", false);
  expect(regular).toContain("tail -n +1 -F '/tmp/live feed' | formatter");
  expect(regular).toContain('read -p "Press Enter to close..."');
  expect(regular).not.toContain("setsid");

  const automatic = buildWatcherCommand("/tmp/live feed", "/tmp/state.json", "formatter", true);
  expect(automatic).toContain("setsid bash -c");
  expect(automatic).toContain("(PASS|FAIL|STOPPED|ABORTED)");
  expect(automatic).toContain('kill -TERM -- "-$watcher_pid"');
  expect(automatic).not.toContain("read -p");
});

test("watcher quoting remains valid with an apostrophe in a path", () => {
  for (const command of [
    buildWatcherCommand("/tmp/live feed team's", "/tmp/state team's.json", "formatter", false),
    buildWatcherCommand("/tmp/live feed team's", "/tmp/state team's.json", "formatter", true),
  ]) {
    const syntax = spawnSync("bash", ["-n", "-c", command], { encoding: "utf-8" });
    expect(syntax.status).toBe(0);
  }
});
