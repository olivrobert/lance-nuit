// runner/model/run-report.ts
//
// Contract of `artifacts/report.json`: the structured delivery report a pipeline
// writes at the end of a run, and the only file the dashboard reads to render a
// finished run as a report. Shapes only: a pipeline builds and writes it (usually
// from a command step), the dashboard's read model validates it field by field.
//
// The dashboard never parses pipeline prose. Everything it shows as a status or a
// proof comes from this file; the markdown reports stay the narrative, one click
// away in the explorer.

/** File name of the report, under the work item's `artifacts/` directory. */
export const RUN_REPORT_FILE = "report.json";

/** How a criterion was proved: an automated test, a reading of the code, or a
 *  screen capture. */
export type RunReportProof = "test" | "code" | "screen";

/** An outbound link. Only `http:` and `https:` URLs are shown; `primary` marks the
 *  one the dashboard offers as the run's main action (a merge request). */
export interface RunReportLink {
  label: string;
  url: string;
  primary?: boolean;
}

/** One delivered value (branch, last commit, lot count). `copy` offers a copy
 *  button for it. */
export interface RunReportDelivered {
  label: string;
  value: string;
  copy?: boolean;
  hint?: string;
}

/** One acceptance criterion, as the agent that verified it recorded it. */
export interface RunReportCriterion {
  id: string;
  text: string;
  met: boolean;
  proof: RunReportProof[];
  /** Screenshots that prove it, each as `<group dir>/<file name>` of an entry
   *  of `captures`. The directory is part of the key: two lots may write the
   *  same file name. */
  captures?: string[];
  /** What is left unproved or conditional, even when `met` is true. */
  reserve?: string;
}

/** Something left for a human to do on this ticket. */
export interface RunReportFollowUp {
  text: string;
  detail?: string;
  source?: string;
}

/** Items a product owner should review, such as the assumptions the run made. */
export interface RunReportReview {
  title: string;
  items: { ref?: string; text: string }[];
}

/** Screenshots of one directory. `dir` is relative to the work-item directory. */
export interface RunReportCaptureGroup {
  dir: string;
  files: { name: string; acs: string[]; caption?: string }[];
}

/** A document worth a folded link (a retrospective). `path` is relative to the
 *  work-item directory. */
export interface RunReportNote {
  title: string;
  path: string;
  summary?: string;
}

/**
 * `artifacts/report.json`.
 *
 * A report belongs to the run whose `runId` it carries: the dashboard ignores it
 * once the work item's current run is another one, so a rerun that fails before
 * writing its own report never shows the previous one. Every list is optional;
 * an absent list is simply not rendered.
 */
export interface RunReport {
  version: 1;
  /** Run that wrote the report. */
  runId: string;
  links?: RunReportLink[];
  delivered?: RunReportDelivered[];
  criteria?: RunReportCriterion[];
  followUps?: RunReportFollowUp[];
  forReview?: RunReportReview;
  captures?: RunReportCaptureGroup[];
  notes?: RunReportNote[];
}
