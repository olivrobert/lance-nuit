import { XMLParser } from "fast-xml-parser";
import type { ErrorExtractor } from "../contracts/extraction.js";
import { truncate } from "../lib/truncate.js";

/** Trace lines kept per failure: past that it is all vendor/ and framework. */
const TRACE_LINES = 6;

/** Attempts made to salvage a report cut mid-tag (see `parseReport`). */
const MAX_REPAIRS = 5;

const ATTRIBUTE_PREFIX = "@_";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: ATTRIBUTE_PREFIX,
  // Elements become arrays, attributes stay scalars: one <testcase> and twenty
  // are then read by the same code. CDATA is deliberately left merged into the
  // text node, since a failure message is one message however it was written.
  isArray: (_name, _path, _isLeafNode, isAttribute) => !isAttribute,
  // A message reading `12` is a message, not a number, and a trace keeps its
  // own indentation: `condense` decides what to trim.
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  // `&lt;` and friends: the XML escapes the message, and a fix must read PHP.
  // This also covers the numeric references PHPUnit writes for non-ASCII text.
  htmlEntities: true,
});

type XmlNode = Record<string, unknown>;

function isNode(value: unknown): value is XmlNode {
  return typeof value === "object" && value !== null;
}

/** Child elements under `tag`, tolerating the scalar shape of a text-only leaf. */
function elements(node: XmlNode, tag: string): unknown[] {
  const value = node[tag];
  if (Array.isArray(value)) return value;
  return value === undefined ? [] : [value];
}

function attribute(element: unknown, name: string): string {
  if (!isNode(element)) return "";
  const value = element[`${ATTRIBUTE_PREFIX}${name}`];
  return typeof value === "string" ? value : "";
}

function counter(element: unknown, name: string): number {
  const value = Number(attribute(element, name));
  return Number.isFinite(value) ? value : 0;
}

/** Text of an element, whether it carries attributes or is a bare string. */
function text(element: unknown): string {
  if (typeof element === "string") return element;
  if (!isNode(element)) return "";
  const value = element["#text"];
  return typeof value === "string" ? value : "";
}

/**
 * The runner merges stdout and stderr into one buffer: isolate the report
 * before parsing, so a PHP deprecation carrying a `<` cannot derail the parse.
 */
function closingIndex(output: string, tag: string): number {
  const index = output.lastIndexOf(tag);
  return index < 0 ? -1 : index + tag.length;
}

function xmlRegion(output: string): string | undefined {
  const start = output.search(/<testsuites?[\s/>]/);
  if (start < 0) return undefined;
  const end = Math.max(closingIndex(output, "</testsuites>"), closingIndex(output, "</testsuite>"));
  return end > start ? output.slice(start, end) : output.slice(start);
}

/**
 * A killed suite leaves the report cut mid-write. Unclosed elements are parsed
 * as they stand, but a tag cut before its `>` throws: retry on the prefix that
 * ends at the last complete tag, which keeps every testcase written so far.
 */
function parseReport(xml: string): XmlNode | undefined {
  let candidate = xml;
  let searchFrom = xml.length;
  for (let attempt = 0; attempt <= MAX_REPAIRS; attempt++) {
    try {
      return parser.parse(candidate) as XmlNode;
    } catch {
      const cut = candidate.lastIndexOf(">", searchFrom - 1);
      if (cut <= 0) return undefined;
      candidate = xml.slice(0, cut + 1);
      searchFrom = cut;
    }
  }
  return undefined;
}

/** Every `<testsuite>` of the report, parents before the suites they nest. */
function collectSuites(node: unknown, into: XmlNode[]): void {
  if (!isNode(node)) return;
  for (const root of elements(node, "testsuites")) collectSuites(root, into);
  for (const suite of elements(node, "testsuite")) {
    if (!isNode(suite)) continue;
    into.push(suite);
    collectSuites(suite, into);
  }
}

/**
 * PHPUnit >= 9 emits a `<testsuites>` root WITHOUT attributes: the `failures`
 * and `errors` counters are carried by the nested `<testsuite>` elements. Each
 * one is therefore tested, and a single non-zero counter is enough (a boolean,
 * not a sum: nested suites would double-count).
 */
function anySuiteReportsFailure(suites: XmlNode[]): boolean {
  return suites.some((suite) => counter(suite, "failures") > 0 || counter(suite, "errors") > 0);
}

/** Message plus the head of the trace. The rest is vendor/ noise for a fix. */
function condense(body: string, test: string): string {
  const lines = body
    .trim()
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean);
  // PHPUnit opens the block with the test name, which the header already
  // carries: drop it rather than paying for the same line twice.
  if (lines[0] === test || lines[0]?.startsWith(`${test} `)) lines.shift();
  const kept = lines.slice(0, TRACE_LINES);
  if (lines.length > TRACE_LINES) kept.push(`  ... (+${lines.length - TRACE_LINES} trace lines)`);
  return kept.join("\n");
}

/**
 * Reads the JUnit XML written by PHPUnit. Each failure is rendered as
 * `Class::test` plus its message: without the test name a bare assertion
 * message does not say what to fix, and the XML carries that name on the parent
 * `<testcase>` — never inside the `<failure>` block.
 */
export const extract: ErrorExtractor = (output) => {
  const xml = xmlRegion(output);
  if (xml === undefined) return { hasErrors: false, errors: truncate(output), reportFound: false };

  const report = parseReport(xml);
  // Nothing parsable survived: the failing exit code still stands, and the raw
  // output is what the fix pass gets.
  if (!report) return { hasErrors: false, errors: truncate(output), reportFound: false };

  const suites: XmlNode[] = [];
  collectSuites(report, suites);

  const details: string[] = [];
  for (const suite of suites) {
    for (const testcase of elements(suite, "testcase")) {
      const problem = [...elements(testcase as XmlNode, "failure"), ...elements(testcase as XmlNode, "error")][0];
      if (problem === undefined) continue; // green testcase (or skipped/warning only)
      const test =
        [attribute(testcase, "class"), attribute(testcase, "name")].filter(Boolean).join("::") ||
        attribute(testcase, "file") ||
        "unknown test";
      const message = condense(text(problem), test);
      details.push(message ? `${test}\n${message}` : test);
    }
  }

  // A counter can be non-zero with no detailed block (a suite cut before its
  // first testcase, or a suite that logs counters only).
  const hasErrors = details.length > 0 || anySuiteReportsFailure(suites);
  if (!hasErrors) return { hasErrors: false, errors: "", reportFound: true };

  // The total precedes truncation: a fix handed 3 failures out of 19 would
  // otherwise believe it has the complete list and stop too early.
  const header = details.length > 1 ? `${details.length} failing tests:\n\n` : "";
  return { hasErrors: true, errors: header + truncate(details.join("\n\n") || output), reportFound: true };
};
