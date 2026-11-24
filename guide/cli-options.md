# CLI options

Source of truth: the `FLAGS` registry in `entry/cli-options.ts`, which drives the
parser (`entry/cli/parse.ts`) and `runner --help`. The `pipeline` wrapper maps `run`, `single`, `inspect`, `logs`,
`clean`, `worktree clean`, `stats`, `typecheck`, `lint`, `create`, `approve`, `reject`, `close`, `reopen`, and `list` to these
flags.

| Option | Alias | Description |
|---|---|---|
| `--pipeline <name\|path>` | `-p` | **Name** (`deploy`) resolved through the kit chain, or a path used as-is (default: `default`) |
| `--steps <ids>` | `-s` | Comma-separated IDs (the others are skipped). A prefix such as `checks` also selects `checks.*`. The selection lasts this invocation only ([admission of settled steps](dsl.md#admission-of-settled-steps)). It leaves out every step it does not name, whatever its status, and the journal records the reason `operator selection`: a `done` step stays `done`, a pending one becomes `skipped`, and one whose last pass failed, was aborted or was interrupted keeps that status, so the next invocation still meets the interruption guard and reruns the failed pass. The run then stops with `needs-decision` instead of passing (a run holding an aborted step stays `ABORTED`), unless an `--until` bound or another stop ended it first. An unfinished pass left no stamp in any case, so its outputs never settle the step later ([input freshness](dsl.md#input-freshness)). Nothing is persisted, so the run can otherwise still pass, and the next invocation admits those steps like any other, except `runPipeline`/`forEachPipeline` nodes and the step `forEachWorkItem` adds to read the ticket, which keep the status the selection left them in the run (`done`, or `skipped` for one that was pending). The final report counts and names them. Under `--scan`, applied to every ticket |
| `--skip <ids>` | `-k` | IDs to skip (mutually exclusive with `--steps`). Same scope and persistence as `--steps` |
| `--start-at <id>` | `-a` | Fork a new run from this step: the new run copies the steps before it as settled, and it and every later step start blank `pending`. The source is `--run <id>`, else `latest`, whatever its status (`PASS` included); no run is an error, and so is a source held by a live runner or a composed child run. `--run <older>` is refused while a different unfinished run is `latest`, naming it. A source that did not pass is closed `SUPERSEDED`. The target runs even when up to date in the freshness lock; the steps after it run only when their inputs changed or they have no stamp. No clean-tree guard. Refused, before anything is written, for an unknown id, with `--fresh`, `--steps` or `--skip`, on an inspection command, and when a step before the target is not settled, no longer fresh on its artifacts, or was left out by `--steps`/`--skip` and never ran. Rejected under `--scan`. See [Forking a run](usage.md#common-options) |
| `--until <id>` | | Stop the run once this step is settled (`done` or `skipped`): later steps stay `pending`, the run stops `STOPPED` with the stop kind `until`, stays resumable, and exits `3` (see [Exit codes](#exit-codes)). With nothing left after the step, the run passes normally. Valid for this invocation only and never persisted: a plain rerun continues past it. Exclusive with `--steps`; works with `--skip` and `--start-at` (a bound before the `--start-at` target is refused: nothing would run). A bound that `--skip` sets aside is reached even when its last pass is unfinished, so the run stops after it all the same. An unknown id is refused before any step, with the list of ids. Rejected on an inspection command. Under `--scan`, applied to every ticket |
| `--budget <usd>` | | Approve a cost ceiling in USD for this run. Resumes a run stopped by its budget without repaying completed steps. It changes the amount only: it never authorizes spend the runner could not price. Giving a ceiling to a run that had none when it spent an unpriceable amount stops that run as `cost-unaccounted` — the new amount is enforceable against nothing, so pair it with `--allow-unmetered` to cap the priced spend and authorize the rest |
| `--allow-unmetered` | | Authorize spend nobody can price, and resume a run stopped by `cost-unaccounted`. It lifts that stop only — the spend the runner *did* price still obeys the ceiling. Recorded on the selected run (later resumes need no flag) and propagated to the children it composes. Rejected on an inspection command and under `--scan` |
| `--replay-interrupted` | | Authorize replaying a step the runner died in (crash, OOM, `SIGKILL`); without it, or a `replayInterrupted` declaration on the step, the resumed run stops before running that step again. Valid for this invocation only, never persisted, and passed to the children it composes. Rejected on an inspection command and under `--scan`. See [Interrupted steps](dsl.md#interrupted-steps) |
| `--watch` | `-w` | Open a tmux pane with a live stream |
| `--watch-auto-close` | | With `--watch`, close the pane when the run is terminal (default: keep it open) |
| `--fresh` | `-f` | Ignore `latest` and force a new run. The [freshness lock](dsl.md#input-freshness) belongs to the work item, so steps still up to date are skipped in the new run too; force one with `--start-at` |
| `--allow-dirty` | | Bypass the clean Git tree guard for a top-level *fresh* run |
| `--worktree` | | Run in a dedicated Git worktree; optional project hooks perform setup |
| `--worktree-clean` | | Internal form used by `lancenuit worktree clean <ticket>`: run the optional `worktree-teardown.sh` hook, then remove the ticket worktree. See [usage.md](usage.md#worktrees) |
| `--scan` | | Without a ticket: discover through `forEachWorkItem({ scan })` and loop over tickets. Rejected without a scannable loop |
| `--limit <n>` | `-n` | Bound the items a command handles: tickets processed by `--scan` (overriding the `forEachWorkItem` limit), or runs listed by `--stats`. Error outside those two |
| `--base-branch <branch>` | `-b` | Available through `ctx.baseBranch`. Under `--scan`, also the branch checked out between tickets (otherwise the configured `baseBranch`) |
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
| `--close` | | Mark the latest failed, stopped, or aborted run of `--pipeline` as closed by hand, keeping its status. Requires a ticket and `--pipeline`, a name or the path of the pipeline file (`lancenuit close <ticket> --pipeline <name\|path>`): a path designates the pipeline whose runs started from that file or that is named after it, and is refused when it designates several. See [human-control.md](human-control.md#close-a-run-finished-by-hand) |
| `--reopen` | | Remove the closure written by `--close` (`lancenuit reopen <ticket> --pipeline <name\|path>`), `--pipeline` read as for `--close` |
| `--inspect` | | Display the latest run of each of a ticket's pipelines, from `state.json`, `closure.json`, the run lock and the work item's `lock.json`: status (`ABORTED (interrupted …)` for a `RUNNING` run no live runner holds, `SUPERSEDED` with `superseded by`), `forked from` with its `--start-at` step, `closed`, duration of the attempts, own spend, inherited spend and budget, `cwd` and worktree, and per step its attempt count, the kind and status of the last attempt, and `[absorbed]` when the stamp in `lock.json` was written by that run. Sub-runs are listed under their parent; a child on another work item reads its status from its own snapshot, the parent's ref when that snapshot is gone. The `journal` line only counts events: it is a trace, never a verdict. Combine with `--run` to select a run and `--pipeline <name>` to keep one pipeline's runs |
| `--logs` | | Display a ticket's logs; combine with `--step` and/or `--run` |
| `--run <runId>` | | Explicitly resume a run, or filter `--inspect`/`--logs` |
| `--pipeline <name>` with `--inspect` | | Keep the runs of that pipeline name, a composed child whose parent runs another pipeline included. A path, as `-p` takes it, keeps the runs started from that file and those of the pipeline named after it |
| `--step <id>` | | Filter `--logs` (for example `tests`) |
| `--clean` | | Remove old step logs; requires `--logs-only` |
| `--logs-only` | | With `--clean`, remove only step log files (snapshots/history are preserved) |
| `--older-than <duration>` | | With `--clean`, age threshold such as `30d` or `12h` |
| `--keep-failed` | | With `--clean`, preserve logs from failed, stopped and interrupted runs, a run whose runner died without a verdict included |
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
lancenuit inspect PROJ-28 --pipeline release
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
| `--worktree` | no | rejected with `--scan`, so a dispatch child never runs in a worktree |
| `--watch` | no | scans do not propagate it to children |
| `--steps`, `--skip` | yes | the operator's selection applies to every scanned ticket. It lasts that invocation of each child only, but a child that passed is complete, so a later scan skips its ticket and does not reconcile the steps the selection left out: run that ticket on its own to do so |
| `--until` | yes | the bound of a sweep (a night of triage only) applies to every scanned ticket; a child stopped at it is counted on the scan's `Until` line, not as a failure |
| `--start-at` | no | rejected with `--scan`: a fork is a decision about one run |
| `--pipeline` | no | set explicitly by the spawn caller |

## Exit codes

| Code | Meaning |
|---|---|
| `0` | The run passed, or stopped cleanly at a gate (`STOPPED` with `needs-*` or `blocked`): only the snapshot says it stopped |
| `1` | A failure, a budget or `cost-unaccounted` stop, or a usage or boot error |
| `3` | The run stopped at its `--until` bound with steps left after it. Resumable: rerun without `--until`, or with a later step |
| `130`, `143` | Interrupted by `SIGINT` or `SIGTERM` |

`3` is distinct from `1` so that `--scan`, cron, and shell scripts can tell a
stop the operator asked for from a run that broke, and non-zero so that none of
them reads an unfinished run as complete. `2` is avoided because shells and
argument parsers use it for usage errors. A failure or a cost stop reached in
the same invocation outranks it and exits `1`. A `--scan` parent's code does not
carry its children's: it reads them to classify each ticket, which its report and
[scan record](persistence.md#scan-records) show.
