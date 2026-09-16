# Jira via `acli` (optional)

This pipeline opts into the Jira adapter. Configure `.lance-nuit/config.json`:

```json
{
  "workItem": { "provider": "jira", "project": "DEMO" },
  "specPath": ".lance-nuit/work-items"
}
```

Then install and authenticate Atlassian's `acli`, and run:

```sh
lancenuit run DEMO-123 --pipeline ./examples/jira-acli/pipeline.ts
```

Without this pipeline (or another work-item step), the generic engine never
calls `acli`. The repository test suite exercises this example with a fake
executable and no network.
