import { expect, test } from "bun:test";
import type { Run } from "../model/run.js";
import { createAbortScope } from "./abort.js";

function run(name: string): Run {
  return { name, pipeline: name, pipeline_path: `${name}.ts`, run_dir: `/tmp/${name}`, steps: [] };
}

test("abort scope: two scopes never observe each other", () => {
  const a = createAbortScope();
  const b = createAbortScope();
  const ra = run("a");
  const rb = run("b");
  a.registerActiveRun(ra);
  b.registerActiveRun(rb);

  a.requestAbort("SIGINT");

  expect(a.isAbortRequested()).toBe(true);
  expect(a.isRunAborted(ra)).toBe(true);
  expect(b.isAbortRequested()).toBe(false);
  expect(b.isRunAborted(rb)).toBe(false);
  expect(b.requestedSignal()).toBeUndefined();
  expect(a.activeRuns()).toEqual([ra]);
  expect(b.activeRuns()).toEqual([rb]);
});

test("abort scope: a run is aborted by its own flag or by the scope, and the first signal wins", () => {
  const scope = createAbortScope();
  expect(scope.isRunAborted({ aborted: false })).toBe(false);
  expect(scope.isRunAborted({ aborted: true })).toBe(true);

  scope.requestAbort("SIGTERM");
  scope.requestAbort("SIGINT");

  expect(scope.isRunAborted({})).toBe(true);
  expect(scope.requestedSignal()).toBe("SIGTERM");
});

test("abort scope: active runs are listed innermost first and leave on unregister", () => {
  const scope = createAbortScope();
  const parent = run("parent");
  const child = run("child");
  const leaveParent = scope.registerActiveRun(parent);
  const leaveChild = scope.registerActiveRun(child);

  expect(scope.activeRuns()).toEqual([child, parent]);

  leaveChild();
  expect(scope.activeRuns()).toEqual([parent]);
  // Unregistering twice is harmless.
  leaveChild();
  leaveParent();
  expect(scope.activeRuns()).toEqual([]);
});
