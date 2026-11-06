# Read API

`lancenuit ui` also serves a read-only, versioned JSON API under `/api/v1/`,
for a dashboard of your own or a script running on the same machine. It answers
what the [dashboard](usage.md#dashboard) shows — every run of every listed
project, its status, its cost, why it stopped — in a published shape that does
not follow the dashboard's screens.

The rest of `/api/` belongs to the dashboard's front end and changes with it,
without notice. Build on `/api/v1/` only.

## Reaching it

```bash
lancenuit ui --port 4848 --cors-origin http://localhost:3000
curl -s 'http://127.0.0.1:4848/api/v1/runs?current=true&status=FAIL,STOPPED'
```

- The server listens on `127.0.0.1` only, and every `/api/` request must carry
  `Host: 127.0.0.1:<port>` or `localhost:<port>` (this blocks DNS rebinding).
  Call it by one of those two names.
- **Same machine.** Whether a run is still running comes from its runner's
  lock, a live process on this machine. A reader elsewhere would need the
  answers exported to it; the API does not do that for it.
- **Containers.** A container on a bridge network cannot reach the host's
  `127.0.0.1`. Run it on the host network (`docker run --network host`) and
  call `127.0.0.1:<port>`.
- **Hosted pages.** Browsers refuse to let a page served from a public origin
  call a loopback address, whatever the server answers. A hosted dashboard
  (Grafana Cloud, for instance) cannot use this API.

## Endpoints

### `GET /api/v1/runs`

Every **root run** of every listed project, newest `updatedAt` first.

| Parameter | Meaning |
| --- | --- |
| `project` | Project name as the dashboard lists it |
| `ticket` | Ticket key |
| `status` | `RUNNING`, `PASS`, `FAIL`, `STOPPED`, `ABORTED`, case-insensitive; comma-separated or repeated (`status=FAIL&status=STOPPED`) |
| `since` | A duration back from now (`90s`, `45m`, `12h`, `30d`, `2w`) or an ISO 8601 instant; a run with no timestamp is left out |
| `current` | `true` keeps only the run each ticket is currently about |
| `limit` | 1 to 1000, default 200 |

Unknown parameters are ignored, so a reader written for a later version still
gets an answer. An invalid value is a `400` whose `error` starts with the
parameter's name: `{"error": "limit: expected an integer from 1 to 1000 ..."}`.

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-11-06T08:00:00.000Z",
  "runs": [
    {
      "project": "shop",
      "ticket": "SHOP-12",
      "pipeline": "bugfix",
      "runId": "20261105T221407.118Z-bugfix-3f9a1c",
      "current": true,
      "title": "Export a CSV",
      "status": "STOPPED",
      "awaitsHuman": true,
      "stop": { "subject": "plan", "kind": "needs-decision", "detail": "plan needs approval" },
      "approval": { "subject": "plan", "state": "absent" },
      "cost": { "usd": 1.84, "estimated": false, "lowerBound": false },
      "activeMs": 612000,
      "createdAt": "2026-11-05T22:14:07.118Z",
      "updatedAt": "2026-11-05T22:24:19.502Z",
      "worktree": true
    }
  ]
}
```

### `GET /api/v1/runs/<project>/<ticket>/<runId>`

One root run with its steps:

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-11-06T08:00:00.000Z",
  "run": { "...": "the same object as in the list" },
  "steps": [
    {
      "id": "coder",
      "status": "done",
      "profile": "coder",
      "model": "claude-sonnet-5-5",
      "durationMs": 412000,
      "cost": { "usd": 1.52, "estimated": false, "lowerBound": false },
      "retries": 1,
      "tokens": { "input": 120000, "output": 9000, "cacheRead": 800000, "cacheWrite": 40000 }
    }
  ],
  "report": { "version": 1, "...": "the delivery report" }
}
```

`report` is the work item's [delivery report](work-item-layout.md#delivery-report-artifactsreportjson),
in its own versioned format, and only on the current run. `reportError` says
why an existing `report.json` was ignored. A step composing pipelines ran no
agent itself: it lists its children's models in `models` instead of `model`.

