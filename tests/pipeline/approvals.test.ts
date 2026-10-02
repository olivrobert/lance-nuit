// General approval mechanism: a pipeline declares its subjects and the artifact
// each commits to; the CLI resolves the mapping against that declaration.
// No hardcoded subject list exists anywhere—that is the point of these tests.

import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveApprovableArtifact, resolveApprovalArtifact } from "../../src/commands/approval-subject.js";
import { artifact, textArtifact } from "../../src/dsl/artifact.js";
import { bashStep, humanReview, pipeline } from "../../src/dsl.js";
import { buildPipelineContext } from "../../src/pipeline/context.js";
import {
  decisionActor,
  decisionMatchesArtifact,
  MAX_REJECTION_REASON,
  markDecisionApplied,
  pendingRejection,
  readDecision,
  readDecisionAt,
  recordApproval,
  recordRejection,
  rejectionPending,
} from "../../src/state/decisions.js";

const step = () => bashStep({ id: "noop", name: "Noop", command: "true" });

/** Arbitrary project artifact: the mechanism knows no particular name. */
const budgetArtifact = artifact("budget.json", (value) => {
  const data = value as Record<string, unknown>;
  if (typeof data?.amountUsd !== "number") throw new Error("budget.json: amountUsd requis");
  return data as { amountUsd: number };
});

function ticketContext() {
  const cwd = mkdtempSync(join(tmpdir(), "approvals-"));
  const base = buildPipelineContext();
  const context = buildPipelineContext({
    cwd,
    ticket: "PROJ-9",
    config: { ...base.config, specPath: ".lance-nuit/work-items" },
  });
  mkdirSync(context.paths.artifactsDir!, { recursive: true });
  return context;
}

test("a pipeline exposes its declared subjects and nothing else", () => {
  const def = pipeline("budgeted").approval("budget", budgetArtifact).add(step()).build();

  expect([...def.approvals!.keys()]).toEqual(["budget"]);
  expect(resolveApprovalArtifact(def, "budget").name).toBe("budget.json");
  expect(() => resolveApprovalArtifact(def, "split")).toThrow(
    'Approval subject "split" is not declared by pipeline "budgeted" (declared: budget).',
  );
});

test("a pipeline without approvals rejects every subject and says so", () => {
  const def = pipeline("plain").add(step()).build();
  expect(def.approvals).toBeUndefined();
  expect(() => resolveApprovalArtifact(def, "budget")).toThrow("(no subjects declared)");
});

test("a subject outside the charset is rejected at declaration and resolution", () => {
  // The subject becomes a filename under `decisions/`: the guard must hold
  // BEFORE any disk write, at pipeline construction time.
  expect(() => pipeline("evil").approval("../../etc/passwd", budgetArtifact).add(step()).build()).toThrow(
    'Pipeline "evil": invalid approval subject "../../etc/passwd"',
  );
  expect(() => pipeline("evil").approval("with space", budgetArtifact).add(step()).build()).toThrow(
    'Pipeline "evil": invalid approval subject "with space"',
  );

  const def = pipeline("budgeted").approval("budget", budgetArtifact).add(step()).build();
  expect(() => resolveApprovalArtifact(def, "../escape")).toThrow('Invalid approval subject "../escape"');
});

test("the same subject on two different artifacts fails pipeline loading", () => {
  const other = artifact("other.json", (value) => value as object);
  expect(() =>
    pipeline("ambiguous").approval("budget", budgetArtifact).approval("budget", other).add(step()).build(),
  ).toThrow(
    'Pipeline "ambiguous": approval subject "budget" declared on two artifacts ("budget.json" and "other.json")',
  );
});

test("the same subject redeclared on the SAME artifact is idempotent", () => {
  const def = pipeline("twice")
    .approval("budget", budgetArtifact)
    .approval("budget", budgetArtifact)
    .add(step())
    .build();
  expect([...def.approvals!.keys()]).toEqual(["budget"]);
});

