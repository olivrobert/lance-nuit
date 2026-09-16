import { afterEach, expect, test } from "bun:test";
import type { Run } from "../model/run.js";
import { makeRunStep } from "../state/run-step.js";
import { setColorEnabled, visibleLength } from "./color.js";
import {
  ConsoleRunReporter,
  fmtContextShare,
  formatDuration,
  logStepFailed,
  renderConsoleReport,
} from "./console-reporter.js";
import { buildRunReport } from "./run-report.js";

const outcome = { failed: true, stopped: false, budgetExceeded: false, cumulativeCost: 12.34 };

// Color is process-global: a test that turns it on must not leak into the next.
afterEach(() => setColorEnabled(false));

function sampleRun(): Run {
  const steps = [
    makeRunStep(
      { id: "preflight", name: "Preflight", command: "true", runner: "bash" },
      {
        status: "done",
        control: { duration_ms: 2_000 },
      },
    ),
    makeRunStep(
      { id: "unused", name: "Optional step", command: "true", runner: "bash" },
      {
        status: "skipped",
      },
    ),
    makeRunStep(
      { id: "audit", name: "Reuse Audit", command: "true", runner: "agent", backend: { id: "claude" } },
      {
        status: "failed",
        errors: "A detailed reuse-contract violation requires intervention.",
        fail_kind: "verdict",
        retries: 1,
        control: { duration_ms: 125_000, total_cost_usd: 2.5 },
        usage: { output_tokens: 1_044 },
      },
    ),
    makeRunStep({ id: "tests", name: "Tests", command: "true", runner: "bash" }),
  ];
  return {
    name: "default",
    pipeline: "default",
    ticket: "PROJ-311",
    pipeline_path: "pipeline.ts",
    run_dir: "/project/.lance-nuit/runs/run-1",
    status: "FAIL",
    outcome: {
      phase: "audit",
      reason: steps[2].errors!,
      logPath: "steps/audit/attempt-001/output.log",
      resumable: true,
      failKind: "verdict",
    },
    steps,
  };
}

test("durations remain readable beyond one minute and one hour", () => {
  expect(formatDuration(59_000)).toBe("59s");
  expect(formatDuration(125_000)).toBe("2m05s");
  expect(formatDuration(10_529_000)).toBe("2h55m");
});

test("summary puts result and action before details and folds pending", () => {
  const text = renderConsoleReport(buildRunReport(sampleRun(), outcome), { cwd: "/project" });

  expect(text).toContain("╭─ ! ACTION REQUIRED · default · PROJ-311");
  expect(text).toContain("Quality check failed: Reuse Audit");
  expect(text).toContain("1 skipped · 1 failed · 1 not run");
  expect(text).toContain("✗ Reuse Audit  2m05s · $2.50 · 1,044 tok · 1 retry");
  expect(text).toContain("└─ 1 step skipped · 1 step not run");
  expect(text).not.toContain("  · Tests");
  expect(text.indexOf("ACTION REQUIRED")).toBeLessThan(text.indexOf("Executed steps"));
  expect(text.indexOf("Verdict")).toBeLessThan(text.indexOf("Files"));
});

test("context share needs both an occupancy and a window", () => {
  expect(fmtContextShare({ duration_ms: 0, last_turn_context_tokens: 84_000, context_window: 200_000 })).toBe(
    "ctx 42%",
  );
  expect(fmtContextShare({ duration_ms: 0, last_turn_context_tokens: 84_000 })).toBeUndefined();
  expect(fmtContextShare({ duration_ms: 0, context_window: 200_000 })).toBeUndefined();
  expect(fmtContextShare(undefined)).toBeUndefined();
});

test("context share is reported per step, never on the run total", () => {
  const run = sampleRun();
  run.steps[2].control = {
    duration_ms: 125_000,
    total_cost_usd: 2.5,
    last_turn_context_tokens: 84_000,
    context_window: 200_000,
  };
  const text = renderConsoleReport(buildRunReport(run, outcome), { cwd: "/project" });

  expect(text).toContain("✗ Reuse Audit  2m05s · $2.50 · 1,044 tok · ctx 42% · 1 retry");
  // The header block aggregates every step; an occupancy there would describe a
  // context that never existed, since each step opens its own session.
  const header = text.slice(0, text.indexOf("Executed steps"));
  expect(header).not.toContain("ctx ");
});

