# Core contract and extensions

This repository is one TypeScript application, not a collection of independently
versioned features. Its CLI, execution engine, DSL, persistence, and built-in
integrations are implemented under `src/` and published as
`lance-nuit`.

The stable extension surface is a subpath export of the same package:

| Entry point | Responsibility |
| --- | --- |
| `lance-nuit/contracts` | Stable backend and work-item ports used by external extensions |
| `lance-nuit` | CLI, engine, DSL, persistence, and built-in integrations |

Keeping the public port on its own entry point lets a Redmine adapter implement
the contract against a small, stable surface. It does not require turning every
internal directory into an npm package.

`lance-nuit/contracts` has no runtime dependency and performs no I/O; `bun run
lint` enforces it. An adapter can import it on any runtime, and anything the
contracts need from the host — paths, environment, file contents — is passed in
by the caller.

An agent backend reports a failure no repair can clear by setting
`failCause: "blocked"` on its `AgentResult` (see
[failures, retries, escalation](failures-retries-escalation.md)). A result that
only carries the `BLOCKED:` prefix on `failReason` is normalized by the runner,
so an adapter that reports the obstacle in prose works unchanged. `hasBlockedPrefix` is
exported for an adapter that would rather read that prefix itself — off a wrapped
provider, say — and set the field.

## Explicit composition

An extension is an ordinary ESM module. It default-exports a manifest; importing
the module does not mutate a global registry. The manifest shape is part of the
public contract, as `ExtensionManifest` in `lance-nuit/contracts`:

| Manifest key | Contribution | Contract |
| --- | --- | --- |
| `backends` | Agent backends: run an agent, return its result, session and usage | `AgentBackendFactory` |
| `workItems` | Work-item providers: read tickets, find candidates, comment, move | `WorkItemGatewayRegistration` |

Every key is optional. Each contribution is a `{ id, create }` pair: the host
stores the factory under its `id` and calls `create` only when a run first needs
that provider, so a manifest with a misconfigured adapter still loads. The host
refuses two rules explicitly rather than resolving them silently: a key outside
the table above is an error, and an `id` the registries already hold, built-in
or not, is an error. A composition that wants to replace a built-in provider
therefore builds registries that do not register it, instead of shadowing it.

`defineExtension` types a manifest in place, without importing the interface.
It performs no validation and registers nothing:

```ts
import { defineExtension } from "lance-nuit/contracts";
import { redmine } from "./redmine.js";

export default defineExtension({ workItems: [redmine] });
```

The standalone CLI loads the module named in `.lance-nuit/config.json`:

```json
{
  "extensions": { "module": "./.lance-nuit/extensions.mjs" },
  "workItem": { "provider": "redmine", "project": "APP" }
}
```

The path is resolved from the project. A bare name such as
`@acme/pipeline-redmine` is resolved from that project's `node_modules`. There
is no package scan and no registration by import side effect. One manifest can
aggregate several local and npm adapters.

## How a kit extension resolves `lance-nuit/contracts`

An ESM module resolves a bare specifier by walking up `node_modules/` from its
own location. An extension that lives in a kit — `<project>/.lance-nuit/` or
the shared `~/.lance-nuit/` — would therefore only find `lance-nuit/contracts`
if the project had installed `lance-nuit` locally, and a shared kit never could.

The CLI closes that gap itself. `lancenuit types install` (and `lancenuit
create`, which runs it) writes a self-contained copy of the contracts into the
kit, at `<kit>/node_modules/lance-nuit/`: `package.json` with the `./contracts`
and `./contracts/*` exports, the compiled JavaScript, and the declarations. The
copy has no dependency and about 200 KB; `node_modules/` inside the kit ignores
itself, so it never reaches Git. From an extension inside the kit,
`lance-nuit/contracts` and `lance-nuit/contracts/testing` resolve to that copy
by ordinary resolution, whether the CLI is installed globally, from a checkout,
or in another project.

The copy is the running CLI's, by construction: before a run imports the
extension named in `extensions.module`, boot compares the fingerprint recorded
in the vendored `package.json` with its own contracts and rewrites the package
when it is missing, incomplete, or stale — after a CLI update, for instance. A
worktree run shares the main clone's copy through a link. Boot only touches a
package it wrote: a `node_modules/lance-nuit` that is a symlink or carries no
`lanceNuitContracts` marker belongs to you and is left alone, and `types
install` refuses to replace it. An extension outside every kit (a file at the
project root, an npm package) is not concerned and resolves the contracts from
the project's own `node_modules`, as before.

Type-only imports work the same way: the kit's `tsconfig.json` resolves
`lance-nuit/contracts` through the vendored declarations, so `lancenuit
typecheck` and an editor see the same surface the runtime loads.

The standalone CLI has two composition paths: `entry/registries.ts` for runs
and `commands/registries.ts` for commands outside a run. The default registry
factories supply the built-in providers; boot receives the selected registries,
applies the manifest, and attaches the resulting providers to the pipeline
context. It does not compose a second default registry, and nothing falls back
to the built-in registry. A composition that replaces a built-in provider is
therefore the single source of truth for the whole run.

## A local Redmine adapter

Keep the adapter inside the kit, next to the manifest: `lancenuit types install`
vendors the contracts there, so its imports of `lance-nuit/contracts` resolve
against the CLI that runs it, with no dependency to declare in the project and
no version to keep aligned. This holds for a global CLI, a checkout on the
`PATH`, or a project-local install alike; see [usage](usage.md#installation).

Redmine does not need to become a package while it is project-specific.
Implement the core port locally and register its factory:

```ts
// .lance-nuit/redmine.ts
import type {
  WorkItemGateway,
  WorkItemGatewayDeps,
  WorkItemGatewayRegistration,
} from "lance-nuit/contracts";

class RedmineGateway implements WorkItemGateway {
  readonly provider = "redmine";

  constructor(private readonly deps: WorkItemGatewayDeps) {}

  // Implement validateRef, fetch, findCandidates, comment and moveTo here.
}

export const redmine: WorkItemGatewayRegistration = {
  id: "redmine",
  create: (deps) => new RedmineGateway(deps),
};
```

```ts
// .lance-nuit/extensions.ts
import { defineExtension } from "lance-nuit/contracts";
import { redmine } from "./redmine.js";

export default defineExtension({ workItems: [redmine] });
```

Use `lance-nuit/contracts/testing` to run the reusable gateway contract. It
checks projection, stable queue filtering, idempotent comments, and moves. Two
cases need adapter-specific hooks and only run when you supply them: pass
`readNotes` to verify marker-based note deduplication, and `armMoveInterrupt`
(plus optionally `appliedOperations`) to verify safe replay after an
interrupted move. Without a hook, its case is not registered — a green run
never means an unchecked guarantee.

The contract does not import a test runner: bind it to yours once per file, so
an adapter can run on bun, vitest or jest.

```ts
import { describe, expect, it } from "vitest";
import { createWorkItemGatewayContract } from "lance-nuit/contracts/testing";

const runWorkItemGatewayContract = createWorkItemGatewayContract({ describe, it, expect });

runWorkItemGatewayContract("redmine", () => new RedmineGateway(deps));
```

## When Redmine should become a package

Keep the adapter local when it encodes one project's URL conventions, fields,
authentication, or workflow. Publish it when several projects need the same
implementation and independent versioning. That package should depend only on
`lance-nuit/contracts`, export a registration or an `ExtensionManifest`, and
remain independent of the CLI.
