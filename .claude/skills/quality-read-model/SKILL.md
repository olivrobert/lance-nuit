---
name: quality-read-model
description: "Create Dashboard read model in src/modules/read-model/*.ts. Use whenever a file matching that pattern is added or modified."
allowed-tools: Read, Write, Edit, Skill
---

# Create Dashboard read model

## Workflow

1. Read `.claude/quality/code/constraints/read-model.md` and apply it in full — it is the only normative source.
2. Read `src/modules/read-model/explorer.ts` and mirror its shape; where the constraints disagree, the constraints win.

## Output

- `src/modules/read-model/*.ts`
