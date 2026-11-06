import { afterEach, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readStats } from "./stats.ts";
import {
  cleanupTempDirs,
  makeProject,
  makeTempDir,
  workItemDir,
  writeArtifact,
  writeHistory,
  writeProjectsFile,
  writeRun,
} from "./test-harness.ts";

const originalHome = process.env.PIPELINE_HOME;

afterEach(() => {
  if (originalHome === undefined) delete process.env.PIPELINE_HOME;
  else process.env.PIPELINE_HOME = originalHome;
  cleanupTempDirs();
});

function kit(): string {
  const dir = makeTempDir("read-model-home-");
  process.env.PIPELINE_HOME = dir;
  return dir;
}

function listedProject(home: string, name = "demo-app"): string {
  const project = makeProject(name, { baseUrl: "https://tracker.example/browse" });
  writeProjectsFile(home, [project]);
  return project;
}

function writeUiFile(home: string, name: string, value: unknown): void {
  mkdirSync(join(home, "ui"), { recursive: true });
  writeFileSync(join(home, "ui", name), typeof value === "string" ? value : JSON.stringify(value));
}

const control = (usd: number, ms: number) => ({ duration_ms: ms, total_cost_usd: usd });

test("stats: a ticket sums its root runs across pipelines, each run read once despite `latest`", () => {
  const home = kit();
  const project = listedProject(home);
  writeRun(project, "DEMO-1", "triage", {
    runId: "t-1",
    status: "PASS",
    createdAt: "2026-09-01T08:00:00.000Z",
    updatedAt: "2026-09-01T08:10:00.000Z",
    total_control: control(1, 60_000),
  });
  writeRun(project, "DEMO-1", "bugfix", {
    runId: "b-1",
    status: "FAIL",
    createdAt: "2026-09-02T08:00:00.000Z",
    updatedAt: "2026-09-02T09:00:00.000Z",
    total_control: control(2.5, 120_000),
  });
  // `latest` now points at b-2: b-1 is still counted, b-2 only once.
  writeRun(project, "DEMO-1", "bugfix", {
    runId: "b-2",
    status: "PASS",
    createdAt: "2026-09-03T08:00:00.000Z",
    updatedAt: "2026-09-04T08:00:00.000Z",
    total_control: control(4, 300_000),
  });

  const [ticket] = readStats().tickets;

  expect(ticket).toMatchObject({
    key: "demo-app/DEMO-1",
    project: "demo-app",
    ticket: "DEMO-1",
    ticketUrl: "https://tracker.example/browse/DEMO-1",
    source: "live",
    cost: { usd: 7.5, estimated: false },
    activeMs: 480_000,
    firstAt: "2026-09-01T08:00:00.000Z",
    lastAt: "2026-09-04T08:00:00.000Z",
    outcome: "PASS",
    pipelines: ["triage", "bugfix"],
  });
  expect(ticket?.runs.map((run) => run.runId)).toEqual(["b-2", "b-1", "t-1"]);
});

test("stats: a child run is already inside its parent's total and is not summed again", () => {
  const home = kit();
  const project = listedProject(home);
  writeRun(project, "DEMO-2", "feature", { runId: "p-1", total_control: control(30, 1000) });
  writeRun(project, "DEMO-2", "lot", { runId: "c-1", parentRunId: "p-1", total_control: control(23, 800) });

  const [ticket] = readStats().tickets;

  expect(ticket?.cost.usd).toBe(30);
  expect(ticket?.runs.map((run) => run.runId)).toEqual(["p-1"]);
});

test("stats: an estimated or unpriced run marks the ticket's total", () => {
  const home = kit();
  const project = listedProject(home);
  writeRun(project, "DEMO-3", "feature", {
    runId: "r-1",
    total_control: { duration_ms: 1, total_cost_usd: 2, cost_estimated: true },
  });
  writeRun(project, "DEMO-3", "review", { runId: "r-2", cost_unaccounted: true, total_control: control(1, 1) });

  const [ticket] = readStats().tickets;

  expect(ticket?.cost).toEqual({ usd: 3, estimated: true, unknown: true });
});

test("stats: a run kept in a folder renamed aside belongs to the ticket it recorded", () => {
  const home = kit();
  const project = listedProject(home);
  writeRun(project, "DEMO-4", "feature", { runId: "r-2", ticket: "DEMO-4", total_control: control(1, 1) });
  writeRun(project, "DEMO-4.archive-bugfix-20260831", "bugfix", {
    runId: "r-1",
    ticket: "DEMO-4",
    total_control: control(2, 1),
  });

  const { tickets } = readStats();

  expect(tickets.map((ticket) => ticket.key)).toEqual(["demo-app/DEMO-4"]);
  expect(tickets[0]?.cost.usd).toBe(3);
});

test("stats: without rules every ticket is `other`", () => {
  const home = kit();
  const project = listedProject(home);
  writeRun(project, "DEMO-5", "bugfix", { runId: "r-1" });

  expect(readStats().tickets[0]?.kind).toBe("other");
});

