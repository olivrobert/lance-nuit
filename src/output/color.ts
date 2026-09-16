// output/color.ts
//
// ANSI styling for every console surface.
//
// Color is an ENHANCEMENT, never information: a run read without it must lose
// nothing. Icons, labels and counts already say what happened; color only makes
// the scan faster. That rule is what allows the whole module to collapse to
// identity functions on a pipe, in CI, or under NO_COLOR — the callers stay the
// same, and so does the text they produce.

export type Style = (text: string) => string;

interface ColorStream {
  isTTY?: boolean;
}

const CODES = {
  red: 31,
  green: 32,
  yellow: 33,
  cyan: 36,
  gray: 90,
  bold: 1,
  dim: 2,
} as const;

const RESET = "\x1b[0m";

/**
 * Resolution order follows the conventions terminals already agree on:
 * NO_COLOR wins over everything, FORCE_COLOR overrides a non-TTY (useful to
 * inspect the real output through a pager), and `TERM=dumb` is honored.
 */
export function detectColor(env: NodeJS.ProcessEnv = process.env, stream: ColorStream = process.stderr): boolean {
  if (env.NO_COLOR) return false;
  if (env.FORCE_COLOR) return env.FORCE_COLOR !== "0";
  if (env.TERM === "dumb") return false;
  return stream.isTTY === true;
}

let enabled = detectColor();

export function isColorEnabled(): boolean {
  return enabled;
}

/** Override the detection — for tests, and for surfaces that write to stdout. */
export function setColorEnabled(value: boolean): void {
  enabled = value;
}

/** Styles never nest: each one resets fully, so a wrapped style would lose the
 * outer one. Callers compose by concatenation instead. */
function style(code: number): Style {
  return (text) => (enabled && text ? `\x1b[${code}m${text}${RESET}` : text);
}

export const red = style(CODES.red);
export const green = style(CODES.green);
export const yellow = style(CODES.yellow);
export const cyan = style(CODES.cyan);
export const gray = style(CODES.gray);
export const bold = style(CODES.bold);
export const dim = style(CODES.dim);

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escape sequences is the point
const ANSI = /\x1b\[[0-9;]*m/g;

/** Length as the terminal sees it. Layout must be computed on this, never on
 * `String.length`, or padding and clipping drift by the width of the escapes. */
export function visibleLength(text: string): number {
  return text.replace(ANSI, "").length;
}
