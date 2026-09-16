---
paths:
  - "src/state/stores/file-*.ts"
exclude:
  - "src/state/stores/*.test.ts"
---

# Constraints — File-backed stores

Scope: `src/state/stores/file-*.ts` matching `Class `File*Store` / `File*Catalog` implementing a persistence port, owning reads and writes of one on-disk artifact.`.

Tooling checked: `biome.json`, `eslint.config.mjs`, `tsconfig.json`, `package.json`. None of the rules below are covered by this tooling.

## Semantic Rules

- MUST: A `File…Store` class explicitly declares the persistence port it implements. Trigger: declaration of a store class in src/state/stores/. Anchor: `implements <Port>` clause on the class declaration, the port coming from a `model/*-ports.ts` module. (5/5)
- MUST: Publishing a full file goes through a writer-owned temporary file then a rename, with the temporary removed if the write fails. Trigger: full write of an artifact to disk (writeFileSync / writeFile). Anchor: temporary path suffixed `.${process.pid}.<uuid>.tmp`, followed by a rename, with unlink/rm of the temporary in the catch. (3/3)
- MUST: A store addressing runs by identifier exposes for each operation an `…At` variant taking the run directory explicitly. Trigger: store that resolves a run directory from a runId (runDirs, resolveRunDir). Anchor: method suffixed `At` whose first parameter is `runDir: string`. (3/3)
- MUST: Content read back from disk goes through a schema parser before being handed to the domain. Trigger: reading a JSON file persisted by the store. Anchor: call to a dedicated parsing function (parseJournalEntry, parseScanRecord, readRunSnapshot, `parse` callback) on the result of JSON.parse. (5/5)
- MUST: A path built from a caller-supplied segment is checked as a descendant of the store root and rejected if it crosses a symlink. Trigger: composition of an I/O path incorporating a value from outside (step identifier, artifact name, ticket directory). Anchor: call to isDescendantPath / isPathWithin from path-safety.ts, then rejection of symlink components, before any I/O. (2/2)
- MUST: A catch that swallows the error carries a comment stating why the degradation is acceptable. Trigger: catch block that does not rethrow and returns a neutral value. Anchor: comment immediately in the catch body, explaining the tolerated failure. (6/6)
