#!/usr/bin/env bun

// Bundles the dashboard front end.
//
// The runner ships no bundler at runtime and the dashboard must stay a folder of
// plain files the static handler can serve, so the React sources under
// `src/modules/ui/app/` are compiled ahead of time into exactly the two assets
// `index.html` already asks for: `/app.js` and `/app.css`.
//
// Two things are worth knowing about this build.
//
// First, the emitted bundle is self-contained: React is inlined, nothing is
// fetched from a CDN, and no runtime dependency is added to `package.json` —
// `bun run pack:audit` and `bun run verify:production` stay green.
//
// Second, esbuild handles CSS Modules natively since 0.24 (this repository is on
// 0.28.2): a file whose name ends in `.module.css` is loaded with the `local-css`
// loader automatically, its class names are hashed, and importing it yields the
// name map as the default export. Every other `.css` file keeps global scope,
// which is exactly what `styles/tokens.css` wants. Because a single entry point
// pulls in both kinds, esbuild emits one JS file and one sibling CSS file named
// after `outfile` — hence `app.js` and `app.css` from one `build()` call.

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, context } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const watch = process.argv.includes("--watch");
const dev = watch || process.argv.includes("--dev");

/** @type {import("esbuild").BuildOptions} */
const options = {
  absWorkingDir: root,
  entryPoints: [join(root, "src/modules/ui/app/index.tsx")],
  outfile: join(root, "src/modules/ui/static/app.js"),
  bundle: true,
  format: "esm",
  target: "es2022",
  platform: "browser",
  // The automatic runtime keeps `import React` out of every component file;
  // React itself is still bundled, resolved from devDependencies.
  jsx: "automatic",
  minify: !dev,
  sourcemap: dev,
  legalComments: "none",
  logLevel: "info",
  define: { "process.env.NODE_ENV": dev ? '"development"' : '"production"' },
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log("build-ui: watching src/modules/ui/app");
} else {
  await build(options);
  console.log("build-ui: emitted src/modules/ui/static/app.js and app.css");
}
