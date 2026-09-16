import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "../runtime/logging.js";
import type { LiveFeed } from "../runtime/live-feed.js";
import { liveFeedFromEnvironment } from "./live-feed.js";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function resolveLiveFeed(feed?: LiveFeed): LiveFeed | undefined {
  return feed ?? liveFeedFromEnvironment();
}

/**
 * Build the pane shell separately from the tmux spawn so the ergonomics contract
 * can be tested without a real tmux session.
 */
export function buildWatcherCommand(live: string, state: string, formatterCommand: string, autoClose = false): string {
  const pipeline = `tail -n +1 -F ${shellQuote(live)} | ${formatterCommand}`;
  if (!autoClose) return `${pipeline}; read -p "Press Enter to close..."`;

  return [
    // The pipeline runs in its own group so tail and the formatter can be stopped together.
    // Format everything once the terminal snapshot has been written.
    `setsid bash -c ${shellQuote(pipeline)} &`,
    "watcher_pid=$!",
    `while kill -0 "$watcher_pid" 2>/dev/null; do if grep -Eq ${shellQuote('"status"[[:space:]]*:[[:space:]]*"(PASS|FAIL|STOPPED|ABORTED)"')} ${shellQuote(state)} 2>/dev/null; then kill -TERM -- "-$watcher_pid" 2>/dev/null || true; break; fi; sleep 0.25; done`,
    'wait "$watcher_pid" 2>/dev/null || true',
  ].join("\n");
}

export function ensureLiveFeed(feed?: LiveFeed): void {
  const liveFeed = resolveLiveFeed(feed);
  if (!liveFeed) return;

  liveFeed.ensure();
  const live = liveFeed.path();
  process.env.RUNNER_EVENTS_FILE = live;
  process.env.RUNNER_LIVE_FEED = live;
}

export function openWatcherPane(feed?: LiveFeed, options: { autoClose?: boolean } = {}): string | undefined {
  const live = resolveLiveFeed(feed)?.path();
  if (!live) return undefined;

  // Resolve formatter relative to this file (works whether run from repo or installed copy).
  const outputDir = dirname(fileURLToPath(import.meta.url));
  const formatter = join(outputDir, "stream-formatter.ts");

  // tail -F follows the file in real time via inotify and survives truncation.
  // Pipe to the formatter, which reads stdin; polling is not used by default.
  // The runner's own interpreter runs the formatter: it already loads this
  // TypeScript module, so it needs no separate resolution.
  const formatterCommand = `${shellQuote(process.execPath)} ${shellQuote(formatter)}`;
  const state = join(dirname(live), "state.json");
  const cmd = buildWatcherCommand(live, state, formatterCommand, options.autoClose);
  const tmuxResult = spawnSync("tmux", ["split-window", "-h", "-d", "-P", `bash -c ${shellQuote(cmd)}`], {
    encoding: "utf-8",
  });

  if (tmuxResult.status === 0) {
    const pane = tmuxResult.stdout?.trim();
    log(`Watcher opened in pane: ${pane} (live feed: ${live})`);
    return pane;
  }

  log("Warning: unable to open tmux pane (is tmux running?)");
  return undefined;
}
