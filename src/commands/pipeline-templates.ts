// runner/commands/pipeline-templates.ts
//
// Starting points offered by `lancenuit create --template <id>`.
//
// A shell step is the smallest useful pipeline, but it is not what the runner is
// for: budgets, fix loops, agent roles, and work-item loops are the reason to
// adopt it. Reading a 500-line guide before writing the second pipeline is the
// wrong first step, so each template is a working, typechecked pipeline that
// shows one of those capabilities and is meant to be edited in place.
//
// Every template is rendered and typechecked by `pipeline-templates.test.ts`:
// a template that does not compile against the installed declarations fails the
// suite, not the user's first run.

import { PIPELINE_NAME_RE } from "../env/builtin-pipeline.js";

export interface PipelineTemplate {
  id: string;
  desc: string;
  /** True when the template runs a project command and therefore needs `--command`. */
  usesCommand: boolean;
  /** `command` is the empty string for templates that do not use one. */
  render(name: string, command: string): string;
}

export const DEFAULT_TEMPLATE_ID = "bash";

function validateName(name: string): void {
  if (!PIPELINE_NAME_RE.test(name)) {
    throw new Error(`Invalid pipeline name: "${name}" (expected: ^[a-z][a-z0-9-]*$).`);
  }
}

/** Serialize author-supplied text as a TypeScript literal: a created pipeline
 *  never interpolates a command into the generated source. */
function literal(value: string): string {
  return JSON.stringify(value);
}

const bashTemplate: PipelineTemplate = {
  id: "bash",
  desc: "One shell step. The smallest pipeline that resumes and reports.",
  usesCommand: true,
  render: (name, command) =>
    [
      `import type { Dsl } from "@lance-nuit/dsl";`,
      ``,
      `export default ({ pipeline, bashStep }: Dsl) =>`,
      `  pipeline(${literal(name)})`,
      `    .desc(${literal(`Run ${name}`)})`,
      `    .add(`,
      `      bashStep({`,
      `        id: "check",`,
      `        name: "Check",`,
      `        command: ${literal(command)},`,
      `      }),`,
      `    )`,
      `    .build();`,
      ``,
    ].join("\n"),
};

const checkedTemplate: PipelineTemplate = {
  id: "checked",
  desc: "A shell step an agent repairs when it fails (mechanicalFix), under a cost cap.",
  usesCommand: true,
  render: (name, command) =>
    [
      `import type { Dsl } from "@lance-nuit/dsl";`,
      ``,
      `// mechanicalFix is a ready-made failure policy: a fresh Claude session limited`,
      `// to Read and Edit, two attempts, effort raised on the second one. Replace it`,
      `// with an explicit onFail object when this pipeline needs another policy.`,
      `export default ({ pipeline, bashStep, mechanicalFix }: Dsl) =>`,
      `  pipeline(${literal(name)})`,
      `    .desc(${literal(`Run ${name} and repair a failure`)})`,
      `    // The whole run stops when the accumulated agent cost reaches this ceiling.`,
      `    .maxCost(2)`,
      `    .add(`,
      `      bashStep({`,
      `        id: "check",`,
      `        name: "Check",`,
      `        command: ${literal(command)},`,
      `        onFail: mechanicalFix(`,
      `          (ctx) =>`,
      `            \`The project command failed. Fix the cause and change nothing else.\\n\\n\${ctx.errors}\`,`,
      `        ),`,
      `      }),`,
      `    )`,
      `    .build();`,
      ``,
    ].join("\n"),
};

const agentTemplate: PipelineTemplate = {
  id: "agent",
  desc: "One agent step: explicit backend, semantic role, cost cap, and retry escalation.",
  usesCommand: false,
  render: (name) =>
    [
      `import type { Dsl } from "@lance-nuit/dsl";`,
      ``,
      `// backend selects the provider; profile is the semantic role that carries the`,
      `// nominal model and effort. Never write a model here: retune the role in`,
      `// .lance-nuit/config.json under profiles.coder.backends.claude instead.`,
      `export default ({ pipeline, llmStep }: Dsl) =>`,
      `  pipeline(${literal(name)})`,
      `    .desc(${literal(`Run ${name} with an agent`)})`,
      `    .maxCost(5)`,
      `    .add(`,
      `      llmStep({`,
      `        id: "work",`,
      `        name: "Work",`,
      `        backend: "claude",`,
      `        profile: "coder",`,
      `        // Replace this with the real instruction, or move it to a prompt file`,
      `        // with the injected promptFile() helper once it grows.`,
      `        command: (ctx) => \`Describe the task for \${ctx.ticket ?? "this run"} here.\`,`,
      `        onFail: {`,
      `          fix: (ctx) => \`The step failed. Fix the cause.\\n\\n\${ctx.errors}\`,`,
      `          retries: 2,`,
      `          // After one failed retry, run the next one at a higher effort.`,
      `          escalate: { effort: "high", after: 1 },`,
      `        },`,
      `      }),`,
      `    )`,
      `    .build();`,
      ``,
    ].join("\n"),
};

