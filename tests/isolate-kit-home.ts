// runner/tests/isolate-kit-home.ts
//
// Suite preload: pin `$PIPELINE_HOME` to an EMPTY disposable directory.
//
// Otherwise kit resolution (env/kit-paths.ts) would read the real `~/.lance-nuit`
// on the machine running the tests. A shared contract there could add a family
// to `discoverFamilies` and break discovery assertions, without reproducing in
// CI or on another developer's machine.
//
// A test that wants to EXERCISE the user root reassigns `process.env.PIPELINE_HOME`
// itself: resolution rereads it on every call and nothing is memoized.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PIPELINE_HOME ??= mkdtempSync(join(tmpdir(), "pipeline-kit-home-"));
