/** Contract implemented by every module in `extractors/` through its exported
 *  `extract` function (see `extractors/registry.ts`). */
export interface ExtractionResult {
  hasErrors: boolean;
  errors: string;
  /** Whether a machine-readable report was actually found and parsed. `false` says
   *  the step produced no report at all — it crashed, or never ran — so `hasErrors:
   *  false` is an absence of evidence rather than a green suite. `undefined` (the
   *  default, and what a third-party extractor that ignores the field reports) means
   *  the extractor does not distinguish the two cases. The runner never changes a
   *  verdict on it: only the `fixOnlyWhenExtracted` policy reads it. */
  reportFound?: boolean;
}

export type ErrorExtractor = (output: string) => ExtractionResult;
