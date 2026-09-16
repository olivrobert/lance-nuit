// env/pricing.schema.ts
//
// Shape and reader of the optional project rate table
// (`.lance-nuit/pipeline-history/pricing.json`).
//
// Why here and not next to the type: `contracts/pricing.ts` is part of the
// installed DSL declarations. It keeps the hand-written `ProjectPricing` type and
// the matching rules; the shape check and the file reading live in this module so
// that no `import "zod"` can reach a project that never installed it
// (`tests/project/declarations-no-zod.test.ts` guards it). See
// `guide/architecture.md`, section "Persistence and observability".
//
// Diagnostic policy for this boundary: a malformed table is NOT an error to
// raise. Pricing is optional — an exact provider-reported cost wins over any
// token estimation — and the readers that need it are statistics readers, which
// must keep working on a project whose rate table is broken. So the file is
// reported once, by name, with the reason (`z.prettifyError`), and treated as
// absent, exactly as a missing file is. Reporting once falls out of the caller's
// cache (`loadProjectPricing`): the file is read at most once per process.
//
// Strict on the form, like `config.json` and unlike a persisted format: this file
// is hand-written, so `"cachRead": 0.6` silently ignored is a trap. Rates are
// judged as numbers here; whether a set of rates is usable (at least one rate,
// none negative) stays in `projectPricingForModel`, which owns that rule for
// tables given directly by a caller too.

import { readFileSync } from "node:fs";
import * as z from "zod";
import type { ProjectPricing } from "../contracts/pricing.js";
import { errorMessage } from "../lib/errors.js";
import type { AssertAssignable, Plain } from "../lib/type-assertions.js";

/** Rates of one model, in currency units per million tokens. */
const PricingEntrySchema = z.strictObject({
  in: z.number().optional(),
  out: z.number().optional(),
  cacheRead: z.number().optional(),
  cacheWrite: z.number().optional(),
});

/** The table: model name → rates, plus string entries such as `_currency`. Keys
 * are model names, so they stay open; values do not. */
export const ProjectPricingSchema = z.record(z.string(), z.union([PricingEntrySchema, z.string()]));

/** Human-readable reason a value is not a rate table, or undefined when it is. */
export function diagnoseProjectPricing(value: unknown): string | undefined {
  const result = ProjectPricingSchema.safeParse(value);
  return result.success ? undefined : z.prettifyError(result.error);
}

/** The table, or null when the value is not one. */
export function parseProjectPricing(value: unknown): ProjectPricing | null {
  const result = ProjectPricingSchema.safeParse(value);
  return result.success ? result.data : null;
}

/**
 * Read the project rate table. A missing file yields null silently; an unreadable
 * or malformed one yields null after a single warning naming the file.
 */
export function readProjectPricingFile(path: string): ProjectPricing | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    // Absent (the common case) or unreadable: pricing is optional, stay quiet.
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    const message = errorMessage(error);
    warn(path, `contains invalid JSON (${message})`);
    return null;
  }
  const result = ProjectPricingSchema.safeParse(value);
  if (!result.success) {
    warn(path, `is not a valid rate table:\n${z.prettifyError(result.error)}`);
    return null;
  }
  return result.data;
}

function warn(path: string, reason: string): void {
  console.error(`[pipeline] WARNING: ${path} ${reason}; treating it as absent.`);
}

/* ------------------------------------------------------------------------- *
 * Compile-time proof that the schema and the hand-written type describe the
 * same data (see `lib/type-assertions.ts`).
 * ------------------------------------------------------------------------- */

type _OutputIsTable = AssertAssignable<z.output<typeof ProjectPricingSchema>, ProjectPricing>;
type _TableIsInput = AssertAssignable<Plain<ProjectPricing>, z.input<typeof ProjectPricingSchema>>;
