import { liveFeedFilePath } from "../../../runtime/live-feed.js";
import { emitAgentSpawn } from "../../../runtime/events.js";
import { appendBestEffort } from "../host-helpers.js";
import { createNodeCodexHost } from "./execution.js";
import type { CodexBackendHost } from "./types.js";

/** Runner composition host: adds live feed and runner events on top of the node host. */
export function createRunnerCodexHost(): CodexBackendHost {
  return createNodeCodexHost({
    appendLiveOutput: (text) => appendBestEffort(liveFeedFilePath(), text),
    onSpawn: emitAgentSpawn,
  });
}
