import type { ExecutionKey, WorkItemNote } from "./types.js";

const MARKER_UNSAFE = /[^A-Za-z0-9._-]+/g;
const MARKER_PREFIX = "[pipeline:";
const slug = (value: string) =>
  value
    .trim()
    .replace(MARKER_UNSAFE, "-")
    .replace(/^-+|-+$/g, "");

export function markerFor(key: ExecutionKey): string {
  return `[pipeline:${slug(key.stepId)}:${slug(key.ticket)}]`;
}

export function hasMarker(body: string, key: ExecutionKey): boolean {
  return body.includes(markerFor(key));
}

export function isPipelineNote(body: string): boolean {
  return body.includes(MARKER_PREFIX);
}

/** Strips Markdown syntax without touching the line structure. */
function strip(value: string): string {
  return value
    .replace(/```+/g, "")
    .replace(/`/g, "")
    .replace(/\[([^\]]*)\]\(([^)]*)\)/g, "$1 $2")
    .replace(/[[\]]/g, "")
    .replace(/\*+/g, "")
    .replace(/_{2,}/g, "")
    .replace(/^\s*#{1,6}\s*/gm, "");
}

/** A headline or a label holds on one line: every run of whitespace collapses. */
function flattenInline(value: string): string {
  return strip(value)
    .replace(/^\s*[-+*>]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** A field value carries its structure in its line breaks: groups and bullets.
 *  Collapsing them rendered an unreadable block on the ticket, so only horizontal
 *  whitespace and surplus blank lines are dropped; bullets stay bullets. */
function flattenBlock(value: string): string {
  return strip(value)
    .split("\n")
    .map((line) => line.replace(/[^\S\n]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function renderPlainText(note: WorkItemNote, key: ExecutionKey): string {
  const lines = [
    flattenInline(note.headline),
    ...note.fields.map((field) => {
      const label = flattenInline(field.label);
      const value = flattenBlock(field.value);
      // A multi-line field keeps its label alone on its line: otherwise the first
      // line of the value would stick to the label and the rest would drift away.
      return value.includes("\n") ? `${label} :\n${value}` : `${label} : ${value}`;
    }),
  ];
  if (note.footer) lines.push(flattenBlock(note.footer));
  lines.push(markerFor(key));
  return lines.filter((line) => line.length > 0).join("\n\n");
}

export function renderMarkdown(note: WorkItemNote, key: ExecutionKey): string {
  const blocks = [`**${note.headline.trim()}**`];
  // A multi-line value leaves the list: a bullet that itself contains bullets does
  // not render, and the block would lose its groups.
  for (const field of note.fields) {
    const value = field.value.trim();
    blocks.push(
      value.includes("\n") ? `**${field.label.trim()}** :\n\n${value}` : `- **${field.label.trim()}** : ${value}`,
    );
  }
  if (note.footer) blocks.push(note.footer.trim());
  blocks.push(`<!-- ${markerFor(key)} -->`);
  return blocks.join("\n\n");
}
