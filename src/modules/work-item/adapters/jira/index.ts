import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderPlainText } from "../../../../contracts/index.js";
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
  reconcileMutation,
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
import { adfToMarkdown, resolveAdfConverter } from "./adf.js";
import { outputOf } from "./diagnostics.js";
import {
  commentBodies,
  findFields,
  isDoneStatus,
  labelsOf,
  parseAcliTicketKeys,
  sameStatus,
  statusNameOf,
} from "./payload.js";

export type { ProcessResult, ProcessRunner, ProcessRunOptions } from "../../process/runner.js";
export { nodeProcessRunner } from "../../process/runner.js";
export { adfToMarkdown, resolveAdfConverter } from "./adf.js";
export { redactProviderOutput } from "./diagnostics.js";
export { parseAcliTicketKeys } from "./payload.js";

const PROVIDER = "jira";
const REF_KEY = /^[A-Z][A-Z0-9]*-\d+$/;
export interface JiraGatewayOptions {
  workItem: WorkItemConfig;
  labels: PipelineLabels;
  run?: ProcessRunner;
  adfConverter?: string;
}
interface TicketState {
  labels: string[];
  status: string;
}

export function createJiraWorkItemGateway(opts: JiraGatewayOptions): WorkItemGateway {
  const run = opts.run ?? nodeProcessRunner;
  const converter = resolveAdfConverter(opts.adfConverter);
  const labelFor = (queue: AutomationQueue): string => queueLabel(opts.labels, queue);
  const statusFor = (state: WorkItemState): string => configuredState(opts.workItem, state);
  const acli = (args: string[]): Promise<ProcessResult> => run("acli", args);
  const validateRef = refValidator(
    REF_KEY,
    (ref) => `${PROVIDER}: invalid reference "${ref}" (expected format: PROJ-123)`,
  );

  function requireValid(ref: string): void {
    requireValidRef(validateRef, ref);
  }

  async function viewFields(ref: WorkItemRef, fields: string): Promise<Record<string, unknown>> {
    const result = await acli(["jira", "workitem", "view", ref, "--fields", fields, "--json"]);
    if (result.code !== 0)
      throw new Error(`${PROVIDER}: unable to read ticket ${ref} (${fields}): ${outputOf(result)}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout) as unknown;
    } catch {
      throw new Error(`${PROVIDER}: invalid JSON response for ticket ${ref} (acli view ${fields}).`);
    }
    const found = findFields(parsed);
    if (!found) throw new Error(`${PROVIDER}: no readable fields for ticket ${ref} (acli view ${fields}).`);
    return found;
  }

  async function describe(raw: unknown): Promise<string> {
    if (raw == null) return "";
    if (typeof raw === "string") return raw.trim();
    if (converter) {
      const converted = await convertWithScript(converter, raw);
      if (converted !== undefined) return converted;
    }
    return adfToMarkdown(raw).trim();
  }

  async function convertWithScript(script: string, description: unknown): Promise<string | undefined> {
    const dir = mkdtempSync(join(tmpdir(), "pipeline-adf-"));
    const payload = join(dir, "workitem.json");
    try {
      writeFileSync(payload, JSON.stringify({ fields: { description } }), "utf-8");
      const result = await run("sh", ["-c", 'exec python3 "$1" description < "$2"', "sh", script, payload]);
      if (result.code !== 0) return undefined;
      const text = result.stdout.replace(/\s+$/, "");
      return text.length > 0 ? text : undefined;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async function readState(ref: WorkItemRef): Promise<TicketState> {
    const fields = await viewFields(ref, "labels,status");
    return { labels: labelsOf(fields), status: statusNameOf(fields) };
  }

  async function addLabel(ref: string, label: string, state: TicketState): Promise<void> {
    if (state.labels.includes(label)) return;
    const result = await acli(["jira", "workitem", "edit", "--key", ref, "--labels", label, "--yes"]);
    if (result.code !== 0) throw new Error(`${PROVIDER}: failed to add label ${label} to ${ref}: ${outputOf(result)}`);
    state.labels.push(label);
  }

  async function removeLabel(ref: string, label: string, state: TicketState): Promise<void> {
    if (!state.labels.includes(label)) return;
    const reconciled = await reconcileMutation(
      () => acli(["jira", "workitem", "edit", "--key", ref, "--remove-labels", label, "--yes"]),
      () => readState(ref),
      (fresh) => !fresh.labels.includes(label),
      (fresh) => {
        state.labels = fresh.labels;
      },
      (result) => new Error(`${PROVIDER}: failed to remove label ${label} from ${ref}: ${outputOf(result)}`),
    );
    if (reconciled) return;
    state.labels = state.labels.filter((existing) => existing !== label);
  }

  async function setStatus(ref: string, status: string, state: TicketState): Promise<void> {
    if (sameStatus(state.status, status)) return;
    const reconciled = await reconcileMutation(
      () => acli(["jira", "workitem", "transition", "--key", ref, "--status", status, "--yes"]),
      () => readState(ref),
      (fresh) => sameStatus(fresh.status, status),
      (fresh) => {
        state.status = fresh.status;
      },
      (result) => new Error(`${PROVIDER}: failed to transition ${ref} to "${status}": ${outputOf(result)}`),
    );
    if (reconciled) return;
    state.status = status;
  }

  return {
    provider: PROVIDER,
    validateRef,
    async fetch(ref: WorkItemRef): Promise<WorkItem> {
      requireValid(ref);
      const fields = await viewFields(ref, "summary,description,status,comment");
      const title = typeof fields.summary === "string" ? fields.summary.trim() : "";
      if (!title)
        throw new Error(`${PROVIDER}: ticket ${ref} has no title — unexpected payload or inaccessible ticket.`);
      const description = await describe(fields.description);
      if (!description) throw new Error(`${PROVIDER}: ticket ${ref} has no usable description.`);
      const comments = humanComments(commentBodies(fields));
      return { ref, title, description, closed: isDoneStatus(fields), comments };
    },
    async findCandidates(query: WorkItemQuery): Promise<WorkItemRef[]> {
      // A pipeline-owned JQL replaces the projection entirely: the author wrote the
      // project clause too, and completing it here would silently narrow their query.
      const jql =
        query.query ??
        `project = ${opts.workItem.project} AND labels = ${labelFor(query.queue)} AND status = '${statusFor(query.state)}'`;
      const result = await acli(["jira", "workitem", "search", "--jql", jql, "--json"]);
      if (result.code !== 0) throw new Error(`${PROVIDER}: search failed — ${outputOf(result)}`);
      return parseAcliTicketKeys(result.stdout);
    },
    async comment(ref: WorkItemRef, note: WorkItemNote, key: ExecutionKey): Promise<void> {
      requireValid(ref);
      const existing = commentBodies(await viewFields(ref, "comment"));
      if (existing.some((body) => hasMarker(body, key))) return;
      const body = renderPlainText(note, key);
      const result = await acli(["jira", "workitem", "comment", "create", "--key", ref, "--body", body]);
      if (result.code !== 0) throw new Error(`${PROVIDER}: failed to publish comment on ${ref}: ${outputOf(result)}`);
    },
    async moveTo(ref: WorkItemRef, target: MoveTarget): Promise<void> {
      requireValid(ref);
      await performMove(target, labelFor, statusFor, () => readState(ref), {
        "queue-add": addLabel.bind(undefined, ref),
        "queue-remove": removeLabel.bind(undefined, ref),
        "state-set": setStatus.bind(undefined, ref),
      });
    },
  };
}
