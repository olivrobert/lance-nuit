import { expect, test } from "bun:test";
import { isSafeHref, renderMarkdown } from "./markdown.js";

test("markdown: HTML in the source is escaped, never rendered", () => {
  const html = renderMarkdown('Look: <script>alert("x")</script> & <b>bold</b>');
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("<b>");
  expect(html).toContain("&lt;script&gt;");
  expect(html).toContain("&amp;");
});

test("markdown: escaping runs before the rules, so injected markup cannot come back", () => {
  // A closing tag written inside emphasis must stay text after the rule fires.
  expect(renderMarkdown("**</p><img src=x onerror=1>**")).toContain(
    "<strong>&lt;/p&gt;&lt;img src=x onerror=1&gt;</strong>",
  );
});

test("markdown: headings, emphasis, and inline code", () => {
  const html = renderMarkdown("# Title\n\nSome **bold**, some *italic*, and `code()`.");
  expect(html).toContain("<h1>Title</h1>");
  expect(html).toContain("<strong>bold</strong>");
  expect(html).toContain("<em>italic</em>");
  expect(html).toContain("<code>code()</code>");
});

test("markdown: emphasis markers inside a code span stay literal", () => {
  expect(renderMarkdown("Use `a ** b` here")).toContain("<code>a ** b</code>");
});

test("markdown: fenced code keeps its content verbatim and escaped", () => {
  const html = renderMarkdown("```ts\nconst a = 1 < 2;\n```");
  expect(html).toContain('<pre><code class="language-ts">');
  expect(html).toContain("const a = 1 &lt; 2;");
});

test("markdown: unordered, ordered, and nested lists", () => {
  const html = renderMarkdown("- one\n- two\n  - nested\n\n1. first\n2. second");
  expect(html).toContain("<ul>");
  expect(html).toContain("<li>one</li>");
  expect(html).toContain("<ol>");
  expect(html).toContain("<li>first</li>");
  // Every list that was opened is closed.
  expect(html.split("<ul>").length).toBe(html.split("</ul>").length);
  expect(html.split("<ol>").length).toBe(html.split("</ol>").length);
});

test("markdown: task checkboxes render checked and unchecked, and stay disabled", () => {
  const html = renderMarkdown("- [x] done\n- [ ] todo");
  expect(html).toContain('<input type="checkbox" disabled checked>');
  expect(html).toContain('<input type="checkbox" disabled>');
  expect(html).toContain("<span>done</span>");
  expect(html).toContain("<span>todo</span>");
});

test("markdown: tables become a real table, header apart", () => {
  const html = renderMarkdown("| Field | Source |\n|---|---|\n| status | `state.json` |\n| cost | history |");
  expect(html).toContain("<table>");
  expect(html).toContain("<th>Field</th>");
  expect(html).toContain("<td>status</td>");
  expect(html).toContain("<td><code>state.json</code></td>");
  expect(html).toContain("</table>");
});

test("markdown: a line of pipes without a delimiter row is not a table", () => {
  expect(renderMarkdown("a | b | c")).not.toContain("<table>");
});

test("markdown: http(s) and relative links become anchors", () => {
  const html = renderMarkdown("[spec](https://example.test/spec) and [file](artifacts/plan.md)");
  expect(html).toContain('<a href="https://example.test/spec" target="_blank" rel="noreferrer noopener">spec</a>');
  expect(html).toContain('<a href="artifacts/plan.md">file</a>');
});

test("markdown: a javascript: link renders as text, not as an anchor", () => {
  const html = renderMarkdown("[click](javascript:alert(1))");
  expect(html).not.toContain("<a ");
  expect(html).not.toContain("href");
  expect(html).toContain("[click](javascript:alert(1))");
});

test("markdown: data: and other schemes are refused by the same rule", () => {
  expect(isSafeHref("data:text/html,<script>")).toBe(false);
  expect(isSafeHref("vbscript:msgbox")).toBe(false);
  expect(isSafeHref("JavaScript:alert(1)")).toBe(false);
  expect(isSafeHref("http://example.test")).toBe(true);
  expect(isSafeHref("./report.md")).toBe(true);
  expect(isSafeHref("#section")).toBe(true);
});

test("markdown: block quotes and horizontal rules close cleanly", () => {
  const html = renderMarkdown("> quoted\n\n---\n\ntail");
  expect(html).toContain("<blockquote>");
  expect(html).toContain("</blockquote>");
  expect(html).toContain("<hr>");
  expect(html).toContain("<p>tail</p>");
});
