---
name: quality-contract
description: "Create Public contracts in src/contracts/**/*.ts. Use whenever a file matching that pattern is added or modified."
allowed-tools: Read, Write, Edit, Skill
---

# Create Public contracts

## Workflow

1. Read `.claude/quality/code/constraints/contract.md` and apply it in full — it is the only normative source.
2. Read `src/contracts/backends/claude-code.ts` and mirror its shape; where the constraints disagree, the constraints win.

## Output

- `src/contracts/**/*.ts`
