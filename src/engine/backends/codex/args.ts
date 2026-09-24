import type { ArtifactScope } from "../../../contracts/index.js";
import { artifactScopeDirsOutside, artifactScopeInstruction } from "../artifact-scope.js";
import { CODEX_SANDBOX, type CodexOptions } from "./types.js";

export interface CodexArgsOptions {
  readonly outputFormat?: "text" | "json";
  readonly cwd?: string;
  readonly sessionId?: string;
  readonly resumeSessionId?: string;
  readonly schemaPath?: string;
  readonly artifactScope?: ArtifactScope;
}

function pushOption(args: string[], flag: string, value: string | undefined): void {
  if (value != null && value !== "") args.push(flag, value);
}

function pushConfig(args: string[], key: string, value: string | undefined): void {
  if (value != null && value !== "") args.push("--config", `${key}="${value}"`);
}

export function buildCodexArgs(prompt: string, options: CodexOptions = {}, run: CodexArgsOptions = {}): string[] {
  const resumed = !!run.resumeSessionId;
  const args = ["exec"];
  if (resumed) args.push("resume", run.resumeSessionId!);
  args.push("--json");
  if (!resumed) args.push("--color", "never");
  pushOption(args, "--model", options.model);
  pushConfig(args, "model_reasoning_effort", options.effort);
  if (!resumed) {
    pushOption(args, "--profile", options.codexProfile);
    pushOption(args, "--sandbox", options.sandbox ?? CODEX_SANDBOX.READ_ONLY);
  }
  if (options.ephemeral) args.push("--ephemeral");
  if (options.ignoreUserConfig) args.push("--ignore-user-config");
  if (options.ignoreRules) args.push("--ignore-rules");
  if (options.skipGitRepoCheck) args.push("--skip-git-repo-check");
  if (!resumed) {
    for (const dir of options.addDirs ?? []) pushOption(args, "--add-dir", dir);
    if (run.cwd)
      for (const dir of artifactScopeDirsOutside(run.cwd, run.artifactScope)) pushOption(args, "--add-dir", dir);
    pushOption(args, "--cd", run.cwd);
  }
  if (run.outputFormat === "json" && run.schemaPath) args.push("--output-schema", run.schemaPath);
  const finalPrompt = run.artifactScope ? `${prompt}\n\n${artifactScopeInstruction(run.artifactScope)}` : prompt;
  args.push(finalPrompt);
  return args;
}
