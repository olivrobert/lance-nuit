// The architecture gate is only worth what it catches. These tests run the real
// `.dependency-cruiser.cjs` and the real `scripts/check-deps.mjs` against tiny
// trees under fixtures/, each built to break exactly one guarantee, plus the
// baseline rules themselves: a stale entry, an unjustified entry, and the
// refusal to refill an empty baseline.
//
// The `folder-cycle-*` fixtures cover the second baseline, the one holding
// folder cycles: none of them contains a file-level cycle, so a folder cycle
// they raise can only come from the grouped graph.
//
// The module checks run on the real `MODULES`: the entry-only rules on the
// `module-entry-only` fixture, and the entry-existence check on a temporary root
// (`--modules-root`) holding every declared entry but one.
//
// Since the real config declares modules and contexts (scripts/layers.cjs), a
// fixture that imports across folders uses folders of one context that no module
// claims, such as `definition/validation/` and `definition/pipeline/`: otherwise an
// entry-only or a direction rule would fire on top of the guarantee under test.

import { afterAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CONFIG = join(REPO_ROOT, ".dependency-cruiser.cjs");
const CHECK_DEPS = join(REPO_ROOT, "scripts/check-deps.mjs");
// The package entry point rather than `.bin/depcruise`, whose `node` shebang is not
// honoured on a Bun-only machine; it is spawned with `process.execPath` below.
const DEPCRUISE = join(REPO_ROOT, "node_modules/dependency-cruiser/bin/dependency-cruise.mjs");
const { MODULES, moduleEntries } = createRequire(import.meta.url)(join(REPO_ROOT, "scripts/layers.cjs")) as {
  MODULES: { name: string; path: string; entry: string; otherEntries?: string[] }[];
  moduleEntries: (module: { entry: string; otherEntries?: string[] }) => string[];
};

const MAX_CONCURRENT = 4;
let activeProcesses = 0;
const waitQueue: Array<() => void> = [];
const tempDirectories: string[] = [];
const violationsCache = new Map<string, Promise<{ rule: string; from: string }[]>>();

afterAll(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeTempDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  tempDirectories.push(directory);
  return directory;
}

async function runProcess(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  if (activeProcesses >= MAX_CONCURRENT) {
    await new Promise<void>((resolveSlot) => waitQueue.push(resolveSlot));
  }
  activeProcesses += 1;
  try {
    return await new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(command, args, { cwd });
      let stdout = "";
      let stderr = "";
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", rejectPromise);
      child.on("close", (status) => {
        resolvePromise({ status, stdout, stderr });
      });
    });
  } finally {
    activeProcesses -= 1;
    waitQueue.shift()?.();
  }
}

function fixture(name: string): string {
  return join(REPO_ROOT, "tests/deps/fixtures", name);
}

/** Violations raised by cruising the fixture with the repository's own config, memoized per fixture. */
function violationsIn(name: string): Promise<{ rule: string; from: string }[]> {
  const cached = violationsCache.get(name);
  if (cached) return cached;
  const pending = runProcess(
    process.execPath,
    [DEPCRUISE, "--config", CONFIG, "--output-type", "json", "src"],
    fixture(name),
  ).then((run) => {
    const report = JSON.parse(run.stdout) as {
      summary: { violations: { rule: { name: string }; from: string }[] };
    };
    return report.summary.violations.map((violation) => ({ rule: violation.rule.name, from: violation.from }));
  });
  violationsCache.set(name, pending);
  return pending;
}

/** Rule names raised by cruising the fixture with the repository's own config. */
async function rulesRaisedIn(name: string): Promise<string[]> {
  return [...new Set((await violationsIn(name)).map((violation) => violation.rule))].sort();
}

