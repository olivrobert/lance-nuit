import { expect, test } from "bun:test";
import { skipUnlessCommand } from "../dsl/input.js";
import type { PipelineContext } from "../model/context.js";
import type { RunStep } from "../model/run.js";
import { checkInputs } from "./step-admission.js";

const step = { def: { id: "guard", name: "Guard" } } as unknown as RunStep;
const ctx = {} as PipelineContext;

test("checkInputs: a guard refusing on stderr yields its text as the reason, without the stream marker", async () => {
  const decision = await checkInputs(step, ctx, [
    skipUnlessCommand("echo '3 commit(s) already on the branch — refused' >&2; exit 1"),
  ]);
  expect(decision).toEqual({ action: "skip", reason: "3 commit(s) already on the branch — refused" });
});

test("checkInputs: a silent refusal falls back to the command itself", async () => {
  const decision = await checkInputs(step, ctx, [skipUnlessCommand("false")]);
  expect(decision).toEqual({ action: "skip", reason: "false" });
});
