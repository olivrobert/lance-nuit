// Automation exit point built by `humanReview()`.
//
// Verify what the six exit points used to copy by hand: step IDs (note idempotency
// keys), "and no one approved" added to the raw verdict, stop message, and the
// `--approve` subject exposed to the pipeline.

import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifact } from "../../dsl/artifact.js";
import { createInternalWorkItemSourceStep, pipeline } from "../../dsl.js";
import type { ArtifactRef, WorkItemArtifactStore } from "../../model/artifact-ports.js";
import type { PipelineContext } from "../../model/context.js";
import type { PipelineStep } from "../../model/definition.js";
import { createFakeWorkItemGateway } from "../../modules/work-item/fake.js";
import { buildPipelineContext } from "../../pipeline/context.js";
import { checkInputs } from "../../step/step-admission.js";
import { humanReview } from "./human-review.js";

const TICKET = "PROJ-1";

interface Verdict {
  blocked?: boolean;
  /** Triage family: the per-verdict approval tests offer a subject for each but `split`. */
  family?: "info" | "decision" | "split";
}

const verdictArtifact = artifact<Verdict>("verdict.json", (value) => value as Verdict);

class MemoryArtifactStore implements WorkItemArtifactStore {
  private readonly values = new Map<string, string>();

  put(name: string, value: string): void {
    this.values.set(name, value);
  }

  async exists(ref: ArtifactRef): Promise<boolean> {
    return this.values.has(ref.name);
  }

  async readText(ref: ArtifactRef): Promise<string | undefined> {
    return this.values.get(ref.name);
  }

  async readJson<T>(ref: ArtifactRef, parse: (value: unknown) => T): Promise<T | undefined> {
    const value = await this.readText(ref);
    return value === undefined ? undefined : parse(JSON.parse(value));
  }

  async writeText(ref: ArtifactRef, value: string): Promise<void> {
    this.put(ref.name, value);
  }

  async remove(ref: ArtifactRef): Promise<void> {
    this.values.delete(ref.name);
  }
}

interface Fixture {
  ctx: PipelineContext;
  store: MemoryArtifactStore;
}

function fixture(
  opts: { blocked?: boolean; approved?: boolean; body?: Verdict; approvedSubject?: string } = {},
): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "human-review-"));
  const store = new MemoryArtifactStore();
  const ctx = buildPipelineContext({ cwd: dir, ticket: TICKET, artifacts: store });
  const value = opts.body ?? (opts.blocked === undefined ? undefined : { blocked: opts.blocked });
  const body = value === undefined ? undefined : JSON.stringify(value);
  if (body !== undefined) store.put("verdict.json", body);
  const subject = opts.approvedSubject ?? (opts.approved ? "sujet" : undefined);
  if (subject) {
    mkdirSync(ctx.paths.decisionsDir!, { recursive: true });
    writeFileSync(
      join(ctx.paths.decisionsDir!, `${subject}.json`),
      JSON.stringify({
        schemaVersion: 1,
        decision: "approved",
        subject,
        artifact: "artifacts/verdict.json",
        artifactSha256: createHash("sha256")
          .update(body ?? "")
          .digest("hex"),
        decidedAt: "2026-08-01T00:00:00.000Z",
        decidedBy: "human",
      }),
    );
  }
  return { ctx, store };
}

/** Steps mounted in a real pipeline: escalation needs a source queue. */
function build(
  overrides: Partial<Parameters<typeof humanReview<Verdict>>[0]> = {},
  pipelineName = "test",
): PipelineStep[] {
  return pipeline(pipelineName)
    .add(createInternalWorkItemSourceStep({ dir: () => "/tmp/work-items", queue: "featureTodo" }))
    .add(
      humanReview<Verdict>({
        id: "demo",
        artifact: verdictArtifact,
        kind: "needs-decision",
        blocked: (value) => value.blocked === true,
        note: () => ({
          headline: "🤖 Escalation — demo.",
          fields: [
            { label: "State", value: "no code written" },
            { label: "Action", value: "decide" },
          ],
        }),
        reason: () => "blocking verdict",
        ...overrides,
      }),
    )
    .build().steps;
}

