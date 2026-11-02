import { existsSync } from "node:fs";
import { join } from "node:path";

const BLOCK_TYPES = new Set([
  "blockquote",
  "bulletList",
  "codeBlock",
  "decisionItem",
  "decisionList",
  "expand",
  "heading",
  "listItem",
  "mediaGroup",
  "mediaSingle",
  "nestedExpand",
  "orderedList",
  "panel",
  "paragraph",
  "rule",
  "table",
  "tableCell",
  "tableHeader",
  "tableRow",
  "taskItem",
  "taskList",
]);

interface AdfNode {
  type?: unknown;
  text?: unknown;
  content?: unknown;
  attrs?: unknown;
  marks?: unknown;
}

function nodesOf(value: unknown): AdfNode[] {
  return Array.isArray(value) ? (value.filter((node) => node && typeof node === "object") as AdfNode[]) : [];
}

function attrsOf(node: AdfNode): Record<string, unknown> {
  return node.attrs && typeof node.attrs === "object" ? (node.attrs as Record<string, unknown>) : {};
}

function applyMarks(text: string, marks: unknown): string {
  let out = text;
  for (const mark of nodesOf(marks)) {
    switch (mark.type) {
      case "strong":
        out = `**${out}**`;
        break;
      case "em":
        out = `*${out}*`;
        break;
      case "code":
        out = `\`${out}\``;
        break;
      case "link":
        out = `[${out}](${String(attrsOf(mark).href ?? "")})`;
        break;
      default:
        break;
    }
  }
  return out;
}

function inlineOf(node: AdfNode, indent: number): string {
  return nodesOf(node.content)
    .map((child) => adfToMarkdown(child, indent))
    .join("");
}

function blocksOf(node: AdfNode, indent: number): string {
  return nodesOf(node.content)
    .map((child) => adfToMarkdown(child, indent))
    .filter((part) => part.length > 0)
    .join("\n\n");
}

function holdsBlocks(node: AdfNode): boolean {
  return nodesOf(node.content).some((child) => typeof child.type === "string" && BLOCK_TYPES.has(child.type));
}

function sublistToMarkdown(node: AdfNode, indent: number): string | undefined {
  if (node.type === "bulletList" || node.type === "orderedList") {
    return nodesOf(node.content)
      .map((item, index) => listItemToMarkdown(item, indent, node.type === "orderedList", index + 1))
      .join("\n");
  }
  if (node.type === "taskList") return taskListToMarkdown(node, indent);
  return undefined;
}

function taskListToMarkdown(node: AdfNode, indent: number): string {
  return nodesOf(node.content)
    .map((item) => (item.type === "taskList" ? taskListToMarkdown(item, indent + 1) : taskItemToMarkdown(item, indent)))
    .filter((part) => part.length > 0)
    .join("\n");
}

function taskItemToMarkdown(node: AdfNode, indent: number): string {
  const prefix = "  ".repeat(indent);
  const bullet = attrsOf(node).state === "DONE" ? "- [x]" : "- [ ]";
  const inline: string[] = [];
  const parts: string[] = [];
  for (const child of nodesOf(node.content)) {
    const sublist = sublistToMarkdown(child, indent + 1);
    if (undefined !== sublist) {
      if (sublist.length > 0) parts.push(sublist);
      continue;
    }
    inline.push(adfToMarkdown(child, indent));
  }
  return [`${prefix}${bullet} ${inline.join("")}`, ...parts].join("\n");
}

function listItemToMarkdown(node: AdfNode, indent: number, ordered = false, index = 1): string {
  const prefix = "  ".repeat(indent);
  const bullet = ordered ? `${index}.` : "-";
  const parts: string[] = [];
  nodesOf(node.content).forEach((child, position) => {
    const sublist = sublistToMarkdown(child, indent + 1);
    if (undefined !== sublist) {
      if (sublist.length > 0) parts.push(sublist);
      return;
    }
    const text = adfToMarkdown(child, indent);
    if (!text) return;
    parts.push(position === 0 ? `${prefix}${bullet} ${text}` : `${prefix}  ${text}`);
  });
  return parts.join("\n");
}

/**
 * A Markdown table row holds one line, so a cell's blocks (several paragraphs, a
 * list) are joined with `<br>`; `|` is escaped because it would otherwise end
 * the cell, even inside inline code.
 */
