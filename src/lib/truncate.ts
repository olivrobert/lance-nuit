export const MAX_ERROR_CHARS = 2000;

export function truncate(text: string, max: number = MAX_ERROR_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n... (truncated, ${text.length - max} characters removed)`;
}

/** Maximum stepOutput injected into a fix_prompt (E2BIG argv plus token cost). */
export const MAX_STEP_OUTPUT_CHARS = 100_000;

/** Truncate while keeping both the beginning AND end; useful errors often appear
 * at the end of output. */
export function truncateMiddle(text: string, max: number = MAX_STEP_OUTPUT_CHARS): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.2);
  const tail = max - head;
  return (
    text.slice(0, head) +
    `\n\n... (truncated, ${text.length - max} characters removed from the middle) ...\n\n` +
    text.slice(-tail)
  );
}
