import { describe, expect, it } from "bun:test";
import { adfToMarkdown } from "./index.js";

describe("jira gateway — internal ADF conversion", () => {
  it("headings, marks, links, and inline code", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: "Symptom" }] },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "bold", marks: [{ type: "strong" }] },
            { type: "text", text: " and " },
            { type: "text", text: "code", marks: [{ type: "code" }] },
            { type: "text", text: " and " },
            { type: "text", text: "link", marks: [{ type: "link", attrs: { href: "https://x.test/a" } }] },
          ],
        },
      ],
    };
    expect(adfToMarkdown(doc)).toBe("### Symptom\n\n**bold** and `code` and [link](https://x.test/a)");
  });

  it("bullet lists, ordered lists, and nesting", () => {
    const item = (text: string, sub?: unknown) => ({
      type: "listItem",
      content: [{ type: "paragraph", content: [{ type: "text", text }] }, ...(sub ? [sub] : [])],
    });
    const doc = {
      type: "doc",
      content: [
        { type: "bulletList", content: [item("one", { type: "orderedList", content: [item("one-a")] }), item("two")] },
      ],
    };
    expect(adfToMarkdown(doc)).toBe("- one\n  1. one-a\n- two");
  });

  it("code block, quote, rule, and media", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "codeBlock", attrs: { language: "php" }, content: [{ type: "text", text: "echo 1;" }] },
        { type: "blockquote", content: [{ type: "paragraph", content: [{ type: "text", text: "quoted" }] }] },
        { type: "rule" },
        { type: "mediaSingle", content: [{ type: "media", attrs: { id: "x" } }] },
      ],
    };
    expect(adfToMarkdown(doc)).toBe("```php\necho 1;\n```\n\n> quoted\n\n---");
  });

  it("task lists become markdown checkboxes", () => {
    const task = (text: string, state: string) => ({
      type: "taskItem",
      attrs: { state },
      content: [{ type: "text", text }],
    });
    const doc = {
      type: "doc",
      content: [{ type: "taskList", content: [task("done", "DONE"), task("todo", "TODO")] }],
    };
    expect(adfToMarkdown(doc)).toBe("- [x] done\n- [ ] todo");
  });

  it("task item with a nested sublist", () => {
    const child = {
      type: "bulletList",
      content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "child" }] }] }],
    };
    const sub = {
      type: "taskList",
      content: [{ type: "taskItem", attrs: { state: "DONE" }, content: [{ type: "text", text: "sub" }] }],
    };
    const doc = {
      type: "doc",
      content: [
        {
          type: "taskList",
          content: [
            { type: "taskItem", attrs: { state: "TODO" }, content: [{ type: "text", text: "parent" }, child, sub] },
          ],
        },
      ],
    };
    expect(adfToMarkdown(doc)).toBe("- [ ] parent\n  - child\n  - [x] sub");
  });

  it("unknown block node keeps its children separated", () => {
    const paragraph = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
    const doc = {
      type: "doc",
      content: [{ type: "panel", content: [paragraph("first"), paragraph("second")] }],
    };
    expect(adfToMarkdown(doc)).toBe("first\n\nsecond");
  });

  it("unknown node → content preserved without silent loss", () => {
    const doc = {
      type: "doc",
      content: [{ type: "panel", content: [{ type: "paragraph", content: [{ type: "text", text: "info" }] }] }],
    };
    expect(adfToMarkdown(doc)).toBe("info");
    expect(adfToMarkdown(undefined)).toBe("");
    expect(adfToMarkdown({ type: "doc" })).toBe("");
  });
});
