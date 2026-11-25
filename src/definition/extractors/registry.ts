import type { ErrorExtractor } from "../../contracts/extraction.js";
import { extract as infection } from "./infection.js";
import { extract as phpstan } from "./phpstan.js";
import { extract as phpunit } from "./phpunit.js";
import { extract as testsJson } from "./tests-json.js";
import { extract as tsc } from "./tsc.js";

/** The extractors a step may name in `errorExtractor`. Adding one means
 *  registering it here: the definition validates names against these keys and
 *  execution reads the function from this table. */
const ERROR_EXTRACTORS: ReadonlyMap<string, ErrorExtractor> = new Map([
  ["infection", infection],
  ["phpstan", phpstan],
  ["phpunit", phpunit],
  ["tests-json", testsJson],
  ["tsc", tsc],
]);

export function errorExtractorNames(): string[] {
  return [...ERROR_EXTRACTORS.keys()];
}

export function errorExtractor(name: string): ErrorExtractor | undefined {
  return ERROR_EXTRACTORS.get(name);
}
