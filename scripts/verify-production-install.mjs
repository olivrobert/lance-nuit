#!/usr/bin/env bun

/**
 * Verify the artifact a consumer would install, rather than the checkout's
 * node_modules. This intentionally creates a tarball and installs it into a
 * fresh directory with devDependencies omitted.
 */

import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DECLARATIONS_ENTRY } from "../dist/definition/project/dsl-types/layout.js";

const runnerRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const temporaryRoot = mkdtempSync(join(tmpdir(), "lance-nuit-production-"));
const npmCache = process.env.npm_config_cache ?? join(tmpdir(), "lance-nuit-verify-npm-cache");
const packageRoot = join(temporaryRoot, "consumer");
const packageJsonPath = join(runnerRoot, "package.json");

mkdirSync(npmCache, { recursive: true });

const npmEnv = {
  ...process.env,
  // Isolate temporary Git repositories from any global gitignore (such as one
  // ignoring `.lance-nuit/`) while still testing each kit's own `.gitignore`.
  GIT_CONFIG_GLOBAL: "/dev/null",
  npm_config_audit: "false",
  npm_config_cache: npmCache,
  npm_config_fund: "false",
  npm_config_update_notifier: "false",
};

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: runnerRoot,
    env: npmEnv,
    encoding: "utf8",
    ...options,
  });
  if (result.error) throw result.error;
  return result;
}

function runAsync(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: runnerRoot,
      env: npmEnv,
      ...options,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", rejectPromise);
    child.on("close", (status) => {
      resolvePromise({ status, stdout, stderr });
    });
  });
}

