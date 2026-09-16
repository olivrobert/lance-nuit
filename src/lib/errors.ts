// lib/errors.ts
//
// The two things every `catch` in this repository needs: a readable message,
// and errno discrimination. Both were reimplemented inline dozens of times
// before they lived here.

/**
 * Readable message for an unknown thrown value.
 *
 * Does not keep the cause: the last link only, which is what a console line or
 * a journal entry wants. To re-throw while keeping the chain, pass the original
 * error as `{ cause }`:
 *
 *   throw new Error(`${context}: ${errorMessage(error)}`, { cause: error });
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The errno code of a thrown value, or `undefined` when it carries none.
 *
 * For the sites that report the code rather than branch on it; a branch should
 * use `isErrno`.
 */
export function errnoCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Narrow a thrown value to a system error carrying `code`, without a cast.
 *
 * `catch` yields `unknown`, and a failed syscall is the one case where the
 * caught value must be inspected rather than reported. Replaces the four
 * mutually incompatible cast idioms this repository accumulated.
 *
 * `code` excludes `undefined` on purpose: `NodeJS.ErrnoException["code"]` is
 * optional, so accepting it as written would make `isErrno(error, undefined)`
 * compile and narrow every plain `Error` — a check that reads like errno
 * discrimination and is the opposite of one.
 */
export function isErrno(
  error: unknown,
  code: NonNullable<NodeJS.ErrnoException["code"]>,
): error is NodeJS.ErrnoException {
  return errnoCode(error) === code;
}
