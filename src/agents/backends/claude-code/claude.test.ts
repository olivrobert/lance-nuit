import { expect, test } from "bun:test";
import { claudeBackendFactory } from "./backend.js";
import type { ClaudeOptions } from "./types.js";

const backend = claudeBackendFactory.create();
const base: ClaudeOptions = { model: "sonnet", tools: ["Read", "Edit"] };
const ladder = { model: "opus", effort: "high" };

test("applyEscalation: the effort rung does not touch the model, and vice versa", () => {
  expect(backend.applyEscalation!(base, { rung: "effort", ...ladder })).toEqual({ ...base, effort: "high" });
  // Model rung: no effort bump (it is also reached on timeout).
  expect(backend.applyEscalation!({ ...base, effort: "medium" }, { rung: "model", ...ladder })).toEqual({
    ...base,
    effort: "medium",
    model: "opus",
  });
  expect(backend.applyEscalation!(base, { rung: "none", ...ladder })).toEqual(base);
});

test("applyEscalation: a ladder rung without a value leaves options unchanged", () => {
  expect(backend.applyEscalation!(base, { rung: "model" })).toEqual(base);
  expect(backend.applyEscalation!(base, { rung: "effort" })).toEqual(base);
  expect(backend.applyEscalation!(undefined, { rung: "model", model: "opus" })).toEqual({ model: "opus" });
});

test("applyEscalation does not mutate the original options", () => {
  const options: ClaudeOptions = { model: "sonnet" };
  backend.applyEscalation!(options, { rung: "model", model: "opus" });
  expect(options.model).toBe("sonnet");
});

test("applyConfigAxes: writes only supplied axes without touching the rest", () => {
  expect(backend.applyConfigAxes!(base, { effort: "max" })).toEqual({ ...base, effort: "max" });
  expect(backend.applyConfigAxes!(base, {})).toEqual(base);
});

test("capabilities: session resume and both configuration axes are advertised", () => {
  expect(backend.capabilities.resume).toBe(true);
  expect(backend.capabilities.configurationAxes).toEqual(["model", "effort"]);
});