test("a custom subject is approved end to end without knowing split/refactoring", async () => {
  const context = ticketContext();
  const def = pipeline("budgeted").approval("budget", budgetArtifact).add(step()).build();
  writeFileSync(context.paths.artifact("budget.json"), JSON.stringify({ amountUsd: 12 }));

  const resolved = resolveApprovalArtifact(def, "budget");
  const { decision } = await recordApproval(context, "budget", resolved);
  expect(decision.subject).toBe("budget");
  expect(decision.artifact).toBe("artifacts/budget.json");
  expect(await decisionMatchesArtifact(context, "budget", budgetArtifact)).toBe(true);

  // The decision file uses the same format as split/assumptions/refactoring:
  // no data migration; generalization changed only the mapping.
  const onDisk = JSON.parse(readFileSync(join(context.paths.decisionsDir!, "budget.json"), "utf-8"));
  expect(onDisk.schemaVersion).toBe(1);
  expect(onDisk.decidedBy).toBe("human");

  expect((await markDecisionApplied(context, "budget", budgetArtifact)).decision).toBe("applied");

  // Modifying the artifact expires the approval, custom or not.
  writeFileSync(context.paths.artifact("budget.json"), JSON.stringify({ amountUsd: 13 }));
  expect(await decisionMatchesArtifact(context, "budget", budgetArtifact)).toBe(false);
});

test("approval delegates validation to the artifact parser", async () => {
  const context = ticketContext();
  writeFileSync(context.paths.artifact("budget.json"), JSON.stringify({ amountUsd: "douze" }));
  expect(recordApproval(context, "budget", budgetArtifact)).rejects.toThrow("budget.json: amountUsd requis");

  writeFileSync(context.paths.artifact("budget.json"), "");
  expect(recordApproval(context, "budget", budgetArtifact)).rejects.toThrow("is empty");
});

test("a text artifact is approved like a JSON artifact", async () => {
  const context = ticketContext();
  const notes = textArtifact("notes.md");
  writeFileSync(context.paths.artifact("notes.md"), "# Decision\n");

  const { decision } = await recordApproval(context, "notes", notes);
  expect(decision.artifact).toBe("artifacts/notes.md");
  expect(await decisionMatchesArtifact(context, "notes", notes)).toBe(true);
});

test("the decision author comes from LANCENUIT_ACTOR, or is the anonymous human", () => {
  expect(decisionActor({})).toBe("human");
  expect(decisionActor({ LANCENUIT_ACTOR: "Olivier" })).toBe("Olivier");
  expect(decisionActor({ LANCENUIT_ACTOR: " Olivier R. " })).toBe("Olivier R.");
  // The name lands in a decision file every reader trusts: a value outside the
  // charset, or too long to be a name, is ignored rather than written.
  expect(decisionActor({ LANCENUIT_ACTOR: "" })).toBe("human");
  expect(decisionActor({ LANCENUIT_ACTOR: "rm -rf /; echo" })).toBe("human");
  expect(decisionActor({ LANCENUIT_ACTOR: "a".repeat(65) })).toBe("human");
});

test("an approval records who granted it", async () => {
  const context = ticketContext();
  writeFileSync(context.paths.artifact("budget.json"), JSON.stringify({ amountUsd: 12 }));
  const previous = process.env.LANCENUIT_ACTOR;
  process.env.LANCENUIT_ACTOR = "Olivier";
  try {
    expect((await recordApproval(context, "budget", budgetArtifact)).decision.decidedBy).toBe("Olivier");
    // A named decision still opens the gate: the reader accepts any author.
    expect(await decisionMatchesArtifact(context, "budget", budgetArtifact)).toBe(true);

    writeFileSync(context.paths.artifact("budget.json"), JSON.stringify({ amountUsd: 13 }));
    process.env.LANCENUIT_ACTOR = "not a name!";
    expect((await recordApproval(context, "budget", budgetArtifact)).decision.decidedBy).toBe("human");
  } finally {
    if (previous === undefined) delete process.env.LANCENUIT_ACTOR;
    else process.env.LANCENUIT_ACTOR = previous;
  }
});

test("approving an artifact already approved keeps the first decision", async () => {
  const context = ticketContext();
  writeFileSync(context.paths.artifact("budget.json"), JSON.stringify({ amountUsd: 12 }));
  const previous = process.env.LANCENUIT_ACTOR;
  process.env.LANCENUIT_ACTOR = "Olivier";
  try {
    const first = await recordApproval(context, "budget", budgetArtifact);
    expect(first.written).toBe(true);

    // The same gate lifted again from another place: the author is not replaced.
    delete process.env.LANCENUIT_ACTOR;
    const again = await recordApproval(context, "budget", budgetArtifact);
    expect(again).toEqual({ decision: first.decision, written: false });

    // An applied decision stays applied rather than turning pending again.
    await markDecisionApplied(context, "budget", budgetArtifact);
    const afterApply = await recordApproval(context, "budget", budgetArtifact);
    expect(afterApply.written).toBe(false);
    expect(afterApply.decision.decision).toBe("applied");

    // A changed artifact is a new question: the approval is written anew.
    writeFileSync(context.paths.artifact("budget.json"), JSON.stringify({ amountUsd: 13 }));
    const changed = await recordApproval(context, "budget", budgetArtifact);
    expect(changed.written).toBe(true);
    expect(changed.decision.decidedBy).toBe("human");
  } finally {
    if (previous === undefined) delete process.env.LANCENUIT_ACTOR;
    else process.env.LANCENUIT_ACTOR = previous;
  }
});

