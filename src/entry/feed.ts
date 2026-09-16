// runner/entry/feed.ts
//
// Live run feed. It belongs to the composition root rather than to boot: it wires
// a concrete `FileLiveFeed` into the runtime port, and it depends on
// `run.run_dir`, which is only available after `loadOrCreateRun`.

import { FileLiveFeed } from "../output/live-feed.js";
import { ensureLiveFeed, openWatcherPane } from "../output/watcher.js";
import { LIVE_FEED_ENV_VARS, type LiveFeed, setRunnerLiveFeed } from "../runtime/live-feed.js";

/** Read the canonical run journal directly so resumes do not truncate it.
 * `events.jsonl` is both the live view and the append-only audit source. */
export function startLiveFeed(runDir: string, watch: boolean, options: { autoClose?: boolean } = {}): LiveFeed {
  const feed = new FileLiveFeed({ runDir });
  const path = feed.path();

  // Child processes can receive the feed path only through the environment.
  for (const name of LIVE_FEED_ENV_VARS) process.env[name] = path;

  setRunnerLiveFeed(feed);
  ensureLiveFeed(feed);
  if (watch) openWatcherPane(feed, { autoClose: options.autoClose });
  return feed;
}
