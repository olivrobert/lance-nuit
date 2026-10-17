import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifact, source, textArtifact } from "../dsl/artifact.ts";
import type { ArtifactRef, WorkItemArtifactStore } from "../model/artifact-ports.ts";
import type { PipelineContext } from "../model/context.ts";
import { buildPipelineContext } from "../pipeline/context.ts";
import { sha256Text } from "./hash.ts";
import {
  adoptOutputs,
  fingerprintInputs,
  freshness,
  inputsUnchanged,
  mergeProvenance,
  outputFreshness,
  PROVENANCE_PREFIX,
  pureInputsOf,
  readInputs,
  readSource,
  SOURCE_TIMEOUT_MS,
  readProvenance,
  removeProvenance,
  revisedInPlace,
  stepFreshness,
  writeProvenance,
} from "./provenance.ts";

/** Map-keyed fake: provenance touches several artifacts at once, so a store that
 *  holds one value cannot express the situations under test. */
class FakeArtifactStore implements WorkItemArtifactStore {
  readonly values = new Map<string, string>();

  async exists(ref: ArtifactRef): Promise<boolean> {
    return this.values.has(ref.name);
  }

  async readText(ref: ArtifactRef): Promise<string | undefined> {
    return this.values.get(ref.name);
  }

  async readJson<T>(ref: ArtifactRef, parse: (value: unknown) => T): Promise<T | undefined> {
    const raw = this.values.get(ref.name);
    return raw === undefined ? undefined : parse(JSON.parse(raw));
  }

  async writeText(ref: ArtifactRef, value: string): Promise<void> {
    this.values.set(ref.name, value);
  }

  async remove(ref: ArtifactRef): Promise<void> {
    this.values.delete(ref.name);
  }
}

const ticket = textArtifact("ticket.md");
const spec = textArtifact("spec.md");
const plan = textArtifact("plan.md");

function fixture(): { ctx: PipelineContext; store: FakeArtifactStore } {
  const store = new FakeArtifactStore();
  const ctx = buildPipelineContext({ cwd: ".", ticket: "PROJ-1", artifacts: store });
  return { ctx, store };
}

test("fingerprintInputs: hashes present inputs and reports absent ones", async () => {
  const { ctx, store } = fixture();
  store.values.set("ticket.md", "one");

  expect(await fingerprintInputs(ctx, [ticket, spec])).toEqual({
    "artifacts/ticket.md": sha256Text("one"),
    "artifacts/spec.md": null,
  });
});

test("fingerprintInputs: a declared input without a ticket is an authoring error", async () => {
  const ctx = buildPipelineContext({ cwd: ".", artifacts: new FakeArtifactStore() });
  expect(fingerprintInputs(ctx, [ticket])).rejects.toThrow(/requires a ticket/);
});

test("writeProvenance: the record is stored under the reserved prefix", async () => {
  const { ctx, store } = fixture();
  store.values.set("ticket.md", "one");

  const record = await writeProvenance(ctx, spec, "spec", await fingerprintInputs(ctx, [ticket]));

  expect(record.artifact).toBe("artifacts/spec.md");
  expect(record.producedBy).toBe("spec");
  expect(store.values.has(`${PROVENANCE_PREFIX}spec.md.json`)).toBe(true);
  expect(await readProvenance(ctx, spec)).toEqual(record);
});

test("mergeProvenance: a revising step adds its inputs and keeps the first producer", async () => {
  const { ctx, store } = fixture();
  store.values.set("ticket.md", "one");
  store.values.set("spec.md", "s");
  await writeProvenance(ctx, plan, "plan", await fingerprintInputs(ctx, [ticket]));

  await mergeProvenance(ctx, plan, "plan-audit", await fingerprintInputs(ctx, [spec]));

  const record = await readProvenance(ctx, plan);
  expect(record?.producedBy).toBe("plan");
  expect(Object.keys(record?.inputs ?? {}).sort()).toEqual(["artifacts/spec.md", "artifacts/ticket.md"]);
});

test("removeProvenance: the record disappears with the artifact", async () => {
  const { ctx, store } = fixture();
  store.values.set("ticket.md", "one");
  await writeProvenance(ctx, spec, "spec", await fingerprintInputs(ctx, [ticket]));

  await removeProvenance(ctx, spec);

  expect(await readProvenance(ctx, spec)).toBeUndefined();
});

