#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const result = spawnSync(
  process.platform === "win32" ? "npm.cmd" : "npm",
  ["pack", "--dry-run", "--json", "--ignore-scripts"],
  {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  },
);

if (result.status !== 0) {
  process.stderr.write(result.stderr || result.stdout);
  process.exit(result.status ?? 1);
}

let manifest;
try {
  [manifest] = JSON.parse(result.stdout);
} catch {
  process.stderr.write(`npm pack did not produce readable JSON:\n${result.stdout}\n`);
  process.exit(1);
}

const files = manifest.files.map(({ path }) => path);
const forbidden = [
  [".claude state", /(^|\/)\.claude(\/|$)/],
  [".lance-nuit state", /(^|\/)\.lance-nuit\/(state|runs|history|logs|tmp)(\/|$)/],
  ["work-items", /(^|\/)work-items(\/|$)/],
  ["history", /(^|\/)(pipeline-history|history)(\/|$)/],
  ["logs", /(^|\/)(logs?|.*\.log)(\/|$)/],
  ["cache", /(^|\/)(\.cache|\.bun|cache)(\/|$)/],
  ["node_modules", /(^|\/)node_modules(\/|$)/],
  ["tests", /(^|\/)(tests?|.*\.test\.[cm]?[jt]sx?)(\/|$)/],
  ["viewer", /(^|\/)viewer(\/|$)/],
  ["archive npm locale", /\.tgz$/],
];

const violations = [];
for (const [label, pattern] of forbidden) {
  for (const file of files.filter((candidate) => pattern.test(candidate))) {
    violations.push(`${label}: ${file}`);
  }
}

const required = [
  "package.json",
  "README.md",
  "LICENSE",
  "bin/lancenuit",
  "dist/runner.js",
  "dist/runner.d.ts",
  "dist/model/cli-options.js",
  "dist/cli/parse.js",
  "dist/runtime/context.js",
  "dist/runtime/logging.js",
  "dist/runtime/events.js",
  "dist/model/definition.d.ts",
  "dist/model/context.d.ts",
  "dist/model/persisted.d.ts",
  "dist/dsl.js",
  "dist/dsl/artifact.d.ts",
  "dist/dsl/input.d.ts",
  "dist/dsl/profiles.d.ts",
  "dist/dsl/work-item-assembly.d.ts",
  "dist/pipeline/context.js",
  "dist/pipeline/loader.js",
  "dist/project/dsl.d.ts",
  "dist/project/dsl-types.js",
  "dist/extractors/registry.js",
  "dist/engine/backends/claude-code/prompts/fork-relay.md",
  "dist/builtins/default.js",
  "dist/builtins/default.ts",
  "dist/contracts/index.js",
  "dist/contracts/index.d.ts",
  "dist/contracts/backends.js",
  "dist/contracts/backends.d.ts",
  "dist/contracts/work-items.js",
  "dist/contracts/registry.js",
  "dist/contracts/testing.js",
  "examples/generic-shell/pipeline.ts",
  "examples/jira-acli/pipeline.ts",
  "examples/gitlab-glab/pipeline.ts",
  "dist/modules/ui/server.js",
  "dist/modules/ui/static/index.html",
  "dist/modules/ui/static/app.js",
  "dist/modules/ui/static/app.css",
  "dist/state/stats/stats-core.js",
  "dist/state/stats/stats-core.d.ts",
];
for (const file of required) {
  if (!files.includes(file)) violations.push(`missing runtime file: ${file}`);
}

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
for (const dependency of ["typescript"]) {
  if (!packageJson.dependencies?.[dependency]) {
    violations.push(`missing runtime dependency: ${dependency}`);
  }
}
for (const command of ["lancenuit"]) {
  if (!packageJson.bin?.[command]) violations.push(`missing bin entry: ${command}`);
}

// The contracts surface (lance-nuit/contracts) must stay importable
// from plain Node after the build.
const coreImport = spawnSync(
  process.execPath,
  [
    "--input-type=module",
    "-e",
    'const m = await import("./dist/contracts/index.js"); if (typeof m.WorkItemGatewayRegistry !== "function") process.exit(1);',
  ],
  { cwd: new URL("..", import.meta.url), encoding: "utf8" },
);
if (coreImport.status !== 0) {
  violations.push(`contracts Node import smoke failed: ${coreImport.stderr || coreImport.stdout}`);
}

// The claude-code backend resolves its fork-relay prompt relative to the
// compiled module, so the prompt directory must travel with it into dist/.
const promptResolution = spawnSync(
  process.execPath,
  [
    "--input-type=module",
    "-e",
    'const { promptTemplate } = await import("./dist/engine/backends/claude-code/prompt.js"); const rendered = promptTemplate("fork-relay", ["slash"])({ slash: "x" }); if (!rendered.includes("skill `x`")) { process.stderr.write("fork-relay rendered without its placeholder value\\n"); process.exit(1); }',
  ],
  { cwd: new URL("..", import.meta.url), encoding: "utf8" },
);
if (promptResolution.status !== 0) {
  violations.push(
    `fork-relay prompt resolution from dist/ failed: ${promptResolution.stderr || promptResolution.stdout}`,
  );
}

if (violations.length > 0) {
  process.stderr.write(`npm pack audit failed:\n- ${violations.join("\n- ")}\n`);
  process.exit(1);
}

console.log(
  `npm pack audit: ${files.length} files, ${manifest.size} compressed bytes, ` +
    `${manifest.unpackedSize} unpacked bytes — content is valid.`,
);
