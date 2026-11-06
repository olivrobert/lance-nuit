//
// A spend as the dashboard receives it: the run record decides the amount and
// whether it is a floor (`runSpend`, `figuresSpend`); this file only names it in
// the dashboard's vocabulary, so no screen re-derives either.

import type { Spend } from "../../run/index.js";
import type { ItemCost } from "./types.js";

/** `spend` as a dashboard cost, printed even when no figure was reported. */
export function itemCost(spend: Spend): ItemCost {
  return {
    ...(spend.usd !== undefined ? { usd: spend.usd } : {}),
    estimated: spend.estimated,
    ...(spend.lowerBound ? { unknown: true } : {}),
  };
}

/** `spend` as a dashboard cost, or `undefined` when there is nothing to print:
 *  no figure, and no unpriced spend that a blank would hide. */
export function reportedCost(spend: Spend): ItemCost | undefined {
  return spend.usd !== undefined || spend.lowerBound ? itemCost(spend) : undefined;
}
