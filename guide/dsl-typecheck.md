# Project DSL and typechecking

Declarations are installed in the **kit directory** that owns the pipelines:
`<kit>/.lance-nuit-types/` and `<kit>/tsconfig.json`, for
`<kit>/pipelines/**/*.ts`. For a project this is normally `.lance-nuit/`; for a
shared pipeline it is `~/.lance-nuit` (or `$PIPELINE_HOME`). The generated
`tsconfig.json` is anchored at `baseUrl: "."`, so it remains relocatable.
Declarations are generated from the runner DSL and carry a source fingerprint;
do not edit the generated package by hand.

Only the declarations reachable from the public entry point are installed.
Declaration emit drops runtime-only imports, so the authoring types land in the
kit while the runner's internals — boot, dispatch, output, step execution,
persistence stores — do not: a project receives the surface it writes pipelines
against, not the application.

Installation also vendors `lance-nuit/contracts` into the kit, at
`<kit>/node_modules/lance-nuit/`, so an extension in the kit imports the
contracts of the CLI that loads it. See
[extensions](packages-and-extensions.md#how-a-kit-extension-resolves-lance-nuitcontracts).

All these artifacts are generated: the kit directory writes its own `.gitignore`,
without relying on the project's `.gitignore`; `.lance-nuit/` must remain tracked.

`lancenuit create …` installs the declarations automatically. To refresh an
existing kit from the installed CLI, run:

```bash
lancenuit types install
lancenuit types install --user
lancenuit typecheck
lancenuit typecheck --user
```

The `--user` form targets the shared `~/.lance-nuit` kit (or `$PIPELINE_HOME`).
Typechecking a kit whose
generated declarations are missing or stale fails and tells you to install them.

Typechecking has one safeguard:

- A kit directory with no `.ts` files under `pipelines/` is **skipped** with an
  explicit “no project pipelines” result, never a success-like “0 files checked”.

The injected DSL exposes `humanReview`, work-item delivery with an inferred
queue, `requireCapabilitiesStep`, and `promptFile`. Package built-ins may use
internal imports; project pipelines should use the generated public declarations.
