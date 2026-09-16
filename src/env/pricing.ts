// env/pricing.ts
//
// Kit-side resolution of the optional project rate table. `contracts/pricing.ts`
// owns the shapes and the pure rules; this module owns what needs the platform:
// walking the kit chain, reading each layer through the schema, and caching the
// answer for the process.

import { mergePricingLayers, PRICING_FILE, type ProjectPricing } from "../contracts/pricing.js";
import { kitFileLayers } from "./kit-paths.js";
import { readProjectPricingFile } from "./pricing.schema.js";

let projectPricingCache: ProjectPricing | null | undefined;

/**
 * Rate table resolved through the kit chain: `~/.lance-nuit/pipeline-history/pricing.json`
 * supplies machine-wide rates, `<project>/.lance-nuit/pipeline-history/pricing.json`
 * overrides them model by model. Layers merge by key, like `config.json`: a project
 * can reprice one model without copying the shared table. A malformed layer is
 * reported by the reader and skipped; `null` when no layer holds a table.
 */
export function resolveProjectPricing(
  cwd: string = process.cwd(),
  env: Record<string, string | undefined> = process.env,
): ProjectPricing | null {
  return mergePricingLayers([...kitFileLayers(PRICING_FILE, { cwd, env })].map((path) => readProjectPricingFile(path)));
}

/** The rate table, read once per process. A missing table — and a malformed one,
 *  reported by the reader — yields null: pricing is optional. */
export function loadProjectPricing(): ProjectPricing | null {
  if (projectPricingCache !== undefined) return projectPricingCache;
  projectPricingCache = resolveProjectPricing();
  return projectPricingCache ?? null;
}
