import { parseStructuredVerdict } from "../result-helpers.js";
import type { ParsedOpencodeEvents } from "./events.js";

/**
 * opencode has neither `--output-schema` nor a StructuredOutput tool: the verdict
 * is asked for in the prompt and comes back inside the text. The shared cascade
 * accepts it from the most explicit shape to the most forgiving.
 */
export function parseStructuredOutput(parsed: ParsedOpencodeEvents): { value?: unknown; invalidReason?: string } {
  return parseStructuredVerdict(parsed.text, parsed.structuredOutput);
}
