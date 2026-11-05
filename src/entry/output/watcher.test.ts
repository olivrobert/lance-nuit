import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUNNER_STATE_ENV } from "../../shared/env/runner-env.js";
import { setRunnerLiveFeed } from "../../shared/runtime/live-feed.js";
import { startLiveFeed } from "../composition/feed.js";
import { FileLiveFeed } from "./live-feed.js";
import { buildWatcherCommand } from "./watcher.ts";

let saved: Record<string, string | undefined>;
let runDir: string;

beforeEach(() => {
  saved = { [RUNNER_STATE_ENV.liveFeed]: process.env[RUNNER_STATE_ENV.liveFeed] };
  runDir = mkdtempSync(join(tmpdir(), "watcher-"));
  delete process.env[RUNNER_STATE_ENV.liveFeed];
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  setRunnerLiveFeed(undefined);
  rmSync(runDir, { recursive: true, force: true });
});

const live = () => join(runDir, "live.jsonl");

test("preserves existing log on top-level relaunch", () => {
  writeFileSync(live(), "previous attempt\n");
  new FileLiveFeed(live()).ensure();
  expect(readFileSync(live(), "utf-8")).toBe("previous attempt\n");
});

test("preserves existing feed", () => {
  writeFileSync(live(), "feed parent\n");
  new FileLiveFeed(live()).ensure();
  expect(readFileSync(live(), "utf-8")).toBe("feed parent\n");
});

test("creates empty feed when absent (both modes)", () => {
  expect(existsSync(live())).toBe(false);
  new FileLiveFeed(live()).ensure();
  expect(existsSync(live())).toBe(true);
  expect(readFileSync(live(), "utf-8")).toBe("");
});

test("advertises the run feed path to child processes", () => {
  const feed = startLiveFeed(join(runDir, "nested"), false);
  expect(existsSync(feed.path())).toBe(true);
  expect(process.env[RUNNER_STATE_ENV.liveFeed]).toBe(feed.path());
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
