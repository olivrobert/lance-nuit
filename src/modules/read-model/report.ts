// modules/read-model/report.ts
//
// The delivery report of a work item's current run: `artifacts/report.json`,
// written by the pipeline, validated here before the dashboard renders it.
//
// The file is written by project code, so nothing in it is trusted. Validation
// is tolerant and field by field: an invalid entry is dropped and named in a
// warning, never the whole report; only a file that is unreadable, not JSON, or
// whose header (`version`, `runId`) is wrong yields no report at all, with a
// one-line reason. A report whose `runId` is not the current run's is stale —
// last night's report after a rerun — and is ignored without an error.
//
// Parsing is pure (`parseRunReport`) and kept apart from the IO (`readReport`),
// so every rule is tested without a fixture on disk.

import { readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  RUN_REPORT_FILE,
  type RunReport,
  type RunReportCaptureGroup,
  type RunReportCriterion,
  type RunReportDelivered,
  type RunReportFollowUp,
  type RunReportLink,
  type RunReportNote,
  type RunReportProof,
  type RunReportReview,
} from "../../model/run-report.js";
import { isPathWithin } from "../../state/stores/path-safety.js";
import { isSafeRelativePath, TEXT_LIMIT_BYTES } from "./explorer.js";
import type { ReadModelOptions } from "./projects.js";
import { resolveRun } from "./runs.js";

/**
 * What the sheet receives about the report.
 *
 * `report` is `null` when there is none to show — absent, stale, or rejected;
 * `reportError` says why only for a rejected file. `reportWarnings` lists the
 * entries dropped from a report that is otherwise shown, so a dropped criterion
 * never passes silently for a smaller, fully met list.
 */
export interface ReportRead {
  report: RunReport | null;
  reportError?: string;
  reportWarnings?: string[];
}

const PROOFS: readonly RunReportProof[] = ["test", "code", "screen"];

/** A report with more broken entries than this is broken as a whole; listing
 *  every one would bury the sheet. */
const MAX_WARNINGS = 20;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Collects the reasons entries were dropped, in document order. */
class Problems {
  readonly list: string[] = [];

  add(message: string): void {
    if (this.list.length < MAX_WARNINGS) this.list.push(message);
  }
}

/** Reads the fields of one entry. The first invalid field makes the entry
 *  invalid, and its path (`criteria[2].met`) is the reason given. */
class Fields {
  failure: string | undefined;

  constructor(
    private readonly value: Json,
    private readonly path: string,
  ) {}

  private fail(key: string, reason: string): undefined {
    this.failure ??= `${this.path}.${key} ${reason}`;
    return undefined;
  }

  text(key: string): string {
    const value = this.value[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
    this.fail(key, value === undefined ? "is missing" : "is not a non-empty string");
    return "";
  }

  optionalText(key: string): string | undefined {
    const value = this.value[key];
    if (value === undefined || typeof value === "string") return value;
    return this.fail(key, "is not a string");
  }

  optionalFlag(key: string): boolean | undefined {
    const value = this.value[key];
    if (value === undefined || typeof value === "boolean") return value;
    return this.fail(key, "is not a boolean");
  }

  flag(key: string): boolean {
    const value = this.value[key];
    if (typeof value === "boolean") return value;
    this.fail(key, value === undefined ? "is missing" : "is not a boolean");
    return false;
  }

  texts(key: string): string[] {
    const value = this.value[key];
    if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) return value;
    this.fail(key, value === undefined ? "is missing" : "is not a list of strings");
    return [];
  }

  /** A required list whose entries the caller parses one by one. */
  requireList(key: string): void {
    const value = this.value[key];
    if (!Array.isArray(value)) this.fail(key, value === undefined ? "is missing" : "is not a list");
  }

  optionalTexts(key: string): string[] | undefined {
    return this.value[key] === undefined ? undefined : this.texts(key);
  }

  /** A path relative to the work-item directory, rejected when it could leave
   *  it. The physical check happens when the file is opened through `readFile`. */
  relativePath(key: string): string {
    const value = this.text(key);
    if (value && !isSafeRelativePath(value)) this.fail(key, "escapes the work item");
    return value;
  }

