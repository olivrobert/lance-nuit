# Built-in pipelines

The package currently ships exactly one built-in pipeline: `default` (the
definition is `builtins/default.ts`). It is deliberately small and technology
neutral: one Bash step prints a readiness message and it performs no tracker,
forge, Docker, or agent initialization.

```bash
lancenuit list
lancenuit run PROJ-28                 # resolves the `default` name
lancenuit run PROJ-28 --pipeline default
```

`lancenuit list` also shows project and shared pipelines when they exist. A
project `.lance-nuit/pipelines/default.ts` or shared pipeline of the same name
shadows the package builtin according to the kit resolution chain.

Project-specific pipelines belong under `.lance-nuit/pipelines/`. Optional Jira,
GitHub, GitLab, Claude, and Codex integrations are activated only when a project
pipeline explicitly selects them; they are not hidden presets behind wrapper
verbs such as `quality` or `bugfix`.
