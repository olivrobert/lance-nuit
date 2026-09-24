# Where kit files live

The runner stores its project kit and state under `.lance-nuit/`. Claude Code
assets remain under `.claude/` and are owned by that integration.

| Directory | Contents | Versioned |
|---|---|---|
| `<project>/.lance-nuit/` | `config.json`, `pipelines/`, `prompts/`, work-item root | source files are normally versioned; runtime state is ignored |
| `~/.lance-nuit/` (or `$PIPELINE_HOME`) | same kit layout, shared by every project on the machine | outside the repo |
| `<project>/.claude/` | Claude Code assets (`settings.local.json`, `skills/`, `agents/`, sessions/plugins) | no |

`.lance-nuit/` is the project-owned source of pipelines and prompts. Run state,
logs, and pipeline history are runtime/telemetry data and should not be
committed; the `.lance-nuit/.gitignore` written by `lancenuit create` excludes
those directories. Two generated directories sit beside them in every equipped
kit, project or shared: `.lance-nuit-types/` (DSL declarations, see
[typechecking](dsl-typecheck.md)) and `node_modules/lance-nuit/`, a
self-contained copy of `lance-nuit/contracts` for the extensions the kit holds
(see [extensions](packages-and-extensions.md#how-a-kit-extension-resolves-lance-nuitcontracts)).
Both are ignored and rewritten by the CLI; a worktree shares the main clone's.

**Resolution chain** (`env/kit-paths.ts`), from highest to lowest priority:

```text
<project>/.lance-nuit/  >  ~/.lance-nuit/  >  kit builtin
```

- Pipelines and prompts are project-owned source files. A project pipeline
  masking a shared homonym is reported.
- Configuration is **MERGED**, not replaced:
  `~/.lance-nuit/config.json` < `.lance-nuit/config.json`.
  Objects merge recursively (`profiles`, `steps`, `testSkills`: a project can
  change one key without copying the others), while arrays are **replaced** (a
  project's `sensitivePaths` must be able to REDUCE the shared list).
- Configuration is **strict on its form**. Each layer is validated on its own
  before the merge, so an error names the file that carries the mistake. An
  unknown key at any level (`worktreMode`, `steps.<key>.timeout`,
  `profiles.<role>.model`), a value of the wrong kind (`"workItem": "jira"`), a
  misspelled enum value (`"worktreeMode": "ligth"`), or a file that is not JSON
  stops the runner with the offending path, instead of silently falling back to a
  default. Numeric limits must be positive (`usTokenBudget`,
  `stackPreflight.readinessTimeoutMs`): `0` is an error, not "disabled".
  Defaults apply only to keys that are absent; `stackPreflight` without
  `services` still means no preflight.
- The rate table `pipeline-history/pricing.json` follows the same merge:
  `~/.lance-nuit/pipeline-history/pricing.json` < `.lance-nuit/pipeline-history/pricing.json`,
  model by model. See [budgets and timeouts](budgets-timeouts.md#cost-accounting-and-pricing).
- `$PIPELINE_HOME` replaces `~/.lance-nuit` and names the directory itself. Tests
  pin it to a disposable root (`tests/isolate-kit-home.ts`), otherwise the
  machine's `~/.lance-nuit` would alter discovery assertions.

A set of ready-made review steps is available as a TypeScript example in
[`examples/builtin-reviews`](../examples/builtin-reviews/README.md). It is not
loaded from kit paths; project pipelines own their quality steps directly.

**Run a pipeline by name.** `--pipeline` accepts both forms, separated by
`^[a-z][a-z0-9-]*$`: a matching value is a NAME resolved through the chain; a value
containing `/`, `.`, or an uppercase letter is a PATH used as-is. This is the same
expression used at creation, so `lancenuit create deploy …` followed by `-p deploy`
refers to the same identifier. An unknown name lists the paths searched, in order.

```bash
lancenuit run PROJ-28 --pipeline deploy    # project .lance-nuit/, then ~/.lance-nuit/, then builtin
lancenuit run PROJ-28 -p ./scratch/exp.ts  # path: no resolution
lancenuit list                            # project, shared, and package builtin pipelines
```

The wrapper has generic `run` and `single` verbs. They pass a **name** through
the same chain; a project's `.lance-nuit/pipelines/default.ts` therefore overrides
`lancenuit run`. A path containing `/`, `.`, or uppercase letters is loaded as a
path and is not looked up in the chain.

## State and work-item paths

`specPath` defaults to `.lance-nuit/work-items` and is resolved relative to the
run cwd. For a ticket, artifacts and state are stored under:

```text
<specPath>/<ticket>/
├── artifacts/
├── reports/
├── decisions/
└── runs/<pipeline>/<runId>/
    ├── state.json
    └── steps/<step>/attempt-XXX/output.log
```

The top-level `.lance-nuit/runs/` fallback is used only for runs without a ticket.
`.lance-nuit/run/` is a local lock/worktree directory, not the canonical snapshot
location. Worktree setup copies the project config into the linked worktree;
`$PIPELINE_HOME` is still the shared kit root.

What a worktree must not own, it links back to the main clone: the whole
work-item directory of the ticket (a sub-US links its parent), plus
`.lance-nuit/pipeline-history/`. Steps and agents receive the work item by its
real path in the main clone, never through the link: agent file search does not
follow links, and backends grant that directory beside the worktree cwd.

```text
<project>/.lance-nuit/pipeline-history/
├── runs.jsonl                 # one line per logical run
├── pricing.json               # rate table, merged with the user kit's
└── scans/<scan>.json          # one record per --scan dispatch
```

`runs.jsonl` is the single cross-run projection read by `lancenuit stats`,
`pricing.json` the rate table for backends that report no cost, and `scans/`
holds one record per scan, named `<start instant>-<pipeline>-<short id>.json` so
that the directory lists chronologically. Kept inside a worktree, all three
would die with it — the runs would vanish from the history, every run priced
from that table would read as unknown cost, and the scan record would be lost
along with the worktrees whose children it accounts for. A scan is dispatched
from the main clone, which is where its record therefore belongs. See
[persistence](persistence.md#scan-records) for the record itself.

`.lance-nuit/pipelines/` is linked for the opposite reason: not to keep what the
worktree writes, but to give it something to read. A project that git-ignores its
whole `.lance-nuit/` — the usual choice, since the directory also holds run state
— checks a worktree out without a single pipeline, and `--pipeline <name>` then
fails to resolve before the first step. A project that tracks its pipelines needs
no link: Git already put the branch's own copy there, and setup leaves it alone.
