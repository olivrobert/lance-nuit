# Work-item layout

A work item is a directory under `.lance-nuit/work-items/<TICKET>/`. A project
pipeline may keep one plan split into batches (for example in
`artifacts/lots.json`) without creating one dispatch run per batch.

```text
.lance-nuit/work-items/<TICKET>/
├── artifacts/               # pipeline outputs (spec, plan, triage, lots, ...)
│   ├── ticket.md            # fetched source content, written by the work-item loop
│   ├── inputs/              # optional human-provided files
│   ├── report.json          # optional delivery report shown by the dashboard
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

## Delivery report: `artifacts/report.json`

A pipeline may end a run by writing `artifacts/report.json`, a structured
delivery report. It is the only file the dashboard reads to render a finished
run as a report: the dashboard never extracts a status from markdown. The shape
is the `RunReport` type, exported with `RUN_REPORT_FILE` from `@lance-nuit/dsl`
so the step that builds it typechecks against it (see
[`DSL-API.md`](../docs/DSL-API.md#run-report)). Build it in a command or action
step from artifacts that already exist rather than asking an agent to write it.

| Field | Content |
| --- | --- |
| `version` | Always `1`. |
| `runId` | The id of the run that wrote it, as in `runs/<pipeline>/<runId>/`. |
| `links` | `{ label, url, primary? }`. Only `http:` and `https:` URLs are kept; the `primary` link (a merge request) becomes the sheet's main action. |
| `delivered` | `{ label, value, copy?, hint? }` cells such as the branch or the last commit; `copy` offers a copy button. |
| `criteria` | `{ id, text, met, proof, captures?, reserve? }` per acceptance criterion; `proof` lists `test`, `code` or `screen`; each `captures` entry is `<dir>/<name>` of a screenshot listed under `captures`, so two lots writing the same file name stay distinct. |
| `followUps` | `{ text, detail?, source? }`: what is left for a human on this ticket. |
| `forReview` | `{ title, items: [{ ref?, text }] }`: points for a product owner, such as assumptions. |
| `captures` | `{ dir, files: [{ name, acs, caption? }] }`: screenshots, `dir` relative to the work-item directory. |
| `notes` | `{ title, path, summary? }`: folded links to documents, `path` relative to the work-item directory. |

Rules the dashboard applies when it reads the file:

- **One run.** A report whose `runId` is not the work item's current run is
  ignored silently: a rerun that fails before writing its report never shows
  the previous one.
- **Field by field.** An invalid entry (missing required field, wrong type,
  non-http(s) link, path that is absolute or has an empty, `.` or `..` segment)
  is dropped and named in a warning at the bottom of the Report tab; the rest of
  the report is shown. An unknown `proof` value is dropped from its criterion.
- **Whole-file rejection** only when the file resolves outside the work item
  (through a link), is larger than the text limit of the explorer (1 MiB), is
  not valid JSON, is not an object, has a `version` other than `1`, or has an
  empty or non-string `runId`. The sheet then shows one line with the reason in
  place of the Report tab.
- **Absent file.** No report: the sheet shows its generic parts only.

Like every artifact, the file is read from the effective work-item directory,
which is the worktree copy for a worktree run.

## Disable dispatch

`RUNNER_DISABLE_DISPATCH=1` forces single-run mode. This recursion guard is set on
every child launched by a dispatch strategy; without it, the child would select
the same strategy forever.
