//
// Where the runner keeps what it writes beside a ticket. Pure: it takes a
// work-item directory, not a `PipelineContext`, so a reader that has no context —
// the dashboard's read model — derives the same paths as the runner instead of
// recoding them.

import { join } from "node:path";

/** Approval subject. It is free-form but becomes a filename under `decisions/`,
 * so charset validation is a security guard, not a style convention. */
export type DecisionSubject = string;

const SUBJECT_CHARSET = /^[\w-]+$/;

/** The freshness lock inside `artifacts/`, next to the artifacts it vouches for. */
const LOCK_FILENAME = "lock.json";

/** Whether an artifact name would collide with the freshness lock, its write lock
 *  or their temporary files: those belong to the runner. */
export function isReservedArtifactName(name: string): boolean {
  return name === LOCK_FILENAME || name.startsWith(`${LOCK_FILENAME}.`);
}

/** The reference a decision, a lock stamp or a gate stop persists for an
 *  artifact: relative to the work item, so the same record reads from any clone
 *  or worktree. A persisted format, not a path to open. */
export function artifactKey(name: string): string {
  return `artifacts/${name}`;
}

/** An approval subject must never escape `decisions/`. */
export function isValidSubjectToken(value: string): value is DecisionSubject {
  return SUBJECT_CHARSET.test(value);
}

export interface WorkItemLayout {
  readonly workItemDir: string;
  /** Business artifacts, the gate artifacts among them. */
  readonly artifactsDir: string;
  /** One file per approval subject: the current human decision. */
  readonly decisionsDir: string;
  /** What steps report beside the artifacts; a batch sub-run gets its own
   *  subdirectory, which the run context adds. */
  readonly reportsDir: string;
  /** The freshness lock: one stamp per step that last succeeded. */
  readonly lockPath: string;
  /** File of the decision on `subject`. Throws on a subject outside the charset. */
  decisionPath(subject: DecisionSubject): string;
}

export function workItemLayout(workItemDir: string): WorkItemLayout {
  const artifactsDir = join(workItemDir, "artifacts");
  const decisionsDir = join(workItemDir, "decisions");
  return {
    workItemDir,
    artifactsDir,
    decisionsDir,
    reportsDir: join(workItemDir, "reports"),
    lockPath: join(artifactsDir, LOCK_FILENAME),
    decisionPath: (subject) => {
      if (!isValidSubjectToken(subject)) throw new Error(`invalid decision subject "${subject}" (charset [\\w-])`);
      return join(decisionsDir, `${subject}.json`);
    },
  };
}