test("a nested text artifact approval is readable by the gate", async () => {
  const context = ticketContext();
  const plan = textArtifact("reports/plan.json");
  await plan.write(context, "plan\n");

  const { decision } = await recordApproval(context, "plan", plan);
  expect(decision.artifact).toBe("artifacts/reports/plan.json");
  expect(await decisionMatchesArtifact(context, "plan", plan)).toBe(true);
});

test("a subject the current verdict does not offer is refused and nothing is written", async () => {
  const context = ticketContext();
  const triage = artifact("triage.json", (value) => value as { verdict: "decision" | "split" });
  const def = pipeline("triaged")
    .add(
      humanReview({
        id: "triage",
        artifact: triage,
        kind: "needs-decision",
        blocked: () => true,
        approval: {
          subjects: ["triage-decision"],
          subjectFor: (value) => (value.verdict === "split" ? undefined : "triage-decision"),
        },
        reason: () => "triage blocks",
      }),
    )
    .build();
  writeFileSync(context.paths.artifact("triage.json"), JSON.stringify({ verdict: "split" }));

  expect(resolveApprovableArtifact(def, "triage-decision", context)).rejects.toThrow(
    'Approval subject "triage-decision" is not offered by the current verdict of artifacts/triage.json (this verdict cannot be approved).',
  );
  expect(existsSync(join(context.paths.decisionsDir!, "triage-decision.json"))).toBe(false);
  // Same errors as the static lookup for an undeclared subject.
  expect(resolveApprovableArtifact(def, "split", context)).rejects.toThrow(
    'Approval subject "split" is not declared by pipeline "triaged" (declared: triage-decision).',
  );

  writeFileSync(context.paths.artifact("triage.json"), JSON.stringify({ verdict: "decision" }));
  expect((await resolveApprovableArtifact(def, "triage-decision", context)).name).toBe("triage.json");
});

test("a static subject is accepted whatever the verdict", async () => {
  const context = ticketContext();
  const def = pipeline("budgeted").approval("budget", budgetArtifact).add(step()).build();
  expect((await resolveApprovableArtifact(def, "budget", context)).name).toBe("budget.json");
});

