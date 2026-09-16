// modules/work-item/adapters/github/test-harness.ts
//
// The GitHub adapter runs against a small `gh` simulator. It models the JSON
// shapes and mutations used by the adapter, keeping the tests offline while
// still exercising command construction and replay behavior.

import type { WorkItemGateway, WorkItemNote } from "../../../../contracts/work-items.js";
import type { PipelineLabels, WorkItemConfig } from "../../../../env/config.js";
import type { ProcessResult, ProcessRunner } from "../../process/runner.js";
import {
  argValue,
  argValues,
  gatewayHarness,
  interruptGate,
  inverseStringMap,
  ko,
  matchingCommands,
  ok,
  stubbedGateway,
} from "../test-harness-shared.js";
import { createGithubWorkItemGateway } from "./index.js";

export const WORK_ITEM: WorkItemConfig = {
  provider: "github",
  project: "acme/lance-nuit",
  todoState: "pipeline:todo",
  reviewState: "pipeline:in-review",
};

export const LABELS: PipelineLabels = {
  bugTodo: "queue:bug",
  featureTodo: "queue:feature",
  done: "queue:done",
  escalate: "queue:human",
};

const QUEUE_OF_LABEL = inverseStringMap(LABELS);
const STATE_OF_LABEL = inverseStringMap({ todo: WORK_ITEM.todoState, inReview: WORK_ITEM.reviewState });

export interface GithubIssueSeed {
  number: number;
  title?: string;
  body?: string | null;
  labels?: string[];
  state?: "OPEN" | "CLOSED";
  comments?: string[];
}

export interface GithubIssue extends GithubIssueSeed {
  title: string;
  body: string | null;
  labels: string[];
  state: "OPEN" | "CLOSED";
  comments: string[];
}

export interface GithubMutation {
  kind: string;
  value: string;
  applied: boolean;
}

export interface GithubSim {
  run: ProcessRunner;
  commands: string[][];
  mutations: GithubMutation[];
  issueOf(number: number): GithubIssue | undefined;
  armInterrupt(number: number, afterOps: number): void;
}

export { ko, messageOf, ok } from "../test-harness-shared.js";

export const DEFAULT_SEED: GithubIssueSeed[] = [
  {
    number: 24,
    title: "500 error on export",
    body: "L'export plante en production.",
    labels: [LABELS.bugTodo, WORK_ITEM.todoState],
  },
  {
    number: 25,
    title: "Filter the list",
    body: "Ajouter un filtre.",
    labels: [LABELS.featureTodo, WORK_ITEM.todoState],
  },
  {
    number: 26,
    title: "Export already delivered",
    body: "Delivered in June.",
    state: "CLOSED",
  },
];

