import { expect, test } from "bun:test";
import { toolLabel } from "./tool-label.js";

test("file tools are named by basename, not by path", () => {
  expect(toolLabel("Read", { file_path: "/src/domain/order/handler.ts" })).toBe("Read handler.ts");
  expect(toolLabel("Edit", { file_path: "a.ts" })).toBe("Edit a.ts");
  expect(toolLabel("Write", {})).toBe("Write");
});

test("delegating tools are named by what they delegate to", () => {
  expect(toolLabel("Skill", { skill: "db-migration" })).toBe("skill(db-migration)");
  expect(toolLabel("Agent", { subagent_type: "Explore" })).toBe("agent(Explore)");
  expect(toolLabel("Agent", { name: "reviewer" })).toBe("agent(reviewer)");
  expect(toolLabel("Agent", {})).toBe("agent(?)");
});

test("searches keep their pattern and their scope", () => {
  expect(toolLabel("Grep", { pattern: "dispatch", path: "/src/Domain" })).toBe('Grep "dispatch" in Domain');
  expect(toolLabel("Grep", { pattern: "x" })).toBe('Grep "x"');
  expect(toolLabel("Glob", { pattern: "**/*.php" })).toBe("Glob **/*.php");
});

test("a shell call prefers its description over its command", () => {
  expect(toolLabel("Bash", { description: "Run tests", command: "bun test" })).toBe("Bash Run tests");
  expect(toolLabel("Bash", { command: "bun test" })).toBe("Bash bun test");
});

test("unknown tools and malformed input degrade to the bare name", () => {
  expect(toolLabel("Mystery", { anything: 1 })).toBe("Mystery");
  expect(toolLabel("Read", null)).toBe("Read");
  expect(toolLabel("Read", "not-an-object")).toBe("Read");
  expect(toolLabel("Read", [1, 2])).toBe("Read");
  expect(toolLabel("Skill", { skill: 42 })).toBe("skill(?)");
});

test("long values are clipped so one call stays one line", () => {
  const label = toolLabel("Bash", { command: "x".repeat(200) });
  expect(label.length).toBeLessThanOrEqual("Bash ".length + 61);
  expect(label.endsWith("…")).toBe(true);
});
