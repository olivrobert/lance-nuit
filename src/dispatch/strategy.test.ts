// Single selection point replacing logic previously scattered across three main()
// zones separated by lock and ticket validation.

import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pipeline } from "../model/definition.ts";
import { buildPipelineContext } from "../pipeline/context.ts";
import { parseRunnerArgs } from "../cli/parse.ts";
import { scanStrategy } from "./scan.ts";
import { selectDispatch, validateDispatchArgs } from "./strategy.ts";

const def: Pipeline = { name: "p", steps: [] };

function ctxFor(root: string, ticket?: string) {
  return buildPipelineContext({ cwd: root, ticket });
}

test("--scan selects the scan strategy", () => {
  const root = mkdtempSync(join(tmpdir(), "dispatch-select-"));
  expect(selectDispatch(parseRunnerArgs(["--scan"]), def, ctxFor(root), {})).toBe(scanStrategy);
});

test("a single ticket dispatches nothing: run executes in place", () => {
  const root = mkdtempSync(join(tmpdir(), "dispatch-select-"));
  expect(selectDispatch(parseRunnerArgs(["PROJ-1"]), def, ctxFor(root, "PROJ-1"), {})).toBeNull();
});

test("without ticket or --scan: nothing to dispatch", () => {
  const root = mkdtempSync(join(tmpdir(), "dispatch-select-"));
  expect(selectDispatch(parseRunnerArgs([]), def, ctxFor(root), {})).toBeNull();
});

test("RUNNER_DISABLE_DISPATCH disables ALL dispatch — child recursion guard", () => {
  const root = mkdtempSync(join(tmpdir(), "dispatch-select-"));
  const env = { RUNNER_DISABLE_DISPATCH: "1" };
  expect(selectDispatch(parseRunnerArgs(["PROJ-1"]), def, ctxFor(root, "PROJ-1"), env)).toBeNull();
  expect(selectDispatch(parseRunnerArgs(["--scan"]), def, ctxFor(root), env)).toBeNull();
});

test("ticket forbidden: --scan with positional argument rejected before side effects", () => {
  expect(validateDispatchArgs(parseRunnerArgs(["--scan", "PROJ-28"]))).toBe(
    "--scan does not accept a ticket (it discovers tickets in the tracker).",
  );
  expect(validateDispatchArgs(parseRunnerArgs(["--scan"]))).toBeNull();
  expect(validateDispatchArgs(parseRunnerArgs(["PROJ-28"]))).toBeNull();
});
