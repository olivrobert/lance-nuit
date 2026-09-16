# GitHub Issues via `gh` (optional)

Configure the provider in `.lance-nuit/config.json`:

```json
{
  "workItem": {
    "provider": "github",
    "project": "owner/repository",
    "todoState": "pipeline:todo",
    "reviewState": "pipeline:in-review",
    "baseUrl": "https://github.com/owner/repository/issues"
  },
  "labels": {
    "bugTodo": "queue:bug",
    "featureTodo": "queue:feature",
    "done": "queue:done",
    "escalate": "queue:human"
  }
}
```

Create the configured labels in the repository, install/authenticate the
GitHub CLI, then run a pipeline with a numeric issue reference:

```sh
gh auth login
lancenuit run 123 --pipeline ./examples/github-gh/pipeline.ts
```

`--scan` lists open issues carrying both the selected queue label and the
configured logical-state label. Queue and state changes remain label-based;
the adapter does not close issues automatically.
