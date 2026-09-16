import type { ArtifactScope, EffortLevel, JsonSchema } from "../../../contracts/index.js";
import { artifactScopeInstruction } from "../artifact-scope.js";
import { JSON_VERDICT_INSTRUCTION, verdictInstruction } from "../verdict-instruction.js";
import { OPENCODE_LOG_LEVEL, OPENCODE_VARIANT, type OpencodeOptions, type OpencodeVariant } from "./types.js";

export { artifactScopeInstruction, JSON_VERDICT_INSTRUCTION };

export interface OpencodeArgsOptions {
  readonly outputFormat?: "text" | "json";
  readonly cwd?: string;
  readonly resumeSessionId?: string;
  /** Fork the resumed session instead of appending to it. Needs a resume target. */
  readonly fork?: boolean;
  readonly artifactScope?: ArtifactScope;
  /** Captured fields: opencode has no output schema, so they ride in the text
   *  instruction and come back inside the ```json:verdict fence. */
  readonly outputFields?: Readonly<Record<string, JsonSchema>>;
}

/**
 * `--variant` carries the reasoning effort. `medium` maps to nothing: it is the
 * provider default, and pushing an unknown variant is rejected by models that
 * do not reason.
 */
export function variantForEffort(effort: EffortLevel | undefined): OpencodeVariant | undefined {
  switch (effort) {
    case "low":
      return OPENCODE_VARIANT.MINIMAL;
    case "high":
      return OPENCODE_VARIANT.HIGH;
    case "xhigh":
    case "max":
      return OPENCODE_VARIANT.MAX;
    default:
      return undefined;
  }
}

function pushOption(args: string[], flag: string, value: string | undefined): void {
  if (value != null && value !== "") args.push(flag, value);
}

/**
 * opencode has no `--output-schema` and no `StructuredOutput` tool, so the
 * verdict contract is injected into the prompt. Skipped when the caller already
 * spelled it out.
 */
function needsVerdict(prompt: string, outputFormat: "text" | "json" | undefined): boolean {
  return outputFormat === "json" && !prompt.includes("json:verdict");
}

export function buildOpencodeArgs(
  prompt: string,
  options: OpencodeOptions = {},
  run: OpencodeArgsOptions = {},
): string[] {
  const args = ["run", "--format", "json"];
  pushOption(args, "--session", run.resumeSessionId);
  if (run.fork && run.resumeSessionId) args.push("--fork");
  pushOption(args, "--model", options.model);
  pushOption(args, "--variant", variantForEffort(options.effort));
  pushOption(args, "--agent", options.agent);
  pushOption(args, "--dir", run.cwd);
  if (options.pure) args.push("--pure");
  args.push("--print-logs", "--log-level", options.logLevel ?? OPENCODE_LOG_LEVEL.ERROR);
  const appended = [
    ...(run.artifactScope ? [artifactScopeInstruction(run.artifactScope)] : []),
    ...(needsVerdict(prompt, run.outputFormat) ? [verdictInstruction(run.outputFields)] : []),
  ];
  args.push(appended.length ? [prompt, ...appended].join("\n\n") : prompt);
  return args;
}

/**
 * Environment overrides for one request. Both matter for determinism, and
 * neither has a command-line equivalent.
 */
export function buildOpencodeEnv(
  options: OpencodeOptions = {},
  base: Readonly<Record<string, string | undefined>> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) if (value !== undefined) env[key] = value;
  if (options.disableClaudeCodeCompat === false) delete env.OPENCODE_DISABLE_CLAUDE_CODE;
  else env.OPENCODE_DISABLE_CLAUDE_CODE = "1";
  if (options.configPath) env.OPENCODE_CONFIG = options.configPath;
  return env;
}
