import { promptTemplate } from "./prompt.js";
import type { ArtifactScope, JsonSchema } from "../../../contracts/index.js";
import { capabilityAxes, isForked } from "../../../env/capability-frontmatter.js";
import { artifactScopeDirsOutside, artifactScopeInstruction } from "../artifact-scope.js";
import { JSON_VERDICT_INSTRUCTION, verdictInstruction, verdictSchema } from "../verdict-instruction.js";
import type { ClaudeOptions } from "./types.js";

export { artifactScopeInstruction, JSON_VERDICT_INSTRUCTION };

/** Bare verdict schema, shared with Codex through `verdictSchema()`. The one sent
 *  as `--json-schema` is `verdictSchema(options.outputFields)`. */
export const VERDICT_SCHEMA = verdictSchema();
export type VerdictMode = "schema" | "text";
export type Environment = Readonly<Record<string, string | undefined>>;
export function resolveVerdictMode(env: Environment = process.env): VerdictMode {
  return env.RUNNER_VERDICT_MODE === "text" ? "text" : "schema";
}
export function isSlashCommandPrompt(prompt: string): boolean {
  return /^\/[A-Za-z0-9]/.test(prompt.trimStart());
}
export function isForkedSlashCommand(
  prompt: string,
  roots: readonly string[],
  resolver?: (prompt: string, roots: readonly string[]) => boolean,
): boolean {
  if (resolver) return resolver(prompt, roots);
  const match = prompt.trimStart().match(/^\/([\w:-]+)/);
  if (!match) return false;
  const skill = match[1].includes(":") ? match[1] : `lance-nuit:${match[1]}`;
  return isForked(capabilityAxes("skill", skill, roots));
}
export interface ClaudeArgsOptions {
  outputFormat?: "text" | "json";
  claudeOptions?: ClaudeOptions;
  sessionId?: string;
  resumeSessionId?: string;
  cwd?: string;
  capabilityRoots?: readonly string[];
  verdictMode?: VerdictMode;
  artifactScope?: ArtifactScope;
  /** Captured fields, declared in the schema or in the text instruction. */
  outputFields?: Readonly<Record<string, JsonSchema>>;
  forkResolver?: (prompt: string, roots: readonly string[]) => boolean;
  forkRelay?: (slash: string) => string;
}
export function buildClaudeArgs(prompt: string, options: ClaudeArgsOptions = {}): string[] {
  const args: string[] = [];
  if (options.resumeSessionId) args.push("--resume", options.resumeSessionId);
  else if (options.sessionId) args.push("--session-id", options.sessionId);
  const schemaMode = (options.verdictMode ?? resolveVerdictMode()) === "schema";
  const needsVerdict = options.outputFormat === "json" && (schemaMode || !prompt.includes("json:verdict"));
  const slash = prompt.trimStart().match(/^\/[\w:-]+/)?.[0];
  const relay = promptTemplate("fork-relay", ["slash"]);
  const forkRelay =
    slash && options.capabilityRoots && isForkedSlashCommand(prompt, options.capabilityRoots, options.forkResolver)
      ? (options.forkRelay ?? ((value: string) => relay({ slash: value })))(slash)
      : undefined;
  const verdictInSystemPrompt = needsVerdict && !schemaMode && (Boolean(forkRelay) || isSlashCommandPrompt(prompt));
  const instruction = verdictInstruction(options.outputFields);
  const finalPrompt = needsVerdict && !schemaMode && !verdictInSystemPrompt ? `${prompt}\n\n${instruction}` : prompt;
  args.push(
    "-p",
    finalPrompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--add-dir",
    options.cwd ?? process.cwd(),
  );
  for (const dir of artifactScopeDirsOutside(options.cwd ?? process.cwd(), options.artifactScope))
    args.push("--add-dir", dir);
  if (needsVerdict && schemaMode) args.push("--json-schema", JSON.stringify(verdictSchema(options.outputFields)));
  const co = options.claudeOptions;
  if (co?.system_prompt) args.push("--system-prompt", co.system_prompt);
  const appended = [
    ...(options.artifactScope ? [artifactScopeInstruction(options.artifactScope)] : []),
    ...(forkRelay ? [forkRelay] : []),
    ...(verdictInSystemPrompt && !forkRelay ? [instruction] : []),
  ];
  if (appended.length) args.push("--append-system-prompt", appended.join("\n\n"));
  if (co?.tools) args.push("--tools", co.tools.join(","));
  if (co?.allowed_tools) args.push("--allowedTools", co.allowed_tools.join(","));
  if (co?.strict_mcp) args.push("--strict-mcp-config");
  if (co?.setting_sources != null) args.push("--setting-sources", co.setting_sources);
  args.push("--permission-mode", co?.permission_mode ?? "bypassPermissions");
  if (co?.model) args.push("--model", co.model);
  if (co?.effort) args.push("--effort", co.effort);
  if (co?.agent) args.push("--agent", co.agent);
  return args;
}