test("stats: an artifact rule wins over the pipeline map, which wins over `other`", () => {
  const home = kit();
  const project = listedProject(home);
  writeUiFile(home, "stats.json", {
    kinds: {
      pipelines: { bugfix: "bug", feature: "feature", triage: "other" },
      artifacts: [
        { file: "ticket-kind.txt" },
        { file: "triage.json", field: "kind" },
        { file: "bug.json", kind: "bug" },
        { file: "../escape.txt" },
      ],
    },
  });
  writeRun(project, "DEMO-6", "feature", { runId: "a" });
  writeArtifact(project, "DEMO-6", "ticket-kind.txt", "bug\n");
  writeRun(project, "DEMO-7", "feature", { runId: "b" });
  writeArtifact(project, "DEMO-7", "ticket-kind.txt", "auto\n");
  writeArtifact(project, "DEMO-7", "triage.json", JSON.stringify({ kind: "bug" }));
  writeRun(project, "DEMO-8", "feature", { runId: "c" });
  writeArtifact(project, "DEMO-8", "bug.json", "{}");
  writeRun(project, "DEMO-9", "triage", { runId: "d", updatedAt: "2026-09-02T00:00:00.000Z" });
  writeRun(project, "DEMO-9", "feature", { runId: "e", updatedAt: "2026-09-01T00:00:00.000Z" });
  writeRun(project, "DEMO-10", "triage", { runId: "f" });

  const kinds = Object.fromEntries(readStats().tickets.map((ticket) => [ticket.ticket, ticket.kind]));

  expect(kinds).toEqual({
    "DEMO-6": "bug",
    "DEMO-7": "bug",
    "DEMO-8": "bug",
    "DEMO-9": "feature",
    "DEMO-10": "other",
  });
});

test("stats: the outcome is the most recent delivery run, a later triage does not change it", () => {
  const home = kit();
  const project = listedProject(home);
  writeUiFile(home, "stats.json", { delivery: { pipelines: ["feature", "default"] } });
  writeRun(project, "DEMO-20", "feature", { runId: "f", status: "PASS", updatedAt: "2026-09-01T00:00:00.000Z" });
  writeRun(project, "DEMO-20", "default", { runId: "d", status: "FAIL", updatedAt: "2026-09-02T00:00:00.000Z" });
  writeRun(project, "DEMO-20", "triage-seul", { runId: "t", status: "PASS", updatedAt: "2026-09-03T00:00:00.000Z" });
  writeRun(project, "DEMO-21", "triage-seul", {
    runId: "t2",
    status: "PASS",
    total_control: control(0.4, 1),
  });

  const byTicket = new Map(readStats().tickets.map((ticket) => [ticket.ticket, ticket]));

  const delivered = byTicket.get("DEMO-20");
  expect(delivered?.outcome).toBe("FAIL");
  expect(delivered?.runs.map((run) => [run.runId, run.delivery === true])).toEqual([
    ["t", false],
    ["d", true],
    ["f", true],
  ]);
  const triaged = byTicket.get("DEMO-21");
  expect(triaged?.outcome).toBeUndefined();
  expect(triaged?.cost.usd).toBe(0.4);
});

test("stats: without a delivery rule every run delivers, so the latest one is the outcome", () => {
  const home = kit();
  const project = listedProject(home);
  writeUiFile(home, "stats.json", { delivery: { pipelines: [] } });
  writeRun(project, "DEMO-22", "feature", { runId: "f", status: "FAIL", updatedAt: "2026-09-01T00:00:00.000Z" });
  writeRun(project, "DEMO-22", "triage-seul", { runId: "t", status: "PASS", updatedAt: "2026-09-02T00:00:00.000Z" });

  expect(readStats().tickets[0]?.outcome).toBe("PASS");
});

const step = (id: string, status: "done" | "skipped" | "failed") => ({ id, status, retries: 0 });

test("stats: with shipping steps, a ticket passes once a run reached its handover and a bare pass is unshipped", () => {
  const home = kit();
  const project = listedProject(home);
  writeUiFile(home, "stats.json", {
    delivery: { pipelines: ["feature", "bugfix"], steps: ["create-mr", "push-mr"] },
  });
  // Shipped, then a later rerun failed: the merge request still exists.
  writeRun(project, "DEMO-30", "feature", {
    runId: "s",
    status: "PASS",
    updatedAt: "2026-09-01T00:00:00.000Z",
    steps: [step("implement", "done"), step("delivery.create-mr", "done")],
  });
  writeRun(project, "DEMO-30", "feature", { runId: "r", status: "FAIL", updatedAt: "2026-09-02T00:00:00.000Z" });
  // Passed with its merge request skipped.
  writeRun(project, "DEMO-31", "bugfix", {
    runId: "k",
    status: "PASS",
    steps: [step("implement", "done"), step("create-mr", "skipped")],
  });
  writeRun(project, "DEMO-32", "bugfix", { runId: "f", status: "FAIL", steps: [step("implement", "failed")] });
  // The work was done; pushing it failed on a revoked token.
  writeRun(project, "DEMO-34", "bugfix", {
    runId: "h",
    status: "FAIL",
    steps: [step("implement", "done"), step("push-mr", "failed")],
  });
  // A pipeline outside the delivery list still delivers once it ships.
  writeRun(project, "DEMO-33", "tickets-simples", { runId: "t", status: "PASS", steps: [step("push-mr", "done")] });

  const byTicket = new Map(readStats().tickets.map((ticket) => [ticket.ticket, ticket]));

  expect(byTicket.get("DEMO-30")?.outcome).toBe("PASS");
  expect(byTicket.get("DEMO-30")?.runs.map((run) => [run.runId, run.handover])).toEqual([
    ["r", undefined],
    ["s", "shipped"],
  ]);
  expect(byTicket.get("DEMO-31")?.outcome).toBe("UNSHIPPED");
  expect(byTicket.get("DEMO-32")?.outcome).toBe("FAIL");
  expect(byTicket.get("DEMO-33")).toMatchObject({ outcome: "PASS", runs: [{ delivery: true, handover: "shipped" }] });
  expect(byTicket.get("DEMO-34")).toMatchObject({ outcome: "PASS", runs: [{ handover: "failed" }] });
});

