// modules/work-item/adapters/jira/test-harness.ts
//
// The Jira adapter runs the same contract suite as the fake against a simulated
// `acli`. The simulator keeps labels, status, and comments, interprets JQL, and
// applies mutations, so idempotency and resume assertions exercise real adapter
// logic.
//
// Deliberate limit: the simulator models documented `acli` output shapes, not the
// Jira server. Assumptions about subcommands, JSON, and impossible-transition exit
// codes are marked HYPOTHESIS and must still be checked against a real server.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkItemGateway, WorkItemNote } from "../../../../contracts/work-items.js";
import type { PipelineLabels, WorkItemConfig } from "../../../../env/config.js";
import type { ProcessResult, ProcessRunner } from "../../process/runner.js";
import {
  argValue,
  gatewayHarness,
  interruptGate,
  inverseStringMap,
  ko,
  matchingCommands,
  ok,
  stubbedGateway,
} from "../test-harness-shared.js";
import { createJiraWorkItemGateway } from "./index.js";

export const WORK_ITEM: WorkItemConfig = {
  provider: "jira",
  project: "PROJ",
  todoState: "To Do",
  reviewState: "In Review",
};

export const LABELS: PipelineLabels = {
  bugTodo: "auto-fix",
  featureTodo: "auto-feature",
  done: "auto-fixed",
  escalate: "needs-human",
};

/** Inverse projections used only by assertions; the adapter projects one way. */
const QUEUE_OF_LABEL = inverseStringMap(LABELS);
const STATE_OF_STATUS = inverseStringMap({ todo: WORK_ITEM.todoState, inReview: WORK_ITEM.reviewState });

/** Guaranteed-missing path that forces internal ADF conversion without depending
 * on the pipeline-jira plugin being installed. */
export const NO_CONVERTER = join(tmpdir(), "pipeline-adf-absent", "adf-to-markdown.py");

/** Fake converter never executed because the simulator intercepts the call. It
 * only needs to exist because the adapter checks for it. */
const scriptDir = mkdtempSync(join(tmpdir(), "pipeline-jira-test-"));
export const FAKE_CONVERTER = join(scriptDir, "adf-to-markdown.py");
writeFileSync(FAKE_CONVERTER, "#!/usr/bin/env python3\n");

export interface SimTicketSeed {
  key: string;
  summary?: string;
  description?: unknown;
  labels?: string[];
  status?: string;
  /** Status category key as exposed by `acli`. `undefined` derives it from the
   * status name; `null` omits the category and forces the status-name fallback. */
  statusCategory?: string | null;
  /** Display name as Jira renders it in `assignee = '...'` JQL clauses. */
  assignee?: string;
  comments?: string[];
}

export interface SimTicket {
  key: string;
  summary: string;
  description: unknown;
  labels: string[];
  status: string;
  statusCategory: string | null | undefined;
  assignee: string | undefined;
  comments: string[];
}

const DONE_STATUSES = new Set(["Done", "Terminado", "Won't Do"]);

/** HYPOTHESIS: `acli` copies the REST API status category, whose keys are `new`,
 * `indeterminate`, and `done`. */
function categoryOf(status: string): string {
  if (DONE_STATUSES.has(status)) return "done";
  return status === WORK_ITEM.todoState ? "new" : "indeterminate";
}

/** Observed primitive operation reconstructed from `acli` write commands. Only
 * applied operations produce commands, so `applied` is always true. */
export interface SimMutation {
  kind: string;
  value: string;
  applied: boolean;
}

export interface AcliSim {
  run: ProcessRunner;
  commands: string[][];
  mutations: SimMutation[];
  ticketOf(key: string): SimTicket | undefined;
  armInterrupt(key: string, afterOps: number): void;
  /** Python converter response, overrideable to test fallback behavior. */
  python: ProcessResult;
  /** Next search output, overrideable to test parsing. */
  searchOutput?: string;
}

export { ko, messageOf, ok } from "../test-harness-shared.js";

/** Minimal text-equivalent ADF: one paragraph per line. Jira returns plain-text
 * comments in this shape, so the idempotency marker must survive the round trip. */
export function adfDoc(text: string): unknown {
  return {
    type: "doc",
    version: 1,
    content: text.split("\n").map((line) => ({ type: "paragraph", content: [{ type: "text", text: line }] })),
  };
}

const DEFAULT_DESCRIPTION = {
  type: "doc",
  version: 1,
  content: [
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Contexte" }] },
    { type: "paragraph", content: [{ type: "text", text: "L'export plante en prod." }] },
  ],
};

