import { liveFeedFilePath } from "../../../runtime/live-feed.js";
import { emitAgentSpawn, emitRunnerEvent, type RunnerEvent } from "../../../runtime/events.js";
import { appendBestEffort } from "../host-helpers.js";
import { createNodeOpencodeHost } from "./execution.js";
import type { OpencodeBackendHost } from "./types.js";

/** Runner composition host: adds live feed and runner events on top of the node host. */
export function createRunnerOpencodeHost(): OpencodeBackendHost {
  return createNodeOpencodeHost({
    appendLiveOutput: (text) => appendBestEffort(liveFeedFilePath(), text),
    // `--print-logs --log-level ERROR` only writes on hard failures, so forwarding
    // it costs nothing on a healthy run and is the only trace of a silent retry.
    appendLiveLogs: (text) => {
      process.stderr.write(text);
    },
    onEvent: (event) => emitRunnerEvent(event as RunnerEvent),
    onSpawn: emitAgentSpawn,
  });
}
