import { expect, test } from "bun:test";
import { source, textArtifact } from "./dsl/artifact.js";
import { readmittedOnResume } from "./definition.js";

const tree = source("tree", { command: "git diff" });
const report = textArtifact("report.md");

test("a resume re-admits a step declaring input, output or rerunOnResume", () => {
  expect(readmittedOnResume({ runner: "bash", sources: [tree] })).toBe(true);
  expect(readmittedOnResume({ runner: "bash", outputs: [report] })).toBe(true);
  expect(readmittedOnResume({ runner: "bash", rerun_on_resume: true })).toBe(true);
  expect(readmittedOnResume({ runner: "bash" })).toBe(false);
});

test("an orchestration node keeps the authority of its status whatever it declares", () => {
  expect(readmittedOnResume({ runner: "pipeline", sources: [tree] })).toBe(false);
  expect(readmittedOnResume({ runner: "pipeline", outputs: [report] })).toBe(false);
  expect(readmittedOnResume({ runner: "pipeline", rerun_on_resume: true })).toBe(false);
  expect(readmittedOnResume({ runner: "pipeline", sources: [tree], outputs: [report], rerun_on_resume: true })).toBe(
    false,
  );
});