const stepOf = (steps: PipelineStep[], id: string): PipelineStep => {
  const found = steps.find((step) => step.id === id);
  if (!found) throw new Error(`step ${id} not found`);
  return found;
};

const admit = (step: PipelineStep, ctx: PipelineContext) => checkInputs({ def: step } as never, ctx);

test("IDs derive from id and can be overridden individually", () => {
  const ids = build({ abandonBranch: () => "main" }).map((step) => step.id);
  expect(ids).toEqual(["ticket", "escalate-demo", "abandon-demo-branch", "demo-gate"]);

  const renamed = build({ abandonBranch: () => "main", ids: { abandon: "abandon-branch" } }).map((step) => step.id);
  expect(renamed).toContain("abandon-branch");
});

test("no branch abandonment declared → no abandonment step", () => {
  expect(build().map((step) => step.id)).toEqual(["ticket", "escalate-demo", "demo-gate"]);
});

test("blocking verdict: escalation admitted, gate stopped with prefixed reason", async () => {
  const steps = build();
  const { ctx } = fixture({ blocked: true });

  expect((await admit(stepOf(steps, "escalate-demo"), ctx)).action).toBe("pass");
  const gate = await admit(stepOf(steps, "demo-gate"), ctx);
  expect(gate.action).toBe("stop");
  expect(gate.action === "pass" ? "" : gate.reason).toBe("escalated: blocking verdict");
});

test("non-blocking verdict: escalation skipped, gate passes", async () => {
  const steps = build();
  const { ctx } = fixture({ blocked: false });

  expect((await admit(stepOf(steps, "escalate-demo"), ctx)).action).toBe("skip");
  expect((await admit(stepOf(steps, "demo-gate"), ctx)).action).toBe("pass");
});

test("missing artifact: nothing blocks by default (check did not happen)", async () => {
  const steps = build();
  const { ctx } = fixture({});

  expect((await admit(stepOf(steps, "escalate-demo"), ctx)).action).toBe("skip");
  expect((await admit(stepOf(steps, "demo-gate"), ctx)).action).toBe("pass");
});

test("approval: and no one approved is added to the raw verdict", async () => {
  const steps = build({ approval: { subject: "sujet" } });

  const pending = fixture({ blocked: true });
  expect((await admit(stepOf(steps, "escalate-demo"), pending.ctx)).action).toBe("pass");
  expect((await admit(stepOf(steps, "demo-gate"), pending.ctx)).action).toBe("stop");

  // Same blocking verdict, but approved: no escalation (no repeated comment on
  // relaunch) and the gate lets the run continue.
  const approved = fixture({ blocked: true, approved: true });
  expect((await admit(stepOf(steps, "escalate-demo"), approved.ctx)).action).toBe("skip");
  expect((await admit(stepOf(steps, "demo-gate"), approved.ctx)).action).toBe("pass");
});

test("stale approval: artifact changed, exit point reopens", async () => {
  const steps = build({ approval: { subject: "sujet" } });
  const f = fixture({ blocked: true, approved: true });

  f.store.put("verdict.json", JSON.stringify({ blocked: true, other: "thing" }));
  expect((await admit(stepOf(steps, "demo-gate"), f.ctx)).action).toBe("stop");
});

test("stop message: unlock command derives from subject, ticket, and pipeline", async () => {
  const steps = build({ approval: { subject: "sujet" } }, "renamed-feature");
  const { ctx } = fixture({ blocked: true });

  const gate = await admit(stepOf(steps, "demo-gate"), ctx);
  expect(gate.action === "pass" ? "" : gate.reason).toBe(
    'escalated: blocking verdict — lift with "lancenuit run PROJ-1 --pipeline renamed-feature --approve sujet"',
  );
});

test("the gate describes its stop: subject, expected recovery, undecorated reason", async () => {
  const steps = build({ approval: { subject: "sujet" } });
  const { ctx } = fixture({ blocked: true });

  const gate = await admit(stepOf(steps, "demo-gate"), ctx);
  // The reason is written for a console; the stop is written for a reader that
  // must know what lifts the block without parsing that sentence.
  expect(gate.action === "pass" ? undefined : gate.stop).toEqual({
    subject: "sujet",
    artifact: "artifacts/verdict.json",
    kind: "needs-decision",
    detail: "blocking verdict",
  });
});

