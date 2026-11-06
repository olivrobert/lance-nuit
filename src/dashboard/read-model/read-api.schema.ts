//
// The read API, version 1: what `GET /api/v1/runs` and
// `GET /api/v1/runs/<project>/<ticket>/<runId>` answer to a reader outside the
// dashboard (a dashboard of its own, a script).
//
// The interfaces are the contract. The zod schemas prove them at compile time,
// in both directions, and generate `docs/read-api/v1/*.schema.json`, the copy a
// reader that is not written in TypeScript validates against. They are strict
// here, so a test fails on any field the contract does not name; the published
// copy drops `additionalProperties: false`, because a reader of version 1 must
// keep reading when a later release adds a field.
//
// Within version 1 a field may be added, never removed, renamed or retyped, and
// an enumeration may gain a value: a reader treats an unknown one as "other".
// Anything else is version 2, under another path. See `guide/read-api.md`.

import * as z from "zod";
import type { RunReport } from "../../definition/index.js";
import type { AssertAssignable, Plain } from "../../shared/lib/type-assertions.js";

export const READ_API_VERSION = 1;

/** Every status the read API serves: the values its schema and its `status`
 *  filter accept. */
export const API_RUN_STATUSES = ["RUNNING", "PASS", "FAIL", "STOPPED", "ABORTED"] as const;

/** The status a later `lancenuit run` would judge: a snapshot without a verdict
 *  that no live process holds is `ABORTED`, never `RUNNING`. */
export type ApiRunStatus = (typeof API_RUN_STATUSES)[number];

/** Expected recovery of a clean stop, as the runner recorded it. */
export type ApiStopKind = "needs-info" | "needs-decision" | "needs-human" | "blocked" | "until";

/** Where the decision that lifts a pending gate stands. */
export type ApiApprovalState = "absent" | "fresh" | "stale" | "rejected" | "reworked";

export type ApiStepStatus = "pending" | "running" | "done" | "failed" | "skipped" | "aborted";

/** A spend. `usd` is absent when nothing reported a figure; with `lowerBound`
 *  it is a floor, never the spend itself. */
export interface ApiCost {
  usd?: number;
  /** The figure comes from a rate table, not from the provider. */
  estimated: boolean;
  /** Some tokens could not be priced: `usd` is a lower bound. */
  lowerBound: boolean;
}

export interface ApiStop {
  /** Approval subject that lifts the stop, when the gate declares one. */
  subject?: string;
  kind?: ApiStopKind;
  /** Why the run stopped. Free text from the pipeline: escape it. */
  detail: string;
  /** The gate declares a rework step, so the artifact can be rejected. */
  reworkable?: true;
}

export interface ApiFailure {
  /** Step the run failed in; empty when the snapshot names none. */
  phase: string;
  /** Free text from the runner or an agent: escape it. */
  reason: string;
  /** `verdict`: the agent or a check judged the work wrong. `technical`: an
   *  incident stopped it. */
  kind?: "verdict" | "technical";
  /** Present when no fix pass could have changed the answer. */
  cause?: "blocked";
}

export interface ApiApproval {
  subject: string;
  state: ApiApprovalState;
  decidedAt?: string;
  decidedBy?: string;
  /** On `rejected`: why the human rejected the artifact. */
  reason?: string;
  /** On `rejected` or `reworked`: the rework round the rejection opened. */
  round?: number;
}

export interface ApiClosure {
  at: string;
  by: string;
}

/** One root run. A composed child is never listed: its spend is already in
 *  its parent's `cost`. */
export interface ApiRun {
  /** Name of the project as the dashboard lists it. */
  project: string;
  ticket: string;
  pipeline: string;
  runId: string;
  /** This is the run the ticket is about now: the most recently updated latest
   *  run across its pipelines. Exactly one run per ticket carries it. */
  current: boolean;
  /** First `# ` heading of the ticket's `artifacts/ticket.md`. Escape it. */
  title?: string;
  ticketUrl?: string;
  status: ApiRunStatus;
  /** The runner died without a verdict; `status` is then `ABORTED`. */
  interrupted?: true;
  /** Somebody has to act: rerun, decide, or close. */
  awaitsHuman: boolean;
  /** Set exactly when `status` is `STOPPED`. */
  stop?: ApiStop;
  /** Set exactly when `status` is `FAIL` or `ABORTED`. */
  failure?: ApiFailure;
  /** The pending approval of a stopped current run, judged on the artifact as
   *  it stands now. Never set on a run that is not `current`. */
  approval?: ApiApproval;
  budgetExceeded?: true;
  /** Stopped because its spending could no longer be accounted for. */
  costUnaccounted?: true;
  cost: ApiCost;
  /** Time spent executing steps, waits excluded. */
  activeMs?: number;
  createdAt?: string;
  updatedAt?: string;
  /** Recorded when the run finished; absent while it runs. */
  branch?: string;
  worktree: boolean;
  /** Closed by hand (`lancenuit close`) while it still awaited somebody. */
  closed?: ApiClosure;
}

export interface ApiRunList {
  schemaVersion: 1;
  generatedAt: string;
  /** Newest `updatedAt` first, at most the requested `limit`. */
  runs: ApiRun[];
}

export interface ApiTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ApiModelCost {
  model: string;
  costUsd?: number;
}

export interface ApiStep {
  id: string;
  status: ApiStepStatus;
  profile?: string;
  model?: string;
  /** A step composing pipelines ran no agent: its children's models. */
  models?: ApiModelCost[];
  durationMs?: number;
  cost?: ApiCost;
  retries?: number;
  tokens?: ApiTokens;
}