test("outputFreshness: reports the five admission states", async () => {
  const { ctx, store } = fixture();
  store.values.set("ticket.md", "one");

  // Absent output.
  expect(await outputFreshness(ctx, spec, await fingerprintInputs(ctx, [ticket]))).toBe("missing");

  // Present output, absent input: rerun rather than trust a missing comparison.
  store.values.set("spec.md", "written");
  expect(await outputFreshness(ctx, spec, await fingerprintInputs(ctx, [plan]))).toBe("unknown");

  // Present output, no record yet.
  expect(await outputFreshness(ctx, spec, await fingerprintInputs(ctx, [ticket]))).toBe("adoptable");

  await writeProvenance(ctx, spec, "spec", await fingerprintInputs(ctx, [ticket]));
  expect(await outputFreshness(ctx, spec, await fingerprintInputs(ctx, [ticket]))).toBe("fresh");

  store.values.set("ticket.md", "answered");
  expect(await outputFreshness(ctx, spec, await fingerprintInputs(ctx, [ticket]))).toBe("stale");
});

test("outputFreshness: an input the record does not list is stale", async () => {
  const { ctx, store } = fixture();
  store.values.set("ticket.md", "one");
  store.values.set("spec.md", "s");
  store.values.set("plan.md", "p");
  await writeProvenance(ctx, plan, "plan", await fingerprintInputs(ctx, [ticket]));

  expect(await outputFreshness(ctx, plan, await fingerprintInputs(ctx, [ticket, spec]))).toBe("stale");
});

test("stepFreshness: a step revising an output another step produced runs on its extra input", async () => {
  const { ctx, store } = fixture();
  const planAudit = textArtifact("plan-audit.json");
  store.values.set("spec.md", "s");
  store.values.set("plan.md", "p");
  store.values.set("plan-audit.json", "{}");
  // `plan` wrote plan.md from spec.md; `plan-audit.json` was never an input of it.
  await writeProvenance(ctx, plan, "plan", await fingerprintInputs(ctx, [spec]));
  const planRevise = { sources: [plan, planAudit], outputs: [plan] };

  expect(pureInputsOf(planRevise).map((entry) => entry.name)).toEqual(["plan-audit.json"]);
  const report = await stepFreshness(ctx, planRevise);
  expect(report.states).toEqual({ "plan.md": "stale" });
  expect(report.mustRun).toBe(true);
  expect(report.adoptable).toEqual([]);
});

test("stepFreshness: pure inputs exclude what the step revises in place", async () => {
  const { ctx, store } = fixture();
  store.values.set("ticket.md", "one");
  store.values.set("spec.md", "s");
  const step = { sources: [ticket, spec], outputs: [spec, plan] };

  expect(pureInputsOf(step).map((entry) => entry.name)).toEqual(["ticket.md"]);
  expect([...revisedInPlace(step)]).toEqual(["spec.md"]);

  const report = await stepFreshness(ctx, step);
  expect(Object.keys(report.fingerprints)).toEqual(["artifacts/ticket.md"]);
  expect(report.states).toEqual({ "spec.md": "adoptable", "plan.md": "missing" });
  expect(report.summary).toBe("missing");
  expect(report.mustRun).toBe(true);
});

test("inputsUnchanged: equal maps match, a changed byte or a different key set does not", async () => {
  const { ctx, store } = fixture();
  store.values.set("ticket.md", "one");
  const step = { sources: [ticket, spec], outputs: [plan] };
  const recorded = { "artifacts/ticket.md": sha256Text("one"), "artifacts/spec.md": null };

  // An input absent at absorption and still absent is unchanged.
  expect(await inputsUnchanged(ctx, step, recorded)).toBe(true);

  store.values.set("ticket.md", "two");
  expect(await inputsUnchanged(ctx, step, recorded)).toBe(false);

  store.values.set("ticket.md", "one");
  store.values.set("spec.md", "now present");
  expect(await inputsUnchanged(ctx, step, recorded)).toBe(false);

  store.values.delete("spec.md");
  // The definition gained or lost an input since the absorption.
  expect(await inputsUnchanged(ctx, { sources: [ticket], outputs: [plan] }, recorded)).toBe(false);
  expect(await inputsUnchanged(ctx, { sources: [ticket, spec, plan], outputs: [] }, recorded)).toBe(false);
  // Inputs the step revises in place are not compared.
  expect(await inputsUnchanged(ctx, { sources: [ticket, spec, plan], outputs: [plan] }, recorded)).toBe(true);
});

test("adoptOutputs: an output without a record keeps its content and gains fingerprints", async () => {
  const { ctx, store } = fixture();
  store.values.set("ticket.md", "one");
  store.values.set("spec.md", "written before this feature existed");
  const step = { sources: [ticket], outputs: [spec] };

  const report = await stepFreshness(ctx, step);
  expect(report.mustRun).toBe(false);
  expect(report.adoptable.map((entry) => entry.name)).toEqual(["spec.md"]);

  await adoptOutputs(ctx, "spec", report);

  expect(store.values.get("spec.md")).toBe("written before this feature existed");
  expect((await stepFreshness(ctx, step)).states["spec.md"]).toBe("fresh");
});

