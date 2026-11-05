// The delivery report's derived views: what it leaves to a human, the numbering
// of its screenshots, and its review list as text.

import type { RunReport } from "../api/types.js";

/** One line of the report's "Left for you": a follow-up the run listed, or a
 *  criterion's reserve, which names the criterion it belongs to. */
export interface LeftForYouEntry {
  text: string;
  detail?: string;
  source?: string;
  criterion?: string;
}

/** Everything the report leaves to a human: its follow-ups, then the reserve of
 *  every criterion that has one, met or not. */
export function leftForYou(report: RunReport): LeftForYouEntry[] {
  const followUps = (report.followUps ?? []).map(
    (entry): LeftForYouEntry => ({
      text: entry.text,
      ...(entry.detail ? { detail: entry.detail } : {}),
      ...(entry.source ? { source: entry.source } : {}),
    }),
  );
  const reserves = (report.criteria ?? []).flatMap((criterion): LeftForYouEntry[] =>
    criterion.reserve
      ? [{ text: `Reserve on ${criterion.id}`, detail: criterion.reserve, criterion: criterion.id }]
      : [],
  );
  return [...followUps, ...reserves];
}

/** The key of a screenshot: its path relative to the work item. Two lots can
 *  write the same file name, their directories tell them apart; a criterion's
 *  `captures` list holds these paths. */
export function capturePath(dir: string, name: string): string {
  const base = dir.replace(/\/+$/, "");
  return base ? `${base}/${name}` : name;
}

/** The number of each screenshot, `01`, `02`…, in the order the report lists
 *  them, keyed by {@link capturePath}: the reader matches the number on a
 *  criterion with the one under the thumbnail. A path listed twice keeps its
 *  first number. */
export function captureNumbers(report: RunReport): Map<string, string> {
  const numbers = new Map<string, string>();
  for (const group of report.captures ?? []) {
    for (const file of group.files) {
      const path = capturePath(group.dir, file.name);
      if (!numbers.has(path)) numbers.set(path, String(numbers.size + 1).padStart(2, "0"));
    }
  }
  return numbers;
}

/** The review list as plain text, for a reader to paste into a message. */
export function reviewText(review: NonNullable<RunReport["forReview"]>): string {
  const lines = review.items.map((entry) => `- ${entry.ref ? `${entry.ref}: ` : ""}${entry.text}`);
  return [review.title, "", ...lines].join("\n");
}
