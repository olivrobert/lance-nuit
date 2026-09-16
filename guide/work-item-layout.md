# Work-item layout

A work item is a directory under `.lance-nuit/work-items/<TICKET>/`. A project
pipeline may keep one plan split into batches (for example in
`artifacts/lots.json`) without creating one dispatch run per batch.

```text
.lance-nuit/work-items/<TICKET>/
├── artifacts/               # pipeline outputs (spec, plan, triage, lots, ...)
│   ├── ticket.md            # fetched source content, written by the work-item loop
│   ├── inputs/              # optional human-provided files
│   └── .provenance/         # <name>.json: inputs each output was produced from
├── reports/                 # timestamped reports (e2e, retrospective, ...)
├── decisions/               # human decisions (--approve)
└── runs/                    # per-run state and logs
```

The three families (`artifacts/`, `reports/`, `runs/`) are described in the
architecture guide. `artifacts/.provenance/` is owned by the runner: it holds one
`{ artifact, producedBy, producedAt, inputs: { "artifacts/<name>": "<sha256>" } }`
record per output of a step declaring `input`, which is what makes a rerun replay
only what its sources changed. See [`persistence.md`](persistence.md) for the
record shape and [`dsl.md`](dsl.md) for the freshness rules.

Tickets in **arbitrary work-item subdirectories** are supported by passing the
full path: `lancenuit run exports/PROJ-1478 --pipeline delivery` targets
`.lance-nuit/work-items/exports/PROJ-1478/` (the directory must exist). Segments may
contain `[a-zA-Z0-9_-]` only; `..` and absolute paths are rejected.

In TypeScript pipelines, `ctx.ticketDir` is the resolved path and `ctx.ticket` is
the original identifier. `ctx.paths.artifactsDir`, `reportsDir`, and
`decisionsDir` are the canonical subdirectories; use artifact descriptors or
`ctx.artifacts` instead of assembling artifact paths manually.

The resolver also supports explicit nested identifiers such as
`exports/PROJ-1478`. Numeric sub-work-item identifiers can resolve
`PROJ-28-01` to `PROJ-28/US-01` when that layout is present; this is a path
resolution convention, not a dispatch model imposed by the runner.

## Disable dispatch

`RUNNER_DISABLE_DISPATCH=1` forces single-run mode. This recursion guard is set on
every child launched by a dispatch strategy; without it, the child would select
the same strategy forever.
