# Prompt files

Prompt files keep long agent instructions out of a pipeline definition. There are
two authoring APIs:

- `promptTemplate(name, keys)` is the internal loader for the claude-code
  backend's `fork-relay.md` prompt, kept in
  `src/engine/backends/claude-code/prompts/`.
- `promptFile(relativePath, keys)` is injected into project pipeline factories and
  resolves a file relative to that pipeline file.

## Project prompts

```text
.lance-nuit/pipelines/
├── feature.ts
└── prompts/triage.md
```

```ts
import type { Dsl } from "@lance-nuit/dsl";

export default ({ pipeline, llmStep, promptFile }: Dsl) => {
  const triage = promptFile("./prompts/triage.md", ["ticket", "artifactsDir"] as const);
  return pipeline("feature")
    .add(llmStep({
      id: "triage",
      name: "Triage",
      backend: "claude",
      profile: "triage",
      command: (ctx) => triage({
        ticket: ctx.ticket ?? "?",
        artifactsDir: ctx.paths.artifactsDir ?? "artifacts",
      }),
    }))
    .build();
};
```

`prompts/triage.md`:

```md
Analyze ticket {{ticket}} and write the result under {{artifactsDir}}.
```

The path must be relative to the pipeline file; absolute paths are rejected. The
file is read and validated while the pipeline module loads. Every `{{placeholder}}`
must be declared and every declared key must occur in the file. The tuple's
`as const` preserves an exact substitution type. At render time every declared
value must be a string. Placeholders may contain surrounding whitespace
(`{{ ticket }}`); only the double-brace form is substituted, so ordinary JSON
braces remain unchanged.

An agent step can also use the `prompt: "./prompts/triage.md"` option. That option
loads the file as a complete prompt relative to the pipeline file, without
placeholder validation or substitutions. Use `promptFile` when a prompt needs
typed, context-dependent values.

## Runner-shipped templates

`promptTemplate` reads the runner-shipped backend prompt directory by default
(currently `src/engine/backends/claude-code/prompts/` in a source checkout) and
validates the declared keys at module load. Its placeholder grammar is the
narrower `{{word}}` form. It is not a project `pipelines/prompts/` loader; project
pipelines should use the injected
`promptFile` so relocation does not depend on the runner's current working
directory.

## Escalation notes are different

Prompts address an agent. Work-item escalation notes address a tracker and are
provider-neutral structured notes rendered by the work-item adapter. Pipelines
build them in code through the `escalation` callback of `humanReview()`, which
returns `cause`, `state`, `action`, and optional `details`.

Notes are plain text because the current Jira adapter sends comments through
`acli`; Markdown syntax would be visible to the reader. The runner adds the
idempotence marker and any approval command at runtime. See
[`human-control.md`](human-control.md) for the human escalation workflow.
