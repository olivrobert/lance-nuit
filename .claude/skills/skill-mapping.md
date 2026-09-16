# Skill mapping

One row per onboarded scope: the file type, the glob it covers, and the skill to
invoke when a plan creates or modifies such a file.

| File type | Glob | Skill |
|---|---|---|
| Public contract — published extension surface under `src/contracts/` (exported types, ports, registries) | `src/contracts/**/*.ts` | `quality-contract` |
| CLI command — module exporting a `RunnerCommand` (id, flag, key, desc, run) wired into `COMMANDS` | `src/commands/*.ts` | `quality-command` |
| File-backed store — `File*Store` / `File*Catalog` class implementing a persistence port | `src/state/stores/file-*.ts` | `quality-store` |
| Dashboard read model — read-only composer over the runner's state internals | `src/modules/read-model/*.ts` | `quality-read-model` |
| Step execution — module driving one stage of the step loop (admission, attempt, verdict, failure policy, fix loop, nested pipeline) | `src/step/*.ts` | `quality-step` |

## Arbitration with generic skills

- `react-expert` is generic React guidance. Inside `src/modules/ui/app/**/*.tsx`,
  `quality-component` wins: its constraints are derived from this codebase and are the
  only normative source. Use `react-expert` only outside that glob.
