import { afterEach, expect, test } from "bun:test";
import { clearLiveAttemptCost, liveAttemptCost, liveAttemptModel, reportLiveAttemptCost } from "./live-cost.js";

afterEach(clearLiveAttemptCost);

test("a tick without a model keeps the model an earlier tick reported", () => {
  reportLiveAttemptCost(0.1, "claude-opus-5-5");
  reportLiveAttemptCost(0.2);
  expect(liveAttemptCost()).toBe(0.2);
  expect(liveAttemptModel()).toBe("claude-opus-5-5");
});

test("clearing forgets the model with the estimate", () => {
  reportLiveAttemptCost(0.1, "claude-opus-5-5");
  clearLiveAttemptCost();
  expect(liveAttemptCost()).toBeUndefined();
  expect(liveAttemptModel()).toBeUndefined();
});
