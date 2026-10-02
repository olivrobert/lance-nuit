import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerArgs } from "../model/cli-options.js";
import { buildPipelineContext } from "../pipeline/context.js";
import { approvalCommand } from "./approval.js";

/** `lancenuit approve` goes through --approve-only, not through a run: the guard
 *  must hold on this path too. */
async function approveOnly(verdict: "decision" | "split"): Promise<{ code: number; decision: string }> {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "approve-only-")));
  const file = join(cwd, "pipeline.ts");
  writeFileSync(
    file,
    `
    export default ({ pipeline, artifact, humanReview }) => {
      const triage = artifact("triage.json", (value) => value);
      return pipeline("triaged")
        .add(humanReview({
          id: "triage",
          artifact: triage,
          kind: "needs-decision",
          blocked: () => true,
          approval: {
            subjects: ["triage-decision"],
            subjectFor: (value) => (value.verdict === "split" ? undefined : "triage-decision"),
          },
          reason: () => "triage blocks",
        }))
        .build();
    };
  `,
  );
  const context = buildPipelineContext({ cwd, ticket: "PROJ-9" });
  mkdirSync(context.paths.artifactsDir!, { recursive: true });
  writeFileSync(context.paths.artifact("triage.json"), JSON.stringify({ verdict }));

  const previous = process.cwd();
  process.chdir(cwd);
  try {
    const code = await approvalCommand.run({
      ticket: "PROJ-9",
      approve: "triage-decision",
      approveOnly: true,
      pipelinePath: file,
    } as RunnerArgs);
    return { code, decision: join(context.paths.decisionsDir!, "triage-decision.json") };
  } finally {
    process.chdir(previous);
  }
}

test("approve-only refuses a subject the current verdict does not offer", async () => {
  const { code, decision } = await approveOnly("split");
  expect(code).toBe(1);
  expect(existsSync(decision)).toBe(false);
});

test("approve-only records the subject the current verdict offers", async () => {
  const { code, decision } = await approveOnly("decision");
  expect(code).toBe(0);
  expect(existsSync(decision)).toBe(true);
});
