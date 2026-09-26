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
    costUsd: 7.5,
    costEstimated: false,
    costUnknown: false,
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

  expect(ticket?.costUsd).toBe(30);
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

  expect(ticket).toMatchObject({ costUsd: 3, costEstimated: true, costUnknown: true });
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
  expect(tickets[0]?.costUsd).toBe(3);
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
  expect(triaged?.costUsd).toBe(0.4);
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

test("stats: an archived run carries its handover", () => {
  const home = kit();
  listedProject(home);
  writeUiFile(home, "stats.json", { delivery: { steps: ["create-mr"] } });
  writeUiFile(home, "stats-archive.json", {
    version: 1,
    runs: [
      { project: "demo-app", ticket: "OLD-2", runId: "a", pipeline: "feature", status: "PASS", handover: "shipped" },
      { project: "demo-app", ticket: "OLD-3", runId: "b", pipeline: "feature", status: "PASS" },
      { project: "demo-app", ticket: "OLD-4", runId: "c", pipeline: "feature", status: "FAIL", handover: "failed" },
      { project: "demo-app", ticket: "OLD-5", runId: "d", pipeline: "feature", status: "PASS", handover: "yes" },
    ],
  });

  const outcomes = Object.fromEntries(readStats().tickets.map((ticket) => [ticket.ticket, ticket.outcome]));

  expect(outcomes).toEqual({ "OLD-2": "PASS", "OLD-3": "UNSHIPPED", "OLD-4": "PASS", "OLD-5": "UNSHIPPED" });
});

test("stats: archived runs are merged, and a run present in both is read live", () => {
  const home = kit();
  const project = listedProject(home);
  writeRun(project, "DEMO-11", "feature", { runId: "r-1", total_control: control(5, 10) });
  writeUiFile(home, "stats-archive.json", {
    version: 1,
    generatedAt: "2026-09-20T00:00:00.000Z",
    runs: [
      { project: "demo-app", ticket: "DEMO-11", runId: "r-1", pipeline: "feature", costUsd: 99 },
      { project: "demo-app", ticket: "DEMO-11", runId: "old", pipeline: "runner:feature", costUsd: 1, kind: "feature" },
      {
        project: "gone-app",
        ticket: "OLD-1",
        runId: "x",
        pipeline: "bugfix",
        status: "STOP",
        costUsd: 2,
        costEstimated: true,
        activeMs: 60_000,
        createdAt: "2026-07-01T00:00:00.000Z",
        kind: "bug",
      },
      { project: "demo-app", ticket: "missing-run-id" },
    ],
  });

  const { tickets, archive } = readStats();

  expect(archive).toEqual({ status: "ok", generatedAt: "2026-09-20T00:00:00.000Z", runs: 3 });
  const live = tickets.find((ticket) => ticket.ticket === "DEMO-11");
  expect(live).toMatchObject({ costUsd: 6, source: "mixed", kind: "feature" });
  const old = tickets.find((ticket) => ticket.ticket === "OLD-1");
  expect(old).toMatchObject({
    project: "gone-app",
    source: "archive",
    kind: "bug",
    costUsd: 2,
    costEstimated: true,
    activeMs: 60_000,
    outcome: "RUNNING",
  });
  expect(old?.ticketUrl).toBeUndefined();
});

test("stats: a malformed archive is reported and ignored, the live tickets still read", () => {
  const home = kit();
  const project = listedProject(home);
  writeRun(project, "DEMO-12", "feature", { runId: "r-1", total_control: control(1, 1) });
  writeUiFile(home, "stats-archive.json", "{ not json");

  const { tickets, archive } = readStats();

  expect(archive.status).toBe("invalid");
  expect(tickets.map((ticket) => ticket.ticket)).toEqual(["DEMO-12"]);
});

test("stats: an archive with the wrong shape is invalid, a missing one is absent", () => {
  const home = kit();
  listedProject(home);
  expect(readStats().archive).toEqual({ status: "absent" });

  writeUiFile(home, "stats-archive.json", { version: 2, runs: [] });
  expect(readStats().archive.status).toBe("invalid");
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

  expect(readStats().tickets[0]?.costUsd).toBe(2);
});
