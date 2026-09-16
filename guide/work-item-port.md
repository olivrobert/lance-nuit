# Work-item port: controlling a tracker

Everything the runner does to a ticket goes through **one port**,
`src/contracts/work-items.ts`: `WorkItemGateway`. Previously this control lived in
natural-language prompts that hardcoded the provider CLI: the model decided the
format, queue names, and operation order, while idempotence depended on its good
will. Today the engine knows only a logical vocabulary; provider operations stay in
adapters. The registry and configuration still name the selected provider
deliberately—there is no implicit provider fallback.

```
src/builtin-steps/lib/work-item-steps.ts  deterministic actionSteps
  forEachWorkItem      → source scan + ticket.md (blocking: downstream spec source)
  workItemEscalateStep → note + queue       (blocking(false): tracker outage ≠ failed run)
  workItemDeliveryStep → merge-request note + queue + state
        │
        │  ctx.workItem  (LAZY memoized getter — src/pipeline/context.ts)
        ▼
┌─ src/modules/work-item ──────────────────────────────────────────────────────┐
│  contracts/work-items.ts  the port: 4 operations, logical vocabulary         │
│  registry.ts  provider → factory, the explicit extension point               │
│  note.ts      structured notes + idempotence marker (markerFor)              │
│  fake.ts      in-memory adapter, seedable and deliberately failure-capable   │
│  contract.test.ts  EXPORTED contract suite, replayed by every adapter        │
│  adapters/jira/  Jira provider                                                │
│  adapters/github/ GitHub Issues provider                                      │
│  process/runner.ts spawn adapter (the only place that launches a binary)     │
└──────────────────────────────────────────────────────────────────────────────┘
```

## Port vocabulary

| Concept | Values | What the adapter does |
|---|---|---|
| `WorkQueue` | `bugTodo`, `featureTodo` | logical input queue, therefore scannable. A new pipeline adds its queue here |
| `TerminalQueue` | `done`, `escalate` | automation output queue, never a scan source |
| `AutomationQueue` | `WorkQueue \| TerminalQueue` | queues projected by the provider however it chooses (label, custom field, column), through Jira's `config.labels` |
| `WorkItemState` | `todo`, `inReview` | workflow state. The real status name and allowed transition are adapter data (`workItem.todoState` / `reviewState`) |
| `WorkItemRef` | opaque string | `validateRef` is the **sole** authority on its shape |
| `WorkItemNote` | structured `{ headline, fields, footer? }` | the adapter renders the text and knows whether its provider interprets Markdown |
| `MoveTarget` | `{ queue?, from?, state? }` | one logical move may become N provider operations |

The four operations—`fetch`, `findCandidates`, `comment`, and `moveTo`—plus
`validateRef`, which is not an operation (no effect or call: it validates the
reference shape, something only the provider can own). This is the complete set of
things pipelines do, including `--scan`, which discovers tickets through
`findCandidates({ queue, state, query? })` rather than a query written in the engine.
When a pipeline sets `scan.query`, the adapter sends that provider-native text
verbatim (Jira: the whole JQL; GitHub: `gh issue list --search`) instead of
projecting `queue` and `state`, and adds nothing to it. A provider without a
query language ignores it and keeps its projection.

## Add a provider (Redmine, GitHub Issues...)

1. **Write the adapter** — `src/modules/work-item/adapters/<provider>/index.ts`, exporting a
   `(deps: WorkItemGatewayDeps) => WorkItemGateway` factory. `deps` contains only
   `{ workItem, labels }`; if the adapter needs anything else from runner config,
   the boundary is in the wrong place. Every binary call goes through
`src/modules/work-item/process/runner.ts`, never a direct `spawn`.
2. **Replay the contract suite** — in `<provider>.test.ts`, call
   `runWorkItemGatewayContract("<provider>", factory, opts)`. It is **exported as a
   function** specifically to be replayed unchanged: this is the only mechanical
   guarantee that providers behave alike. It observes a provider only through the
   port (queue state is derived from `findCandidates`, fixtures are set through
   `moveTo`); rare observations unavailable through the port use capabilities in
   `opts`. An adapter that does not provide them gets those assertions skipped, not
   the entire suite.
3. **Register** — add one line to `createDefaultWorkItemGatewayRegistry()` in
   `registry.ts`. No dynamic discovery or import-time registration: a registry
   readable at a glance is one whose contents are known.
   `KNOWN_WORK_ITEM_PROVIDERS` follows from it and feeds the unknown-provider
   error.
4. **Configure** — extend the configuration parser/type to accept the provider,
   then set `workItem.provider: "<provider>"` in `.lance-nuit/config.json`. The
   standalone runner currently registers `jira` and `github`; nothing else
   changes: no pipeline, prompt, or step.

### GitHub through `gh`

The built-in GitHub adapter uses the authenticated `gh` CLI. Configure the
repository as `owner/repository`, use numeric issue references, and provide two
labels for the logical states because GitHub's native issue state only has
`open` and `closed`:

```json
{
  "workItem": {
    "provider": "github",
    "project": "owner/repository",
    "todoState": "pipeline:todo",
    "reviewState": "pipeline:in-review",
    "baseUrl": "https://github.com/owner/repository/issues"
  }
}
```

The four `labels.*` configuration values project the logical queues. The
adapter uses `gh issue view/list/comment/edit`, keeps issues open during queue
and state transitions, and reserves `closed` in the port for an issue actually
closed on GitHub. Authenticate first with `gh auth login` (or the normal
`GH_TOKEN` environment variable flow).

The non-negotiable contract is **idempotence**. A run may die between a provider
side effect and local persistence, and a step may be replayed on resume: every write
must therefore be replayable without duplicates, and each `moveTo` operation must
be idempotent **individually**. A mid-operation crash may leave partial state; replay
must complete only what is missing. For notes, the key is `{ ticket, stepId }`: the
adapter derives a marker (`markerFor`), includes it in the published body, and checks
before writing that no note already carries it. Pipeline corollary: **two escalations
from one pipeline must use distinct IDs** (`escalate` vs `escalate-redtest`), or the
second note looks like a replay and is never published. Runner corollary: renaming a
tracker step changes its idempotence key, so step IDs should remain stable.

## Lazy initialization invariant

`ctx.workItem` is a **memoized getter**: the adapter is created only on first access.
Nearly all runs, and `--lint-config`, never contact the tracker; constructing the
gateway while building the context would make the entire runner depend on valid
provider configuration.

Consequence: **never derive a context with `{ ...context }`**, which reads the getter
and creates the gateway. Use `deriveContext(base, overrides)` (`src/pipeline/context.ts`),
which copies the property's *descriptor* instead of evaluating it. This is harmless
until an adapter validates its configuration during construction; then every spread
would fail for a tracker nobody needed. `tests/pipeline/pipeline-context.test.ts` and
`lint-config.test.ts` lock the invariant by configuring an unregistered provider:
construction throws, so “derive without throwing” mechanically proves nothing was
created.