test("a gate without approval declares no subject to approve", async () => {
  const steps = build({ kind: "needs-human" });
  const { ctx } = fixture({ blocked: true });

  const gate = await admit(stepOf(steps, "demo-gate"), ctx);
  expect(gate.action === "pass" ? undefined : gate.stop).toEqual({
    artifact: "artifacts/verdict.json",
    kind: "needs-human",
    detail: "blocking verdict",
  });
});

test("approval subject is exposed to the pipeline without redeclaration", () => {
  const built = pipeline("test")
    .add(createInternalWorkItemSourceStep({ dir: () => "/tmp/work-items", queue: "featureTodo" }))
    .add(
      humanReview<Verdict>({
        id: "demo",
        artifact: verdictArtifact,
        kind: "needs-decision",
        blocked: (value) => value.blocked === true,
        approval: { subject: "sujet" },
        note: () => ({ headline: "🤖 Escalation — demo.", fields: [] }),
        reason: () => "blocking verdict",
      }),
    )
    .build();

  expect(built.approvals?.get("sujet")?.name).toBe("verdict.json");
});

test("note carries recovery type inserted before State / Action", async () => {
  const gateway = createFakeWorkItemGateway({ items: [{ ref: TICKET, queues: ["featureTodo"], state: "todo" }] });
  const { ctx: base } = fixture({ blocked: true });
  const ctx = buildPipelineContext({
    cwd: base.cwd,
    ticket: TICKET,
    artifacts: base.artifacts,
    workItem: gateway,
  });

  await stepOf(build({ kind: "needs-info" }), "escalate-demo").action!(ctx);

  const body = gateway.bodiesOf(TICKET)[0]!;
  expect(body).toContain("needs-info");
  // Reading order is the contract: type comes BEFORE code state and expected
  // action, which always close an escalation note.
  expect(body.indexOf("needs-info")).toBeLessThan(body.indexOf("no code written"));
});

test("note closes with approval command derived from the gate subject", async () => {
  const gateway = createFakeWorkItemGateway({ items: [{ ref: TICKET, queues: ["featureTodo"], state: "todo" }] });
  const { ctx: base } = fixture({ blocked: true });
  const ctx = buildPipelineContext({ cwd: base.cwd, ticket: TICKET, artifacts: base.artifacts, workItem: gateway });

  const steps = build({ approval: { subject: "sujet" } });
  await stepOf(steps, "escalate-demo").action!(ctx);

  const body = gateway.bodiesOf(TICKET)[0]!;
  // No escalation template writes this command: it comes from the subject actually
  // declared by the gate and remains correct after a rename.
  expect(body).toContain("Approve : lancenuit run PROJ-1 --pipeline test --approve sujet");
});

test("without approval declared: no command promised to the human", async () => {
  const gateway = createFakeWorkItemGateway({ items: [{ ref: TICKET, queues: ["featureTodo"], state: "todo" }] });
  const { ctx: base } = fixture({ blocked: true });
  const ctx = buildPipelineContext({ cwd: base.cwd, ticket: TICKET, artifacts: base.artifacts, workItem: gateway });

  await stepOf(build({ kind: "needs-human" }), "escalate-demo").action!(ctx);

  // `needs-human`: nothing unlocks the ticket automatically, so the note must not
  // offer a relaunch.
  expect(gateway.bodiesOf(TICKET)[0]!).not.toContain("--approve");
});

test("branch abandonment: runs only when the exit point blocks", async () => {
  const steps = build({ abandonBranch: () => "main" });

  const blocked = fixture({ blocked: true });
  expect((await admit(stepOf(steps, "abandon-demo-branch"), blocked.ctx)).action).toBe("pass");

  const free = fixture({ blocked: false });
  const skipped = await admit(stepOf(steps, "abandon-demo-branch"), free.ctx);
  expect(skipped.action).toBe("skip");
  expect(skipped.action === "pass" ? "" : skipped.reason).toBe("no escalation — branch kept");
});