test("freshness: the public helper reads the artifact's own record", async () => {
  const { ctx, store } = fixture();

  expect(await freshness(ctx, spec)).toBe("missing");

  store.values.set("spec.md", "s");
  expect(await freshness(ctx, spec)).toBe("unknown");

  store.values.set("ticket.md", "one");
  await writeProvenance(ctx, spec, "spec", await fingerprintInputs(ctx, [ticket]));
  expect(await freshness(ctx, spec)).toBe("fresh");

  store.values.set("ticket.md", "answered");
  expect(await freshness(ctx, spec)).toBe("stale");

  store.values.delete("ticket.md");
  expect(await freshness(ctx, spec)).toBe("unknown");
});

test("readProvenance: a record that does not name its artifact is ignored", async () => {
  const { ctx, store } = fixture();
  store.values.set(
    `${PROVENANCE_PREFIX}spec.md.json`,
    JSON.stringify({ schemaVersion: 1, artifact: "artifacts/plan.md", producedBy: "x", producedAt: "x", inputs: {} }),
  );

  expect(await readProvenance(ctx, spec)).toBeUndefined();
});

test("artifact descriptors: the provenance prefix is reserved by the runner", () => {
  expect(() => textArtifact(`${PROVENANCE_PREFIX}spec.md.json`)).toThrow(/reserved/);
  expect(() => artifact(`${PROVENANCE_PREFIX}spec.json`, (value) => value)).toThrow(/reserved/);
});

const scratchDirs: string[] = [];

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixtureIn(cwd: string): { ctx: PipelineContext; store: FakeArtifactStore } {
  const store = new FakeArtifactStore();
  return { ctx: buildPipelineContext({ cwd, ticket: "PROJ-1", artifacts: store }), store };
}

function scratchDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "provenance-source-")));
  scratchDirs.push(dir);
  return dir;
}

test("readInputs: a source is the SHA-256 of its stdout, keyed apart from an artifact of the same name", async () => {
  const { ctx, store } = fixture();
  store.values.set("tree", "artifact bytes");
  const tree = source("tree", { command: "printf 'HEAD\\n'; printf 'diff' >&2" });

  const reading = await readInputs(ctx, [textArtifact("tree"), tree]);

  // stderr is not content: only stdout is fingerprinted.
  expect(reading).toEqual({
    fingerprints: { "artifacts/tree": sha256Text("artifact bytes"), "source:tree": sha256Text("HEAD\n") },
    unavailable: [],
  });
});

test("readSource: runs in the context's working directory, without the runner's internal variables", async () => {
  const cwd = scratchDir();
  const previous = process.env.RUNNER_LOCK_HELD;
  process.env.RUNNER_LOCK_HELD = "1";
  const { ctx } = fixtureIn(cwd);

  try {
    const stdout = await readSource(ctx, source("where", { command: "pwd; printenv RUNNER_LOCK_HELD || echo unset" }));
    expect(stdout).toBe(`${cwd}\nunset\n`);
  } finally {
    if (previous === undefined) delete process.env.RUNNER_LOCK_HELD;
    else process.env.RUNNER_LOCK_HELD = previous;
  }
});

test("readSource: a function command is resolved against the context", async () => {
  const { ctx } = fixture();
  expect(await readSource(ctx, source("ticket", { command: (c) => `echo ${c.ticket}` }))).toBe("PROJ-1\n");
});

test("readInputs: a failing source is null and unavailable, with the exit code and stderr as reason", async () => {
  const { ctx } = fixture();
  const tree = source("tree", { command: "echo partial; echo 'not a git repository' >&2; exit 128" });

  const reading = await readInputs(ctx, [tree]);

  expect(reading.fingerprints).toEqual({ "source:tree": null });
  expect(reading.unavailable).toHaveLength(1);
  expect(reading.unavailable[0]?.source).toBe("tree");
  expect(reading.unavailable[0]?.reason).toContain("exit code 128");
  expect(reading.unavailable[0]?.reason).toContain("not a git repository");
});

