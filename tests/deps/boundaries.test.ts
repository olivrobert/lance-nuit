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
// Since the real config declares modules (scripts/layers.cjs), a fixture that
// imports across folders uses folders no module claims, such as `dispatch/`:
// otherwise an entry-only rule would fire on top of the guarantee under test.

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
const { MODULES } = createRequire(import.meta.url)(join(REPO_ROOT, "scripts/layers.cjs")) as {
  MODULES: { name: string; path: string; entry: string }[];
};

function fixture(name: string): string {
  return join(REPO_ROOT, "tests/deps/fixtures", name);
}

/** Violations raised by cruising the fixture with the repository's own config. */
function violationsIn(name: string): { rule: string; from: string }[] {
  const run = spawnSync(process.execPath, [DEPCRUISE, "--config", CONFIG, "--output-type", "json", "src"], {
    cwd: fixture(name),
    encoding: "utf8",
  });
  const report = JSON.parse(run.stdout) as {
    summary: { violations: { rule: { name: string }; from: string }[] };
  };

  return report.summary.violations.map((violation) => ({ rule: violation.rule.name, from: violation.from }));
}

/** Rule names raised by cruising the fixture with the repository's own config. */
function rulesRaisedIn(name: string): string[] {
  return [...new Set(violationsIn(name).map((violation) => violation.rule))].sort();
}

