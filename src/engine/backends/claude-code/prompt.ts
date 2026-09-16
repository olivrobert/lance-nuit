import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Load the fork-relay prompt shipped with the claude-code backend. */
const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "prompts");

const PLACEHOLDER_RE = /\{\{(\w+)\}\}/g;

export function promptTemplate<const K extends readonly string[]>(
  name: string,
  keys: K,
  dir: string = PROMPTS_DIR,
): (vars: Record<K[number], string>) => string {
  const path = join(dir, `${name}.md`);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8").trimEnd();
  } catch {
    throw new Error(`Prompt "${name}": file not found (${path})`);
  }
  const found = new Set([...raw.matchAll(PLACEHOLDER_RE)].map((match) => match[1]));
  const declared = new Set<string>(keys);
  const undeclared = [...found].filter((key) => !declared.has(key));
  const unused = [...declared].filter((key) => !found.has(key));
  if (undeclared.length || unused.length) {
    throw new Error(
      [
        undeclared.length ? `undeclared placeholders: ${undeclared.join(", ")}` : "",
        unused.length ? `declared keys absent from file: ${unused.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("; "),
    );
  }
  return (vars) => raw.replace(PLACEHOLDER_RE, (_, key: K[number]) => vars[key]);
}
