# CLI options

Source of truth: the `FLAGS` registry in `model/cli-options.ts`, which drives the
parser (`cli/parse.ts`) and `runner --help`. The `pipeline` wrapper maps `run`, `single`, `inspect`, `logs`,
`clean`, `worktree clean`, `stats`, `typecheck`, `lint`, `create`, `approve`, `reject`, `close`, `reopen`, and `list` to these
flags.

| Option | Alias | Description |
|---|---|---|
| `--pipeline <name\|path>` | `-p` | **Name** (`deploy`) resolved through the kit chain, or a path used as-is (default: `default`) |
| `--steps <ids>` | `-s` | Comma-separated IDs (the others are skipped). A prefix such as `checks` also selects `checks.*`. Applies only to steps that still owe work: on resume, a `done` step declaring `input` is still re-checked and re-runs if its inputs changed ([input freshness](dsl.md#input-freshness)), and one declaring `rerunOnResume` is replayed. Under `--scan`, applied to every ticket |
| `--skip <ids>` | `-k` | IDs to skip (mutually exclusive with `--steps`). Same scope as `--steps` |
| `--start-at <id>` | `-a` | Replay from this step: it and every later step run again, even when already `done`; previous steps are skipped (exclusive with `--steps`/`--skip`). A `done` step before it that declares `input` or `rerunOnResume` is still reconsidered on resume ([input freshness](dsl.md#input-freshness)). Rejected under `--scan` |
| `--budget <usd>` | | Approve a cost ceiling in USD for this run. Resumes a run stopped by its budget without repaying completed steps. It changes the amount only: it never authorizes spend the runner could not price. Giving a ceiling to a run that had none when it spent an unpriceable amount stops that run as `cost-unaccounted` — the new amount is enforceable against nothing, so pair it with `--allow-unmetered` to cap the priced spend and authorize the rest |
| `--allow-unmetered` | | Authorize spend nobody can price, and resume a run stopped by `cost-unaccounted`. It lifts that stop only — the spend the runner *did* price still obeys the ceiling. Recorded on the selected run (later resumes need no flag) and propagated to the children it composes. Rejected on an inspection command and under `--scan` |
| `--replay-interrupted` | | Authorize replaying a step the runner died in (crash, OOM, `SIGKILL`); without it, or a `replayInterrupted` declaration on the step, the resumed run stops before running that step again. Valid for this invocation only, never persisted, and passed to the children it composes. Rejected on an inspection command and under `--scan`. See [Interrupted steps](dsl.md#interrupted-steps) |
| `--watch` | `-w` | Open a tmux pane with a live stream |
| `--watch-auto-close` | | With `--watch`, close the pane when the run is terminal (default: keep it open) |
| `--fresh` | `-f` | Ignore `latest` and force a new run |
| `--allow-dirty` | | Bypass the clean Git tree guard for a top-level *fresh* run |
| `--worktree` | | Run in a dedicated Git worktree; optional project hooks perform setup |
| `--worktree-clean` | | Internal form used by `lancenuit worktree clean <ticket>`: run the optional `worktree-teardown.sh` hook, then remove the ticket worktree. See [usage.md](usage.md#worktrees) |
| `--scan` | | Without a ticket: discover through `forEachWorkItem({ scan })` and loop over tickets. Rejected without a scannable loop |
| `--limit <n>` | `-n` | Bound the items a command handles: tickets processed by `--scan` (overriding the `forEachWorkItem` limit), or runs listed by `--stats`. Error outside those two |
| `--base-branch <branch>` | `-b` | Available through `ctx.baseBranch` |
| `--lint-config` | | Subcommand: compare `.lance-nuit/config.json` with all pipelines, then exit |
| `--lint-pipeline` | | Subcommand: load the pipeline selected by `-p`, validate references, print its steps, then exit (`lancenuit lint -p <name>`) |
| `--typecheck` | | Subcommand: typecheck project pipelines against installed DSL declarations |
| `--types-install` | | Internal form used by `lancenuit types install` to generate or refresh DSL declarations and the vendored `lance-nuit/contracts` package of a kit |
| `--help` | `-h` | Subcommand: usage generated from the registries |
| `--version` | | Display the installed package version without loading project configuration |
| `--approve <subject>` | | Record approval for a declared artifact, then run: the approved gate is re-evaluated in the same invocation. Requires a ticket and `--pipeline` |
| `--approve-only` | | With `--approve`, write the decision and exit without running. The `lancenuit approve` subcommand always implies it |
| `--reject <subject>` | | Reject the artifact of a subject whose gate declares a rework step, then run: the rework step replays with the reason. Requires a ticket, `--pipeline`, and `--reason`; cannot be combined with `--approve`, `--approve-only`, or `--clean`. See [human-control.md](human-control.md#reject-and-rework) |
| `--reason <text>` | | Why the artifact is rejected, read by the rework step through `pendingRejection`. Required by `--reject`, non-empty, at most 2000 characters |
| `--reject-only` | | With `--reject`, write the rejection and exit without running, worktree, or project lock. The `lancenuit reject <ticket> <subject> --reason <text> --pipeline <name>` subcommand always implies it |
| `--close` | | Mark the latest failed, stopped, or aborted run of `--pipeline` as closed by hand, keeping its status. Requires a ticket and `--pipeline` (`lancenuit close <ticket> --pipeline <name>`). See [human-control.md](human-control.md#close-a-run-finished-by-hand) |
| `--reopen` | | Remove the closure written by `--close` (`lancenuit reopen <ticket> --pipeline <name>`) |
| `--inspect` | | Display a ticket's run state with its sub-runs (`forEachPipeline` children) listed under their parent; combine with `--run` to select a run |
| `--logs` | | Display a ticket's logs; combine with `--step` and/or `--run` |
| `--run <runId>` | | Explicitly resume a run, or filter `--inspect`/`--logs` |
| `--step <id>` | | Filter `--logs` (for example `tests`) |
| `--clean` | | Remove old step logs; requires `--logs-only` |
| `--logs-only` | | With `--clean`, remove only step log files (snapshots/history are preserved) |
| `--older-than <duration>` | | With `--clean`, age threshold such as `30d` or `12h` |
| `--keep-failed` | | With `--clean`, preserve logs from failed/interrupted runs |
| `--stats` | | Subcommand: summarize `pipeline-history/runs.jsonl` across runs — status, cost, tokens, failing phases, per-profile spend |
| `--since <duration>` | | With `--stats`, keep runs started within `30d`, `12h`, `45m`... A run with no start timestamp is excluded |
| `--failures` | | With `--stats`, keep only runs that did not pass |
| `--include-children` | | With `--stats`, also count nested runs. Excluded by default: a child's usage is already folded into its parent, so counting both doubles the spend |
| `--create` | | Create a project/shared pipeline; normally use `lancenuit create <name>` |
| `--command <command>` | | Bash command for `--create`; required by, and only by, a template that runs one |
| `--template <id>` | | Starting point for `--create`: `bash` (default), `checked`, `agent`, `review`, `work-item` |
| `--user` | | Target shared `~/.lance-nuit` for `--create`, `--typecheck`, or `lancenuit types install` |
| `<ticket>` | | `PROJ-28`, `PROJ-28-01`, or a work-item path such as `exports/PROJ-1478` |
| `--ticket <ticket>` | | Same as the positional `<ticket>`; giving both is an error. Without either, the run is ticket-less and stored under `.lance-nuit/runs/<pipeline>/` |

The wrapper forms are usually easier to remember:

```bash
lancenuit run PROJ-28 -p release
lancenuit inspect PROJ-28 --run <run-id>
lancenuit logs PROJ-28 --step tests
lancenuit close PROJ-28 --pipeline release
lancenuit clean --logs-only --older-than 30d --keep-failed
lancenuit worktree clean PROJ-28
lancenuit stats
lancenuit stats -p release --since 30d
lancenuit stats --failures --limit 20
lancenuit lint -p release
lancenuit types install
lancenuit create release --command 'make release-check'
lancenuit create triage --template work-item
```

`lancenuit help` is rendered by the runner from the same registries as this
table, so the wrapper's usage text can never fall behind a new option.

For `--lint-config`, use the low-level runner because the wrapper has no
dedicated verb:

```bash
bun /path/to/lance-nuit/src/runner.ts --lint-config
```

**Passthrough rule** (propagation to child runners), previously duplicated in
several places and now carried by the `FlagSpec.passthrough` field: an option is
propagated only when the child cannot derive it from its environment.

| Option | Propagated? | Why |
|---|---|---|
| `--fresh`, `--allow-dirty`, `--base-branch` | yes | parent decisions, invisible to the child |
| `--worktree` | no | the dispatch child inherits the cwd (`chdir`) and `RUNNER_IN_WORKTREE`; it is rejected with `--scan` |
| `--watch` | no | scans do not propagate it to children |
| `--steps`, `--skip` | yes | the operator's selection applies to every scanned ticket |
| `--start-at` | no | rejected with `--scan`: a replay is a decision about one run |
| `--pipeline` | no | set explicitly by the spawn caller |