export interface ApiRunDetail {
  schemaVersion: 1;
  generatedAt: string;
  run: ApiRun;
  steps: ApiStep[];
  /** The delivery report (`artifacts/report.json`, its own versioned format),
   *  only on the current run, and only when it is valid for it. */
  report?: RunReport;
  /** Why an existing `report.json` was ignored. */
  reportError?: string;
}

const RunStatusSchema = z.enum(API_RUN_STATUSES);
const StopKindSchema = z.enum(["needs-info", "needs-decision", "needs-human", "blocked", "until"]);
const ApprovalStateSchema = z.enum(["absent", "fresh", "stale", "rejected", "reworked"]);
const StepStatusSchema = z.enum(["pending", "running", "done", "failed", "skipped", "aborted"]);

const CostSchema = z
  .strictObject({ usd: z.optional(z.number()), estimated: z.boolean(), lowerBound: z.boolean() })
  .meta({ id: "Cost" });

const StopSchema = z
  .strictObject({
    subject: z.optional(z.string()),
    kind: z.optional(StopKindSchema),
    detail: z.string(),
    reworkable: z.optional(z.literal(true)),
  })
  .meta({ id: "Stop" });

const FailureSchema = z
  .strictObject({
    phase: z.string(),
    reason: z.string(),
    kind: z.optional(z.enum(["verdict", "technical"])),
    cause: z.optional(z.literal("blocked")),
  })
  .meta({ id: "Failure" });

const ApprovalSchema = z
  .strictObject({
    subject: z.string(),
    state: ApprovalStateSchema,
    decidedAt: z.optional(z.string()),
    decidedBy: z.optional(z.string()),
    reason: z.optional(z.string()),
    round: z.optional(z.number()),
  })
  .meta({ id: "Approval" });

const ClosureSchema = z.strictObject({ at: z.string(), by: z.string() }).meta({ id: "Closure" });

const RunSchema = z
  .strictObject({
    project: z.string(),
    ticket: z.string(),
    pipeline: z.string(),
    runId: z.string(),
    current: z.boolean(),
    title: z.optional(z.string()),
    ticketUrl: z.optional(z.string()),
    status: RunStatusSchema,
    interrupted: z.optional(z.literal(true)),
    awaitsHuman: z.boolean(),
    stop: z.optional(StopSchema),
    failure: z.optional(FailureSchema),
    approval: z.optional(ApprovalSchema),
    budgetExceeded: z.optional(z.literal(true)),
    costUnaccounted: z.optional(z.literal(true)),
    cost: CostSchema,
    activeMs: z.optional(z.number()),
    createdAt: z.optional(z.string()),
    updatedAt: z.optional(z.string()),
    branch: z.optional(z.string()),
    worktree: z.boolean(),
    closed: z.optional(ClosureSchema),
  })
  .meta({ id: "Run" });

export const RunListSchema = z
  .strictObject({ schemaVersion: z.literal(READ_API_VERSION), generatedAt: z.string(), runs: z.array(RunSchema) })
  .meta({ id: "RunList", title: "lance-nuit read API v1: GET /api/v1/runs" });

const TokensSchema = z
  .strictObject({ input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number() })
  .meta({ id: "Tokens" });

const ModelCostSchema = z
  .strictObject({ model: z.string(), costUsd: z.optional(z.number()) })
  .meta({ id: "ModelCost" });

const StepSchema = z
  .strictObject({
    id: z.string(),
    status: StepStatusSchema,
    profile: z.optional(z.string()),
    model: z.optional(z.string()),
    models: z.optional(z.array(ModelCostSchema)),
    durationMs: z.optional(z.number()),
    cost: z.optional(CostSchema),
    retries: z.optional(z.number()),
    tokens: z.optional(TokensSchema),
  })
  .meta({ id: "Step" });

// The report keeps its own versioned format (`guide/work-item-layout.md`): the
// read API carries it whole and checks only the field that names that format.
const ReportSchema = z.looseObject({ version: z.literal(1) }).meta({ id: "Report" });

export const RunDetailSchema = z
  .strictObject({
    schemaVersion: z.literal(READ_API_VERSION),
    generatedAt: z.string(),
    run: RunSchema,
    steps: z.array(StepSchema),
    report: z.optional(ReportSchema),
    reportError: z.optional(z.string()),
  })
  .meta({ id: "RunDetail", title: "lance-nuit read API v1: GET /api/v1/runs/<project>/<ticket>/<runId>" });

type _RunList = AssertAssignable<z.output<typeof RunListSchema>, ApiRunList>;
type _RunListInput = AssertAssignable<Plain<ApiRunList>, z.input<typeof RunListSchema>>;
type _Detail = AssertAssignable<Omit<z.output<typeof RunDetailSchema>, "report">, Omit<ApiRunDetail, "report">>;
type _DetailInput = AssertAssignable<
  Plain<Omit<ApiRunDetail, "report">>,
  Omit<z.input<typeof RunDetailSchema>, "report">
>;

/** The published JSON Schema of each answer, keyed by its file name under
 *  `docs/read-api/v1/`. */
export function readApiJsonSchemas(): Record<string, unknown> {
  const published = (schema: z.ZodType): unknown =>
    z.toJSONSchema(schema, {
      override: (ctx) => {
        // A reader of version 1 must accept the fields a later release adds.
        delete (ctx.jsonSchema as Record<string, unknown>).additionalProperties;
      },
    });
  return {
    "run-list.schema.json": published(RunListSchema),
    "run-detail.schema.json": published(RunDetailSchema),
  };
}
