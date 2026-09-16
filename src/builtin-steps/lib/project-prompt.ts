import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

const PLACEHOLDER_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

export type PromptRenderer<K extends readonly string[]> = (values: Record<K[number], string>) => string;

/** Function injected into a project factory. The loader supplies the pipeline
 * file base, so the pipeline never needs to know the runner cwd. */
export type PromptFileFactory = <const K extends readonly string[]>(relativePath: string, keys: K) => PromptRenderer<K>;

function formatPromptError(filePath: string, message: string, cause?: unknown): Error {
  return new Error(`Project prompt "${filePath}": ${message}`, cause === undefined ? undefined : { cause });
}

function readProjectPrompt(filePath: string): string {
  try {
    return readFileSync(filePath, "utf8").trimEnd();
  } catch (error) {
    const detail = error instanceof Error ? ` : ${error.message}` : "";
    throw formatPromptError(filePath, `missing or unreadable file${detail}`, error);
  }
}

/** Bind `promptFile` to the imported pipeline directory. */
export function createPromptFile(baseDir: string): PromptFileFactory {
  const pipelineDir = resolve(baseDir);

  return <const K extends readonly string[]>(relativePath: string, keys: K): PromptRenderer<K> => {
    if (typeof relativePath !== "string" || relativePath.trim().length === 0) {
      throw new Error("promptFile(): relative path is required");
    }
    if (isAbsolute(relativePath)) {
      throw new Error(`promptFile(): path must be relative to the pipeline file (received: ${relativePath})`);
    }
    if (!Array.isArray(keys) || !keys.every((key): key is string => typeof key === "string" && key.length > 0)) {
      throw new Error(`promptFile("${relativePath}"): keys must be a tuple of non-empty strings`);
    }
    if (new Set(keys).size !== keys.length) {
      throw new Error(`promptFile("${relativePath}"): keys contains duplicates`);
    }

    const filePath = resolve(pipelineDir, relativePath);
    const raw = readProjectPrompt(filePath);
    const found = new Set<string>();
    for (const match of raw.matchAll(PLACEHOLDER_RE)) {
      const key = match[1]?.trim();
      if (!key) throw formatPromptError(filePath, "empty placeholder");
      found.add(key);
    }

    const declared = new Set<string>(keys);
    const undeclared = [...found].filter((key) => !declared.has(key));
    const unused = [...declared].filter((key) => !found.has(key));
    if (undeclared.length || unused.length) {
      const details = [
        undeclared.length ? `undeclared placeholders: ${undeclared.join(", ")}` : "",
        unused.length ? `declared keys missing from file: ${unused.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("; ");
      throw formatPromptError(filePath, details);
    }

    return (values: Record<K[number], string>): string => {
      for (const key of keys as readonly string[]) {
        if (typeof values?.[key as K[number]] !== "string") {
          throw formatPromptError(filePath, `missing or invalid substitution: ${key}`);
        }
      }
      const substitute = (_match: string, key: string): string => values[key as K[number]];
      return raw.replace(PLACEHOLDER_RE, substitute);
    };
  };
}
