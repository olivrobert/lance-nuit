import { parseStructuredVerdict } from "../result-helpers.js";
import type { ParsedCodexEvents } from "./events.js";

/**
 * Codex constrains its final message with `--output-schema`, so the structured
 * candidate usually is the verdict. The shared cascade still lets an explicit
 * ```json:verdict fence win, so a stray trailing JSON message cannot mask a
 * verdict the agent already stated.
 */
export function parseStructuredOutput(parsed: ParsedCodexEvents): { value?: unknown; invalidReason?: string } {
  return parseStructuredVerdict(parsed.text, parsed.structuredOutput);
}
