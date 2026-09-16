// Real snapshots must stay readable: the schema in `state/schema.ts` is the
// single validator, and these fixtures are the contract it must not narrow.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunStatus } from "../model/persisted.js";
import { buildPipelineContext } from "../pipeline/context.js";
import { loadOrCreateRun } from "../boot/resume.js";
import { pendingSteps, resumeDecision } from "./run-predicates.js";
import { diagnoseRunSnapshot, isRunSnapshot, readRunSnapshot } from "./run-snapshot.js";
import { resolveRunDir } from "./stores/run-storage.js";
import { commandRegistries } from "../commands/registries.js";

const FIXTURES = fileURLToPath(new URL("../../tests/fixtures/state/", import.meta.url));

function fixture(name: string): string {
  return `${FIXTURES}${name}.json`;
}

const CASES: { name: string; status: RunStatus; steps: number }[] = [
  { name: "feature-pass-orchestration", status: "PASS", steps: 36 },
  { name: "bugfix-fail-attempts", status: "FAIL", steps: 29 },
  { name: "lot-pass-child", status: "PASS", steps: 13 },
  { name: "quality-github", status: "PASS", steps: 3 },
];

for (const { name, status, steps } of CASES) {
  test(`run snapshot fixtures: ${name} is readable`, () => {
    const snapshot = readRunSnapshot(fixture(name));
    expect(snapshot).not.toBeNull();
    expect(snapshot!.status).toBe(status);
    expect(snapshot!.steps).toHaveLength(steps);
  });
}

test("run snapshot fixtures: unknown keys survive the read (forward compatibility)", () => {
  const raw = JSON.parse(readFileSync(fixture("quality-github"), "utf-8"));
  raw.future_field = { nested: true };
  raw.steps[0].future_step_field = 1;
  expect(isRunSnapshot(raw)).toBe(true);
});

/** The fixture with `retries` removed from every step: the field is optional on
 * disk and normalized to 0 on read. */
function withoutRetries(name: string): Record<string, unknown> & { steps: Record<string, unknown>[] } {
  const raw = JSON.parse(readFileSync(fixture(name), "utf-8"));
  for (const step of raw.steps) delete step.retries;
  return raw;
}

function writeSnapshot(dir: string, raw: unknown): string {
  const path = join(dir, "state.json");
  writeFileSync(path, JSON.stringify(raw));
  return path;
}

test("run snapshot fixtures: a step without retries is normalized and resumable", () => {
  const raw = withoutRetries("bugfix-fail-attempts");
  const snapshot = readRunSnapshot(writeSnapshot(mkdtempSync(join(tmpdir(), "run-snapshot-early-")), raw));
  expect(snapshot).not.toBeNull();
  expect(snapshot!.steps.every((step) => step.retries === 0)).toBe(true);
  // Readers rely on the persisted status only; the run stays a FAIL to resume.
  expect(resumeDecision(snapshot!).resume).toBe(true);
  expect(pendingSteps(snapshot!)).toHaveLength(3);
});

test("run snapshot fixtures: a real resume through loadOrCreateRun reads a snapshot without retries", async () => {
  const raw = withoutRetries("quality-github");
  const root = mkdtempSync(join(tmpdir(), "run-snapshot-resume-"));
  const pipelinePath = join(root, "quality.ts");
  writeFileSync(
    pipelinePath,
    `export default ({ pipeline, actionStep }) => pipeline("quality")
  .add(actionStep({ id: "phpcsfix", name: "phpcsfix", run: () => {}, describe: "a" }))
  .add(actionStep({ id: "phpstan", name: "phpstan", run: () => {}, describe: "b" }))
  .add(actionStep({ id: "tests", name: "tests", run: () => {}, describe: "c" }))
  .build();`,
  );
  const ctx = buildPipelineContext({ ...commandRegistries(), cwd: root, ticket: "QUALITY" });
  const dir = resolveRunDir("quality", "QUALITY", undefined, true, ctx);
  writeSnapshot(dir, raw);

  const run = await loadOrCreateRun(pipelinePath, "QUALITY", undefined, undefined, dir, false, undefined, ctx);
  // Resumed, not recreated: identity and step state come from the fixture.
  expect(run.runId).toBe(raw.runId as string);
  expect(run.status).toBe("PASS");
  expect(run.steps.map((step) => step.id)).toEqual(["phpcsfix", "phpstan", "tests"]);
  expect(run.steps.every((step) => step.status === "done" && step.retries === 0)).toBe(true);
});

test("run snapshot fixtures: readRunSnapshot normalizes a missing retries to 0", () => {
  const raw = JSON.parse(readFileSync(fixture("quality-github"), "utf-8"));
  delete raw.steps[0].retries;
  const dir = mkdtempSync(join(tmpdir(), "run-snapshot-normalize-"));
  const path = join(dir, "state.json");
  writeFileSync(path, JSON.stringify(raw));
  expect(readRunSnapshot(path)!.steps[0]!.retries).toBe(0);
});

test("run snapshot fixtures: diagnoseRunSnapshot names the offending field", () => {
  const raw = JSON.parse(readFileSync(fixture("quality-github"), "utf-8"));
  raw.steps[1].status = "pendng";
  expect(diagnoseRunSnapshot(raw)).toMatch(/steps\[1\]\.status/);
  expect(diagnoseRunSnapshot(JSON.parse(readFileSync(fixture("quality-github"), "utf-8")))).toBeUndefined();
});
