import { promptTemplate } from "./prompt.js";
import { capabilityRoots } from "../../../env/capability-frontmatter.js";
import { emitAgentSpawn, emitRunnerEvent, type RunnerEvent } from "../../../runtime/events.js";
import { log } from "../../../runtime/logging.js";
import { isForkedSlashCommand } from "./args.js";
import { createNodeClaudeHost } from "./execution.js";
import type { ClaudeBackendHost } from "./types.js";

const relay = promptTemplate("fork-relay", ["slash"]);
export function createRunnerClaudeHost(): ClaudeBackendHost {
  const host = createNodeClaudeHost({
    capabilityRoots: (runnerDir, cwd) => capabilityRoots(runnerDir, cwd),
    isForkedSlashCommand,
    forkRelayPrompt: (slash) => relay({ slash }),
    // Stream telemetry reaches the runner's observers here. The backend builds
    // runner-shaped events but stays unaware of who consumes them.
    onEvent: (event) => emitRunnerEvent(event as RunnerEvent),
    onSpawn: emitAgentSpawn,
    log,
  });
  return host;
}
