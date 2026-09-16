// runner/tests/ensure-ui-bundle.ts
//
// Suite preload: make sure the dashboard bundle exists and is not stale.
//
// `src/modules/ui/static/app.js` and `app.css` are build products of
// `scripts/build-ui.mjs`, git-ignored, and therefore absent from a fresh clone.
// `src/modules/ui/server.test.ts` asserts that the static handler serves both,
// so without them the suite fails on a clone for a reason that has nothing to do
// with the code under test.
//
// This is a PRELOAD and not an npm `pretest` hook on purpose: this repository
// runs `bun test` directly, and `bun test` does not go through npm's lifecycle
// scripts. A guard that only fires under `npm test` would not be a guard at all.
// `bunfig.toml` preloads run whichever way the suite is started, which is the
// only place the guarantee actually holds.
//
// The build runs only when it would change something — the bundle is missing, or
// a source under `src/modules/ui/app/` is newer than it. A suite run on an
// up-to-date tree pays one directory walk and nothing else.

import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sources = join(root, "src/modules/ui/app");
const outputs = ["app.js", "app.css"].map((name) => join(root, "src/modules/ui/static", name));

/** Most recent modification under a directory, or `Infinity` when it cannot be
 *  read — an unreadable source tree must not silently skip the build. */
function newestSource(directory: string): number {
  try {
    let newest = 0;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      newest = Math.max(newest, entry.isDirectory() ? newestSource(path) : statSync(path).mtimeMs);
    }
    return newest;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function oldestOutput(): number {
  let oldest = Number.POSITIVE_INFINITY;
  for (const path of outputs) {
    try {
      oldest = Math.min(oldest, statSync(path).mtimeMs);
    } catch {
      return 0;
    }
  }
  return oldest;
}

if (oldestOutput() < newestSource(sources)) {
  const built = spawnSync(process.execPath, [join(root, "scripts/build-ui.mjs")], { cwd: root, stdio: "inherit" });
  if (built.status !== 0) throw new Error("ensure-ui-bundle: `bun scripts/build-ui.mjs` failed");
}
