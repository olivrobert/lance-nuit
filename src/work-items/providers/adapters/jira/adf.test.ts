import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adfToMarkdown, resolveAdfConverter } from "./index.js";

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

  describe("tables", () => {
    const paragraph = (...content: unknown[]) => ({ type: "paragraph", content });
    const text = (value: string, marks?: unknown[]) => ({ type: "text", text: value, ...(marks ? { marks } : {}) });
    const cell = (value: string, type = "tableCell") => ({ type, content: [paragraph(text(value))] });
    const row = (...cells: unknown[]) => ({ type: "tableRow", content: cells });
    const table = (...rows: unknown[]) => ({ type: "doc", content: [{ type: "table", content: rows }] });

    it("header row and data rows keep their rows and columns", () => {
      const doc = table(
        row(cell("Id", "tableHeader"), cell("Rule", "tableHeader"), cell("Decision", "tableHeader")),
        row(cell("R-1"), cell("Sorting by name fails"), cell("FIX")),
        row(cell("R-2"), cell("Export is slow"), cell("WONTFIX")),
      );
      expect(adfToMarkdown(doc)).toBe(
        [
          "| Id | Rule | Decision |",
          "| --- | --- | --- |",
          "| R-1 | Sorting by name fails | FIX |",
          "| R-2 | Export is slow | WONTFIX |",
        ].join("\n"),
      );
    });

    it("inline marks, links, and code survive inside cells", () => {
      const doc = table(
        row(cell("Case", "tableHeader"), cell("Check", "tableHeader")),
        row(
          { type: "tableCell", content: [paragraph(text("bold", [{ type: "strong" }]))] },
          {
            type: "tableCell",
            content: [
              paragraph(
                text("run", [{ type: "code" }]),
                text(" then "),
                text("docs", [{ type: "link", attrs: { href: "https://x.test/d" } }]),
              ),
            ],
          },
        ),
      );
      expect(adfToMarkdown(doc)).toBe(
        "| Case | Check |\n| --- | --- |\n| **bold** | `run` then [docs](https://x.test/d) |",
      );
    });

    it("pipes are escaped, even inside inline code", () => {
      const doc = table(
        row(cell("Expr", "tableHeader")),
        row({ type: "tableCell", content: [paragraph(text("a|b"), text(" "), text("x || y", [{ type: "code" }]))] }),
      );
      expect(adfToMarkdown(doc)).toBe("| Expr |\n| --- |\n| a\\|b `x \\|\\| y` |");
    });

    it("several paragraphs, a hard break, or a list stay on the cell's row", () => {
      const list = {
        type: "bulletList",
        content: [
          { type: "listItem", content: [paragraph(text("one"))] },
          { type: "listItem", content: [paragraph(text("two"))] },
        ],
      };
      const doc = table(
        row(cell("Notes", "tableHeader"), cell("Steps", "tableHeader")),
        row(
          {
            type: "tableCell",
            content: [paragraph(text("first")), paragraph(text("line"), { type: "hardBreak" }, text("break"))],
          },
          { type: "tableCell", content: [list] },
        ),
      );
      expect(adfToMarkdown(doc)).toBe("| Notes | Steps |\n| --- | --- |\n| first<br>line<br>break | - one<br>- two |");
    });

    it("first row without header cells → empty header row, the data stays data", () => {
      const doc = table(row(cell("R-1"), cell("FIX")), row(cell("R-2"), cell("KEEP")));
      expect(adfToMarkdown(doc)).toBe("|  |  |\n| --- | --- |\n| R-1 | FIX |\n| R-2 | KEEP |");
    });

    it("header column only (first cell of each row) is not a header row", () => {
      const doc = table(row(cell("Id", "tableHeader"), cell("R-1")), row(cell("Rule", "tableHeader"), cell("Sort")));
      expect(adfToMarkdown(doc)).toBe("|  |  |\n| --- | --- |\n| Id | R-1 |\n| Rule | Sort |");
    });

    it("uneven rows, empty cells, and merged cells keep every row as wide as the table", () => {
      const doc = table(
        row(cell("A", "tableHeader"), cell("B", "tableHeader"), cell("C", "tableHeader")),
        row(cell("1")),
        row({ type: "tableCell", attrs: { colspan: 2 }, content: [paragraph(text("wide"))] }, cell("3")),
        row({ type: "tableCell", content: [] }, cell("y"), cell("z")),
      );
      expect(adfToMarkdown(doc)).toBe(
        ["| A | B | C |", "| --- | --- | --- |", "| 1 |  |  |", "| wide |  | 3 |", "|  | y | z |"].join("\n"),
      );
    });

    it("table without rows → nothing", () => {
      expect(adfToMarkdown({ type: "doc", content: [{ type: "table", content: [] }] })).toBe("");
    });
  });

  it("expand and nested expand keep their title before their content", () => {
    const paragraph = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
    const doc = {
      type: "doc",
      content: [
        {
          type: "expand",
          attrs: { title: "Technical notes" },
          content: [
            paragraph("See the repository class"),
            { type: "nestedExpand", attrs: { title: "Out of scope" }, content: [paragraph("The export")] },
          ],
        },
        { type: "expand", attrs: { title: "" }, content: [paragraph("untitled")] },
      ],
    };
    expect(adfToMarkdown(doc)).toBe(
      "**Technical notes**\n\nSee the repository class\n\n**Out of scope**\n\nThe export\n\nuntitled",
    );
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

describe("jira gateway — ADF converter resolution", () => {
  const originalPluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  afterEach(() => {
    if (originalPluginRoot === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
    else process.env.CLAUDE_PLUGIN_ROOT = originalPluginRoot;
  });

  it("ignores a converter script found under CLAUDE_PLUGIN_ROOT", () => {
    const root = mkdtempSync(join(tmpdir(), "adf-plugin-root-"));
    mkdirSync(join(root, "scripts"));
    writeFileSync(join(root, "scripts", "adf-to-markdown.py"), "#!/usr/bin/env python3\n");
    process.env.CLAUDE_PLUGIN_ROOT = root;
    expect(resolveAdfConverter()).toBeUndefined();
  });

  it("keeps an explicit converter that exists, drops one that does not", () => {
    const script = join(mkdtempSync(join(tmpdir(), "adf-explicit-")), "convert.py");
    writeFileSync(script, "#!/usr/bin/env python3\n");
    expect(resolveAdfConverter(script)).toBe(script);
    expect(resolveAdfConverter(join(tmpdir(), "adf-absent", "convert.py"))).toBeUndefined();
  });
});