const reviewTemplate: PipelineTemplate = {
  id: "review",
  desc: "A shell check, then a reviewer agent that must produce a report artifact.",
  usesCommand: true,
  render: (name, command) =>
    [
      `import type { Dsl } from "@lance-nuit/dsl";`,
      ``,
      `export default ({ pipeline, bashStep, llmStep, textArtifact }: Dsl) => {`,
      `  // An artifact declared here is proof of completion: the step fails when the`,
      `  // file is missing or rejected by its parser, not three steps later.`,
      `  const report = textArtifact("review.md");`,
      ``,
      `  return pipeline(${literal(name)})`,
      `    .desc(${literal(`Check and review ${name}`)})`,
      `    .maxCost(5)`,
      `    .add(`,
      `      bashStep({`,
      `        id: "check",`,
      `        name: "Check",`,
      `        command: ${literal(command)},`,
      `      }),`,
      `      llmStep({`,
      `        id: "review",`,
      `        name: "Review",`,
      `        backend: "claude",`,
      `        profile: "reviewer",`,
      `        command: (ctx) =>`,
      `          \`Review the current changes and write your report to \${ctx.paths.artifact("review.md")}.\`,`,
      `        output: [report],`,
      `      }),`,
      `    )`,
      `    .build();`,
      `};`,
      ``,
    ].join("\n"),
};

const workItemTemplate: PipelineTemplate = {
  id: "work-item",
  desc: "A work-item loop: triage each ticket, escalate the ones a human must decide.",
  usesCommand: false,
  render: (name) =>
    [
      `import type { Dsl } from "@lance-nuit/dsl";`,
      ``,
      `// This template needs a configured work-item provider; see`,
      `// guide/work-item-port.md. Everything else stays provider-neutral.`,
      `export default ({ pipeline, llmStep, artifact, workItemEscalateStep }: Dsl) => {`,
      `  const triage = artifact("triage.json", (value: unknown) => {`,
      `    if (!value || typeof value !== "object") throw new Error("invalid triage");`,
      `    const raw = value as { verdict?: unknown; reason?: unknown };`,
      `    if (raw.verdict !== "proceed" && raw.verdict !== "review") {`,
      `      throw new Error("invalid triage verdict");`,
      `    }`,
      `    if (typeof raw.reason !== "string") throw new Error("missing triage reason");`,
      `    return { verdict: raw.verdict, reason: raw.reason };`,
      `  });`,
      ``,
      `  return pipeline(${literal(name)})`,
      `    .desc("Triage the work-item queue")`,
      `    .forEachWorkItem({`,
      `      queue: "featureTodo",`,
      `      // Reached by \`lancenuit run <id> --scan\`; each ticket gets its own budget.`,
      `      scan: { limit: 3 },`,
      `      maxCostPerWorkItemUsd: 5,`,
      `      do: [`,
      `        llmStep({`,
      `          id: "triage",`,
      `          name: "Triage",`,
      `          backend: "claude",`,
      `          profile: "triage",`,
      `          command: (ctx) =>`,
      `            \`Triage \${ctx.ticket ?? "this work item"} and write triage.json to \` +`,
      `            \`\${ctx.paths.artifactsDir ?? "artifacts"}.\`,`,
      `          output: [triage],`,
      `        }),`,
      `        workItemEscalateStep({`,
      `          // Idempotence key: keep it stable once the first escalation is published.`,
      `          id: "review-triage",`,
      `          artifact: triage,`,
      `          onlyIf: (value) => value.verdict === "review",`,
      `          escalation: (value) => ({`,
      `            cause: "the work item requires a human decision",`,
      `            details: { Reason: value.reason },`,
      `            state: "no code written",`,
      `            action: "decide on the ticket, then return it to the queue",`,
      `          }),`,
      `        }),`,
      `      ],`,
      `    })`,
      `    .build();`,
      `};`,
      ``,
    ].join("\n"),
};

export const PIPELINE_TEMPLATES: readonly PipelineTemplate[] = [
  bashTemplate,
  checkedTemplate,
  agentTemplate,
  reviewTemplate,
  workItemTemplate,
];

export function templateIds(): string[] {
  return PIPELINE_TEMPLATES.map((template) => template.id);
}

/** Resolve a template, listing the alternatives when the id is unknown. */
export function pipelineTemplate(id: string = DEFAULT_TEMPLATE_ID): PipelineTemplate {
  const template = PIPELINE_TEMPLATES.find((candidate) => candidate.id === id);
  if (!template) {
    throw new Error(`Unknown template: "${id}" (expected: ${templateIds().join(", ")}).`);
  }
  return template;
}

/** Render one template. `command` is required by, and only by, a template that runs one. */
export function renderPipelineTemplate(name: string, command: string | undefined, id?: string): string {
  validateName(name);
  const template = pipelineTemplate(id);
  if (template.usesCommand) {
    if (typeof command !== "string" || command.trim().length === 0) {
      throw new Error(`Template "${template.id}" requires a non-empty --command.`);
    }
  }
  return template.render(name, command ?? "");
}