function checked(command, args, options = {}) {
  const result = run(command, args, options);
  if (result.status !== 0) {
    const details = [result.stdout?.trim(), result.stderr?.trim()].filter(Boolean).join("\n");
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}\n${details}`);
  }
  return result;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function packageTarball() {
  const destination = join(temporaryRoot, "root");
  mkdirSync(destination, { recursive: true });
  const args = ["pack", "--json", "--ignore-scripts", "--pack-destination", destination];
  const result = await runAsync(npm, args);
  if (result.status !== 0) {
    const details = [result.stdout?.trim(), result.stderr?.trim()].filter(Boolean).join("\n");
    throw new Error(`${npm} ${args.join(" ")} failed with exit code ${result.status}\n${details}`);
  }
  let manifest;
  try {
    [manifest] = JSON.parse(result.stdout);
  } catch {
    const details = [result.stdout?.trim(), result.stderr?.trim()].filter(Boolean).join("\n");
    throw new Error(`npm pack did not return JSON${details ? `:\n${details}` : "."}`);
  }
  const filename = manifest?.filename;
  assert(typeof filename === "string" && filename.length > 0, "npm pack returned no tarball filename");
  const tarball = join(destination, filename);
  assert(existsSync(tarball), `npm pack did not create ${tarball}`);
  return { tarball, manifest };
}

function installConsumer(tarballs) {
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    `${JSON.stringify({ name: "lance-nuit-production-consumer", private: true }, null, 2)}\n`,
  );
  // This is deliberately a real npm install from the packed artifact. The
  // package's runtime dependencies must therefore be listed in dependencies,
  // not only in devDependencies or available from the checkout.
  checked(npm, ["install", "--omit=dev", "--no-package-lock", "--prefer-offline", ...tarballs], { cwd: packageRoot });
}

/**
 * Verify every runtime dependency is published and resolvable from the registry,
 * even when `--prefer-offline` serves the install itself from a warm cache.
 */
async function verifyRegistryResolvable() {
  const { name, dependencies = {} } = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const checks = await Promise.all(
    Object.entries(dependencies).map(async ([depName, range]) => {
      const spec = `${depName}@${range}`;
      const result = await runAsync(npm, ["view", "--json", spec, "version"]);
      if (result.status === 0) return null;
      const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
      // Distinguish "the registry says no" from "the registry could not be asked":
      // an offline run must not be reported as an unpublished dependency.
      if (!/E404|ETARGET|No matching version/.test(output)) {
        throw new Error(`npm view ${spec} could not reach the registry:\n${output.trim()}`);
      }
      return spec;
    }),
  );
  const unpublished = checks.filter(Boolean);
  assert(
    unpublished.length === 0,
    `runtime dependencies are not published, so "npm install ${name}" would fail: ${unpublished.join(", ")}\n` +
      "Publish them before releasing, or move them out of the published dependencies.",
  );
}

/**
 * The installed wrapper resolves `bun` from PATH, so a consumer without Bun gets
 * exit 127 and no run. Probe it explicitly: otherwise a missing interpreter shows
 * up as an opaque failure in the first `lancenuit` invocation below.
 */
function verifyBunInterpreter() {
  const probe = run("bun", ["--version"], { cwd: temporaryRoot });
  if (probe.error || probe.status !== 0) {
    throw new Error("bun is not usable on PATH; the installed lancenuit wrapper runs the runner on Bun 1.3 or newer");
  }
  return probe.stdout.trim();
}

function verifyRuntimeDependencies() {
  const packageJson = JSON.parse(readFileSync(join(packageRoot, "node_modules", "lance-nuit", "package.json"), "utf8"));
  for (const dependency of ["typescript"]) {
    assert(
      packageJson.dependencies?.[dependency],
      `${dependency} is not a runtime dependency in the installed package`,
    );
    assert(
      existsSync(join(packageRoot, "node_modules", dependency)),
      `${dependency} was not installed with --omit=dev`,
    );
  }

  const installedRoot = join(packageRoot, "node_modules", "lance-nuit");
  for (const file of [
    "dist/runner.js",
    `dist/${DECLARATIONS_ENTRY}`,
    // Public contracts surface: lance-nuit/contracts.
    "dist/contracts/index.js",
    "dist/contracts/index.d.ts",
    "dist/contracts/testing.js",
  ]) {
    assert(existsSync(join(installedRoot, file)), `compiled runtime file is missing: ${file}`);
  }
}

function verifyBinAndVersion() {
  const bin = join(packageRoot, "node_modules", ".bin", "lancenuit");
  assert(existsSync(bin), "installed binary is missing: lancenuit");
  const { version } = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const result = checked(bin, ["--version"], { cwd: packageRoot, env: npmEnv });
  assert(result.stdout.trim() === `lance-nuit ${version}`, `incorrect installed version: ${result.stdout}`);
}

/** The kit carries a self-contained copy of `lance-nuit/contracts` for its extensions. */
function assertVendoredContracts(kitDir) {
  const vendored = join(kitDir, "node_modules", "lance-nuit");
  for (const file of ["package.json", "contracts/index.js", "contracts/index.d.ts", "contracts/testing.js"]) {
    assert(existsSync(join(vendored, file)), `lancenuit types install did not vendor ${file} in ${kitDir}`);
  }
  const manifest = JSON.parse(readFileSync(join(vendored, "package.json"), "utf8"));
  assert(manifest.lanceNuitContracts?.sourceHash, `vendored contracts in ${kitDir} carry no source hash`);
  assert(
    readFileSync(join(kitDir, "node_modules", ".gitignore"), "utf8") === "*\n",
    "kit node_modules is not self-ignored",
  );
}

/**
 * Exercise the installed CLI against a consumer project that has NO local
 * `node_modules/`: project & user DSL installation, a single full typecheck of a
 * typed extension pipeline, git-ignored vendored contracts, stale contract
 * refresh, and a work-item run through the kit extension.
 */
function verifyInstalledKitAndExtension() {
  const bin = join(packageRoot, "node_modules", ".bin", "lancenuit");
  const project = join(temporaryRoot, "kit-consumer");
  const kit = join(project, ".lance-nuit");
  const isolatedHome = join(temporaryRoot, "kit-consumer-user-kit");
  mkdirSync(project, { recursive: true });
  const consumerEnv = { ...npmEnv, PIPELINE_HOME: isolatedHome };
  assert(!existsSync(join(project, "node_modules")), "kit-consumer must start without node_modules");

  checked(bin, ["types", "install"], { cwd: project, env: consumerEnv });
  const projectTypes = join(kit, ".lance-nuit-types", DECLARATIONS_ENTRY);
  const projectTsconfig = join(kit, "tsconfig.json");
  assert(existsSync(projectTypes), `lancenuit types install did not generate ${projectTypes}`);
  assert(existsSync(projectTsconfig), `lancenuit types install did not generate ${projectTsconfig}`);
  assertVendoredContracts(kit);

  cpSync(join(runnerRoot, "scripts/fixtures/npm-extension/extension.mjs"), join(kit, "extensions.mjs"));
  writeFileSync(
    join(kit, "config.json"),
    JSON.stringify({
      extensions: { module: "./.lance-nuit/extensions.mjs" },
      workItem: { provider: "npm-smoke", project: "PROJ", todoState: "todo", reviewState: "inReview" },
    }),
  );
  mkdirSync(join(kit, "pipelines"), { recursive: true });
  writeFileSync(
    join(kit, "pipelines/extension.ts"),
    `import type { Dsl } from "@lance-nuit/dsl";
export default ({ pipeline, bashStep }: Dsl) => pipeline("extension")
  .forEachWorkItem({ queue: "bugTodo", do: [bashStep({
    id: "check", name: "Read kit extension ticket",
    command: "test -s .lance-nuit/work-items/PROJ-24/artifacts/ticket.md",
    rerunOnResume: true,
  })] }).build();
`,
  );
  checked(bin, ["typecheck"], { cwd: project, env: consumerEnv });

  checked(bin, ["types", "install", "--user"], { cwd: project, env: consumerEnv });
  const userTypes = join(isolatedHome, ".lance-nuit-types", DECLARATIONS_ENTRY);
  const userTsconfig = join(isolatedHome, "tsconfig.json");
  assert(existsSync(userTypes), `lancenuit types install --user did not generate ${userTypes}`);
  assert(existsSync(userTsconfig), `lancenuit types install --user did not generate ${userTsconfig}`);
  assertVendoredContracts(isolatedHome);

  checked("git", ["init", "--quiet", "-b", "main"], { cwd: project });
  checked("git", ["config", "user.email", "npm-smoke@example.invalid"], { cwd: project });
  checked("git", ["config", "user.name", "Package verification"], { cwd: project });
  checked("git", ["add", "."], { cwd: project });
  checked("git", ["commit", "--quiet", "-m", "Kit extension"], { cwd: project });
  // The vendored package is git-ignored: the commit above must not have caught it.
  const tracked = checked("git", ["ls-files", ".lance-nuit/node_modules"], { cwd: project }).stdout.trim();
  assert(tracked === "", `kit node_modules leaked into Git: ${tracked}`);

  // A stale copy (older CLI) is rewritten by the run itself, before the import.
  const manifestPath = join(kit, "node_modules", "lance-nuit", "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, lanceNuitContracts: { sourceHash: "stale" } }));
  checked(bin, ["run", "PROJ-24", "-p", "extension"], { cwd: project, env: consumerEnv });
  assert(
    JSON.parse(readFileSync(manifestPath, "utf8")).lanceNuitContracts.sourceHash ===
      manifest.lanceNuitContracts.sourceHash,
    "the run did not refresh the stale vendored contracts",
  );
  const ticket = readFileSync(join(kit, "work-items/PROJ-24/artifacts/ticket.md"), "utf8");
  assert(
    ticket.includes("Offline acceptance criteria"),
    "kit extension ticket was not fetched without a local install",
  );
  assert(!existsSync(join(project, "node_modules")), "the kit extension must not need a project node_modules");
}

function verifyInstalledExecution() {
  const bin = join(packageRoot, "node_modules", ".bin", "lancenuit");
  // Reuse the failure/resume assertions against the installed binary, never src/.
  const smoke = checked(process.execPath, [join(runnerRoot, "scripts/smoke-standalone.mjs")], {
    env: { ...npmEnv, SMOKE_RUNNER_BIN: bin },
  });
  process.stdout.write(smoke.stdout);

  cpSync(join(runnerRoot, "scripts/fixtures/npm-extension"), join(packageRoot, "extension"), { recursive: true });
  // The fixture is named `.contract.mjs` in the repository so the runner's own
  // `bun test` does not collect it: it only resolves `lance-nuit/contracts`
  // once installed. Bun discovers test files by name, so restore the suffix here.
  renameSync(join(packageRoot, "extension/extension.contract.mjs"), join(packageRoot, "extension/extension.test.mjs"));
  const consumerEnv = { ...npmEnv, PIPELINE_HOME: join(temporaryRoot, "extension-user-kit") };
  checked(
    "node",
    [
      "--input-type=module",
      "-e",
      'const m = await import("./extension/extension.mjs"); if (m.default.workItems[0].id !== "npm-smoke") process.exit(1);',
    ],
    { cwd: packageRoot, env: consumerEnv },
  );
  checked(process.execPath, ["test", "./extension/extension.test.mjs"], { cwd: packageRoot, env: consumerEnv });
}

async function main() {
  const bunVersion = verifyBunInterpreter();
  const [, rootPackage] = await Promise.all([verifyRegistryResolvable(), packageTarball()]);
  installConsumer([rootPackage.tarball]);
  verifyRuntimeDependencies();
  verifyBinAndVersion();
  verifyInstalledExecution();
  verifyInstalledKitAndExtension();
  if (process.env.VERIFY_TARBALL_DEST) {
    const destination = resolve(process.env.VERIFY_TARBALL_DEST);
    mkdirSync(destination, { recursive: true });
    cpSync(rootPackage.tarball, join(destination, rootPackage.manifest.filename));
    console.log(`verified-artifact=${join(destination, rootPackage.manifest.filename)}`);
  }
  console.log(
    [
      "verify:production PASS",
      `tarball=${rootPackage.manifest.filename}`,
      "install=clean --omit=dev",
      "registry=dependencies resolvable",
      "bins=lancenuit",
      `interpreter=bun ${bunVersion}`,
      "runtime=typescript",
      "types=project install + typecheck + user install + vendored contracts",
      "execution=installed failure + resume without replay",
      "extensions=Node import + published contract suite + typed work-item pipeline + kit extension without local install",
    ].join("\n"),
  );
}

try {
  await main();
} catch (error) {
  console.error(`verify:production FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
