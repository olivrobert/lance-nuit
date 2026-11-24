import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { source, textArtifact } from "../../definition/dsl/artifact.js";
import { buildPipelineContext } from "../../definition/pipeline/context.js";
import type { ArtifactRef, WorkItemArtifactStore } from "../../shared/language/artifact-ports.js";
import type { PipelineContext } from "../../shared/language/context.js";
import { sha256Text } from "./hash.js";
import { clearStamp, commitPass, readInputs, readLock, type StepStamp, stampKey, stepFreshness } from "./step-lock.js";

const MODULE = resolve(import.meta.dir, "step-lock.ts");

function lockContext(initial: Record<string, string> = {}): { values: Map<string, string>; ctx: PipelineContext } {
  const values = new Map<string, string>(Object.entries(initial));
  const store: WorkItemArtifactStore = {
    exists: async (ref: ArtifactRef) => values.has(ref.name),
    readText: async (ref: ArtifactRef) => values.get(ref.name),
    readJson: async () => undefined,
    writeText: async (ref: ArtifactRef, next: string) => {
      values.set(ref.name, next);
    },
    remove: async (ref: ArtifactRef) => {
      values.delete(ref.name);
    },
  };
  const cwd = mkdtempSync(join(tmpdir(), "step-lock-"));
  return { values, ctx: buildPipelineContext({ cwd, ticket: "PROJ-1", artifacts: store }) };
}

const ticket = textArtifact("ticket.md");
const plan = textArtifact("plan.md");
const step = { id: "plan", sources: [ticket], outputs: [plan] };

function stamp(inputs: StepStamp["inputs"], outputs: StepStamp["outputs"]): StepStamp {
  return { pipeline: "p", runId: "r", stampedAt: "2026-01-01T00:00:00.000Z", inputs, outputs };
}

async function stampNow(ctx: PipelineContext, io: typeof step): Promise<void> {
  const inputs = (await readInputs(ctx, io.sources)).fingerprints;
  const outputs = (await readInputs(ctx, io.outputs)).fingerprints as Record<string, string>;
  commitPass(ctx, io.id, stamp(inputs, outputs), []);
}

// ── stepFreshness follows the table, line by line (L7) ───────────────────────

test("freshness 1 (L7): no stamp under the key is none, with the readings of the inputs", async () => {
  const { ctx } = lockContext({ "ticket.md": "t" });
  expect(await stepFreshness(ctx, step, "plan")).toEqual({
    value: "none",
    inputs: { "artifacts/ticket.md": sha256Text("t") },
    unavailable: [],
  });
});

test("freshness 2 (L7): a stamp over other input or output keys is stale", async () => {
  const { ctx } = lockContext({ "ticket.md": "t", "plan.md": "p" });
  await stampNow(ctx, step);
  expect((await stepFreshness(ctx, { ...step, sources: [ticket, textArtifact("ac.md")] }, "plan")).value).toBe("stale");
  expect((await stepFreshness(ctx, { ...step, outputs: [plan, textArtifact("audit.md")] }, "plan")).value).toBe(
    "stale",
  );
});

test("freshness 3 (L7): a source failing now, or recorded null, is stale with unavailable", async () => {
  const { ctx } = lockContext({ "plan.md": "p" });
  const failing = { id: "s", sources: [source("tree", { command: "exit 3" })], outputs: [plan] };
  commitPass(ctx, "s", stamp({ "source:tree": sha256Text("x") }, { "artifacts/plan.md": sha256Text("p") }), []);
  const now = await stepFreshness(ctx, failing, "s");
  expect(now.value).toBe("stale");
  expect(now.unavailable).toEqual([{ source: "tree", reason: expect.stringContaining("tree") }]);

  const steady = { id: "s", sources: [source("tree", { command: "echo ok" })], outputs: [plan] };
  commitPass(ctx, "s", stamp({ "source:tree": null }, { "artifacts/plan.md": sha256Text("p") }), []);
  expect(await stepFreshness(ctx, steady, "s")).toMatchObject({ value: "stale", unavailable: [] });
});

test("freshness 4 (L7): an artifact input that changed is stale; absent then and now is unchanged", async () => {
  const { values, ctx } = lockContext({ "plan.md": "p" });
  await stampNow(ctx, step);
  expect((await stepFreshness(ctx, step, "plan")).value).toBe("fresh");
  values.set("ticket.md", "appeared");
  expect((await stepFreshness(ctx, step, "plan")).value).toBe("stale");
});

test("freshness 4 (L7): a source whose stdout changed is stale, as an artifact would be", async () => {
  const { ctx } = lockContext({ "plan.md": "p" });
  const tree = { id: "s", sources: [source("tree", { command: "echo now" })], outputs: [plan] };
  commitPass(ctx, "s", stamp({ "source:tree": sha256Text("then\n") }, { "artifacts/plan.md": sha256Text("p") }), []);
  expect((await stepFreshness(ctx, tree, "s")).value).toBe("stale");
  commitPass(ctx, "s", stamp({ "source:tree": sha256Text("now\n") }, { "artifacts/plan.md": sha256Text("p") }), []);
  expect((await stepFreshness(ctx, tree, "s")).value).toBe("fresh");
});

test("freshness 5 (L7): an output absent or rewritten is stale", async () => {
  const { values, ctx } = lockContext({ "ticket.md": "t", "plan.md": "p" });
  await stampNow(ctx, step);
  values.set("plan.md", "edited");
  expect((await stepFreshness(ctx, step, "plan")).value).toBe("stale");
  values.delete("plan.md");
  expect((await stepFreshness(ctx, step, "plan")).value).toBe("stale");
});

