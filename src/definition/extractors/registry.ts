import { existsSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** SINGLE source of truth for extractors: directory contents, nothing else. A
 *  hardcoded Set would drift: a contract could accept a name without a module
 *  (crashing at `import()`) or reject a file that is actually present.
 *
 *  The tradeoff: every FLAT file here IS an extractor and therefore exports
 *  `extract`. Code shared by extractors lives in `lib/`, test suites in `*.test.ts`;
 *  neither is offered as an extractor. */
/** `*.test.ts` suites live next to extractors: they do not export `extract` and
 *  must never be offered as extractors. Same for the `*.d.ts` declarations that
 *  tsc emits next to the `.js` files in dist. */
export function isExtractorModuleFile(file: string): boolean {
  return /\.(ts|js)$/.test(file) && !/\.(test\.(ts|js)|d\.ts)$/.test(file);
}

export function listAvailableExtractors(): Set<string> {
  const dir = dirname(fileURLToPath(import.meta.url));
  if (!existsSync(dir)) return new Set();
  return new Set(
    readdirSync(dir)
      .filter(isExtractorModuleFile)
      .map((file) => file.replace(/\.(ts|js)$/, ""))
      .filter((name) => name !== "registry"),
  );
}
