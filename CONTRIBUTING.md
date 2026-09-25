# Contributing

Thanks for considering a contribution. The project is experimental (`0.1.0`);
issues and pull requests are welcome.

## Setup

Requirements: [Bun](https://bun.sh) 1.3+ for dependency installation, repository
scripts and the runner, Git, and Bash, plus Node.js 22+ and npm for packaging
verification only: `pack:audit` uses `npm pack`, and `verify:production` tests
npm installation, registry resolution, and extension imports under Node. Every
other check runs on Bun alone. ESLint, dependency-cruiser and TypeScript keep
their `node` shebangs, which `bun run` substitutes for its own runtime; a script
that spawns one of them therefore names the package entry point and
`process.execPath`, never the `node_modules/.bin/` wrapper, whose shebang a
Bun-only machine cannot honour — it fails with exit 127 and an empty stdout, a
symptom that does not name the missing runtime. Using lance-nuit itself requires
no Node.js; see the [usage guide](guide/usage.md#installation).

The security scanners are optional locally — CI installs them itself. To run
them yourself:

```sh
pip install semgrep            # static analysis
brew install gitleaks          # or a release binary from github.com/gitleaks/gitleaks
```

```sh
git clone https://github.com/olivrobert/lance-nuit.git
cd lance-nuit
bun install --frozen-lockfile
```

## Checks

Run the same set as CI before opening a pull request:

```sh
bun run lint             # includes deps:check, the architecture gate
bun run deps:report      # read it when touching imports: the only cycles it may
                         # show are the ones justified in
                         # .dependency-cruiser-known-violations.json
bun run format:check
bun test
bun run typecheck
bun run language:check
bun run docs:dsl        # regenerates docs/DSL-API.md; commit the diff
bun run pack:audit
bun run smoke:standalone
bun run verify:production # clean tarball installation, execution/resume, external extension
bun run security          # needs semgrep + gitleaks on PATH
```

## Package readiness

Keep one package: `lance-nuit` owns the CLI and exports `lance-nuit/contracts`
and `lance-nuit/contracts/testing`. Consumers never import `src/` or depend on
a developer's checkout path. Update `bun.lock` when dependencies change.

Run all checks above before preparing a release. `pack:audit` checks the shipped
files, and `verify:production` installs a real tarball without dev dependencies,
tests version/help, generates and typechecks project/user DSL declarations,
executes failure/resume, and runs an external provider through the published
contract suite and the installed CLI. Runtime dependencies must resolve from npm
even before lance-nuit itself is published; that check has no unpublished bypass.

To retain the exact verified artifact without publishing:

```bash
VERIFY_TARBALL_DEST=/tmp/lance-nuit-package bun run verify:production
```

Use the resulting tarball for consumer acceptance testing. Publication is a
separate action: choose the release version and npm dist-tag deliberately,
update package metadata and `bun.lock`, and publish the verified artifact rather
than rebuilding different bytes. No workflow in this repository publishes to npm.

## Commits

A commit message is a single line: a subject, and no body. What a change needs
beyond that belongs in the code, in a comment, or in the pull request.

## Conventions

- Public-facing text (README, guides, examples, sources) is written in English;
  `bun run language:check` enforces it.
- Runtime dependencies are kept few and small; they are not forbidden. Add one
  when it replaces home-made code that is a liability — a parser, a protocol, a
  format — and not to save a few lines of plumbing. `bun run pack:audit` and
  `bun run verify:production` check that every runtime dependency is declared
  and installable by a consumer.
- `bun.lock` is the only repository lockfile. Use `bun install` when dependencies
  change and `bun install --frozen-lockfile` for reproducible checkout installs.
  Consumer verification uses `npm install --no-package-lock` in a temporary
  directory and does not need a repository `package-lock.json`.
- The seven architecture levels of [guide/architecture.md](guide/architecture.md)
  are enforced by `bun run deps:check` (dependency-cruiser, type imports
  included). `.dependency-cruiser-known-violations.json` is no longer a debt
  record: it holds only edges someone argued for, one file → file edge per line,
  each with a `why` and a `reviewedOn` date, and the check refuses an entry
  missing either. Three rules govern it: no entry is ever added — a new upward
  import or a new cycle is fixed, not recorded; an entry that no longer matches
  a real edge is removed in the same commit that removed the edge, and the check
  fails until it is; when a file moves and an existing edge merely changes path,
  the entry is rewritten by hand and the pull request states the old → new
  mapping. `--write-baseline` exists to bootstrap and to rewrite after a rename;
  it refuses to run against an empty baseline, so a project that reached zero
  cannot start recording again.
- The same check compares folder cycles to a second baseline,
  `.dependency-cruiser-known-folder-cycles.json`. It groups the graph by folder
  — one node per folder directly under `src/`, one per file directly under
  `src/`, so `src/dsl.ts` and `src/dsl/` are two nodes — and lists every edge
  whose two ends sit in one cycle of that grouped graph. That is how it catches
  a pair of folders locking each other while no single file is in a cycle, which
  `no-circular` cannot see. The three rules above hold here too, on a `from` →
  `to` pair of folders, and an entry carries a fourth field, `removedBy`, naming
  the cut meant to retire it. There is no `--write-baseline` for this one: it is
  edited by hand, and the target is an empty file.
- `docs/DSL-API.md` is generated. Never edit it by hand; run `bun run docs:dsl`.
- Semgrep rules live in `.semgrep.yml`. An `ERROR` rule must match nothing in
  the repository, so a hit always means a regression; a pattern that is
  legitimate here belongs at `WARNING`, which never blocks CI.
- Every `.gitleaks.toml` allowlist states why the match is not a secret, who
  owns the decision, and a re-review date. An undated exception is permanent
  blindness.
- New CLI options are declared in the `FLAGS` registry (`src/model/cli-options.ts`);
  the parser that reads it lives in `src/cli/parse.ts`.
  Both help texts are generated from it: `runner --help` through
  `src/commands/help.ts`, and `lancenuit help` through the `WRAPPER_COMMANDS`
  registry in `src/commands/wrapper-help.ts`. A new wrapper verb goes in that
  registry and in the `case` block of `bin/lancenuit`; a test fails when the two
  disagree.
- New `lancenuit create --template` starting points go in
  `src/commands/pipeline-templates.ts`. Every template is rendered, typechecked,
  and loaded by the test suite.

## Extending the runner

Agent backends and work-item providers plug in through the extension manifest
without forking; see [guide/packages-and-extensions.md](guide/packages-and-extensions.md).
`lance-nuit/contracts` ships a contract test harness for external adapters.