export const DEFAULT_SEED: SimTicketSeed[] = [
  { key: "PROJ-24", summary: "500 error on export", labels: ["auto-fix"] },
  { key: "PROJ-25", summary: "Filter the list", labels: ["auto-feature"] },
  { key: "PROJ-26", summary: "Export already delivered", status: "Terminado" },
];

export function createAcliSim(seed: SimTicketSeed[] = DEFAULT_SEED): AcliSim {
  const tickets = new Map<string, SimTicket>();
  for (const item of seed) {
    tickets.set(item.key, {
      key: item.key,
      summary: item.summary ?? `Ticket ${item.key}`,
      description: item.description === undefined ? DEFAULT_DESCRIPTION : item.description,
      labels: [...(item.labels ?? [])],
      status: item.status ?? WORK_ITEM.todoState,
      statusCategory: item.statusCategory,
      assignee: item.assignee,
      comments: [...(item.comments ?? [])],
    });
  }

  const interruptions = interruptGate<string>();
  const sim: AcliSim = {
    commands: [],
    mutations: [],
    python: ok("## Contexte\n\nL'export plante en prod.\n"),
    ticketOf: (key) => tickets.get(key),
    armInterrupt: (key, afterOps) => {
      interruptions.arm(key, afterOps);
    },
    run: async (cmd, args) => runCommand(cmd, args),
  };

  function unknownTicket(key: string): ProcessResult {
    // HYPOTHESIS: `acli` exits non-zero with a message naming the key.
    return ko(`Work item "${key}" does not exist or you do not have permission to view it.`);
  }

  function view(args: string[]): ProcessResult {
    const key = args[3] ?? "";
    const ticket = tickets.get(key);
    if (!ticket) return unknownTicket(key);
    const requested = argValue(args, "--fields").split(",");
    const fields: Record<string, unknown> = {};
    for (const name of requested) {
      if (name === "summary") fields.summary = ticket.summary;
      if (name === "description") fields.description = ticket.description;
      if (name === "labels") fields.labels = [...ticket.labels];
      // HYPOTHESIS: status is exposed as `{name}`, like the REST API, with its
      // category nested in `statusCategory` (`{id, key, name}`).
      if (name === "status") {
        const category = ticket.statusCategory === undefined ? categoryOf(ticket.status) : ticket.statusCategory;
        fields.status = {
          name: ticket.status,
          id: "10001",
          // `null` means the category is absent, not empty.
          ...(category === null ? {} : { statusCategory: { id: "3", key: category } }),
        };
      }
      if (name === "comment") {
        fields.comment = {
          comments: ticket.comments.map((body, index) => ({ id: String(index + 1), body: adfDoc(body) })),
          total: ticket.comments.length,
        };
      }
    }
    return ok(JSON.stringify({ id: "20001", key: ticket.key, fields }));
  }

  function search(args: string[]): ProcessResult {
    if (sim.searchOutput !== undefined) return ok(sim.searchOutput);
    // Each clause is optional: a pipeline-owned JQL may omit the label or the
    // status, and the simulator only filters on what the query states.
    const jql = argValue(args, "--jql");
    const label = /labels = (\S+)/.exec(jql)?.[1];
    const status = /status = '([^']*)'/.exec(jql)?.[1];
    const assignee = /assignee = '([^']*)'/.exec(jql)?.[1];
    const project = /project = (\S+)/.exec(jql)?.[1] ?? "";
    const issues = [...tickets.values()]
      .filter(
        (ticket) =>
          ticket.key.startsWith(`${project}-`) &&
          (label === undefined || ticket.labels.includes(label)) &&
          (status === undefined || ticket.status === status) &&
          (assignee === undefined || ticket.assignee === assignee),
      )
      .map((ticket) => ({ id: "20001", key: ticket.key, fields: { summary: ticket.summary } }));
    return ok(JSON.stringify({ startAt: 0, total: issues.length, issues }));
  }

  function commentCreate(args: string[]): ProcessResult {
    const key = argValue(args, "--key");
    const ticket = tickets.get(key);
    if (!ticket) return unknownTicket(key);
    ticket.comments.push(argValue(args, "--body"));
    return ok(JSON.stringify({ id: String(ticket.comments.length), key }));
  }

  function mutationTarget(args: string[]): [key: string, ticket: SimTicket] | ProcessResult {
    const key = argValue(args, "--key");
    const ticket = tickets.get(key);
    if (!ticket) return unknownTicket(key);
    if (interruptions.shouldInterrupt(key)) return ko("connection reset by peer");
    return [key, ticket];
  }

  function edit(args: string[]): ProcessResult {
    const target = mutationTarget(args);
    if (!Array.isArray(target)) return target;
    const [key, ticket] = target;
    const added = argValue(args, "--labels");
    const removed = argValue(args, "--remove-labels");
    if (added) {
      if (!ticket.labels.includes(added)) ticket.labels.push(added);
      sim.mutations.push({ kind: "queue-add", value: QUEUE_OF_LABEL.get(added) ?? added, applied: true });
    }
    if (removed) {
      if (!ticket.labels.includes(removed)) {
        // HYPOTHESIS: `acli` rejects removing an absent label. Prompts explicitly
        // require ignoring this case, so simulate it as a failure.
        return ko(`Label "${removed}" is not set on ${key}`);
      }
      ticket.labels = ticket.labels.filter((label) => label !== removed);
      sim.mutations.push({ kind: "queue-remove", value: QUEUE_OF_LABEL.get(removed) ?? removed, applied: true });
    }
    return ok(JSON.stringify({ key }));
  }

  function transition(args: string[]): ProcessResult {
    const target = mutationTarget(args);
    if (!Array.isArray(target)) return target;
    const [key, ticket] = target;
    const status = argValue(args, "--status");
    // HYPOTHESIS: Jira rejects a transition to the current status; standard
    // workflows do not expose a self-looping outgoing transition.
    if (ticket.status === status) return ko(`No transition to "${status}" available from "${ticket.status}"`);
    ticket.status = status;
    sim.mutations.push({ kind: "state-set", value: STATE_OF_STATUS.get(status) ?? status, applied: true });
    return ok(JSON.stringify({ key, status }));
  }

  async function runCommand(cmd: string, args: string[]): Promise<ProcessResult> {
    sim.commands.push([cmd, ...args]);
    if (cmd === "sh") return sim.python;
    if (cmd !== "acli") return ko(`${cmd}: command not found`, 127);
    const verb = args[2];
    if (verb === "view") return view(args);
    if (verb === "search") return search(args);
    if (verb === "comment" && args[3] === "create") return commentCreate(args);
    if (verb === "edit") return edit(args);
    if (verb === "transition") return transition(args);
    return ko(`unknown command: ${args.join(" ")}`, 2);
  }

  return sim;
}

