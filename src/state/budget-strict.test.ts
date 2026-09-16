// Regression scenarios for the strict cost accounting contract.
//
// They pin the contract chosen in
// `.claude/work-items/strict-cost-accounting/plan.md`: a capped run must stop
// admitting work when a closed attempt spent money nobody could price, and
// `cost-unaccounted` is a stop reason of its own, distinct from
// `budget-exceeded`. Before `costDecision`, `budgetHalted` ignored
// `costUnknown`, so a $5 cap with $1 of known spend and an unpriced attempt
// still reported $4 remaining.

import { expect, test } from "bun:test";
import { costDecision as decide } from "./budget.js";

test("strict cost: an unknown closed attempt blocks a capped run", () => {
  expect(decide(5, { cumulative: 1, costUnknown: true })).toBe("unaccounted");
});

test("strict cost: an uncapped run continues despite unknown spend", () => {
  expect(decide(undefined, { cumulative: 1, costUnknown: true })).toBe("continue");
});

test("strict cost: explicit unmetered authorization continues under a cap", () => {
  expect(decide(5, { cumulative: 1, costUnknown: true, allowUnmetered: true })).toBe("continue");
});

test("strict cost: known spending still stops at the cap", () => {
  expect(decide(5, { cumulative: 5 })).toBe("exceeded");
});

test("strict cost: unmetered authorization does not lift the known-cost ceiling", () => {
  expect(decide(5, { cumulative: 5, costUnknown: true, allowUnmetered: true })).toBe("exceeded");
});

test("strict cost: a raised cap alone does not bypass uncertainty", () => {
  // `--budget 20` only changes the amount; the unpriced attempt is still unpriced.
  expect(decide(20, { cumulative: 1, costUnknown: true })).toBe("unaccounted");
});

test("strict cost: a live guard kill still reports an exceeded budget", () => {
  expect(decide(5, { cumulative: 1, exceeded: true })).toBe("exceeded");
});

test("strict cost: a fully priced run under its cap continues", () => {
  expect(decide(5, { cumulative: 1 })).toBe("continue");
});

test("strict cost: an unknown attempt over the cap reports the reached ceiling", () => {
  // Precedence, settled in Lot 2: a reached ceiling outranks uncertainty. The
  // known lower bound is the harder fact, and it is the one an operator can act
  // on with `--budget`.
  expect(decide(5, { cumulative: 6, costUnknown: true })).toBe("exceeded");
});
