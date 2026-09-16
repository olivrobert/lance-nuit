/** Validate mandatory DSL text while keeping composition errors consistent. */
export function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Pipeline composition: ${field} must be a non-empty string`);
  }
  return value;
}
