import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPipelineConfig } from "../env/config.js";
import { buildPipelineContext } from "./context.js";

test("buildPipelineContext: a work item linked to the main clone yields its real paths", () => {
  const main = realpathSync(mkdtempSync(join(tmpdir(), "ctx-main-")));
  const wt = mkdtempSync(join(tmpdir(), "ctx-wt-"));
  mkdirSync(join(main, "P-1"), { recursive: true });
  mkdirSync(join(wt, ".lance-nuit", "work-items"), { recursive: true });
  symlinkSync(join(main, "P-1"), join(wt, ".lance-nuit", "work-items", "P-1"));

  const ctx = buildPipelineContext({ cwd: wt, ticket: "P-1", config: loadPipelineConfig(wt) });

  expect(ctx.paths.workItemDir).toBe(join(main, "P-1"));
  expect(ctx.paths.artifactsDir).toBe(join(main, "P-1", "artifacts"));
  expect(ctx.paths.artifact("plan.md")).toBe(join(main, "P-1", "artifacts", "plan.md"));
});

test("buildPipelineContext: a sub-US not created yet resolves through its linked parent", () => {
  const main = realpathSync(mkdtempSync(join(tmpdir(), "ctx-main-")));
  const wt = mkdtempSync(join(tmpdir(), "ctx-wt-"));
  mkdirSync(join(main, "P-1"), { recursive: true });
  mkdirSync(join(wt, ".lance-nuit", "work-items"), { recursive: true });
  symlinkSync(join(main, "P-1"), join(wt, ".lance-nuit", "work-items", "P-1"));

  const ctx = buildPipelineContext({ cwd: wt, ticket: "P-1-01", config: loadPipelineConfig(wt) });

  expect(ctx.paths.workItemDir).toBe(join(main, "P-1", "US-01"));
});
