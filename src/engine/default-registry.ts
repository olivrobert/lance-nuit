/**
 * Built-in provider composition for the standalone runner.
 *
 * The registry contract itself deliberately does not import provider
 * implementations. This module is the optional composition root used by the
 * current CLI, while external hosts can construct an AgentBackendRegistry with
 * only the providers they installed.
 */

import { AgentBackendRegistry } from "../contracts/backends.js";
import { claudeBackendFactory } from "./backends/claude-code/backend.js";
import { codexBackendFactory } from "./backends/codex/backend.js";
import { opencodeBackendFactory } from "./backends/opencode/backend.js";

export function createDefaultAgentBackendRegistry(): AgentBackendRegistry {
  return new AgentBackendRegistry()
    .register(claudeBackendFactory, { default: true })
    .register(codexBackendFactory)
    .register(opencodeBackendFactory);
}

/** Runtime registry used by the standalone runner. */
export const defaultAgentBackendRegistry = createDefaultAgentBackendRegistry();
