import type { ProcessResult } from "../../process/runner.js";
import { providerOutput, redactProviderOutput as redactOutput } from "../gateway-shared.js";

const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}/g, "[redacted]"],
];

export function redactProviderOutput(raw: string): string {
  return redactOutput(raw, SECRET_PATTERNS);
}

export function outputOf(result: ProcessResult): string {
  return providerOutput(
    result,
    "GitHub integration unavailable: the `gh` executable is required (install it or make `gh` available on PATH).",
    redactProviderOutput,
  );
}