test("child pipeline: no note declared → gate only, approval still exposed", async () => {
  // A child pipeline (a lot inside a feature) borrows its parent's ticket and owns
  // no source queue. Declaring a note there makes the pipeline UNLOADABLE, which
  // used to leave a child gate no way to expose `--approve` at all.
  const child = pipeline("lot")
    .add(
      humanReview<Verdict>({
        id: "reuse",
        artifact: verdictArtifact,
        kind: "needs-decision",
        blocked: (value) => value.blocked === true,
        approval: { subject: "sujet" },
        reason: () => "duplication assumed or fixed",
      }),
    )
    .build();

  expect(child.steps.map((step) => step.id)).toEqual(["reuse-gate"]);
  expect(child.approvals?.get("sujet")?.name).toBe("verdict.json");

  const pending = fixture({ blocked: true });
  const stopped = await admit(stepOf(child.steps, "reuse-gate"), pending.ctx);
  expect(stopped.action).toBe("stop");
  expect(stopped.action === "pass" ? "" : stopped.reason).toBe(
    'escalated: duplication assumed or fixed — lift with "lancenuit run PROJ-1 --pipeline lot --approve sujet"',
  );

  const approved = fixture({ blocked: true, approved: true });
  expect((await admit(stepOf(child.steps, "reuse-gate"), approved.ctx)).action).toBe("pass");
});

/** A triage gate whose split verdict must be undone by new tickets, not approved. */
const byVerdict = {
  subjects: ["triage-info", "triage-decision"],
  subjectFor: (value: Verdict) => (value.family === "split" ? undefined : `triage-${value.family}`),
} as const;

const blockedAs = (family: Verdict["family"]): Verdict => ({ blocked: true, family });

test("approval by verdict: the hint names the subject the verdict offers", async () => {
  const steps = build({ approval: byVerdict });
  const { ctx } = fixture({ body: blockedAs("decision") });

  const gate = await admit(stepOf(steps, "demo-gate"), ctx);
  expect(gate.action === "pass" ? "" : gate.reason).toBe(
    'escalated: blocking verdict — lift with "lancenuit run PROJ-1 --pipeline test --approve triage-decision"',
  );
  expect(gate.action === "pass" ? undefined : gate.stop?.subject).toBe("triage-decision");
});

test("approval by verdict: a non-approvable verdict stops with its reason and no subject", async () => {
  const steps = build({ approval: byVerdict });
  // A fresh decision under another declared subject must not lift a verdict that
  // offers none: it was recorded for an earlier, approvable verdict.
  const { ctx } = fixture({ body: blockedAs("split"), approvedSubject: "triage-info" });

  expect((await admit(stepOf(steps, "escalate-demo"), ctx)).action).toBe("pass");
  const gate = await admit(stepOf(steps, "demo-gate"), ctx);
  expect(gate.action === "pass" ? "" : gate.reason).toBe("escalated: blocking verdict");
  expect(gate.action === "pass" ? undefined : gate.stop).toEqual({
    artifact: "artifacts/verdict.json",
    kind: "needs-decision",
    detail: "blocking verdict",
  });
});

test("approval by verdict: only a decision under the offered subject lifts the gate", async () => {
  const steps = build({ approval: byVerdict });

  const other = fixture({ body: blockedAs("decision"), approvedSubject: "triage-info" });
  expect((await admit(stepOf(steps, "demo-gate"), other.ctx)).action).toBe("stop");

  const offered = fixture({ body: blockedAs("decision"), approvedSubject: "triage-decision" });
  expect((await admit(stepOf(steps, "escalate-demo"), offered.ctx)).action).toBe("skip");
  expect((await admit(stepOf(steps, "demo-gate"), offered.ctx)).action).toBe("pass");
});

test("approval by verdict: a subject outside the declared list is an authoring error", async () => {
  const steps = build({ approval: { subjects: ["triage-info"], subjectFor: () => "triage-other" } });
  const { ctx } = fixture({ body: blockedAs("info") });

  // Admission turns the thrown error into a stop, so the run halts on the bug
  // instead of writing a decision for an undeclared subject.
  const gate = await admit(stepOf(steps, "demo-gate"), ctx);
  expect(gate.action).toBe("stop");
  expect(gate.action === "pass" ? "" : gate.reason).toBe(
    'humanReview("demo"): approval.subjectFor returned "triage-other", which is not declared (subjects: triage-info)',
  );
});

