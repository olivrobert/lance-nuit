// Public shape of an extension module.
//
// An extension is an ordinary ESM module whose default export is a manifest.
// The manifest lists contributions by category; the host (the standalone CLI,
// or any program composing its own registries) reads it and registers each
// contribution. Importing an extension has no side effect: nothing here touches
// a global registry, and the host alone decides which manifests are loaded.
//
// This file is the contract only. Loading, resolution and runtime validation of
// a manifest belong to the host (`src/boot/extensions.ts` for the CLI).

import type { AgentBackendFactory } from "./backends.js";
import type { WorkItemGatewayRegistration } from "./registry.js";

/**
 * Contributions an extension module may declare. Every key is optional and
 * every list may be empty. Unknown keys are rejected by the host so a typo, or
 * a manifest written for a newer contract, fails loudly instead of being
 * ignored.
 *
 * Each contribution carries its own `id` and a `create` factory. The host
 * refuses an `id` already registered, built-in or not: a composition that wants
 * to replace a built-in provider must not register that built-in in the first
 * place. Factories are stored, never called, while the manifest is loaded.
 */
export interface ExtensionManifest {
  /** Agent backends: run an agent and report its result, session and usage. */
  readonly backends?: readonly AgentBackendFactory[];
  /** Work-item providers: read tickets, find candidates, comment, move. */
  readonly workItems?: readonly WorkItemGatewayRegistration[];
}

/** Keys the host accepts in a manifest; anything else is an error. */
export const EXTENSION_MANIFEST_KEYS: readonly (keyof ExtensionManifest)[] = ["backends", "workItems"];

/**
 * Identity helper that types a manifest in place, so an extension gets
 * completion and type errors without importing the interface:
 *
 * ```ts
 * import { defineExtension } from "lance-nuit/contracts";
 * export default defineExtension({ workItems: [redmine] });
 * ```
 *
 * It performs no validation and registers nothing.
 */
export function defineExtension<const M extends ExtensionManifest>(manifest: M): M {
  return manifest;
}
