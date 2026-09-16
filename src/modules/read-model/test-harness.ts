// Fixture builder shared by the read-model tests: a disposable kit home, a
// project tree, and work items whose runs are written exactly as the runner
// writes them (`runs/<pipeline>/<runId>/state.json` plus the `latest` link).

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PersistedRun } from "../../model/persisted.js";
import { sha256Text } from "../../state/hash.js";

export const SPEC_PATH = ".lance-nuit/work-items";

const created: string[] = [];

export function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

export function cleanupTempDirs(): void {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** `~/.lance-nuit/ui/projects.json` as the dashboard writes it. */
export function writeProjectsFile(home: string, paths: string[]): void {
  writeJson(join(home, "ui", "projects.json"), { projects: paths.map((path) => ({ path })) });
}

export interface ProjectConfigOptions {
  provider?: string;
  project?: string;
  baseUrl?: string;
}

export function makeProject(name: string, config: ProjectConfigOptions = {}): string {
  const root = join(makeTempDir("read-model-project-"), name);
  mkdirSync(root, { recursive: true });
  writeJson(join(root, ".lance-nuit", "config.json"), {
    workItem: {
      provider: config.provider ?? "jira",
      project: config.project ?? "PROJ",
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    },
  });
  return root;
}

export function workItemDir(root: string, ticket: string): string {
  return join(root, SPEC_PATH, ticket);
}

export interface RunFixture extends Partial<PersistedRun> {
  runId: string;
}

/** Write one run and point `latest` at it. Writing two runs for the same
 *  pipeline moves the link, exactly as a resume or a `--fresh` run does. */
export function writeRun(root: string, ticket: string, pipeline: string, run: RunFixture): string {
  const pipelineDir = join(workItemDir(root, ticket), "runs", pipeline);
  const runDir = join(pipelineDir, run.runId);
  mkdirSync(runDir, { recursive: true });
  const state: PersistedRun = {
    schemaVersion: 1,
    name: pipeline,
    pipeline,
    ticket,
    steps: [],
    ...run,
  };
  writeJson(join(runDir, "state.json"), state);
  const link = join(pipelineDir, "latest");
  rmSync(link, { force: true });
  symlinkSync(run.runId, link);
  return runDir;
}

export function writeArtifact(root: string, ticket: string, name: string, body: string): void {
  writeWorkItemFile(root, ticket, join("artifacts", name), body);
}

/** Any file of a work item, addressed the way the explorer addresses it. Returns
 *  its absolute path. */
export function writeWorkItemFile(root: string, ticket: string, relativePath: string, body: string): string {
  const path = join(workItemDir(root, ticket), relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  return path;
}

/** The run journal, one JSON object per line, as the runner appends it. */
export function writeRunEvents(runDir: string, events: Record<string, unknown>[]): void {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "events.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
}

/** An approval decision locked to `body`; pass the body the artifact had when it
 *  was approved to build a stale one. */
export function writeDecision(root: string, ticket: string, subject: string, artifact: string, body: string): void {
  writeJson(join(workItemDir(root, ticket), "decisions", `${subject}.json`), {
    schemaVersion: 1,
    decision: "approved",
    subject,
    artifact: `artifacts/${artifact}`,
    artifactSha256: sha256Text(body),
    decidedAt: "2026-09-05T08:00:00.000Z",
    decidedBy: "Olivier",
  });
}

/** One line of the central history, reduced to the fields the read model uses. */
export function writeHistory(root: string, entries: Record<string, unknown>[]): void {
  const path = join(root, ".lance-nuit", "pipeline-history", "runs.jsonl");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}
