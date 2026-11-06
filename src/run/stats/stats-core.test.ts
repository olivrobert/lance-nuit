import { expect, test } from "bun:test";
import * as core from "./stats-core.js";

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
