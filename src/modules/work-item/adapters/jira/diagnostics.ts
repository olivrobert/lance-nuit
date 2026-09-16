import type { ProcessResult } from "../../process/runner.js";
import { providerOutput, redactProviderOutput as redactOutput } from "../gateway-shared.js";

const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(?:ATATT|ATCTT)[A-Za-z0-9._~+/=-]{6,}/g, "[redacted]"],
];
export function redactProviderOutput(raw: string): string {
  return redactOutput(raw, SECRET_PATTERNS);
}
export function outputOf(result: ProcessResult): string {
  return providerOutput(
    result,
    "Jira integration unavailable: the `acli` executable is required (install it or make `acli` available on PATH).",
    redactProviderOutput,
  );
}
