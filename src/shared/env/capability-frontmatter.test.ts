import { expect, test } from "bun:test";
import { delimiter, join } from "node:path";
import { capabilityRoots } from "./capability-frontmatter.ts";

test("capabilityRoots: a standalone checkout does not walk up two levels", () => {
  const roots = capabilityRoots("/tmp/lance-nuit", "/tmp/project", {});

  expect(roots.slice(0, 2)).toEqual(["/tmp/lance-nuit", "/tmp/project/.claude"]);
  expect(roots.at(-1)).toMatch(/[/\\]\.claude$/);
});

test("capabilityRoots: does not infer a root from a neighboring layout", () => {
  expect(capabilityRoots("/tmp/kit/lance-nuit/runner", "/tmp/project", {}).slice(0, 2)).toEqual([
    "/tmp/kit/lance-nuit/runner",
    "/tmp/project/.claude",
  ]);
});

test("capabilityRoots: PIPELINE_CAPABILITY_ROOTS prepends explicit roots", () => {
  const first = join("/tmp", "capabilities-a");
  const second = join("/tmp", "capabilities-b");
  const roots = capabilityRoots("/tmp/lance-nuit", "/tmp/project", {
    PIPELINE_CAPABILITY_ROOTS: [first, second].join(delimiter),
  });

  expect(roots.slice(0, 2)).toEqual([first, second]);
});
