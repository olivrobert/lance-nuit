import { expect, test } from "bun:test";
import { source, textArtifact } from "./dsl/artifact.js";
import { isStamped, readmittedOnResume } from "./definition.js";

const tree = source("tree", { command: "git diff" });
const report = textArtifact("report.md");

test("a resume re-admits a step declaring input, output or rerunOnResume", () => {
  expect(readmittedOnResume({ id: "s", runner: "bash", sources: [tree] }, undefined)).toBe(true);
  expect(readmittedOnResume({ id: "s", runner: "bash", outputs: [report] }, undefined)).toBe(true);
  expect(readmittedOnResume({ id: "s", runner: "bash", rerun_on_resume: true }, undefined)).toBe(true);
  expect(readmittedOnResume({ id: "s", runner: "bash" }, undefined)).toBe(false);
});

test("an orchestration node keeps the authority of its status whatever it declares", () => {
  expect(readmittedOnResume({ id: "n", runner: "pipeline", sources: [tree] }, undefined)).toBe(false);
  expect(readmittedOnResume({ id: "n", runner: "pipeline", outputs: [report] }, undefined)).toBe(false);
  expect(readmittedOnResume({ id: "n", runner: "pipeline", rerun_on_resume: true }, undefined)).toBe(false);
  expect(
    readmittedOnResume(
      { id: "n", runner: "pipeline", sources: [tree], outputs: [report], rerun_on_resume: true },
      undefined,
    ),
  ).toBe(false);
});

test("the work-item source step is never stamped nor re-admitted, even with an output (D3)", () => {
  const sourceStep = { id: "ticket", runner: "fn" as const, sources: [tree], outputs: [report] };

  expect(isStamped(sourceStep, "ticket")).toBe(false);
  expect(readmittedOnResume(sourceStep, "ticket")).toBe(false);
  expect(isStamped(sourceStep, "other")).toBe(true);
  expect(readmittedOnResume(sourceStep, "other")).toBe(true);
});