An unknown project, ticket or run, a composed child, and any other path under
`/api/v1/` are a `404` with `{"error": "not found"}`. Only `GET` is served.

## Reading a run

| Field | What to know |
| --- | --- |
| root runs only | A run composed by another (`runPipeline`, `forEachPipeline`) is never listed: its spend is already in its parent's `cost`. Summing the list never counts it twice |
| `status` | The status a later `lancenuit run` would judge. A snapshot without a verdict that no live runner holds is `ABORTED` with `interrupted: true`, never `RUNNING` |
| `current` | Exactly one run per ticket carries it: the most recently updated latest run across the ticket's pipelines, the one the dashboard's inbox shows |
| `awaitsHuman` | Somebody has to rerun, decide, or close it |
| `stop` | Set exactly when `status` is `STOPPED`; `kind` is `needs-info`, `needs-decision`, `needs-human`, `blocked` or `until` |
| `failure` | Set exactly when `status` is `FAIL` or `ABORTED`. `kind`: `verdict` (the work was judged wrong) or `technical` (an incident stopped it); `cause: "blocked"` when no fix pass could change the answer |
| `approval` | The decision a stopped gate waits on, judged on the artifact as it stands now: `absent`, `fresh`, `stale`, `rejected` or `reworked`. Only on the current run |
| `cost` | `usd` is absent when nothing reported a figure: show nothing, not `0`. `estimated` means a rate table priced it. `lowerBound` means some tokens could not be priced: `usd` is a floor, to show as `≥` and never as the spend |
| `activeMs` | Time spent executing steps, waits for review excluded |
| `branch` | Recorded when the run finished; absent while it runs |
| `closed` | Closed by hand with `lancenuit close` while it still awaited somebody |

`title`, `stop.detail`, `failure.reason` and everything in `report` come from
the tracker, the pipeline or an agent. **Escape them** before rendering them as
HTML.

## Compatibility

The version is in the path and in `schemaVersion`. Within version 1:

- a field may be added, an enumeration may gain a value;
- a field is never removed, renamed, or given another type.

A reader ignores the fields it does not know and treats an unknown enumeration
value as "other". Anything else is version 2, served under `/api/v2/`; version
1 then stays served for at least one more minor release.

The JSON Schema of each answer (draft 2020-12) is in
[`docs/read-api/v1/`](../docs/read-api/v1/): `run-list.schema.json` and
`run-detail.schema.json`. It accepts additional properties, as the rules above
require. It is generated from the contract (`bun run docs:read-api`); never edit
it by hand.

## Browsers and CORS

A page served from another origin (`http://localhost:3000`, a Vite dev server)
may read the API only when that origin is listed at start-up:

```bash
lancenuit ui --cors-origin http://localhost:3000,http://localhost:5173
```

- Each value is one exact origin, `scheme://host[:port]`, compared the way a
  browser spells it. `*`, `null` and a value with a path are refused, and the
  dashboard does not start.
- Only `/api/v1/` answers with `Access-Control-Allow-Origin`; the rest of
  `/api/` never does. Credentials are never allowed: the dashboard's identity
  cookie does not travel with these requests, and the read API does not need it.
- A preflight `OPTIONS` under `/api/v1/` is answered `204` for a listed origin
  and `403` for any other. A simple `fetch` with no custom header needs none.
- An origin that is not listed still gets the answer: its browser keeps it from
  the page. `curl`, scripts and a server-side Grafana data source need no CORS
  at all.

```js
const response = await fetch("http://127.0.0.1:4848/api/v1/runs?since=7d");
const { runs } = await response.json();
```

## Cost of a request

Nothing is cached: each request reads the run snapshot of every root run of the
listed projects, and `limit` only cuts the answer once every run is read. The
cost grows with the number of runs on disk, not with `limit`. Poll at the pace
you need; the dashboard itself reads every 15 seconds.