function tableCellToMarkdown(node: AdfNode, indent: number): string {
  return nodesOf(node.content)
    .map((child) => adfToMarkdown(child, indent).trim())
    .filter((part) => part.length > 0)
    .join("<br>")
    .replace(/\n/g, "<br>")
    .replace(/\|/g, "\\|");
}

function tableRowCells(row: AdfNode, indent: number): string[] {
  return nodesOf(row.content).flatMap((cell) => {
    // A merged cell still occupies its columns: without the padding every cell
    // after it would shift left under the wrong header.
    const span = attrsOf(cell).colspan;
    const padding = typeof span === "number" && span > 1 ? Array<string>(span - 1).fill("") : [];
    return [tableCellToMarkdown(cell, indent), ...padding];
  });
}

function isHeaderRow(row: AdfNode): boolean {
  const cells = nodesOf(row.content);
  return cells.length > 0 && cells.every((cell) => cell.type === "tableHeader");
}

function tableToMarkdown(node: AdfNode, indent: number): string {
  const rows = nodesOf(node.content).filter((row) => row.type === "tableRow");
  if (rows.length === 0) return "";
  const [first, ...rest] = rows as [AdfNode, ...AdfNode[]];
  const header = isHeaderRow(first) ? tableRowCells(first, indent) : [];
  const body = (header.length > 0 ? rest : rows).map((row) => tableRowCells(row, indent));
  const width = Math.max(1, header.length, ...body.map((cells) => cells.length));
  // GFM has no headerless table: an empty header row keeps the first data row
  // from being promoted to column titles it never was.
  const line = (cells: string[]): string =>
    `| ${Array.from({ length: width }, (_, column) => cells[column] ?? "").join(" | ")} |`;
  return [line(header), `| ${Array<string>(width).fill("---").join(" | ")} |`, ...body.map(line)].join("\n");
}

function expandToMarkdown(node: AdfNode, indent: number): string {
  const title = attrsOf(node).title;
  const heading = typeof title === "string" && title.trim() ? `**${title.trim()}**` : "";
  return [heading, blocksOf(node, indent)].filter((part) => part.length > 0).join("\n\n");
}

export function adfToMarkdown(node: unknown, indent = 0): string {
  if (typeof node === "string") return node;
  if (!node || typeof node !== "object") return "";
  const current = node as AdfNode;
  const attrs = attrsOf(current);
  switch (current.type) {
    case "doc":
      return blocksOf(current, indent);
    case "paragraph":
      return inlineOf(current, indent);
    case "heading": {
      const level = typeof attrs.level === "number" && attrs.level >= 1 && attrs.level <= 6 ? attrs.level : 1;
      return `${"#".repeat(level)} ${inlineOf(current, indent)}`;
    }
    case "text": {
      const text = typeof current.text === "string" ? current.text : "";
      return nodesOf(current.marks).length > 0 ? applyMarks(text, current.marks) : text;
    }
    case "hardBreak":
      return "\n";
    case "inlineCard":
      return String(attrs.url ?? "");
    case "bulletList":
    case "orderedList":
      return nodesOf(current.content)
        .map((item, index) => listItemToMarkdown(item, indent, current.type === "orderedList", index + 1))
        .join("\n");
    case "listItem":
      return listItemToMarkdown(current, indent);
    case "taskList":
      return taskListToMarkdown(current, indent);
    case "taskItem":
      return taskItemToMarkdown(current, indent);
    case "codeBlock":
      return `\`\`\`${String(attrs.language ?? "")}\n${inlineOf(current, indent)}\n\`\`\``;
    case "blockquote":
      return nodesOf(current.content)
        .map((child) => adfToMarkdown(child, indent))
        .filter((part) => part.length > 0)
        .map((part) => `> ${part}`)
        .join("\n");
    case "rule":
      return "---";
    case "table":
      return tableToMarkdown(current, indent);
    case "expand":
    case "nestedExpand":
      return expandToMarkdown(current, indent);
    case "mediaSingle":
    case "media":
      return "";
    default:
      return holdsBlocks(current) ? blocksOf(current, indent) : inlineOf(current, indent);
  }
}
export function resolveAdfConverter(explicit?: string): string | undefined {
  if (explicit) return existsSync(explicit) ? explicit : undefined;
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  return pluginRoot
    ? existsSync(join(pluginRoot, "scripts", "adf-to-markdown.py"))
      ? join(pluginRoot, "scripts", "adf-to-markdown.py")
      : undefined
    : undefined;
}
