---
name: quality-store
description: "Create File-backed stores in src/state/stores/file-*.ts. Use whenever a file matching that pattern is added or modified."
allowed-tools: Read, Write, Edit, Skill
---

# Create File-backed stores

## Workflow

1. Read `.claude/quality/code/constraints/store.md` and apply it in full — it is the only normative source.
2. Read `src/state/stores/file-run-state-store.ts` and mirror its shape; where the constraints disagree, the constraints win.

## Output

- `src/state/stores/file-*.ts`