async function checkDeps(
  name: string,
  baseline: unknown,
  extraArgs: string[] = [],
  folderBaseline: unknown = [],
): Promise<{ status: number | null; output: string }> {
  const directory = makeTempDirectory("lance-nuit-deps-");
  const baselinePath = join(directory, "baseline.json");
  const folderBaselinePath = join(directory, "folder-baseline.json");

  writeFileSync(baselinePath, JSON.stringify(baseline));
  writeFileSync(folderBaselinePath, JSON.stringify(folderBaseline));

  const run = await runProcess(
    process.execPath,
    [CHECK_DEPS, "--config", CONFIG, "--baseline", baselinePath, "--folder-baseline", folderBaselinePath, ...extraArgs],
    fixture(name),
  );

  return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

/** A folder-cycle baseline entry, justified and dated as the check demands. */
function folderEdge(from: string, to: string): Record<string, string> {
  return { from, to, why: "fixture", reviewedOn: "2026-09-06", removedBy: "fixture" };
}

/** The only edge the `upward` fixture raises, justified as the baseline demands. */
const UPWARD_EDGE = {
  rule: "layer-0-no-upward",
  from: "src/shared/lib/a.ts",
  to: "src/shared/env/config.ts",
  why: "fixture",
  reviewedOn: "2026-09-06",
};

test.concurrent("a file of shared importing a higher level raises its level rule", async () => {
  expect(await rulesRaisedIn("upward")).toContain("layer-0-no-upward");
});

test.concurrent("an import against the declared direction raises its context rule", async () => {
  expect(await violationsIn("context-direction")).toContainEqual({
    rule: "context-definition-direction",
    from: "src/definition/validation/upstream.ts",
  });
});

test.concurrent("an import in the declared direction raises nothing", async () => {
  const raisedByDownstream = (await violationsIn("context-direction")).filter(
    (violation) => violation.from === "src/execution/dispatch/downstream.ts",
  );

  expect(raisedByDownstream).toEqual([]);
});

test.concurrent("a new file in the closed list of shared must be claimed, though its level is known", async () => {
  const result = await checkDeps("context-unclassified", []);

  expect(result.status).not.toBe(0);
  expect(result.output).toContain("file in no context: src/shared/env/a.ts");
  expect(result.output).not.toContain("in no level");
});

test.concurrent("an import past the facade of another context raises its entry-only rule", async () => {
  expect(await violationsIn("facade")).toContainEqual({
    rule: "module-run-entry-only",
    from: "src/execution/past-facade.ts",
  });
});

test.concurrent("an import through the facade of another context raises nothing", async () => {
  const raised = (await violationsIn("facade")).filter(
    (violation) => violation.from === "src/execution/through-facade.ts",
  );

  expect(raised).toEqual([]);
});

test.concurrent("a file importing the facade of its own context raises its rule", async () => {
  expect(await violationsIn("facade")).toContainEqual({
    rule: "context-run-no-own-facade",
    from: "src/run/own-facade.ts",
  });
});

test.concurrent("an import past a module's entry raises its entry-only rule", async () => {
  expect(await violationsIn("module-entry-only")).toContainEqual({
    rule: "module-read-model-entry-only",
    from: "src/entry/commands/deep.ts",
  });
});

test.concurrent("an import through a module's entry raises nothing", async () => {
  const raisedByEntryImport = (await violationsIn("module-entry-only")).filter(
    (violation) => violation.from === "src/entry/commands/through-entry.ts",
  );

  expect(raisedByEntryImport).toEqual([]);
});

/** The only edge past an entry the `module-entry-only` fixture raises, as a baseline would record it. */
const PAST_ENTRY_EDGE = {
  rule: "module-read-model-entry-only",
  from: "src/entry/commands/deep.ts",
  to: "src/dashboard/read-model/internal.ts",
  why: "fixture",
  reviewedOn: "2026-09-06",
};

test.concurrent("an import past a module's entry fails without offering a baseline line", async () => {
  const result = await checkDeps("module-entry-only", []);

  expect(result.status).not.toBe(0);
  expect(result.output).toContain("Import past a module entry");
  expect(result.output).toContain(
    "module-read-model-entry-only: src/entry/commands/deep.ts -> src/dashboard/read-model/internal.ts",
  );
  expect(result.output).not.toContain("add these lines to the baseline");
});

test.concurrent("a baseline entry for a module rule is refused, even justified and matching the edge", async () => {
  const result = await checkDeps("module-entry-only", [PAST_ENTRY_EDGE]);

  expect(result.status).not.toBe(0);
  expect(result.output).toContain("may not list them");
});

test.concurrent("rewriting the baseline is refused while an import past a module's entry remains", async () => {
  const result = await checkDeps("module-entry-only", [UPWARD_EDGE], ["--write-baseline"]);

  expect(result.status).not.toBe(0);
  expect(result.output).toContain("Import past a module entry");
});

/** A root holding the entry of every declared module except `missing`. */
function rootWithEntriesBut(missing: string): string {
  const root = makeTempDirectory("lance-nuit-modules-");

  for (const module of MODULES.filter((declared) => declared.name !== missing)) {
    mkdirSync(join(root, module.path), { recursive: true });
    for (const entry of moduleEntries(module)) writeFileSync(join(root, module.path, entry), "");
  }

  return root;
}

test.concurrent("a declared module whose entry does not exist fails the check", async () => {
  const [missing] = MODULES;

  if (missing === undefined) throw new Error("scripts/layers.cjs declares no module");

  const result = await checkDeps("upward", [UPWARD_EDGE], ["--modules-root", rootWithEntriesBut(missing.name)]);

  expect(result.status).not.toBe(0);
  expect(result.output).toContain(`module ${missing.name}: entry ${missing.path}/${missing.entry} does not exist`);
  expect(result.output).not.toContain("New architecture debt");
});

test.concurrent("every declared entry present: the entry check lets the cruise run", async () => {
  const result = await checkDeps("upward", [UPWARD_EDGE], ["--modules-root", rootWithEntriesBut("")]);

  expect(result.status).toBe(0);
});

test.concurrent("two files of one folder importing each other raise only no-circular", async () => {
  expect(await rulesRaisedIn("cycle")).toEqual(["no-circular"]);
});

test.concurrent("a file in a folder no context claims fails the classification, though it has no edge", async () => {
  const result = await checkDeps("unclassified", []);

  expect(result.status).not.toBe(0);
  expect(result.output).toContain("file in no context: src/foo/a.ts");
});

test.concurrent("a violation absent from the baseline fails as new debt", async () => {
  const result = await checkDeps("upward", []);

  expect(result.status).not.toBe(0);
  expect(result.output).toContain("New architecture debt");
  expect(result.output).toContain("layer-0-no-upward");
});

test.concurrent("a baseline entry matching no edge fails as stale", async () => {
  const gone = { ...UPWARD_EDGE, from: "src/shared/lib/gone.ts" };
  const result = await checkDeps("upward", [UPWARD_EDGE, gone]);

  expect(result.status).not.toBe(0);
  expect(result.output).toContain("Stale baseline");
  expect(result.output).toContain("src/shared/lib/gone.ts");
});

test.concurrent("a baseline matching the observed violations exactly passes", async () => {
  const result = await checkDeps("upward", [UPWARD_EDGE]);

  expect(result.status).toBe(0);
  expect(result.output).toContain("layer-0-no-upward");
});

test.concurrent("a baseline entry without a reason or a review date is refused", async () => {
  const { why: _why, ...unjustified } = UPWARD_EDGE;
  const result = await checkDeps("upward", [unjustified]);

  expect(result.status).not.toBe(0);
  expect(result.output).toContain("must be justified and dated");
  expect(result.output).toContain("missing `why`");
});

test.concurrent("an empty baseline may not be refilled: a violation is fixed, not recorded", async () => {
  const result = await checkDeps("upward", [], ["--write-baseline"]);

  expect(result.status).not.toBe(0);
  expect(result.output).toContain("may no longer be recorded, only fixed");
});

test.concurrent("two folders coupled by two disjoint file edges raise no file cycle at all", async () => {
  expect(await rulesRaisedIn("folder-cycle-crossed")).toEqual([]);
});

test.concurrent("a folder cycle absent from the folder baseline fails, both edges named", async () => {
  const result = await checkDeps("folder-cycle-crossed", []);

  expect(result.status).not.toBe(0);
  expect(result.output).toContain("New folder cycle");
  expect(result.output).toContain('"from":"definition/validation","to":"definition/pipeline"');
  expect(result.output).toContain('"from":"definition/pipeline","to":"definition/validation"');
});

test.concurrent("a folder baseline matching the cyclic edges exactly passes, the edge inside `validation/` aside", async () => {
  const result = await checkDeps(
    "folder-cycle-crossed",
    [],
    [],
    [
      folderEdge("definition/validation", "definition/pipeline"),
      folderEdge("definition/pipeline", "definition/validation"),
    ],
  );

  expect(result.status).toBe(0);
  expect(result.output).toContain("folder cycles");
});

test.concurrent("a folder baseline entry matching no cyclic edge fails as stale", async () => {
  const result = await checkDeps(
    "folder-cycle-crossed",
    [],
    [],
    [
      folderEdge("definition/validation", "definition/pipeline"),
      folderEdge("definition/pipeline", "definition/validation"),
      folderEdge("definition/project", "definition/validation"),
    ],
  );

  expect(result.status).not.toBe(0);
  expect(result.output).toContain("Stale folder baseline");
  expect(result.output).toContain('"from":"definition/project","to":"definition/validation"');
});

test.concurrent("a folder-cycle entry without a reason or a review date is refused", async () => {
  const { why: _why, ...unjustified } = folderEdge("definition/validation", "definition/pipeline");
  const result = await checkDeps(
    "folder-cycle-crossed",
    [],
    [],
    [unjustified, folderEdge("definition/pipeline", "definition/validation")],
  );

  expect(result.status).not.toBe(0);
  expect(result.output).toContain("must be justified and dated");
  expect(result.output).toContain("missing `why`");
});

test.concurrent("a facade file and the folder of the same name are two distinct nodes", async () => {
  // The fixture imports `src/definition/dsl.ts` from `src/definition/validation/`, which the authoring
  // surface rule forbids; that is a file-level edge, and it is the folder graph
  // this test is about.
  const barrel = [
    {
      rule: "root-dsl-barrel",
      from: "src/definition/validation/s2.ts",
      to: "src/definition/dsl.ts",
      why: "fixture",
      reviewedOn: "2026-09-06",
    },
  ];
  const cycle = [
    folderEdge("definition/dsl.ts", "definition/dsl"),
    folderEdge("definition/dsl", "definition/validation"),
    folderEdge("definition/validation", "definition/dsl"),
    folderEdge("definition/validation", "definition/dsl.ts"),
  ];
  const [unknown, matched] = await Promise.all([
    checkDeps("folder-cycle-facade", barrel, [], []),
    checkDeps("folder-cycle-facade", barrel, [], cycle),
  ]);

  // Were the facade folded into the folder of the same name, `dsl.ts -> dsl`
  // would be an edge inside one node and `validation -> dsl.ts` would read
  // `validation -> dsl`: the cycle would hold two nodes instead of three.
  expect(unknown.status).not.toBe(0);
  expect(unknown.output).toContain('"from":"definition/dsl.ts","to":"definition/dsl"');
  expect(unknown.output).toContain('"from":"definition/validation","to":"definition/dsl.ts"');
  expect(matched.status).toBe(0);
});

test.concurrent("a three-folder cycle needs its three edges in the baseline", async () => {
  const edges = [
    folderEdge("definition/validation", "definition/pipeline"),
    folderEdge("definition/pipeline", "definition/builtin-steps"),
    folderEdge("definition/builtin-steps", "definition/validation"),
  ];
  const [partial, full] = await Promise.all([
    checkDeps("folder-cycle-three", [], [], edges.slice(0, 2)),
    checkDeps("folder-cycle-three", [], [], edges),
  ]);

  expect(partial.status).not.toBe(0);
  expect(partial.output).toContain("New folder cycle");
  expect(partial.output).toContain('"from":"definition/builtin-steps","to":"definition/validation"');
  expect(full.status).toBe(0);
});

test.concurrent("a cycle inside a single folder is no folder cycle: an empty folder baseline passes", async () => {
  const result = await checkDeps("cycle", [
    {
      rule: "no-circular",
      from: "src/execution/step/a.ts",
      to: "src/execution/step/b.ts",
      why: "fixture",
      reviewedOn: "2026-09-06",
    },
  ]);

  expect(result.status).toBe(0);
  expect(result.output).toContain("folder cycles");
});