test("freshness 6 (L7): otherwise fresh; artifactsOnly neither reads nor compares sources", async () => {
  const { ctx } = lockContext({ "ticket.md": "t", "plan.md": "p" });
  const tree = source("tree", { command: "exit 1" });
  const withTree = { ...step, sources: [ticket, tree] };
  commitPass(
    ctx,
    "plan",
    stamp(
      { "artifacts/ticket.md": sha256Text("t"), "source:tree": sha256Text("old") },
      { "artifacts/plan.md": sha256Text("p") },
    ),
    [],
  );
  expect((await stepFreshness(ctx, withTree, "plan")).value).toBe("stale");
  expect(await stepFreshness(ctx, withTree, "plan", { artifactsOnly: true })).toMatchObject({
    value: "fresh",
    unavailable: [],
  });
});

// ── Writes ───────────────────────────────────────────────────────────────────

test("an absent lock reads empty; an unreadable one fails closed and names its path (L14)", () => {
  const { ctx } = lockContext();
  const dir = ctx.paths.workItemDir!;
  expect(readLock(dir)).toEqual({ schemaVersion: 1, steps: {} });
  mkdirSync(join(dir, "artifacts"), { recursive: true });
  writeFileSync(join(dir, "artifacts", "lock.json"), JSON.stringify({ schemaVersion: 2, steps: {} }));
  expect(() => readLock(dir)).toThrow(join(dir, "artifacts", "lock.json"));
  expect(() => clearStamp(ctx, "plan")).toThrow("unreadable");
});

test("clearStamp removes one key; commitPass writes one stamp and the advances that still hold", () => {
  const { ctx } = lockContext();
  commitPass(ctx, "a", stamp({ "source:tree": "1".repeat(64) }, {}), []);
  commitPass(ctx, "b", stamp({}, {}), []);
  clearStamp(ctx, "b");
  commitPass(ctx, "r", undefined, [
    { key: "a", source: "source:tree", before: "1".repeat(64), after: "2".repeat(64) },
    { key: "a", source: "source:tree", before: "9".repeat(64), after: "3".repeat(64) },
  ]);
  expect(readLock(ctx.paths.workItemDir!).steps).toEqual({ a: stamp({ "source:tree": "2".repeat(64) }, {}) });
});

test("a lot keys its steps apart", () => {
  expect(stampKey("plan")).toBe("plan");
  expect(stampKey("plan", { id: "LOT-2", title: "t", risk: 1 } as never)).toBe("LOT-2/plan");
});

test("a write waits for another live holder of lock.json.lock, then takes it (L1)", () => {
  const { ctx } = lockContext();
  const artifacts = join(ctx.paths.workItemDir!, "artifacts");
  mkdirSync(artifacts, { recursive: true });
  const holder = spawn("sleep", ["5"]);
  writeFileSync(join(artifacts, "lock.json.lock"), JSON.stringify({ pid: holder.pid }));
  const release = spawn("bash", ["-c", `sleep 0.3; rm -f ${JSON.stringify(join(artifacts, "lock.json.lock"))}`]);
  try {
    const started = Date.now();
    commitPass(ctx, "plan", stamp({}, {}), []);
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(readLock(ctx.paths.workItemDir!).steps.plan).toBeDefined();
    expect(readdirSync(artifacts).sort()).toEqual(["lock.json"]);
  } finally {
    holder.kill();
    release.kill();
  }
});

test("two processes stamping two steps at once both keep their entry, and a reader never sees a torn file (L1, L2)", async () => {
  const { ctx } = lockContext();
  const dir = ctx.paths.workItemDir!;
  const writer = (key: string) =>
    new Promise<number | null>((done) => {
      const child = spawn(process.execPath, [
        "-e",
        `const { commitPass } = await import(${JSON.stringify(MODULE)});
         const ctx = { paths: { workItemDir: ${JSON.stringify(dir)} } };
         for (let i = 0; i < 40; i++) {
           commitPass(ctx, ${JSON.stringify(key)} + "-" + i,
             { pipeline: "p", runId: "r", stampedAt: "t", inputs: {}, outputs: {} }, []);
         }`,
      ]);
      child.on("exit", done);
    });
  const reader = spawn(process.execPath, [
    "-e",
    `const { readFileSync } = await import("node:fs");
     let torn = 0;
     const end = Date.now() + 1500;
     while (Date.now() < end) {
       try { JSON.parse(readFileSync(${JSON.stringify(join(dir, "artifacts", "lock.json"))}, "utf8")); }
       catch (error) { if (error.code !== "ENOENT") torn++; }
     }
     process.stdout.write(String(torn));`,
  ]);
  let torn = "";
  reader.stdout.on("data", (chunk) => {
    torn += chunk;
  });
  const readerDone = new Promise((done) => reader.on("exit", done));

  expect(await Promise.all([writer("a"), writer("b")])).toEqual([0, 0]);
  await readerDone;

  const keys = Object.keys(readLock(dir).steps);
  expect(keys).toHaveLength(80);
  expect(torn).toBe("0");
  expect(existsSync(join(dir, "artifacts", "lock.json.lock"))).toBe(false);
});

test("lock.json is named by the layout alone: no other runner source builds its path (L1)", () => {
  const found = spawnSync(
    "grep",
    ["-rl", "--include=*.ts", "--exclude=*.test.ts", '"lock.json"', resolve(import.meta.dir, "../..")],
    {
      encoding: "utf8",
    },
  );
  expect(found.stdout.trim().split("\n").filter(Boolean)).toEqual([resolve(import.meta.dir, "layout.ts")]);
});