const sims = new WeakMap<WorkItemGateway, AcliSim>();

export function jiraFactory(seed: SimTicketSeed[] = DEFAULT_SEED): () => WorkItemGateway {
  return () => {
    const sim = createAcliSim(seed);
    const gateway = createJiraWorkItemGateway({
      workItem: WORK_ITEM,
      labels: LABELS,
      run: sim.run,
      adfConverter: NO_CONVERTER,
    });
    sims.set(gateway, sim);
    return gateway;
  };
}

export const simOf = (gateway: WorkItemGateway): AcliSim => {
  const sim = sims.get(gateway);
  if (!sim) throw new Error("acli simulator not found for this gateway");
  return sim;
};

export const NOTE: WorkItemNote = {
  headline: "🤖 Pipeline bugfix: automatic escalation.",
  fields: [{ label: "Reason", value: "**Not reproducible** locally." }],
  footer: "Human review required.",
};

export interface Harness {
  gateway: WorkItemGateway;
  sim: AcliSim;
}

export function harness(seed: SimTicketSeed[] = DEFAULT_SEED, adfConverter: string = NO_CONVERTER): Harness {
  const sim = createAcliSim(seed);
  return gatewayHarness(sim, (run) =>
    createJiraWorkItemGateway({ workItem: WORK_ITEM, labels: LABELS, run, adfConverter }),
  );
}

/** Gateway connected to a fixed `acli`; simulator state is irrelevant for error
 * cases. */
export function stubbed(result: ProcessResult | ((cmd: string, args: string[]) => ProcessResult)): {
  gateway: WorkItemGateway;
  commands: string[][];
} {
  return stubbedGateway(result, (run) =>
    createJiraWorkItemGateway({ workItem: WORK_ITEM, labels: LABELS, run, adfConverter: NO_CONVERTER }),
  );
}

export const commandsMatching = (sim: AcliSim, verb: string): string[][] =>
  matchingCommands(sim.commands, ["acli"], 3, verb);
