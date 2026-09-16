/** Abort before a dispatch loop. Kept outside the strategy registry so strategies
 * can throw it without creating a runtime import cycle. */
export class DispatchAbort extends Error {
  constructor(readonly code: number) {
    super(`dispatch abort (${code})`);
  }
}
