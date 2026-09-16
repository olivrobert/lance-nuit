import { expect, test } from "bun:test";
import * as core from "./stats-core.js";

const PRICING = {
  _currency: "$",
  "claude-opus-4-8": { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-4-6": { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 },
};

test("zeroTokens/addTokens: validates the contract", () => {
  const acc = core.zeroTokens();
  core.addTokens(acc, { in: 10, out: 20, cacheRead: 30, cacheWrite: 40 });
  core.addTokens(acc, { in: 1, out: 2 });
  expect(acc).toEqual({ in: 11, out: 22, cacheRead: 30, cacheWrite: 40 });
});

test("fmtInt: validates the contract", () => {
  expect(core.fmtInt(999)).toBe("999");
  expect(core.fmtInt(57000)).toBe("57.0k");
});

test("statusBadge: validates the contract", () => {
  expect(core.statusBadge("PASS")).toBe("✅ PASS");
  expect(core.statusBadge("FAIL")).toBe("❌ FAIL");
  expect(core.statusBadge("STOPPED")).toBe("⏹ STOPPED");
  expect(core.statusBadge(undefined)).toBe("⚪ ?");
});

test("currencyOf: validates the contract", () => {
  expect(core.currencyOf(null)).toBe("$");
  expect(core.currencyOf({})).toBe("$");
  expect(core.currencyOf({ _currency: "€" })).toBe("€");
});

test("costOf: validates the contract", () => {
  const models = { "claude-opus-4-8": { in: 1000, out: 2000, cacheRead: 10000, cacheWrite: 4000 } };
  expect(core.costOf(models, null)).toBeNull();
  const expected = (1000 * 5 + 2000 * 25 + 10000 * 0.5 + 4000 * 6.25) / 1e6;
  expect(core.costOf(models, PRICING)).toBeCloseTo(expected, 10);
  // A model the table does not cover makes the run unpriceable, not free: $0.00
  // would be read as a measured cost.
  expect(core.costOf({ "gpt-4": { in: 1e6, out: 1e6, cacheRead: 0, cacheWrite: 0 } }, PRICING)).toBeNull();
  // An unlisted model that spent nothing costs nothing; it hides no spend.
  expect(core.costOf({ "gpt-4": { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 } }, PRICING)).toBe(0);
  // Fragment matching, like the runner: a dated or vendor-prefixed id resolves to
  // the shortest listed name it contains.
  expect(
    core.costOf({ "anthropic/claude-opus-4-8-20260115": { in: 1e6, out: 0, cacheRead: 0, cacheWrite: 0 } }, PRICING),
  ).toBe(5);
});

test("entryCost: validates the contract", () => {
  const entry = {
    costUsd: 1.23,
    models: { "claude-opus-4-8": { in: 1e6, out: 0, cacheRead: 0, cacheWrite: 0 } }, // = $5 via pricing
  };
  expect(core.entryCost(entry, PRICING)).toBe(1.23);
});

test("entryCost: validates the contract", () => {
  const models = { "claude-sonnet-4-6": { in: 0, out: 1e6, cacheRead: 0, cacheWrite: 0 } };
  expect(core.entryCost({ models }, PRICING)).toBeCloseTo(15, 10);
  expect(core.entryCost({ models }, null)).toBeNull();
  expect(core.entryCost({}, null)).toBeNull();
});

test("usablePricing: validates the contract", () => {
  expect(core.usablePricing(PRICING)).toBe(PRICING);
  expect(core.usablePricing(null)).toBeNull();
  // A euro table cannot price a run whose cost the runner reports in dollars.
  expect(core.usablePricing({ _currency: "€", "claude-opus-4-8": { in: 5 } })).toBeNull();
});

test("costOf: rejects a non-USD table and unusable rates", () => {
  const models = { "claude-opus-4-8": { in: 1e6, out: 0, cacheRead: 0, cacheWrite: 0 } };
  expect(core.costOf(models, { ...PRICING, _currency: "€" })).toBeNull();
  // A negative or non-finite rate makes the run unpriceable, exactly as the runner
  // treats it; a coerced 0 would report the run as free.
  expect(core.costOf(models, { _currency: "$", "claude-opus-4-8": { in: -5 } })).toBeNull();
  expect(core.costOf(models, { _currency: "$", "claude-opus-4-8": { in: Number.NaN } })).toBeNull();
  expect(core.costOf(models, { _currency: "$", "claude-opus-4-8": {} })).toBeNull();
});

test("renderRunMarkdown: never labels a dollar amount with another currency", () => {
  const entry = {
    runId: "2026-07-12T10-00-00",
    pipeline: "feature",
    status: "PASS",
    costUsd: 2.5,
    totals: { in: 1, out: 1, cacheRead: 0, cacheWrite: 0 },
    profiles: { coder: { steps: 1, costUsd: 2.5, tokens: { in: 1, out: 1, cacheRead: 0, cacheWrite: 0 } } },
    models: { "claude-opus-4-8": { in: 1, out: 1, cacheRead: 0, cacheWrite: 0 } },
  };
  const md = core.renderRunMarkdown(entry, { ...PRICING, _currency: "€" });
  expect(md).toContain("- **Cost**: ≈ $2.50");
  expect(md).not.toContain("€");
});

test("unescapeHtml: validates the contract", () => {
  expect(core.unescapeHtml("a &gt; b &amp;&amp; c &lt; d")).toBe("a > b && c < d");
});

test("renderRunMarkdown: validates the contract", () => {
  const entry = {
    runId: "test0001",
    pipeline: "us-review",
    ticket: "AAA-1",
    status: "PASS",
    startedAt: "2026-07-01T10:00:00Z",
    endedAt: "2026-07-01T10:42:00Z",
    sessionId: "sess-1",
    commit: "abcdef1234567",
    totals: { in: 1600, out: 57000, cacheRead: 1200000, cacheWrite: 140000 },
    phases: {
      implement: { agents: 1, fixLoops: 0, tokens: { in: 1200, out: 45000, cacheRead: 900000, cacheWrite: 120000 } },
    },
    models: { "claude-opus-4-8": { in: 1600, out: 57000, cacheRead: 1200000, cacheWrite: 140000 } },
    fixEvents: [
      { kind: "fail", phase: "reviews", iter: 1, contract: "code-audit", details: "issue &gt; grave\nsuite" },
    ],
  };
  const md = core.renderRunMarkdown(entry, PRICING);
  expect(md).toContain("# Run AAA-1 — ✅ PASS");
  expect(md).toContain("- **Pipeline**: us-review");
  expect(md).toContain("- **Duration**: 42min");
  expect(md).toContain("- **Commit**: `abcdef1`");
  expect(md).toContain("- **Run id**: `test0001`");
  expect(md).toContain("## Tokens");
  expect(md).toContain("| **Total** | 1.6k | 57.0k | 1200.0k | 140.0k |");
  expect(md).toContain("## Phases");
  expect(md).toContain("| implement | 1 | 0 | 1.2k | 45.0k | 900.0k | 120.0k |");
  expect(md).toContain("## Models");
  expect(md).toContain("## Fix-loops");
  expect(md).toContain("🔴 **reviews** iter 1 · `code-audit` — issue > grave");
  expect(md).toContain("- **Cost**: ≈ $");
});

test("renderRunMarkdown: validates the contract", () => {
  const entry = {
    runId: "2026-07-11T10-00-00",
    pipeline: "bugfix",
    ticket: "AAA-3",
    status: "FAIL",
    failPhase: "checks",
    costUsd: 2.5,
    totals: { in: 100, out: 5000, cacheRead: 50000, cacheWrite: 1000 },
    phases: { checks: { agents: 1, fixLoops: 2, tokens: { in: 100, out: 5000, cacheRead: 50000, cacheWrite: 1000 } } },
    models: {},
    fixEvents: [],
  };
  const md = core.renderRunMarkdown(entry, null); // Even without pricing.json.
  expect(md).toContain("- **Cost**: ≈ $2.50");
  expect(md).toContain("- **Failure phase**: checks");
  expect(md).not.toContain("## Models");
});
