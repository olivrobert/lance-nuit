// What other contexts may import from this one: re-exports only, every name with a caller outside.
// `module-<context>-entry-only` in `.dependency-cruiser.cjs` holds the rule.
export { createDefaultWorkItemGatewayRegistry } from "./providers/registry.js";