export function createGithubSim(seed: GithubIssueSeed[] = DEFAULT_SEED): GithubSim {
  const issues = new Map<number, GithubIssue>();
  for (const item of seed) {
    issues.set(item.number, {
      number: item.number,
      title: item.title ?? `Issue #${item.number}`,
      body: item.body === undefined ? `Body for issue #${item.number}` : item.body,
      labels: [...(item.labels ?? [])],
      state: item.state ?? "OPEN",
      comments: [...(item.comments ?? [])],
    });
  }

  const interruptions = interruptGate<number>();
  const sim: GithubSim = {
    commands: [],
    mutations: [],
    issueOf: (number) => issues.get(number),
    armInterrupt: (number, afterOps) => {
      interruptions.arm(number, afterOps);
    },
    run: async (cmd, args) => runCommand(cmd, args),
  };

  function issueFromArgs(args: string[]): GithubIssue | undefined {
    const number = Number(args[2]);
    return Number.isInteger(number) ? issues.get(number) : undefined;
  }

  function unknownIssue(number: string): ProcessResult {
    return ko(`Issue #${number} does not exist or you do not have permission to view it.`);
  }

  function view(args: string[]): ProcessResult {
    const issue = issueFromArgs(args);
    if (!issue) return unknownIssue(args[2] ?? "");
    const fields = argValue(args, "--json").split(",");
    const payload: Record<string, unknown> = {};
    for (const field of fields) {
      if (field === "number") payload.number = issue.number;
      if (field === "title") payload.title = issue.title;
      if (field === "body") payload.body = issue.body;
      if (field === "state") payload.state = issue.state;
      if (field === "labels") payload.labels = issue.labels.map((name) => ({ name }));
      if (field === "comments") payload.comments = issue.comments.map((body) => ({ body }));
    }
    return ok(JSON.stringify(payload));
  }

  function list(args: string[]): ProcessResult {
    // `--search` has no interpreter here: a pipeline-owned query selects every open
    // issue, and the adapter test asserts the forwarded arguments instead.
    const requiredLabels = argValues(args, "--label");
    const allStates = argValue(args, "--state").toUpperCase() === "ALL";
    const found = [...issues.values()]
      .filter((issue) => allStates || issue.state === "OPEN")
      .filter((issue) => requiredLabels.every((label) => issue.labels.includes(label)))
      .map((issue) => ({ number: issue.number }));
    return ok(JSON.stringify(found));
  }

  function edit(args: string[]): ProcessResult {
    const issue = issueFromArgs(args);
    if (!issue) return unknownIssue(args[2] ?? "");
    if (interruptions.shouldInterrupt(issue.number)) return ko("connection reset by peer");
    const add = argValue(args, "--add-label");
    const remove = argValue(args, "--remove-label");
    if (add) {
      if (!issue.labels.includes(add)) issue.labels.push(add);
      sim.mutations.push({
        kind: "queue-add",
        value: QUEUE_OF_LABEL.get(add) ?? STATE_OF_LABEL.get(add) ?? add,
        applied: true,
      });
    }
    if (remove) {
      issue.labels = issue.labels.filter((label) => label !== remove);
      sim.mutations.push({
        kind: "queue-remove",
        value: QUEUE_OF_LABEL.get(remove) ?? STATE_OF_LABEL.get(remove) ?? remove,
        applied: true,
      });
    }
    return ok(JSON.stringify({ number: issue.number }));
  }

  function comment(args: string[]): ProcessResult {
    const issue = issueFromArgs(args);
    if (!issue) return unknownIssue(args[2] ?? "");
    issue.comments.push(argValue(args, "--body"));
    return ok(JSON.stringify({ id: String(issue.comments.length), number: issue.number }));
  }

  async function runCommand(cmd: string, args: string[]): Promise<ProcessResult> {
    sim.commands.push([cmd, ...args]);
    if (cmd !== "gh") return ko(`${cmd}: command not found`, 127);
    if (args[0] !== "issue") return ko(`unknown command: ${args.join(" ")}`, 2);
    if (args[1] === "view") return view(args);
    if (args[1] === "list") return list(args);
    if (args[1] === "edit") return edit(args);
    if (args[1] === "comment") return comment(args);
    return ko(`unknown command: ${args.join(" ")}`, 2);
  }

  return sim;
}

const sims = new WeakMap<WorkItemGateway, GithubSim>();

export function githubFactory(seed: GithubIssueSeed[] = DEFAULT_SEED): () => WorkItemGateway {
  return () => {
    const sim = createGithubSim(seed);
    const gateway = createGithubWorkItemGateway({ workItem: WORK_ITEM, labels: LABELS, run: sim.run });
    sims.set(gateway, sim);
    return gateway;
  };
}

export function simOf(gateway: WorkItemGateway): GithubSim {
  const sim = sims.get(gateway);
  if (!sim) throw new Error("gh simulator not found for this gateway");
  return sim;
}

export const NOTE: WorkItemNote = {
  headline: "🤖 Pipeline bugfix: automatic escalation.",
  fields: [{ label: "Reason", value: "**Not reproducible** locally." }],
  footer: "Human review required.",
};

export interface Harness {
  gateway: WorkItemGateway;
  sim: GithubSim;
}

export function harness(seed: GithubIssueSeed[] = DEFAULT_SEED): Harness {
  const sim = createGithubSim(seed);
  return gatewayHarness(sim, (run) => createGithubWorkItemGateway({ workItem: WORK_ITEM, labels: LABELS, run }));
}

export function stubbed(result: ProcessResult | ((cmd: string, args: string[]) => ProcessResult)): {
  gateway: WorkItemGateway;
  commands: string[][];
} {
  return stubbedGateway(result, (run) => createGithubWorkItemGateway({ workItem: WORK_ITEM, labels: LABELS, run }));
}

export const commandsMatching = (sim: GithubSim, action: string): string[][] =>
  matchingCommands(sim.commands, ["gh", "issue"], 2, action);
