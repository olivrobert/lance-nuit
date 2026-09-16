import { readFileSync } from "node:fs";
import type { WorkItemConfig } from "../contracts/work-items.js";
import { errorMessage } from "../lib/errors.js";
import {
  DEFAULT_SENSITIVE_PATHS,
  DEFAULT_STACK_READINESS_TIMEOUT_MS,
  DEFAULT_STACK_START_COMMAND,
  type ExtensionsConfig,
  type PipelineConfig,
  type StackPreflightConfig,
} from "../model/config.js";
import { type ConfigFile, parseConfigFile } from "./config.schema.js";
import { CONFIG_FILE, kitFileLayers } from "./kit-paths.js";

export type { PipelineLabels, WorkItemConfig } from "../contracts/work-items.js";
export type { ExtensionsConfig, PipelineConfig, StackPreflightConfig } from "../model/config.js";
export {
  DEFAULT_SENSITIVE_PATHS,
  DEFAULT_STACK_READINESS_TIMEOUT_MS,
  DEFAULT_STACK_START_COMMAND,
} from "../model/config.js";

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

/**
 * `{ "services": ["app", "db"], "startCommand": "docker compose up -d", "readinessTimeoutMs": 300000 }`.
 *
 * Without a declared service there is nothing to guarantee: preflight is absent
 * rather than present-but-empty, keeping `applies()` a simple presence check.
 */
function parseStackPreflight(value: ConfigFile["stackPreflight"]): StackPreflightConfig | undefined {
  if (!value) return undefined;
  const services = (value.services ?? []).filter((service) => service.trim()).map((s) => s.trim());
  if (services.length === 0) return undefined;
  return {
    services,
    startCommand: stringValue(value.startCommand, DEFAULT_STACK_START_COMMAND),
    readinessTimeoutMs: value.readinessTimeoutMs ?? DEFAULT_STACK_READINESS_TIMEOUT_MS,
  };
}

function parseExtensions(value: ConfigFile["extensions"]): ExtensionsConfig | undefined {
  const module = stringValue(value?.module, "");
  return module ? { module } : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Read and validate one configuration layer. Invalid JSON and an invalid shape
 * are both errors naming the file: a layer that cannot be read must not silently
 * become "no configuration".
 */
function readConfigLayer(path: string): ConfigFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    throw new Error(`Invalid configuration (${path}): ${errorMessage(error)}`, { cause: error });
  }
  return parseConfigFile(parsed, path);
}

/**
 * Recursively merge objects, REPLACE everything else.
 *
 * Arrays are not concatenated: project-declared `sensitivePaths` must be able to
 * REDUCE the shared list, not merely extend it. Free-key sections (`steps`,
 * `profiles`, `testSkills`) benefit from recursion: user config provides defaults and
 * the project changes one key without copying the others.
 */
function mergeConfig(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = merged[key];
    merged[key] = isPlainObject(current) && isPlainObject(value) ? mergeConfig(current, value) : value;
  }
  return merged;
}

/**
 * Config layers from lowest to highest priority:
 * `~/.lance-nuit/config.json` < `.lance-nuit/config.json`.
 *
 * Unlike pipelines (first match wins, file is indivisible), config is
 * MERGED: this is the point of a shared user file carrying `profiles` / `steps`
 * common to all projects. A project file that sets only part of the keys keeps
 * the user values for the rest.
 */
function configLayers(cwd: string): string[] {
  return kitFileLayers(CONFIG_FILE, { cwd });
}

/**
 * Each layer is validated on its own, so an error names the file that carries the
 * mistake. The merge of valid layers is parsed again only to obtain a typed
 * `ConfigFile`: strict layers merge into a strict result, so this parse cannot
 * fail on the form.
 */
function configFile(cwd: string): ConfigFile {
  const layers = configLayers(cwd);
  const merged = layers.reduce<Record<string, unknown>>(
    (acc, path) => mergeConfig(acc, readConfigLayer(path) as Record<string, unknown>),
    {},
  );
  return parseConfigFile(merged, layers.join(" + ") || "no file");
}

function workItemConfig(file: ConfigFile): WorkItemConfig {
  const raw = file.workItem ?? {};
  const baseUrl = stringValue(raw.baseUrl, "");

  return {
    // Preserve an explicitly configured provider. Resolution happens through the
    // injected registry, so an unknown value can report a useful error instead of
    // silently operating against Jira.
    provider: stringValue(raw.provider, "jira"),
    project: stringValue(raw.project, ""),
    todoState: stringValue(raw.todoState, "To Do"),
    reviewState: stringValue(raw.reviewState, "In Review"),
    ...(baseUrl ? { baseUrl } : {}),
  };
}

/**
 * Read and normalize project configuration once. This function keeps no module
 * state; the result is injected into PipelineContext.
 */
export function loadPipelineConfig(cwd: string = process.cwd()): PipelineConfig {
  const file = configFile(cwd);
  const labels = file.labels ?? {};
  const specPath = stringValue(file.specPath, ".lance-nuit/work-items").replace(/\\/g, "/").replace(/\/+$/, "");

  const stackPreflight = parseStackPreflight(file.stackPreflight);
  const extensions = parseExtensions(file.extensions);

  return {
    workItem: workItemConfig(file),
    ...(extensions ? { extensions } : {}),
    labels: {
      bugTodo: stringValue(labels.bugTodo, "auto-fix"),
      featureTodo: stringValue(labels.featureTodo, "auto-feature"),
      done: stringValue(labels.done, "auto-fixed"),
      escalate: stringValue(labels.escalate, "needs-human"),
    },
    baseBranch: stringValue(file.baseBranch, "main"),
    worktreeMode: file.worktreeMode ?? "full",
    sensitivePaths: file.sensitivePaths ?? DEFAULT_SENSITIVE_PATHS,
    specPath: specPath || ".lance-nuit/work-items",
    usTokenBudget: file.usTokenBudget ?? 150_000,
    steps: file.steps ?? {},
    profiles: file.profiles ?? {},
    testSkills: file.testSkills ?? {},
    ...(file.mrCompareUrlTemplate ? { mrCompareUrlTemplate: file.mrCompareUrlTemplate } : {}),
    ...(file.appUrl?.trim() ? { appUrl: file.appUrl.trim().replace(/\/+$/, "") } : {}),
    planAudit: file.planAudit === true,
    ...(stackPreflight ? { stackPreflight } : {}),
  };
}