test("stats: a run whose snapshot is gone is read from its runs.jsonl line", () => {
  const home = kit();
  const project = listedProject(home);
  writeRun(project, "DEMO-11", "feature", { runId: "r-1", total_control: control(5, 10) });
  writeHistory(project, [
    // Written before a resume the snapshot already holds: the snapshot wins.
    { runId: "r-1", pipeline: "feature", ticket: "DEMO-11", costUsd: 99 },
    { runId: "gone", pipeline: "feature", ticket: "DEMO-11", status: "FAIL", costUsd: 1, costStatus: "partial" },
    { runId: "gone-child", pipeline: "lot", ticket: "DEMO-11", parentRunId: "gone", costUsd: 0.5 },
    {
      runId: "x",
      pipeline: "bugfix",
      ticket: "OLD-1",
      costUsd: 2,
      costUnknown: true,
      startedAt: "2026-07-01T00:00:00.000Z",
      endedAt: "2026-07-01T01:00:00.000Z",
    },
    { runId: "no-ticket", pipeline: "release", ticket: null, costUsd: 3 },
  ]);

  const { tickets } = readStats();

  expect(tickets.map((ticket) => ticket.ticket).sort()).toEqual(["DEMO-11", "OLD-1"]);
  const mixed = tickets.find((ticket) => ticket.ticket === "DEMO-11");
  expect(mixed).toMatchObject({ cost: { usd: 6, estimated: true }, source: "mixed" });
  expect(mixed?.runs.map((run) => [run.runId, run.source, run.cost?.usd, run.status])).toEqual(
    expect.arrayContaining([
      ["r-1", "live", 5, "ABORTED"],
      ["gone", "history", 1, "FAIL"],
    ]),
  );
  const old = tickets.find((ticket) => ticket.ticket === "OLD-1");
  expect(old).toMatchObject({
    source: "history",
    cost: { usd: 2, estimated: false, unknown: true },
    firstAt: "2026-07-01T00:00:00.000Z",
    lastAt: "2026-07-01T01:00:00.000Z",
    // A line without a verdict, on a run nothing holds any more: an interrupted
    // run, as the morning box would serve it from its snapshot.
    outcome: "ABORTED",
  });
  // The line holds neither the active time nor the step statuses.
  expect(old?.activeMs).toBeUndefined();
});

test("stats: a snapshot this release no longer reads falls back to its line", () => {
  const home = kit();
  const project = listedProject(home);
  const runDir = writeRun(project, "DEMO-12", "feature", { runId: "v2", total_control: control(7, 1) });
  writeFileSync(join(runDir, "state.json"), JSON.stringify({ schemaVersion: 2, runId: "v2", steps: [] }));
  writeHistory(project, [{ runId: "v2", pipeline: "feature", ticket: "DEMO-12", status: "PASS", costUsd: 4 }]);

  const [ticket] = readStats().tickets;

  expect(ticket).toMatchObject({ ticket: "DEMO-12", source: "history", cost: { usd: 4 }, outcome: "PASS" });
});

test("stats: tickets are sorted costliest first", () => {
  const home = kit();
  const project = listedProject(home);
  writeRun(project, "DEMO-A", "feature", { runId: "a", total_control: control(1, 1) });
  writeRun(project, "DEMO-B", "feature", { runId: "b", total_control: control(3, 1) });
  writeRun(project, "DEMO-C", "feature", { runId: "c" });

  expect(readStats().tickets.map((ticket) => ticket.ticket)).toEqual(["DEMO-B", "DEMO-A", "DEMO-C"]);
});

test("stats: a stray link to a run of another pipeline does not count it twice", () => {
  const home = kit();
  const project = listedProject(home);
  const runDir = writeRun(project, "DEMO-D", "feature", { runId: "a", total_control: control(2, 1) });
  mkdirSync(join(workItemDir(project, "DEMO-D"), "runs", "alias"), { recursive: true });
  symlinkSync(runDir, join(workItemDir(project, "DEMO-D"), "runs", "alias", "a-copy"));

  expect(readStats().tickets[0]?.cost.usd).toBe(2);
});
