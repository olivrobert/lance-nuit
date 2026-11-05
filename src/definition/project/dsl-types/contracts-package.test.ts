import { describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  contractsSourceHash,
  enclosingKitDir,
  ensureContractsForExtension,
  ensureKitContracts,
  installKitContracts,
  staleKitContractsReason,
} from "./contracts-package.js";
import { kitContractsPackageDir, kitNodeModulesDir } from "./layout.js";

function kit(): string {
  return mkdtempSync(join(tmpdir(), "lance-nuit-kit-contracts-"));
}

function readManifest(kitDir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(kitContractsPackageDir(kitDir), "package.json"), "utf8"));
}

function markStale(kitDir: string): void {
  const path = join(kitContractsPackageDir(kitDir), "package.json");
  const manifest = readManifest(kitDir);
  manifest.lanceNuitContracts = { sourceHash: "0".repeat(64) };
  writeFileSync(path, JSON.stringify(manifest));
}

/** A runner layout reduced to `contracts/`: enough for hashing and emission. */
function fakeRunner(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "lance-nuit-fake-runner-"));
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, "contracts", name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  }
  return dir;
}

describe("vendored contracts package", () => {
  test("an extension inside the kit resolves lance-nuit/contracts and its subpaths", async () => {
    const dir = kit();
    const metadata = installKitContracts(dir);
    expect(metadata.sourceHash).toBe(contractsSourceHash());

    const manifest = readManifest(dir);
    expect(manifest.name).toBe("lance-nuit");
    expect(Object.keys(manifest.exports as object)).toEqual(["./package.json", "./contracts", "./contracts/*"]);
    for (const file of ["index.js", "index.d.ts", "testing.js", "testing.d.ts", "extensions.js", "backends/codex.js"]) {
      expect(existsSync(join(kitContractsPackageDir(dir), "contracts", file))).toBe(true);
    }
    // Test files never ship.
    expect(readdirSync(join(kitContractsPackageDir(dir), "contracts")).some((n) => n.includes(".test."))).toBe(false);

    const extension = join(dir, "extensions.mjs");
    writeFileSync(
      extension,
      `import { defineExtension, hasMarker } from "lance-nuit/contracts";
       import { createWorkItemGatewayContract } from "lance-nuit/contracts/testing";
       export const probe = { defineExtension, hasMarker, createWorkItemGatewayContract };
       export default defineExtension({ workItems: [{ id: "probe", create: () => ({ provider: "probe" }) }] });`,
    );
    const module = (await import(extension)) as { probe: Record<string, unknown>; default: { workItems: unknown[] } };
    expect(typeof module.probe.defineExtension).toBe("function");
    expect(typeof module.probe.hasMarker).toBe("function");
    expect(typeof module.probe.createWorkItemGatewayContract).toBe("function");
    expect(module.default.workItems).toHaveLength(1);
  });

  test("the kit node_modules ignores itself, whatever the kit .gitignore says", () => {
    const dir = kit();
    installKitContracts(dir);
    expect(readFileSync(join(kitNodeModulesDir(dir), ".gitignore"), "utf8")).toBe("*\n");
  });

  test("ensure is a no-op when current, reinstalls when missing or stale", () => {
    const dir = kit();
    expect(staleKitContractsReason(dir)).toBe("contracts package is missing");
    expect(ensureKitContracts(dir)).toBe(true);
    expect(staleKitContractsReason(dir)).toBeUndefined();
    expect(ensureKitContracts(dir)).toBe(false);

    markStale(dir);
    expect(staleKitContractsReason(dir)).toBe("contracts package is stale");
    expect(ensureKitContracts(dir)).toBe(true);
    expect(readManifest(dir).lanceNuitContracts).toEqual({ sourceHash: contractsSourceHash() });
  });

  test("an incomplete package (interrupted install) is reported and rewritten", () => {
    const dir = kit();
    const packageDir = kitContractsPackageDir(dir);
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: "lance-nuit", lanceNuitContracts: {} }));
    expect(staleKitContractsReason(dir)).toBe("contracts package is incomplete");
    expect(ensureKitContracts(dir)).toBe(true);
    expect(staleKitContractsReason(dir)).toBeUndefined();
  });

  test("leftover staging directories are dropped, the destination is never one", () => {
    const dir = kit();
    const nodeModules = kitNodeModulesDir(dir);
    mkdirSync(join(nodeModules, ".lance-nuit-staging-old"), { recursive: true });
    writeFileSync(join(nodeModules, ".lance-nuit-staging-old", "package.json"), "{}");
    installKitContracts(dir);
    expect(readdirSync(nodeModules).sort()).toEqual([".gitignore", "lance-nuit"]);
  });

  test("refuses to replace a symlinked node_modules/lance-nuit", () => {
    const dir = kit();
    const target = mkdtempSync(join(tmpdir(), "lance-nuit-checkout-"));
    writeFileSync(join(target, "package.json"), JSON.stringify({ name: "lance-nuit" }));
    mkdirSync(kitNodeModulesDir(dir), { recursive: true });
    symlinkSync(target, kitContractsPackageDir(dir));

    expect(() => installKitContracts(dir)).toThrow(/Refusing to replace .*symbolic link/);
    expect(lstatSync(kitContractsPackageDir(dir)).isSymbolicLink()).toBe(true);
    // A user-owned package is not "stale": boot leaves it alone.
    expect(staleKitContractsReason(dir)).toBeUndefined();
    expect(ensureKitContracts(dir)).toBe(false);
  });

  test("refuses to replace a package without the vendoring marker", () => {
    const dir = kit();
    const packageDir = kitContractsPackageDir(dir);
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: "lance-nuit", version: "9.9.9" }));
    writeFileSync(join(packageDir, "keep.txt"), "user data");

    expect(() => installKitContracts(dir)).toThrow(/Refusing to replace .*marker/);
    expect(readFileSync(join(packageDir, "keep.txt"), "utf8")).toBe("user data");
    expect(ensureKitContracts(dir)).toBe(false);
  });

  test("the hash follows the contracts content, not their location", () => {
    const a = fakeRunner({ "index.ts": "export const x = 1;\n", "note.ts": "export const y = 2;\n" });
    const b = fakeRunner({ "index.ts": "export const x = 1;\n", "note.ts": "export const y = 2;\n" });
    const c = fakeRunner({ "index.ts": "export const x = 1;\n", "note.ts": "export const y = 3;\n" });
    const d = fakeRunner({
      "index.ts": "export const x = 1;\n",
      "note.ts": "export const y = 2;\n",
      "note.test.ts": "x",
    });
    expect(contractsSourceHash(a)).toBe(contractsSourceHash(b));
    expect(contractsSourceHash(a)).not.toBe(contractsSourceHash(c));
    // Tests are not part of the package, so they do not move the hash.
    expect(contractsSourceHash(a)).toBe(contractsSourceHash(d));
  });

  test("a published install (no sources) copies the emitted js and declarations", () => {
    const runner = fakeRunner({
      "index.js": "export const x = 1;\n//# sourceMappingURL=index.js.map\n",
      "index.d.ts": "export declare const x: number;\n",
      "index.js.map": "{}",
    });
    const dir = kit();
    installKitContracts(dir, runner);
    const contracts = join(kitContractsPackageDir(dir), "contracts");
    expect(readdirSync(contracts).sort()).toEqual(["index.d.ts", "index.js"]);
    expect(readFileSync(join(contracts, "index.js"), "utf8")).toContain("export const x = 1;");
    expect(staleKitContractsReason(dir, runner)).toBeUndefined();
  });

  test("a checkout compiles the sources and refuses an import escaping contracts/", () => {
    const runner = fakeRunner({ "index.ts": 'import { leak } from "../outside.js";\nexport const x = leak;\n' });
    mkdirSync(join(runner, "outside"), { recursive: true });
    writeFileSync(join(runner, "outside.ts"), "export const leak = 1;\n");
    const dir = kit();
    expect(() => installKitContracts(dir, runner)).toThrow(/Unable to (compile|emit) contracts/);
    expect(existsSync(kitContractsPackageDir(dir))).toBe(false);
    expect(readdirSync(kitNodeModulesDir(dir))).toEqual([".gitignore"]);
  });
});

