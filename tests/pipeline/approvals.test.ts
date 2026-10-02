// General approval mechanism: a pipeline declares its subjects and the artifact
// each commits to; the CLI resolves the mapping against that declaration.
// No hardcoded subject list exists anywhere—that is the point of these tests.

import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveApprovableArtifact, resolveApprovalArtifact } from "../../src/commands/approval-subject.js";
import { artifact, textArtifact } from "../../src/dsl/artifact.js";
import { bashStep, humanReview, pipeline } from "../../src/dsl.js";
import { buildPipelineContext } from "../../src/pipeline/context.js";
import {
  decisionActor,
  decisionMatchesArtifact,
  markDecisionApplied,
  recordApproval,
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
