---
name: quality-store
description: "Create File-backed stores in src/state/stores/file-*.ts, src/dispatch/file-scan-store.ts and src/work-item-store/file-*.ts. Use whenever a file matching those patterns is added or modified."
allowed-tools: Read, Write, Edit, Skill
---

# Create File-backed stores

## Workflow

1. Read `.claude/quality/code/constraints/store.md` and apply it in full — it is the only normative source.
2. Read `src/state/stores/file-run-state-store.ts` and mirror its shape; where the constraints disagree, the constraints win.

## Output

- `src/state/stores/file-*.ts`
- `src/dispatch/file-scan-store.ts`
- `src/work-item-store/file-*.ts`
