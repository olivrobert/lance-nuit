import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUN_ORIGINS_DIR, recordRunOrigin } from "./run-origin.ts";

const kit = () => mkdtempSync(join(tmpdir(), "run-origin-"));
const run = {
  runId: "20261119T141930.426Z-autonome-local-5f8b1a",
  run_dir: "/proj/.lance-nuit/work-items/X-1/runs/p/r",
};
const at = () => new Date("2026-11-19T14:19:30.000Z");

test("records the caller's origin and the run directory under the user kit", () => {
  const home = kit();
  const file = recordRunOrigin(run, { PIPELINE_HOME: home, LANCENUIT_ORIGIN: "chief:f-42" }, at);
  expect(file).toBe(join(home, RUN_ORIGINS_DIR, `${run.runId}.json`));
  expect(JSON.parse(readFileSync(file ?? "", "utf-8"))).toEqual({
    origin: "chief:f-42",
    runId: run.runId,
    runDir: run.run_dir,
    recordedAt: "2026-11-19T14:19:30.000Z",
  });
});

test("the last caller wins on resume", () => {
  const home = kit();
  recordRunOrigin(run, { PIPELINE_HOME: home, LANCENUIT_ORIGIN: "chief:first" }, at);
  const file = recordRunOrigin(run, { PIPELINE_HOME: home, LANCENUIT_ORIGIN: "chief:second" }, at);
  expect(JSON.parse(readFileSync(file ?? "", "utf-8")).origin).toBe("chief:second");
});

test("writes nothing without the variable", () => {
  const home = kit();
  expect(recordRunOrigin(run, { PIPELINE_HOME: home }, at)).toBeNull();
  expect(existsSync(join(home, RUN_ORIGINS_DIR))).toBe(false);
});

test("ignores an origin that is not a plain name", () => {
  const home = kit();
  expect(recordRunOrigin(run, { PIPELINE_HOME: home, LANCENUIT_ORIGIN: "../x; rm -rf /" }, at)).toBeNull();
  expect(existsSync(join(home, RUN_ORIGINS_DIR))).toBe(false);
});

test("an unwritable kit never fails the run", () => {
  const home = kit();
  chmodSync(home, 0o500);
  try {
    expect(recordRunOrigin(run, { PIPELINE_HOME: home, LANCENUIT_ORIGIN: "chief:f-42" }, at)).toBeNull();
  } finally {
    chmodSync(home, 0o700);
  }
  expect(readdirSync(home)).toEqual([]);
});
