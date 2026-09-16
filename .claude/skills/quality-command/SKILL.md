---
name: quality-command
description: "Create CLI commands in src/commands/*.ts. Use whenever a file matching that pattern is added or modified."
allowed-tools: Read, Write, Edit, Skill
---

# Create CLI commands

## Workflow

1. Read `.claude/quality/code/constraints/command.md` and apply it in full — it is the only normative source.
2. Read `src/commands/stats.ts` and mirror its shape; where the constraints disagree, the constraints win.

## Output

- `src/commands/*.ts`