test("a rejection records the trimmed reason, the artifact hash, the round and its author", async () => {
  const context = ticketContext();
  writeFileSync(context.paths.artifact("budget.json"), JSON.stringify({ amountUsd: 12 }));
  const previous = process.env.LANCENUIT_ACTOR;
  process.env.LANCENUIT_ACTOR = "Olivier";
  try {
    const { decision, written } = await recordRejection(context, "budget", budgetArtifact, "  too expensive  ", 3);
    expect(written).toBe(true);
    expect(decision).toMatchObject({
      decision: "rejected",
      subject: "budget",
      artifact: "artifacts/budget.json",
      reason: "too expensive",
      round: 1,
      decidedBy: "Olivier",
    });
    expect(decision.artifactSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(readDecisionAt(join(context.paths.decisionsDir!, "budget.json"))).toEqual(decision);
  } finally {
    if (previous === undefined) delete process.env.LANCENUIT_ACTOR;
    else process.env.LANCENUIT_ACTOR = previous;
  }
});

test("rejecting the same bytes again keeps the round: same reason writes nothing, another reason rewrites it", async () => {
  const context = ticketContext();
  writeFileSync(context.paths.artifact("budget.json"), JSON.stringify({ amountUsd: 12 }));
  const first = await recordRejection(context, "budget", budgetArtifact, "too expensive", 3);

  expect(await recordRejection(context, "budget", budgetArtifact, "too expensive ", 3)).toEqual({
    decision: first.decision,
    written: false,
  });
  const reworded = await recordRejection(context, "budget", budgetArtifact, "halve it", 3);
  expect(reworded.written).toBe(true);
  expect(reworded.decision).toMatchObject({ reason: "halve it", round: 1 });
});

test("rejecting reworked bytes opens the next round, and a round past the bound is refused", async () => {
  const context = ticketContext();
  writeFileSync(context.paths.artifact("budget.json"), JSON.stringify({ amountUsd: 12 }));
  await recordRejection(context, "budget", budgetArtifact, "too expensive", 2);

  writeFileSync(context.paths.artifact("budget.json"), JSON.stringify({ amountUsd: 11 }));
  expect((await recordRejection(context, "budget", budgetArtifact, "still too expensive", 2)).decision.round).toBe(2);

  writeFileSync(context.paths.artifact("budget.json"), JSON.stringify({ amountUsd: 10 }));
  expect(recordRejection(context, "budget", budgetArtifact, "no", 2)).rejects.toThrow(
    'Rejection of "budget" refused: 2 rework round(s) already rejected (maxRounds 2). Approve the artifact (--approve budget) or answer on the ticket instead.',
  );
  expect(readDecision(context, "budget")?.round).toBe(2);
});

test("an approval replaces a rejection, and the next rejection starts over at round 1", async () => {
  const context = ticketContext();
  writeFileSync(context.paths.artifact("budget.json"), JSON.stringify({ amountUsd: 12 }));
  await recordRejection(context, "budget", budgetArtifact, "too expensive", 1);
  const approved = await recordApproval(context, "budget", budgetArtifact);
  expect(approved.written).toBe(true);
  expect(approved.decision.reason).toBeUndefined();
  expect((await recordRejection(context, "budget", budgetArtifact, "changed my mind", 1)).decision.round).toBe(1);
});

test("an empty or oversized rejection reason is refused and nothing is written", async () => {
  const context = ticketContext();
  writeFileSync(context.paths.artifact("budget.json"), JSON.stringify({ amountUsd: 12 }));
  expect(recordRejection(context, "budget", budgetArtifact, "   ", 3)).rejects.toThrow(
    'Rejection of "budget" needs a reason',
  );
  expect(recordRejection(context, "budget", budgetArtifact, "x".repeat(MAX_REJECTION_REASON + 1), 3)).rejects.toThrow(
    `at most ${MAX_REJECTION_REASON} characters`,
  );
  expect(existsSync(join(context.paths.decisionsDir!, "budget.json"))).toBe(false);
});

test("a decision file is read with or without the rejection fields, and a rejection must carry them", () => {
  const dir = mkdtempSync(join(tmpdir(), "decision-"));
  const base = {
    schemaVersion: 1,
    subject: "budget",
    artifact: "artifacts/budget.json",
    artifactSha256: "a".repeat(64),
    decidedAt: "2026-01-01T00:00:00.000Z",
    decidedBy: "human",
  };
  const write = (value: object) => {
    const path = join(dir, `${Math.random()}.json`);
    writeFileSync(path, JSON.stringify(value));
    return path;
  };
  expect(readDecisionAt(write({ ...base, decision: "approved" }))?.decision).toBe("approved");
  expect(readDecisionAt(write({ ...base, decision: "rejected", reason: "no", round: 2 }))).toMatchObject({
    reason: "no",
    round: 2,
  });
  expect(readDecisionAt(write({ ...base, decision: "rejected" }))).toBeUndefined();
  expect(readDecisionAt(write({ ...base, decision: "rejected", reason: "", round: 1 }))).toBeUndefined();
  expect(readDecisionAt(write({ ...base, decision: "rejected", reason: "no", round: 0 }))).toBeUndefined();
});

test("a rejection is pending while the artifact is absent or unchanged, never for an approval", async () => {
  const context = ticketContext();
  const path = context.paths.artifact("budget.json");
  writeFileSync(path, JSON.stringify({ amountUsd: 12 }));
  const { decision } = await recordRejection(context, "budget", budgetArtifact, "too expensive", 3);
  const body = readFileSync(path, "utf-8");

  expect(rejectionPending(decision, body)).toBe(true);
  // A rework interrupted after its outputs were erased has produced nothing yet.
  expect(rejectionPending(decision, undefined)).toBe(true);
  expect(rejectionPending(decision, `${body} `)).toBe(false);
  expect(rejectionPending({ ...decision, decision: "approved" }, body)).toBe(false);
  expect(rejectionPending(undefined, body)).toBe(false);

  expect(await pendingRejection(context, "budget")).toMatchObject({ reason: "too expensive", round: 1 });
  rmSync(path);
  expect(await pendingRejection(context, "budget")).toMatchObject({ reason: "too expensive", round: 1 });
  writeFileSync(path, JSON.stringify({ amountUsd: 11 }));
  expect(await pendingRejection(context, "budget")).toBeUndefined();
  expect(await pendingRejection(context, "unknown")).toBeUndefined();
});
