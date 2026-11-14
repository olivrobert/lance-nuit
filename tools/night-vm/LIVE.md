# live.json — where a night stands, for a reader outside the VM

`night.sh` keeps `~/.lance-nuit/night-runs/<run-id>/live.json` up to date so
that another program (an app that launched the night, a status bar) can follow
it without reaching into the VM. It is rewritten whole, by rename, at the start
of each phase, at every poll of the run phase (`NIGHT_POLL_SECONDS`, 60 s), and
once more when the night ends. A reader never sees a half-written file.

Next to it, `origin` holds the `LANCENUIT_ORIGIN` of whoever last started or
resumed the night (`chief:<thread>` for instance), when that caller had one.

## Format `night-live/1`

```jsonc
{
  "format": "night-live/1",
  "night": "hypnose-20261114-213000",          // the run id, also the folder's name
  "writtenAt": "2026-11-14T22:41:07+00:00",
  "contactAt": "2026-11-14T22:41:06+00:00",    // last state read from the VM; null before any
  "phase": { "name": "run", "since": "…" },   // vm secrets boot code broker prepare run; null before the first
  "phasesDone": [{ "name": "vm", "at": "…" }], // in night order, a resumed night keeps its earlier ones
  "result": null,                              // once ended: { "state": "passed|failed|cut", "reason", "at" }
  "tickets": [                                 // in the order the scan found them
    {
      "ticket": "18",
      "state": "pending|deferred|running|done",
      "outcome": "fixed|failed|escalated|…",   // null until done
      "run": {                                 // null while pending or deferred
        "runId": "…", "pipeline": "autonome", "status": "RUNNING|DONE|STOPPED|FAILED|…",
        "updatedAt": "…", "durationMs": 1234, "costUsd": 0.42,
        "stoppedReason": "…",                  // null unless stopped
        "stop": { "subject": "triage", "kind": "needs-decision", "detail": "…" },  // or null
        "steps": [                             // every step of the pipeline, pending ones included
          { "id": "triage", "status": "done", "attempt": 1, "startedAt": "…", "finishedAt": "…",
            "durationMs": 37843, "costUsd": 0.24 }
        ]
      }
    }
  ]
}
```

Any field may be `null` when the VM did not say. Texts are cut at 2,000
characters; ticket names that are not plain names (`[A-Za-z0-9._-]`) are left
out.

## The night has gone quiet

A `contactAt` older than a few polls while `result` is `null` means the VM, or
the host unit, stopped answering: `night.sh status <run-id>` says which.

## Trust

What `live.json` reports came from the VM, which runs an agent: `night_report.py`
reads the VM's archive with tar's `data` filter, refuses links, bounds its size
and member count, keeps only the fields above, and never uses a name from the
VM as a path. A reader should still validate the file against this format.