test("approval by verdict: an empty subject list fails at declaration", () => {
  expect(() => build({ approval: { subjects: [], subjectFor: () => undefined } })).toThrow(
    'humanReview("demo"): approval.subjects must be a non-empty array',
  );
});

test("approval by verdict: the note promises no command for a non-approvable verdict", async () => {
  const notes = async (family: Verdict["family"]): Promise<string> => {
    const gateway = createFakeWorkItemGateway({ items: [{ ref: TICKET, queues: ["featureTodo"], state: "todo" }] });
    const { ctx: base } = fixture({ body: blockedAs(family) });
    const ctx = buildPipelineContext({ cwd: base.cwd, ticket: TICKET, artifacts: base.artifacts, workItem: gateway });
    await stepOf(build({ approval: byVerdict }), "escalate-demo").action!(ctx);
    return gateway.bodiesOf(TICKET)[0]!;
  };

  expect(await notes("info")).toContain("Approve : lancenuit run PROJ-1 --pipeline test --approve triage-info");
  const split = await notes("split");
  expect(split).not.toContain("Approve");
  expect(split).not.toContain("--approve");
});

test("approval by verdict: every declared subject is exposed to the pipeline", async () => {
  const built = pipeline("test")
    .add(
      humanReview<Verdict>({
        id: "demo",
        artifact: verdictArtifact,
        kind: "needs-decision",
        blocked: (value) => value.blocked === true,
        approval: byVerdict,
        reason: () => "blocking verdict",
      }),
    )
    .build();

  expect([...built.approvals!.keys()]).toEqual(["triage-info", "triage-decision"]);
  expect(built.approvals?.get("triage-decision")?.name).toBe("verdict.json");
  expect([...built.approvalGuards!.keys()]).toEqual(["triage-info", "triage-decision"]);

  // The guard applies the gate's rule: only the subject the current verdict offers.
  const { ctx } = fixture({ body: blockedAs("decision") });
  expect(await built.approvalGuards!.get("triage-decision")!(ctx)).toBeUndefined();
  expect(await built.approvalGuards!.get("triage-info")!(ctx)).toBe(
    'Approval subject "triage-info" is not offered by the current verdict of artifacts/verdict.json (offered: triage-decision).',
  );
  const split = fixture({ body: blockedAs("split") });
  expect(await built.approvalGuards!.get("triage-info")!(split.ctx)).toBe(
    'Approval subject "triage-info" is not offered by the current verdict of artifacts/verdict.json (this verdict cannot be approved).',
  );
  const free = fixture({ blocked: false });
  expect(await built.approvalGuards!.get("triage-info")!(free.ctx)).toBe(
    'Approval subject "triage-info" is not offered by the current verdict of artifacts/verdict.json (nothing blocks).',
  );
});

test("approval by verdict: a guarded subject cannot be declared twice", () => {
  const review = (approval: Parameters<typeof humanReview<Verdict>>[0]["approval"], id = "demo") =>
    humanReview<Verdict>({
      id,
      artifact: verdictArtifact,
      kind: "needs-decision",
      blocked: (value) => value.blocked === true,
      approval,
      reason: () => "blocking verdict",
    });
  const guarded = 'approval subject "triage-info" is guarded by a human review and cannot be declared twice';

  expect(() => pipeline("twice").add(review(byVerdict, "first"), review(byVerdict, "second")).build()).toThrow(guarded);
  expect(() => pipeline("twice").approval("triage-info", verdictArtifact).add(review(byVerdict)).build()).toThrow(
    guarded,
  );
  expect(() => pipeline("twice").add(review(byVerdict)).approval("triage-info", verdictArtifact).build()).toThrow(
    guarded,
  );
  expect(() =>
    pipeline("twice")
      .add(review(byVerdict, "first"), review({ subject: "triage-info" }, "second"))
      .build(),
  ).toThrow(guarded);
});

test("approval by verdict: an invalid subject token fails at build", () => {
  expect(() =>
    pipeline("evil")
      .add(
        humanReview<Verdict>({
          id: "demo",
          artifact: verdictArtifact,
          kind: "needs-decision",
          blocked: () => true,
          approval: { subjects: ["../escape"], subjectFor: () => undefined },
          reason: () => "blocking verdict",
        }),
      )
      .build(),
  ).toThrow('Pipeline "evil": invalid approval subject "../escape"');
});
