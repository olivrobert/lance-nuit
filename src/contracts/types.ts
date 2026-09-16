export type WorkQueue = "bugTodo" | "featureTodo";
export type TerminalQueue = "done" | "escalate";
export type AutomationQueue = WorkQueue | TerminalQueue;
export type WorkItemState = "todo" | "inReview";
export type WorkItemRef = string;
export type RefValidation = { ok: true } | { ok: false; reason: string };

export interface WorkItem {
  ref: WorkItemRef;
  title: string;
  description: string;
  closed: boolean;
  comments: readonly string[];
}

export interface WorkItemNoteField {
  label: string;
  value: string;
}

export interface WorkItemNote {
  headline: string;
  fields: WorkItemNoteField[];
  footer?: string;
}

export interface ExecutionKey {
  ticket: string;
  stepId: string;
}

export interface MoveTarget {
  queue?: AutomationQueue;
  from?: AutomationQueue;
  state?: WorkItemState;
}

/** Discovery request. `queue` and `state` are the logical selection every provider
 *  projects onto its own labels/statuses. `query`, when present, is a
 *  provider-native selection the pipeline wrote (JQL, `gh --search` syntax...):
 *  the adapter sends it verbatim instead of projecting `queue`/`state`, and a
 *  provider unable to interpret free-form queries ignores it. */
export interface WorkItemQuery {
  queue: AutomationQueue;
  state: WorkItemState;
  query?: string;
}

export interface WorkItemGateway {
  readonly provider: string;
  validateRef(ref: string): RefValidation;
  fetch(ref: WorkItemRef): Promise<WorkItem>;
  findCandidates(query: WorkItemQuery): Promise<WorkItemRef[]>;
  comment(ref: WorkItemRef, note: WorkItemNote, key: ExecutionKey): Promise<void>;
  moveTo(ref: WorkItemRef, target: MoveTarget): Promise<void>;
}
