---
name: quality-step
description: "Create Step execution in src/step/*.ts. Use whenever a file matching that pattern is added or modified."
allowed-tools: Read, Write, Edit, Skill
---

# Create Step execution

## Workflow

1. Read `.claude/quality/code/constraints/step.md` and apply it in full — it is the only normative source.
2. Read `src/step/step-attempt.ts` and mirror its shape; where the constraints disagree, the constraints win.

## Output

- `src/step/*.ts`
