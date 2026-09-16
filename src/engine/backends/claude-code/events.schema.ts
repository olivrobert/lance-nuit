// engine/backends/claude-code/events.schema.ts
//
// Shape of ONE line of the `claude --output-format stream-json` NDJSON stream.
//
// Diagnostic policy for this boundary: nothing is ever rejected. The stream is
// produced by a CLI the runner does not version; a release may add an event type,
// add a field, or drop an optional one at any time. An event the runner does not
// know must not cost it the events it does know, so:
// - each known event is a `looseObject` (unknown keys pass through untouched);
// - every field is optional and self-catching (`lib/stream-values.schema.ts`), so a
//   field of the wrong kind reads as absent instead of failing the whole event;
// - the union ends on a fallback branch that accepts any object and reports
//   `type: null`, which the parser simply ignores.
// A line that is not JSON at all never reaches this schema: `jsonRecords`
// (`lib/json-values.ts`) drops it, as it always did.
//
// zod v4 note: inside an object, a free-form field must be written
// `z.unknown().optional()`. A bare `z.unknown()` key is required, so its absence
// fails the whole branch and the event silently falls through to the fallback.
//
// What stays out of the schema (and in code, in `events.ts`):
// - deduplication of repeated messages by `message.id`;
// - the `<synthetic>` model rule, the session-model versus turn-model split;
// - cost estimation, the 1h fallback for unsplit cache creation, and the choice
//   between a CLI-reported cost and the estimate;
// - the transport-error classification (`isOverloaded`, `isRateLimited`,
//   `isAuthFailure`).
// Rule of thumb: the schema says what a line may contain; what it means is code.
//
// Types stay hand-written interfaces (`ClaudeParsedEvents`, `UsageTotals`,
// `ClaudeTransportError` in `events.ts`); this module never infers a public type
// from a schema, and nothing reachable from the installed DSL declarations
// imports it. See `guide/architecture.md`, section "Persistence and
// observability".

import * as z from "zod";
import type { AttemptStats } from "../../../contracts/index.js";
import { looseBoolean, looseNested, looseNumber, looseString } from "../../../lib/stream-values.schema.js";
import type { AssertAssignable } from "../../../lib/type-assertions.js";

/** `message.usage` of an `assistant` event: the block `addUsage` folds in. */
export const ClaudeUsageSchema = z.looseObject({
  input_tokens: looseNumber,
  output_tokens: looseNumber,
  cache_read_input_tokens: looseNumber,
  cache_creation_input_tokens: looseNumber,
  cache_creation: looseNested(
    z.looseObject({
      ephemeral_5m_input_tokens: looseNumber,
      ephemeral_1h_input_tokens: looseNumber,
    }),
  ),
});

/** A usage block read defensively: a payload that is not an object counts as zero. */
export function parseClaudeUsage(value: unknown): z.output<typeof ClaudeUsageSchema> {
  const result = ClaudeUsageSchema.safeParse(value);
  return result.success ? result.data : { cache_creation: null };
}

const ToolUseBlockSchema = z.looseObject({
  type: z.literal("tool_use"),
  name: z.string(),
  input: z.unknown().optional(),
});

const TextBlockSchema = z.looseObject({
  type: z.literal("text"),
  text: z.string(),
});

// Any other block — including a `tool_use` without a usable `name`, which the
// hand-written probe skipped just as silently.
const OtherBlockSchema = z.looseObject({}).transform(() => ({ type: null }));

const ContentBlockSchema = z.union([ToolUseBlockSchema, TextBlockSchema, OtherBlockSchema]).nullable().catch(null);

/** `message.content`: a non-array reads as empty, a non-object entry as `null`. */
const ContentSchema = z.array(ContentBlockSchema).catch([]);

const AssistantMessageSchema = z.looseObject({
  id: looseString,
  model: looseString,
  content: ContentSchema,
  usage: looseNested(ClaudeUsageSchema),
});

// `session_id` is carried by every event kind, not by one of them.
const base = { session_id: looseString };

const SystemEventSchema = z.looseObject({ ...base, type: z.literal("system"), model: looseString });

const RateLimitEventSchema = z.looseObject({
  ...base,
  type: z.literal("rate_limit_event"),
  rate_limit_info: looseNested(z.looseObject({ resetsAt: looseNumber })),
});

const AssistantEventSchema = z.looseObject({
  ...base,
  type: z.literal("assistant"),
  message: looseNested(AssistantMessageSchema),
});

const ResultEventSchema = z.looseObject({
  ...base,
  type: z.literal("result"),
  is_error: looseBoolean,
  terminal_reason: looseString,
  api_error_status: looseNumber,
  // Free-form: the parser stringifies it, so no shape is imposed.
  result: z.unknown().optional(),
  structured_output: z.unknown().optional(),
  duration_ms: looseNumber,
  duration_api_ms: looseNumber,
  num_turns: looseNumber,
  total_cost_usd: looseNumber,
});

/** The fallback branch: an event type this release knows nothing about. */
const UnknownEventSchema = z
  .looseObject({ ...base, type: looseString })
  .transform((event) => ({ type: null, session_id: event.session_id }));

export const ClaudeEventSchema = z.union([
  z.discriminatedUnion("type", [SystemEventSchema, RateLimitEventSchema, AssistantEventSchema, ResultEventSchema]),
  UnknownEventSchema,
]);

export type ClaudeEvent = z.output<typeof ClaudeEventSchema>;

// The `input` of a `tool_use` block is passed through raw (it becomes
// `structuredOutput` for the `StructuredOutput` tool), so only the few keys the
// tool label needs are described here, and only for reading.
const ToolInputSchema = looseNested(
  z.looseObject({
    skill: z.unknown().optional(),
    subagent_type: z.unknown().optional(),
    name: z.unknown().optional(),
  }),
);

/** The label-bearing keys of a tool input; `null` when the input is not an object. */
export function parseClaudeToolInput(value: unknown): z.output<typeof ToolInputSchema> {
  const parsed = ToolInputSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Reads one stream record. Never throws, never rejects: an unreadable event is
 *  reported as an unknown one (`type: null`) and skipped by the parser. */
export function parseClaudeEvent(record: unknown): ClaudeEvent {
  const parsed = ClaudeEventSchema.safeParse(record);
  return parsed.success ? parsed.data : { type: null, session_id: undefined };
}

/* ------------------------------------------------------------------------- *
 * Compile-time proof, for the fields the parser forwards to a hand-written
 * interface without transforming them. The rest of the agreement is enforced by
 * the declared return type of `parseClaudeEvents`.
 * ------------------------------------------------------------------------- */
type _SessionId = AssertAssignable<ClaudeEvent["session_id"], string | undefined>;
type _Model = AssertAssignable<z.output<typeof SystemEventSchema>["model"], AttemptStats["model"]>;
type _Cost = AssertAssignable<z.output<typeof ResultEventSchema>["total_cost_usd"], AttemptStats["total_cost_usd"]>;
type _Turns = AssertAssignable<z.output<typeof ResultEventSchema>["num_turns"], AttemptStats["num_turns"]>;
type _ApiDuration = AssertAssignable<
  z.output<typeof ResultEventSchema>["duration_api_ms"],
  AttemptStats["duration_api_ms"]
>;