function checkDeps(
  name: string,
  baseline: unknown,
  extraArgs: string[] = [],
  folderBaseline: unknown = [],
): { status: number | null; output: string } {
  const directory = mkdtempSync(join(tmpdir(), "lance-nuit-deps-"));
  const baselinePath = join(directory, "baseline.json");
  const folderBaselinePath = join(directory, "folder-baseline.json");

  writeFileSync(baselinePath, JSON.stringify(baseline));
  writeFileSync(folderBaselinePath, JSON.stringify(folderBaseline));

  const run = spawnSync(
    process.execPath,
    [CHECK_DEPS, "--config", CONFIG, "--baseline", baselinePath, "--folder-baseline", folderBaselinePath, ...extraArgs],
    { cwd: fixture(name), encoding: "utf8" },
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
  from: "src/lib/a.ts",
  to: "src/env/b.ts",
  why: "fixture",
  reviewedOn: "2026-09-06",
};

test("a module importing a higher layer raises its layer rule", () => {
  expect(rulesRaisedIn("upward")).toContain("layer-0-no-upward");
});

test("an import past a module's entry raises its entry-only rule", () => {
  expect(violationsIn("module-entry-only")).toContainEqual({
    rule: "module-read-model-entry-only",
    from: "src/commands/deep.ts",
  });
});

test("an import through a module's entry raises nothing", () => {
  const raisedByEntryImport = violationsIn("module-entry-only").filter(
    (violation) => violation.from === "src/commands/through-entry.ts",
  );

  expect(raisedByEntryImport).toEqual([]);
});

/** The only edge past an entry the `module-entry-only` fixture raises, as a baseline would record it. */
const PAST_ENTRY_EDGE = {
  rule: "module-read-model-entry-only",
  from: "src/commands/deep.ts",
  to: "src/modules/read-model/internal.ts",
  why: "fixture",
  reviewedOn: "2026-09-06",
};

test("an import past a module's entry fails without offering a baseline line", () => {
  const result = checkDeps("module-entry-only", []);

  expect(result.status).not.toBe(0);
  expect(result.output).toContain("Import past a module entry");
  expect(result.output).toContain(
    "module-read-model-entry-only: src/commands/deep.ts -> src/modules/read-model/internal.ts",
  );
  expect(result.output).not.toContain("add these lines to the baseline");
});

test("a baseline entry for a module rule is refused, even justified and matching the edge", () => {
  const result = checkDeps("module-entry-only", [PAST_ENTRY_EDGE]);

  expect(result.status).not.toBe(0);
  expect(result.output).toContain("Module rules have no baseline");
});

test("rewriting the baseline is refused while an import past a module's entry remains", () => {
  const result = checkDeps("module-entry-only", [UPWARD_EDGE], ["--write-baseline"]);

  expect(result.status).not.toBe(0);
  expect(result.output).toContain("Import past a module entry");
});

/** A root holding the entry of every declared module except `missing`. */
function rootWithEntriesBut(missing: string): string {
  const root = mkdtempSync(join(tmpdir(), "lance-nuit-modules-"));

  for (const module of MODULES.filter((declared) => declared.name !== missing)) {
    mkdirSync(join(root, module.path), { recursive: true });
    writeFileSync(join(root, module.path, module.entry), "");
  }

  return root;
}

test("a declared module whose entry does not exist fails the check", () => {
  const [missing] = MODULES;

  if (missing === undefined) throw new Error("scripts/layers.cjs declares no module");

  const result = checkDeps("upward", [UPWARD_EDGE], ["--modules-root", rootWithEntriesBut(missing.name)]);

  expect(result.status).not.toBe(0);
  expect(result.output).toContain(`module ${missing.name}: entry ${missing.path}/${missing.entry} does not exist`);
  expect(result.output).not.toContain("New architecture debt");
});

test("every declared entry present: the entry check lets the cruise run", () => {
  const result = checkDeps("upward", [UPWARD_EDGE], ["--modules-root", rootWithEntriesBut("")]);

  expect(result.status).toBe(0);
});

test("two modules of the same layer importing each other raise only no-circular", () => {
  expect(rulesRaisedIn("cycle")).toEqual(["no-circular"]);
});

test("a file in a folder no layer claims fails the classification, though it has no edge", () => {
  const result = checkDeps("unclassified", []);

  expect(result.status).not.toBe(0);
  expect(result.output).toContain("unclassified file: src/foo/a.ts");
});

test("a violation absent from the baseline fails as new debt", () => {
  const result = checkDeps("upward", []);

  expect(result.status).not.toBe(0);
  expect(result.output).toContain("New architecture debt");
  expect(result.output).toContain("layer-0-no-upward");
});

test("a baseline entry matching no edge fails as stale", () => {
  const gone = { ...UPWARD_EDGE, from: "src/lib/gone.ts" };
  const result = checkDeps("upward", [UPWARD_EDGE, gone]);

  expect(result.status).not.toBe(0);
  expect(result.output).toContain("Stale baseline");
  expect(result.output).toContain("src/lib/gone.ts");
});

test("a baseline matching the observed violations exactly passes", () => {
  const result = checkDeps("upward", [UPWARD_EDGE]);

  expect(result.status).toBe(0);
  expect(result.output).toContain("layer-0-no-upward");
});

test("a baseline entry without a reason or a review date is refused", () => {
  const { why: _why, ...unjustified } = UPWARD_EDGE;
  const result = checkDeps("upward", [unjustified]);

  expect(result.status).not.toBe(0);
  expect(result.output).toContain("must be justified and dated");
  expect(result.output).toContain("missing `why`");
});

test("an empty baseline may not be refilled: a violation is fixed, not recorded", () => {
  const result = checkDeps("upward", [], ["--write-baseline"]);

  expect(result.status).not.toBe(0);
  expect(result.output).toContain("may no longer be recorded, only fixed");
});

test("two folders coupled by two disjoint file edges raise no file cycle at all", () => {
  expect(rulesRaisedIn("folder-cycle-crossed")).toEqual([]);
});

test("a folder cycle absent from the folder baseline fails, both edges named", () => {
  const result = checkDeps("folder-cycle-crossed", []);

  expect(result.status).not.toBe(0);
  expect(result.output).toContain("New folder cycle");
  expect(result.output).toContain('"from":"dispatch","to":"boot"');
  expect(result.output).toContain('"from":"boot","to":"dispatch"');
});

test("a folder baseline matching the cyclic edges exactly passes, the edge inside `dispatch/` aside", () => {
  const result = checkDeps(
    "folder-cycle-crossed",
    [],
    [],
    [folderEdge("dispatch", "boot"), folderEdge("boot", "dispatch")],
  );

  expect(result.status).toBe(0);
  expect(result.output).toContain("folder cycles");
});

test("a folder baseline entry matching no cyclic edge fails as stale", () => {
  const result = checkDeps(
    "folder-cycle-crossed",
    [],
    [],
    [folderEdge("dispatch", "boot"), folderEdge("boot", "dispatch"), folderEdge("pipeline", "dispatch")],
  );

  expect(result.status).not.toBe(0);
  expect(result.output).toContain("Stale folder baseline");
  expect(result.output).toContain('"from":"pipeline","to":"dispatch"');
});

test("a folder-cycle entry without a reason or a review date is refused", () => {
  const { why: _why, ...unjustified } = folderEdge("dispatch", "boot");
  const result = checkDeps("folder-cycle-crossed", [], [], [unjustified, folderEdge("boot", "dispatch")]);

  expect(result.status).not.toBe(0);
  expect(result.output).toContain("must be justified and dated");
  expect(result.output).toContain("missing `why`");
});

test("a facade file and the folder of the same name are two distinct nodes", () => {
  // The fixture imports `src/dsl.ts` from `src/dispatch/`, which the authoring
  // surface rule forbids; that is a file-level edge, and it is the folder graph
  // this test is about.
  const barrel = [
    { rule: "root-dsl-barrel", from: "src/dispatch/s2.ts", to: "src/dsl.ts", why: "fixture", reviewedOn: "2026-09-06" },
  ];
  const unknown = checkDeps("folder-cycle-facade", barrel, [], []);

  // Were the facade folded into the folder of the same name, `dsl.ts -> dsl`
  // would be an edge inside one node and `dispatch -> dsl.ts` would read
  // `dispatch -> dsl`: the cycle would hold two nodes instead of three.
  expect(unknown.status).not.toBe(0);
  expect(unknown.output).toContain('"from":"dsl.ts","to":"dsl"');
  expect(unknown.output).toContain('"from":"dispatch","to":"dsl.ts"');

  const cycle = [
    folderEdge("dsl.ts", "dsl"),
    folderEdge("dsl", "dispatch"),
    folderEdge("dispatch", "dsl"),
    folderEdge("dispatch", "dsl.ts"),
  ];

  expect(checkDeps("folder-cycle-facade", barrel, [], cycle).status).toBe(0);
});

test("a three-folder cycle needs its three edges in the baseline", () => {
  const edges = [folderEdge("dispatch", "boot"), folderEdge("boot", "pipeline"), folderEdge("pipeline", "dispatch")];
  const partial = checkDeps("folder-cycle-three", [], [], edges.slice(0, 2));

  expect(partial.status).not.toBe(0);
  expect(partial.output).toContain("New folder cycle");
  expect(partial.output).toContain('"from":"pipeline","to":"dispatch"');

  expect(checkDeps("folder-cycle-three", [], [], edges).status).toBe(0);
});

test("a cycle inside a single folder is no folder cycle: an empty folder baseline passes", () => {
  const result = checkDeps("cycle", [
    {
      rule: "no-circular",
      from: "src/step/a.ts",
      to: "src/step/b.ts",
      why: "fixture",
      reviewedOn: "2026-09-06",
    },
  ]);

  expect(result.status).toBe(0);
  expect(result.output).toContain("folder cycles");
});
