# Generic shell pipeline

This example needs only Bun, Git, and the package itself. It does not use an
agent backend, work-item tracker, forge CLI, PHP, Symfony, Docker, or kit skills.

```sh
lancenuit run build-42 --pipeline ./examples/generic-shell/pipeline.ts
```

Copy the file to `.lance-nuit/pipelines/build.ts` and replace the `printf` command
with any project command (`npm test`, `cargo test`, `make`, a script, and so on).