test("color adds styling without changing a single character of the report", () => {
  const plain = renderConsoleReport(buildRunReport(sampleRun(), outcome), { cwd: "/project" });
  setColorEnabled(true);
  const colored = renderConsoleReport(buildRunReport(sampleRun(), outcome), { cwd: "/project" });

  expect(colored).not.toBe(plain);
  expect(colored).toContain("\x1b[");
  // Stripping the escapes must give back exactly the uncolored report.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI escapes on purpose
  expect(colored.replace(/\x1b\[[0-9;]*m/g, "")).toBe(plain);
});

test("file paths stay aligned once labels are tinted", () => {
  setColorEnabled(true);
  const lines = renderConsoleReport(
    buildRunReport(sampleRun(), outcome, { statsPath: "/project/.lance-nuit/pipeline-history/runs.jsonl" }),
    { cwd: "/project" },
  ).split("\n");
  const files = lines
    .slice(lines.findIndex((line) => line.includes("Files")) + 1)
    .filter((line) => line.includes("./"));

  expect(files.length).toBeGreaterThan(1);
  const columns = files.map((line) => visibleLength(line.slice(0, line.indexOf("./"))));
  expect(new Set(columns).size).toBe(1);
});

test("a technical failure reads red and a verdict reads yellow", () => {
  setColorEnabled(true);
  const verdict = renderConsoleReport(buildRunReport(sampleRun(), outcome), { cwd: "/project" });
  expect(verdict).toContain("\x1b[33m! ACTION REQUIRED\x1b[0m");

  const broken = sampleRun();
  broken.steps[2].fail_kind = "technical";
  broken.outcome!.failKind = "technical";
  expect(renderConsoleReport(buildRunReport(broken, outcome), { cwd: "/project" })).toContain(
    "\x1b[31m✗ FAILURE\x1b[0m",
  );
});

test("a blocked step reads Blocked, not Error, whatever its kind", () => {
  const written: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((text: string) => {
    written.push(String(text));
    return true;
  }) as typeof process.stderr.write;
  try {
    const step = makeRunStep(
      { id: "deploy", name: "Deploy", command: "true", runner: "agent", backend: { id: "claude" } },
      { status: "failed", fail_kind: "technical", fail_cause: "blocked" },
    );
    logStepFailed(step);
    // The reachable shape: a step whose retry budget was spent on a rerun that
    // came back blocked. Its kind is technical, but "Error" would send an operator
    // to the logs of a step that ran fine.
    expect(written.join("")).toContain("✗ Blocked");

    written.length = 0;
    delete step.fail_cause;
    logStepFailed(step);
    expect(written.join("")).toContain("✗ Error");
  } finally {
    process.stderr.write = original;
  }
});

test("reporter writes to an injected destination", () => {
  const writes: string[] = [];
  new ConsoleRunReporter({ write: (text) => writes.push(text) }, "/project").report(
    buildRunReport(sampleRun(), outcome, { statsPath: "/project/.lance-nuit/pipeline-history/runs.jsonl" }),
  );

  expect(writes).toHaveLength(1);
  expect(writes[0]).toContain("stats   ./.lance-nuit/pipeline-history/runs.jsonl");
});

test("an unpriced attempt turns the budget line into a warning", () => {
  const run = sampleRun();
  run.max_cost_usd = 20;
  run.steps[0].control = { duration_ms: 1_000, cost_unknown: true };
  const report = buildRunReport(run, { ...outcome, cumulativeCost: 12.34 });

  expect(report.budget).toMatchObject({ spent: 12.34, limit: 20, costUnknown: true });
  expect(renderConsoleReport(report)).toContain("spend is under-counted");
});

/** A run killed by a signal: the step it was on ends `aborted`, no step is
 *  `failed`, and `run.outcome.phase` is what points the report at it. */
function abortedRun(): Run {
  const run = sampleRun();
  run.status = "FAIL";
  run.aborted = true;
  run.steps[2].status = "aborted";
  run.steps[2].fail_kind = undefined;
  run.steps[2].session = { provider: "claude", id: "af14fefd-3354-439e-a6aa-d641d350cd73", resumable: true };
  run.outcome = {
    phase: "audit",
    reason: "SIGTERM: run interrupted manually",
    logPath: null,
    resumable: true,
  };
  return run;
}

test("an interrupted run says its resume command is for reading, not for the rerun", () => {
  const report = buildRunReport(abortedRun(), { ...outcome, failed: false, stopped: true });

  // The distinction lives in the model, so an HTML reporter inherits it.
  expect(report.kind).toBe("aborted");
  expect(report.resumptions).toHaveLength(1);
  expect(report.resumptions[0]).toMatchObject({
    provider: "claude",
    sessionId: "af14fefd-3354-439e-a6aa-d641d350cd73",
    nature: "inspect",
  });

  const text = renderConsoleReport(report, { cwd: "/project" });
  expect(text).toContain("↻ claude --resume af14fefd-3354-439e-a6aa-d641d350cd73");
  expect(text).toContain("to read this conversation by hand · a rerun starts a fresh session");
});

test("a failed run keeps its bare resume command", () => {
  const run = sampleRun();
  run.steps[2].session = { provider: "claude", id: "af14fefd-3354-439e-a6aa-d641d350cd73", resumable: true };
  const report = buildRunReport(run, outcome);

  expect(report.resumptions[0]).toMatchObject({ nature: "resume" });

  const text = renderConsoleReport(report, { cwd: "/project" });
  expect(text).toContain("↻ claude --resume af14fefd-3354-439e-a6aa-d641d350cd73");
  expect(text).not.toContain("fresh session");
  expect(text).not.toContain("by hand");
});
