// engine/backends/opencode/events.schema.ts
//
// Shape of ONE line of the `opencode run --format json` NDJSON stream.
//
// Same diagnostic policy as the other two backends: nothing is ever rejected.
// Known events are `looseObject`s, every field is optional and self-catching
// (`lib/stream-values.schema.ts`), and the union ends on a fallback branch that
// accepts any object and reports `type: null`. A line that is not JSON never
// reaches here (`jsonRecords`, `lib/json-values.ts`).
//
// opencode specificity: `part` carries a DIFFERENT payload per event type
// (`tokens`/`cost` on `step_finish`, `text` on `text`, `tool` on `tool_use`), so
// each branch describes its own `part` rather than sharing one. Only `sessionID`
// is common to every event — the parser reads it off whichever event arrives
// first, unknown ones included.
//
// What stays out of the schema (and in code, in `events.ts`):
// - `costReported`: a free model reports `cost: 0`, which is not "price unknown";
//   only the absence of the field is, and that distinction is a rule, not a shape;
// - the JSON sniffing of a text part (`{...}` becomes `structuredOutput`);
// - `unquote` on the provider error message, and the `--print-logs` stderr scan;
// - the tool-name translation (`opencodeToolLabel`, `TOOL_NAMES`).
//
// zod v4 note: inside an object, a free-form field must be written
// `z.unknown().optional()` — a bare `z.unknown()` key is required.
//
// Types stay hand-written interfaces (`ParsedOpencodeEvents` in `events.ts`);
// nothing public is inferred from a schema, and nothing reachable from the
// installed DSL declarations imports this module. See `guide/architecture.md`,
// section "Persistence and observability".

import * as z from "zod";
import { looseNested, looseNumber, looseString } from "../../../lib/stream-values.schema.js";
import type { AssertAssignable } from "../../../lib/type-assertions.js";

// `sessionID` is the only field every event kind carries.
const base = { sessionID: looseString };

const StepFinishEventSchema = z.looseObject({
  ...base,
  type: z.literal("step_finish"),
  part: looseNested(
    z.looseObject({
      cost: looseNumber,
      tokens: looseNested(
        z.looseObject({
          input: looseNumber,
          output: looseNumber,
          reasoning: looseNumber,
          total: looseNumber,
          cache: looseNested(z.looseObject({ read: looseNumber, write: looseNumber })),
        }),
      ),
    }),
  ),
});

const TextEventSchema = z.looseObject({
  ...base,
  type: z.literal("text"),
  part: looseNested(z.looseObject({ id: looseString, text: looseString })),
});

// `part.type` is "tool" inside a `tool_use` event: the event name and the part
// name do not match.
const ToolUseEventSchema = z.looseObject({
  ...base,
  type: z.literal("tool_use"),
  part: looseNested(z.looseObject({ tool: looseString })),
});

const ErrorEventSchema = z.looseObject({
  ...base,
  type: z.literal("error"),
  error: looseNested(z.looseObject({ data: looseNested(z.looseObject({ message: looseString })) })),
});

/** The fallback branch: an event type this release knows nothing about. */
const UnknownEventSchema = z
  .looseObject({ ...base, type: looseString })
  .transform((event) => ({ type: null, sessionID: event.sessionID }));

export const OpencodeEventSchema = z.union([
  z.discriminatedUnion("type", [StepFinishEventSchema, TextEventSchema, ToolUseEventSchema, ErrorEventSchema]),
  UnknownEventSchema,
]);

export type OpencodeEvent = z.output<typeof OpencodeEventSchema>;

/** Reads one stream record. Never throws: an event this release does not know
 *  reads as `{ type: null }` and contributes only its `sessionID`. */
export function parseOpencodeEvent(record: unknown): OpencodeEvent {
  const parsed = OpencodeEventSchema.safeParse(record);
  return parsed.success ? parsed.data : { type: null, sessionID: undefined };
}

/* ------------------------------------------------------------------------- *
 * Compile-time proof, for the fields forwarded to a hand-written interface
 * without transformation. The rest is enforced by the declared return type of
 * `parseOpencodeEvents`.
 * ------------------------------------------------------------------------- */
type _SessionId = AssertAssignable<OpencodeEvent["sessionID"], string | undefined>;
type _Cost = AssertAssignable<NonNullable<z.output<typeof StepFinishEventSchema>["part"]>["cost"], number | undefined>;
