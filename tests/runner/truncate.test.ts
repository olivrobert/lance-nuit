import { expect, test } from "bun:test";
import { MAX_ERROR_CHARS, MAX_STEP_OUTPUT_CHARS, truncate, truncateMiddle } from "../../src/lib/truncate.js";

test("truncate: short text unchanged", () => {
  expect(truncate("court")).toBe("court");
});

test("truncate: cuts the head and reports removed characters", () => {
  const t = truncate("a".repeat(MAX_ERROR_CHARS + 10));
  expect(t.startsWith("a".repeat(MAX_ERROR_CHARS))).toBe(true);
  expect(t).toContain("10 characters removed");
});

test("truncateMiddle: text under the limit unchanged", () => {
  const text = "x".repeat(MAX_STEP_OUTPUT_CHARS);
  expect(truncateMiddle(text)).toBe(text);
});

test("truncateMiddle: preserves both beginning AND end", () => {
  const text = `DEBUT${"x".repeat(200)}FIN`;
  const t = truncateMiddle(text, 100);
  expect(t.startsWith("DEBUT")).toBe(true);
  expect(t.endsWith("FIN")).toBe(true);
  expect(t).toContain("characters removed from the middle");
});