  httpUrl(key: string): string {
    const value = this.text(key);
    if (value && !isHttpUrl(value)) this.fail(key, "is not an http(s) URL");
    return value;
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    // Not a URL at all: never shown as a link.
    return false;
  }
}

/** Entries of one optional list, each parsed on its own. A present value that is
 *  not a list drops the list; an invalid entry drops that entry only. */
function list<T>(
  root: Json,
  key: string,
  problems: Problems,
  parse: (fields: Fields, entry: Json, path: string) => T,
  parent = "",
): T[] | undefined {
  const value = root[key];
  const at = parent ? `${parent}.${key}` : key;
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    problems.add(`${at} is not a list`);
    return undefined;
  }
  const kept: T[] = [];
  value.forEach((entry, index) => {
    const path = `${at}[${index}]`;
    if (!isObject(entry)) {
      problems.add(`${path} is not an object`);
      return;
    }
    const fields = new Fields(entry, path);
    const parsed = parse(fields, entry, path);
    if (fields.failure) problems.add(fields.failure);
    else kept.push(parsed);
  });
  return kept;
}

/** Keep only the proofs the contract knows; an unknown one is named and dropped,
 *  the criterion stays. */
function proofs(values: readonly string[], path: string, problems: Problems): RunReportProof[] {
  const known: RunReportProof[] = [];
  values.forEach((value, index) => {
    const proof = PROOFS.find((candidate) => candidate === value);
    if (proof) known.push(proof);
    else problems.add(`${path}.proof[${index}] is not one of ${PROOFS.join(", ")}`);
  });
  return known;
}

function link(fields: Fields): RunReportLink {
  const primary = fields.optionalFlag("primary");
  return {
    label: fields.text("label"),
    url: fields.httpUrl("url"),
    ...(primary !== undefined ? { primary } : {}),
  };
}

function delivered(fields: Fields): RunReportDelivered {
  const copy = fields.optionalFlag("copy");
  const hint = fields.optionalText("hint");
  return {
    label: fields.text("label"),
    value: fields.text("value"),
    ...(copy !== undefined ? { copy } : {}),
    ...(hint !== undefined ? { hint } : {}),
  };
}

function criterion(problems: Problems) {
  return (fields: Fields, _entry: Json, path: string): RunReportCriterion => {
    const id = fields.text("id");
    const text = fields.text("text");
    const met = fields.flag("met");
    const proofValues = fields.texts("proof");
    const captures = fields.optionalTexts("captures");
    const reserve = fields.optionalText("reserve");
    // Proofs are filtered only for an entry that is kept, so a dropped criterion
    // is reported once, not once per proof.
    const proof = fields.failure ? [] : proofs(proofValues, path, problems);
    return {
      id,
      text,
      met,
      proof,
      ...(captures !== undefined ? { captures } : {}),
      ...(reserve !== undefined ? { reserve } : {}),
    };
  };
}

function followUp(fields: Fields): RunReportFollowUp {
  const detail = fields.optionalText("detail");
  const source = fields.optionalText("source");
  return {
    text: fields.text("text"),
    ...(detail !== undefined ? { detail } : {}),
    ...(source !== undefined ? { source } : {}),
  };
}

function captureFile(fields: Fields): RunReportCaptureGroup["files"][number] {
  const caption = fields.optionalText("caption");
  return {
    name: fields.relativePath("name"),
    acs: fields.texts("acs"),
    ...(caption !== undefined ? { caption } : {}),
  };
}

function captureGroup(problems: Problems) {
  return (fields: Fields, entry: Json, path: string): RunReportCaptureGroup => {
    const dir = fields.relativePath("dir");
    // A group dropped for its directory is reported once, not once per file.
    fields.requireList("files");
    const files = fields.failure ? [] : (list(entry, "files", problems, captureFile, path) ?? []);
    return { dir, files };
  };
}

function note(fields: Fields): RunReportNote {
  const summary = fields.optionalText("summary");
  return {
    title: fields.text("title"),
    path: fields.relativePath("path"),
    ...(summary !== undefined ? { summary } : {}),
  };
}

