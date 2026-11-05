import type { JsonSchema, VERDICT_FIELD_NAMES } from "../../contracts/index.js";

/** The three fields every verdict carries, in the shape the strict structured-output
 *  modes accept. OpenAI Structured Outputs has no optional property: `required`
 *  must list every key of `properties`, or the API rejects the schema with a 400
 *  (`invalid_json_schema ... Missing 'blocked'`). Optionality is expressed by the
 *  `null` union instead; `verdictFromObject` reads a `null` (or absent) `blocked`
 *  as "not stated" and falls back to the `BLOCKED:` prefix. `blocked` stays
 *  declared because `additionalProperties: false` would otherwise forbid the very
 *  field the verdict contract asks a blocked agent for. Claude Code tolerates a
 *  partial `required`, but one rule for every backend keeps the verdict contract
 *  the only place that decides. */
const VERDICT_FIELDS = {
  success: { type: "boolean" },
  reason: { type: "string" },
  blocked: { type: ["boolean", "null"] },
} as const satisfies Record<(typeof VERDICT_FIELD_NAMES)[number], JsonSchema>;

export interface VerdictSchema {
  readonly type: "object";
  readonly properties: Readonly<Record<string, JsonSchema>>;
  readonly required: readonly string[];
  readonly additionalProperties: false;
}

/**
 * Verdict schema for the backends with a native output schema (`--output-schema`,
 * `--json-schema`). `fields` are the captured outputs of the step, added next to
 * the verdict fields; without them the schema carries the three verdict fields alone.
 * `required` is derived from `properties`, never enumerated, so the strict-mode
 * invariant holds whatever is added.
 */
export function verdictSchema(fields?: Readonly<Record<string, JsonSchema>>): VerdictSchema {
  const properties: Record<string, JsonSchema> = { ...VERDICT_FIELDS, ...(fields ?? {}) };
  return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
}

/**
 * Prompt-injected verdict contract, for backends with no native output schema.
 * Parsed back by `extractVerdictDetails()` of `contracts/verdict.ts`. With `fields`,
 * the block also names every captured output and its schema, so the agent returns
 * them in the same object.
 */
export function verdictInstruction(fields?: Readonly<Record<string, JsonSchema>>): string {
  const entries = Object.entries(fields ?? {});
  const extra = entries.map(([name]) => `, "${name}": ...`).join("");
  const fieldLines = entries.map(([name, schema]) => `- "${name}" (required): ${JSON.stringify(schema)}`);
  const fieldsText = fieldLines.length
    ? `\nThe block MUST also carry these fields, each matching its JSON schema:\n${fieldLines.join("\n")}`
    : "";
  return `End your response with a verdict block (success required, reason and blocked optional):
\`\`\`json:verdict
{"success": true|false, "reason": "...", "blocked": true|false${extra}}
\`\`\`
Set "blocked": true only when an obstacle outside the code stops you — a missing branch, an unreachable service, a credential you do not have. The run then stops instead of attempting a repair that cannot work.${fieldsText}`;
}

/** The verdict block with no captured fields, re-exported by the backends that
 *  inject the contract into the prompt. */
export const JSON_VERDICT_INSTRUCTION = verdictInstruction();
