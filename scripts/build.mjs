#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const tsc = join(root, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");

rmSync(dist, { recursive: true, force: true });
const result = spawnSync(tsc, ["-p", "tsconfig.build.json"], {
  cwd: root,
  stdio: "inherit",
});
if (result.status !== 0) process.exit(result.status ?? 1);

// The dashboard's `app.js` and `app.css` are build products, not sources: they
// are bundled from `src/modules/ui/app/` and are absent from a fresh clone. They
// have to exist BEFORE the static directory is copied below, or `dist/` would
// ship an HTML shell pointing at two files that are not there.
const ui = spawnSync(process.execPath, [join(root, "scripts/build-ui.mjs")], { cwd: root, stdio: "inherit" });
if (ui.status !== 0) process.exit(ui.status ?? 1);

// These files are loaded by the compiled runner through stable paths: builtin
// pipelines remain author-facing TypeScript, the live-feed watcher runs its
// formatter on Bun, and the dashboard serves its own HTML/CSS/JS, which tsc
// does not emit. Keep those assets beside their compiled modules while the rest
// of the runner is emitted as JS.
const copy = (relativePath, destinationPath = relativePath.replace(/^src\//, "")) => {
  const source = join(root, relativePath);
  const destination = join(dist, destinationPath);
  if (!existsSync(source)) throw new Error(`Build asset is missing: ${relativePath}`);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true });
};

for (const [source, destination] of [
  ["src/builtins", "builtins"],
  ["src/engine/backends/claude-code/prompts", "engine/backends/claude-code/prompts"],
  ["src/output/stream-formatter.ts", "output/stream-formatter.ts"],
  ["src/modules/ui/static", "modules/ui/static"],
]) {
  copy(source, destination);
}

console.log(`build: emitted compiled runner and declarations to ${dist}`);