function forReview(root: Json, problems: Problems): RunReportReview | undefined {
  const value = root.forReview;
  if (value === undefined) return undefined;
  if (!isObject(value)) {
    problems.add("forReview is not an object");
    return undefined;
  }
  const fields = new Fields(value, "forReview");
  const title = fields.text("title");
  fields.requireList("items");
  if (fields.failure) {
    problems.add(fields.failure);
    return undefined;
  }
  const items = list(
    value,
    "items",
    problems,
    (item) => {
      const ref = item.optionalText("ref");
      return { text: item.text("text"), ...(ref !== undefined ? { ref } : {}) };
    },
    "forReview",
  );
  return { title, items: items ?? [] };
}

/**
 * Validate a parsed `report.json` for the run `runId`.
 *
 * Header errors reject the file; entry errors drop the entry. Nested lists
 * (`captures[i].files`, `forReview.items`) are prefixed with their parent's
 * path in warnings, so each one names the exact place to fix.
 */
export function parseRunReport(value: unknown, runId: string): ReportRead {
  const rejected = (reason: string): ReportRead => ({
    report: null,
    reportError: `${RUN_REPORT_FILE} ignored: ${reason}`,
  });
  if (!isObject(value)) return rejected("not a JSON object");
  if (value.version !== 1) return rejected("version is not 1");
  if (typeof value.runId !== "string" || value.runId.length === 0) return rejected("runId is not a string");
  if (value.runId !== runId) return { report: null };

  const problems = new Problems();
  const links = list(value, "links", problems, link);
  const deliveredList = list(value, "delivered", problems, delivered);
  const criteria = list(value, "criteria", problems, criterion(problems));
  const followUps = list(value, "followUps", problems, followUp);
  const review = forReview(value, problems);
  const captures = list(value, "captures", problems, captureGroup(problems));
  const notes = list(value, "notes", problems, note);

  const report: RunReport = {
    version: 1,
    runId,
    ...(links ? { links } : {}),
    ...(deliveredList ? { delivered: deliveredList } : {}),
    ...(criteria ? { criteria } : {}),
    ...(followUps ? { followUps } : {}),
    ...(review ? { forReview: review } : {}),
    ...(captures ? { captures } : {}),
    ...(notes ? { notes } : {}),
  };
  return { report, ...(problems.list.length > 0 ? { reportWarnings: problems.list } : {}) };
}

/** Bytes of the report, when it is a regular file inside the work item and
 *  within the text cap; otherwise the reason it is not read, or `null` when it
 *  simply is not there. */
function readReportText(workItemDir: string): { text: string } | { error: string } | null {
  const path = join(workItemDir, "artifacts", RUN_REPORT_FILE);
  let real: string;
  let root: string;
  try {
    real = realpathSync(path);
    root = realpathSync(workItemDir);
  } catch {
    // No report: the run did not write one, which is the common case.
    return null;
  }
  if (!isPathWithin(root, real)) return { error: `${RUN_REPORT_FILE} ignored: it resolves outside the work item` };

  try {
    const stat = statSync(real);
    if (!stat.isFile()) return null;
    if (stat.size > TEXT_LIMIT_BYTES)
      return { error: `${RUN_REPORT_FILE} ignored: larger than ${TEXT_LIMIT_BYTES} bytes` };
    return { text: readFileSync(real, "utf-8") };
  } catch {
    // Present a moment ago, unreadable now (permissions, removal): no report.
    return null;
  }
}

/**
 * The report of `project/ticket`'s current run, read from the EFFECTIVE
 * work-item directory — the worktree copy for a worktree run — like every other
 * artifact the dashboard shows. `undefined` when the run cannot be resolved.
 */
export function readReport(
  projectName: string,
  ticket: string,
  options: ReadModelOptions = {},
): ReportRead | undefined {
  const resolved = resolveRun(projectName, ticket, options);
  if (!resolved) return undefined;

  const read = readReportText(resolved.workItemDir);
  if (!read) return { report: null };
  if ("error" in read) return { report: null, reportError: read.error };

  let value: unknown;
  try {
    value = JSON.parse(read.text);
  } catch {
    // A half-written or hand-edited file: said once, never thrown at the sheet.
    return { report: null, reportError: `${RUN_REPORT_FILE} ignored: not valid JSON` };
  }
  return parseRunReport(value, resolved.run.state.runId ?? "");
}
