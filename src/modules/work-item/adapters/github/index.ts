import { renderMarkdown } from "../../../../contracts/index.js";
import { errorMessage } from "../../../../lib/errors.js";
import { nodeProcessRunner, type ProcessResult, type ProcessRunner } from "../../process/runner.js";
import {
  type AutomationQueue,
  configuredState,
  type ExecutionKey,
  hasMarker,
  humanComments,
  type MoveTarget,
  type PipelineLabels,
  performMove,
  queueLabel,
  refValidator,
  requireValidRef,
  type WorkItem,
  type WorkItemConfig,
  type WorkItemGateway,
  type WorkItemNote,
  type WorkItemQuery,
  type WorkItemRef,
  type WorkItemState,
} from "../gateway-shared.js";
import { outputOf } from "./diagnostics.js";
import {
  commentBodies,
  type GithubIssuePayload,
  labelNames,
  parseGithubIssueRefs,
  parseGithubPayload,
  stateIsClosed,
} from "./payload.js";

export type { ProcessResult, ProcessRunner, ProcessRunOptions } from "../../process/runner.js";
export { nodeProcessRunner } from "../../process/runner.js";
export { redactProviderOutput } from "./diagnostics.js";
export type { GithubIssuePayload } from "./payload.js";
export { commentBodies, labelNames, parseGithubIssueRefs, parseGithubPayload, stateIsClosed } from "./payload.js";

const PROVIDER = "github";
const REF_NUMBER = /^\d+$/;
export interface GithubGatewayOptions {
  workItem: WorkItemConfig;
  labels: PipelineLabels;
  run?: ProcessRunner;
}

interface IssueState {
  labels: string[];
  closed: boolean;
}

export function createGithubWorkItemGateway(opts: GithubGatewayOptions): WorkItemGateway {
  const run = opts.run ?? nodeProcessRunner;
  const project = opts.workItem.project.trim();
  if (!project) throw new Error("github: workItem.project must be the repository name (for example owner/repo)");

  const gh = (args: string[]): Promise<ProcessResult> => run("gh", args);
  const labelFor = (queue: AutomationQueue): string => queueLabel(opts.labels, queue);
  const stateLabelFor = (state: WorkItemState): string => configuredState(opts.workItem, state);
  const refValidation = refValidator(
    REF_NUMBER,
    (ref) => `${PROVIDER}: invalid reference "${ref}" (expected an issue number such as 123)`,
  );

  if (stateLabelFor("todo") === stateLabelFor("inReview")) {
    throw new Error("github: workItem.todoState and workItem.reviewState must be different labels");
  }

  function requireValid(ref: string): void {
    requireValidRef(refValidation, ref);
  }

  async function view(ref: WorkItemRef, fields: string): Promise<GithubIssuePayload> {
    const result = await gh(["issue", "view", ref, "--repo", project, "--comments", "--json", fields]);
    if (result.code !== 0) throw new Error(`${PROVIDER}: unable to read issue ${ref}: ${outputOf(result)}`);
    const parsed = parseGithubPayload(result.stdout, `reading issue ${ref}`);
    if (Array.isArray(parsed)) throw new Error(`${PROVIDER}: unexpected list response while reading issue ${ref}.`);
    return parsed;
  }

  async function readState(ref: WorkItemRef): Promise<IssueState> {
    const issue = await view(ref, "labels,state");
    return { labels: labelNames(issue.labels), closed: stateIsClosed(issue.state) };
  }

  async function addLabel(ref: string, label: string, state: IssueState): Promise<void> {
    if (state.labels.includes(label)) return;
    const result = await gh(["issue", "edit", ref, "--repo", project, "--add-label", label]);
    if (result.code !== 0) {
      const fresh = await readState(ref);
      if (!fresh.labels.includes(label))
        throw new Error(`${PROVIDER}: failed to add label ${label} to issue ${ref}: ${outputOf(result)}`);
      state.labels = fresh.labels;
      state.closed = fresh.closed;
      return;
    }
    state.labels.push(label);
  }

  async function removeLabel(ref: string, label: string, state: IssueState): Promise<void> {
    if (!state.labels.includes(label)) return;
    const result = await gh(["issue", "edit", ref, "--repo", project, "--remove-label", label]);
    if (result.code !== 0) {
      const fresh = await readState(ref);
      if (fresh.labels.includes(label))
        throw new Error(`${PROVIDER}: failed to remove label ${label} from issue ${ref}: ${outputOf(result)}`);
      state.labels = fresh.labels;
      state.closed = fresh.closed;
      return;
    }
    state.labels = state.labels.filter((existing) => existing !== label);
  }

  async function setState(ref: string, target: WorkItemState, state: IssueState): Promise<void> {
    const targetLabel = stateLabelFor(target);
    const otherLabel = stateLabelFor(target === "todo" ? "inReview" : "todo");
    await removeLabel(ref, otherLabel, state);
    await addLabel(ref, targetLabel, state);
  }

  return {
    provider: PROVIDER,
    validateRef: refValidation,
    async fetch(ref: WorkItemRef): Promise<WorkItem> {
      requireValid(ref);
      const issue = await view(ref, "title,body,state,labels,comments,number");
      const title = typeof issue.title === "string" ? issue.title.trim() : "";
      if (!title) throw new Error(`${PROVIDER}: issue ${ref} has no title — unexpected payload or inaccessible issue.`);
      const comments = humanComments(commentBodies(issue.comments));
      return {
        ref,
        title,
        description: typeof issue.body === "string" ? issue.body.trim() : "",
        closed: stateIsClosed(issue.state),
        comments,
      };
    },
    async findCandidates(query: WorkItemQuery): Promise<WorkItemRef[]> {
      // A pipeline-owned query goes through `--search` verbatim; it then owns the
      // state filter too (`is:open` or not), so no `--state open` is added.
      const selection = query.query
        ? ["--search", query.query]
        : ["--state", "open", "--label", labelFor(query.queue), "--label", stateLabelFor(query.state)];
      const result = await gh([
        "issue",
        "list",
        "--repo",
        project,
        ...selection,
        "--limit",
        "1000",
        "--json",
        "number",
      ]);
      if (result.code !== 0) throw new Error(`${PROVIDER}: search failed: ${outputOf(result)}`);
      try {
        return parseGithubIssueRefs(result.stdout);
      } catch (error) {
        throw new Error(`${PROVIDER}: ${errorMessage(error)}`, { cause: error });
      }
    },
    async comment(ref: WorkItemRef, note: WorkItemNote, key: ExecutionKey): Promise<void> {
      requireValid(ref);
      const existing = commentBodies((await view(ref, "comments")).comments);
      if (existing.some((body) => hasMarker(body, key))) return;
      const body = renderMarkdown(note, key);
      const result = await gh(["issue", "comment", ref, "--repo", project, "--body", body]);
      if (result.code !== 0)
        throw new Error(`${PROVIDER}: failed to publish comment on issue ${ref}: ${outputOf(result)}`);
    },
    async moveTo(ref: WorkItemRef, target: MoveTarget): Promise<void> {
      requireValid(ref);
      await performMove(target, labelFor, stateLabelFor, () => readState(ref), {
        "queue-add": addLabel.bind(undefined, ref),
        "queue-remove": removeLabel.bind(undefined, ref),
        "state-set": (value, current) => setState(ref, value === stateLabelFor("todo") ? "todo" : "inReview", current),
      });
    },
  };
}
