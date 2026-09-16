# Nightly ticket loop

The complete pipeline the project README summarizes. It takes the next three
tickets from a work-item queue and, for each one: opens a branch, lets a coder
implement the ticket, runs the tests and lets an agent repair them with a tight
tool set if they fail, commits, asks a second backend to review the branch and
write a typed verdict, and hands the ticket over to a human when the verdict
asks for one. Each ticket runs under its own cost ceiling.

Nothing in [`pipeline.ts`](pipeline.ts) names a model: `coder` and `reviewer`
are roles, mapped to a model and an effort per backend in
`.lance-nuit/config.json`. See
[agents, profiles, and backends](../../guide/agents-profiles-backends.md).

## What it needs

- A work-item provider configured in `.lance-nuit/config.json` (Jira through
  `acli` or GitHub through `gh`), with a `featureTodo` queue. See
  [work items](../../guide/work-item-port.md).
- The `claude` and `codex` CLIs installed and authenticated.
- A clean Git tree: a fresh run refuses to start on a dirty one.

## Run it

```sh
cp examples/nightly-tickets/pipeline.ts .lance-nuit/pipelines/nightly.ts
git add .lance-nuit && git commit -m "Add nightly pipeline"
lancenuit run --pipeline nightly --scan
```

Each ticket gets its own run, its own budget, and its own summary. The first
step, reading the ticket from the tracker, is added by the loop:

```text
╭─ ✓ SUCCESS · nightly · PROJ-47
│  Pipeline completed successfully
│  7 completed
│  38m20s · $6.12 · 148,904 tok
│  Budget $6.12 / $8.00
╰────────────────────────────────────────

Executed steps
  ✓ Read ticket (work item → ticket.md)  1s
  ✓ Create branch  0s
  ✓ Implement  24m11s · $3.95 · 1 retry
  ✓ Run tests  6m02s · $0.87 · 1 retry
  ✓ Commit  0s
  ✓ Review  8m05s · $1.30 · 21,410 tok
  ✓ Hand over to a human  2s

Files
  run     .lance-nuit/work-items/PROJ-47/runs/nightly/20260903-031504
  events  .lance-nuit/work-items/PROJ-47/runs/nightly/20260903-031504/events.jsonl
  log     .lance-nuit/work-items/PROJ-47/runs/nightly/20260903-031504/steps/review/attempt-001/output.log
```

In the morning, three local branches exist, each implemented, tested, committed
and reviewed. Nothing is pushed: that is where this pipeline chooses to stop. Two
tickets are still in their queue, ready for you to open a merge request. The
third is in the `escalate` queue with a note that says why the reviewer wanted a
human, where the code is, and what to do next. If the machine went to sleep
halfway through, the same command resumes where it stopped.

## About the cost ceiling

`maxCostPerWorkItemUsd: 8` stops a ticket's run once the agents have reported
eight dollars of usage. The guard reacts to what each backend streams, so a
Codex turn can run past the ceiling before its usage is known. Keep a margin, or
split long steps. See [budgets and timeouts](../../guide/budgets-timeouts.md).

The repository test suite typechecks and loads this pipeline; it is not executed
against real backends.
