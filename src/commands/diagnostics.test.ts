import { expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import type { RunnerArgs } from "../model/cli-options.js";
import { inspectCommand } from "./diagnostics.js";

/**
 * `inspect` is a query, not progress prose: its report is the command's result,
 * so it must survive `lancenuit inspect PROJ-1 > file` and a pipe into `grep`.
 * stderr stays reserved for the execution log (runtime/logging.ts).
 */
test("inspect: the report goes to stdout, not to stderr", () => {
  const out: string[] = [];
  const err: string[] = [];
  const stdout = spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  });
  const stderr = spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    err.push(String(chunk));
    return true;
  });
  const cwd = process.cwd();
  process.chdir(mkdtempSync(`${tmpdir()}/lancenuit-inspect-`));
  let code: number | Promise<number>;
  try {
    code = inspectCommand.run({ ticket: "PROJ-1" } as RunnerArgs);
  } finally {
    process.chdir(cwd);
    stdout.mockRestore();
    stderr.mockRestore();
  }

  expect(code).toBe(0);
  expect(out.join("")).toBe("No run found for PROJ-1.\n");
  expect(err.join("")).toBe("");
});