test("readInputs: a source is hashed on its raw bytes, not on their UTF-8 decoding", async () => {
  const { ctx } = fixture();
  // Latin-1 e-acute and e-grave: invalid UTF-8, both decoded to the replacement character.
  const acute = source("tree", { command: "printf '\\351'" });
  const grave = source("tree", { command: "printf '\\350'" });

  expect(await readSource(ctx, acute)).toBe(await readSource(ctx, grave));
  const [first, second] = [await readInputs(ctx, [acute]), await readInputs(ctx, [grave])];
  expect(first.fingerprints["source:tree"]).not.toBe(second.fingerprints["source:tree"]);
});

test("readInputs: a command that resolves to blanks is unavailable, not an empty fingerprint", async () => {
  const { ctx } = fixture();

  const reading = await readInputs(ctx, [source("tree", { command: () => "  " })]);

  expect(reading.fingerprints).toEqual({ "source:tree": null });
  expect(reading.unavailable).toEqual([
    { source: "tree", reason: 'source "tree": command resolved to an empty string' },
  ]);
});

test("readSource: a source is bounded to 30 s, like an admission command", () => {
  expect(SOURCE_TIMEOUT_MS).toBe(30_000);
});

test("readSource: a command that outlives its bound is killed and reported as timed out", async () => {
  const { ctx } = fixture();
  const started = Date.now();

  const read = readSource(ctx, source("slow", { command: "sleep 5" }), 200);

  await expect(read).rejects.toThrow(/source "slow": command timed out after 0.2s/);
  expect(Date.now() - started).toBeLessThan(4_000);
});

test("stepFreshness: a source makes the output stale when its stdout moves, unknown when it fails", async () => {
  const cwd = scratchDir();
  const { ctx, store } = fixtureIn(cwd);
  const tree = source("tree", { command: "cat state.txt" });
  const step = { sources: [plan, tree], outputs: [spec] };
  writeFileSync(join(cwd, "state.txt"), "v1");
  store.values.set("plan.md", "plan");
  store.values.set("spec.md", "spec");
  await writeProvenance(ctx, spec, "implement", await fingerprintInputs(ctx, pureInputsOf(step)));

  expect((await stepFreshness(ctx, step)).summary).toBe("fresh");
  writeFileSync(join(cwd, "state.txt"), "v2");
  expect((await stepFreshness(ctx, step)).summary).toBe("stale");
  rmSync(join(cwd, "state.txt"));
  const unreadable = await stepFreshness(ctx, step);
  expect(unreadable.summary).toBe("unknown");
  expect(unreadable.mustRun).toBe(true);
  expect(unreadable.unavailable.map((entry) => entry.source)).toEqual(["tree"]);
});

test("inputsUnchanged: a source unreadable then and now is not unchanged", async () => {
  const { ctx } = fixture();
  const step = { sources: [source("tree", { command: "exit 1" })], outputs: [spec] };

  expect(await inputsUnchanged(ctx, step, { "source:tree": null })).toBe(false);
});

test("pureInputsOf: a source named like an output stays a pure input, never revised in place", () => {
  const tree = source("spec.md", { command: "true" });
  const step = { sources: [spec, tree], outputs: [spec] };

  expect(pureInputsOf(step)).toEqual([tree]);
  expect([...revisedInPlace(step)]).toEqual(["spec.md"]);
});

test("freshness: a record bound to a source is unknown, unless an artifact input already made it stale", async () => {
  const { ctx, store } = fixture();
  store.values.set("ticket.md", "one");
  store.values.set("spec.md", "spec");
  const fingerprints = { ...(await fingerprintInputs(ctx, [ticket])), "source:tree": sha256Text("HEAD") };
  await writeProvenance(ctx, spec, "spec", fingerprints);

  expect(await freshness(ctx, spec)).toBe("unknown");
  store.values.set("ticket.md", "two");
  expect(await freshness(ctx, spec)).toBe("stale");
});

test("freshness: a record bound to a source that was unreadable is unknown, never fresh", async () => {
  const { ctx, store } = fixture();
  store.values.set("ticket.md", "one");
  store.values.set("spec.md", "spec");
  await writeProvenance(ctx, spec, "spec", { ...(await fingerprintInputs(ctx, [ticket])), "source:tree": null });

  expect(await freshness(ctx, spec)).toBe("unknown");
});

test("revisedInPlace: a source named like an output does not make that output revised in place", () => {
  const step = { sources: [source("spec.md", { command: "true" })], outputs: [spec] };

  expect([...revisedInPlace(step)]).toEqual([]);
});

test("source descriptors: a name and a command are required", () => {
  expect(() => source(" ", { command: "true" })).toThrow(/name must be a non-empty string/);
  expect(() => source("tree", { command: " " })).toThrow(/command must be a non-empty string or a function/);
  expect(source("tree", { command: "true" })).toMatchObject({ kind: "source", name: "tree", command: "true" });
});