describe("kit of an extension module", () => {
  test("project kit, user kit, or none", () => {
    const project = mkdtempSync(join(tmpdir(), "lance-nuit-project-"));
    const home = mkdtempSync(join(tmpdir(), "lance-nuit-home-"));
    const env = { PIPELINE_HOME: home };
    const projectKit = join(project, ".lance-nuit");
    expect(enclosingKitDir(join(projectKit, "extensions.mjs"), project, env)).toBe(projectKit);
    expect(enclosingKitDir(join(projectKit, "adapters", "redmine.mjs"), project, env)).toBe(projectKit);
    expect(enclosingKitDir(join(home, "extensions.mjs"), project, env)).toBe(home);
    expect(enclosingKitDir(join(project, "tools", "extensions.mjs"), project, env)).toBeUndefined();
    expect(enclosingKitDir(join(project, ".lance-nuit-other", "x.mjs"), project, env)).toBeUndefined();
    expect(enclosingKitDir(join(project, "node_modules", "@acme", "ext", "index.mjs"), project, env)).toBeUndefined();
  });

  test("ensureContractsForExtension equips the enclosing kit only", () => {
    const project = mkdtempSync(join(tmpdir(), "lance-nuit-project-"));
    const home = mkdtempSync(join(tmpdir(), "lance-nuit-home-"));
    const env = { PIPELINE_HOME: home };
    mkdirSync(join(home), { recursive: true });

    expect(ensureContractsForExtension(join(project, "ext.mjs"), project, env)).toBeUndefined();
    expect(existsSync(join(project, ".lance-nuit"))).toBe(false);
    expect(existsSync(kitNodeModulesDir(home))).toBe(false);

    expect(ensureContractsForExtension(join(home, "ext.mjs"), project, env)).toBe(home);
    expect(existsSync(join(kitContractsPackageDir(home), "contracts", "index.js"))).toBe(true);
    expect(existsSync(join(project, ".lance-nuit"))).toBe(false);
  });
});
