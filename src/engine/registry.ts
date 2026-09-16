/**
 * Convenience entrypoint over the engine's backend registries.
 *
 * The provider-neutral contract lives in `lance-nuit/contracts/backends`;
 * built-in provider composition is kept in `default-registry.ts` and is wired by
 * the composition roots (`entry/`, `commands/`). This module deliberately does
 * not import it: nothing below the entry point may reach for the singleton.
 */

export { AgentBackendRegistry, backendForFix } from "../contracts/backends.js";
