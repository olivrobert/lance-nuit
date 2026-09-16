# lance-nuit

A runner that executes agent pipelines against work items, persists every run on
disk, and stops at human gates. `lancenuit ui` is the local web dashboard that reads
that persisted state and drives the runner through its CLI.

## Language

### Runs and state

**Run**:
One execution of a pipeline for a work item, owned by a single writer and persisted
as its own directory. Resumable unless it passed.
_Avoid_: Job, execution, session (a session belongs to an agent backend)

**Gate**:
A point in a pipeline where the run stops until a human approves a declared artifact.
_Avoid_: Checkpoint, pause, review step

**Approval**:
A human decision recorded for one gate subject and locked to the SHA-256 of the
artifact it approves. Fresh while the artifact is unchanged, stale once it changes.
_Avoid_: Validation, sign-off, decision (the file name; use approval in prose)

**Effective work-item directory**:
The directory whose artifacts and approvals a run actually reads: the worktree copy
when the run executes in a worktree, the main clone otherwise.

### Scan

**Parent run**:
The `--scan` process that discovers tickets, spawns one child run per ticket, and
aggregates their outcomes. It never executes a step itself.
_Avoid_: Orchestrator, supervisor, scan run

**Child run**:
The run of one ticket spawned by a parent run, living in its own process and, when
parallelism is above one, its own worktree.
_Avoid_: Subprocess, worker, job

**Parallelism**:
The maximum number of child runs in flight during a scan. Above one, every ticket
runs in its own worktree and the main clone is left untouched.
_Avoid_: Concurrency, workers, threads

**Slot**:
One unit of parallelism, freed when its child run ends and immediately given to the
next ticket in discovery order.
_Avoid_: Worker, lane, thread

### Dashboard

**Morning box**:
The dashboard list of items across all projects that wait for a human: stopped at a
gate, failed, or aborted.
_Avoid_: Inbox, queue, todo list

**Item**:
One work item as the morning box shows it, identified by `project/ticket`, carrying
its latest run's status, stop reason, pending approval, cost and age.
_Avoid_: Ticket (the tracker's reference only), card, row

**Verb**:
One of the closed set of actions the dashboard can trigger on an item, each mapping
to exactly one existing CLI invocation.
_Avoid_: Command, action, endpoint

**Launch**:
The dashboard's own record of one verb it triggered: who, when, which item, the
exact arguments, the process id, the exit code and the captured output.
_Avoid_: Job, task, run (a launch may fail before any run exists)

**Read model**:
The read-only layer that composes the runner's state modules into items for the
dashboard. The only module allowed to import the runner's state internals.
_Avoid_: API, query layer, projection
