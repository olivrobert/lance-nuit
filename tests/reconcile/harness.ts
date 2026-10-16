// Drives the fictitious `route` pipeline through the real CLI (`src/runner.ts`),
// in a throwaway git repository, so a scenario sees exactly what an operator sees:
// run selection, selectors, resume and verdicts included.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const runnerEntry = resolve(import.meta.dir, "../../src/runner.ts");
const fakeWorkItems = resolve(import.meta.dir, "../../src/modules/work-item/fake.ts");
const RUN_TIMEOUT_MS = 25_000;
const KILL_WAIT_TIMEOUT_MS = 15_000;

export const TICKET = "T-1";
export const PIPELINE = "route";

export interface RouteOptions {
  /** Adds `comment`, a side effect with neither receipt nor `rerunOnResume`. */
  unclassified?: boolean;
  /**
   * Tickets a `--scan` discovers. The steps then sit inside
   * `forEachWorkItem({ queue: "bugTodo", scan })`, whose source step writes each
   * ticket's `ticket.md`, and the tracker is the in-memory gateway of the
   * `--scan` unit tests (`modules/work-item/fake.ts`), registered through an
   * extension module.
   */
  scan?: readonly string[];
}

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Repository → its scratch root (repository, kit home, git config, empty ignore file). */
const scratchRoots = new Map<string, string>();

/**
 * The machine's git config may ignore `.lance-nuit/` or `trace.log`, or install
 * hooks: a scratch global config, with system config off, keeps the machine's
 * settings out of `git status` (the runner's clean tree guard) and the fixture
 * commit. It names an empty `excludesFile` because, without one, git still reads
 * `$XDG_CONFIG_HOME/git/ignore` (or `~/.config/git/ignore`). `LANCENUIT_ACTOR` is
 * dropped for the same reason as in `tests/isolate-actor.ts`.
 */
function isolatedEnv(cwd: string): NodeJS.ProcessEnv {
  const root = scratchRoots.get(cwd);
  if (root === undefined) throw new Error(`${cwd} was not created by scratchRoute`);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PIPELINE_HOME: join(root, "kit-home"),
    GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
  };
  delete env.LANCENUIT_ACTOR;
  return env;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore", env: isolatedEnv(cwd) });
}

/** Source of `.lance-nuit/pipelines/route.ts`. */
export function routeSource(options: RouteOptions = {}): string {
  const comment = options.unclassified ? `\n      step("comment", {}),` : "";
  const steps = `
      step("context", { rerunOnResume: true }),
      step("branch", { output: [branch] }, [branch]),
      step("triage", { input: [ticket], output: [triage] }, [triage]),
      step("plan", { input: [ticket, triage], output: [plan] }, [plan]),
      step("prepare", { rerunOnResume: true }),
      step("implement", { input: [plan], output: [impl] }, [impl]),
      step("quality", { rerunOnResume: true }),
      step("commit", { input: [impl], output: [commit] }, [commit]),
      step("publish", { input: [commit], output: [mr] }, [mr]),${comment}
      step("report", { rerunOnResume: true }),
    `;
  const body = options.scan ? `.forEachWorkItem({ queue: "bugTodo", scan: {}, do: [${steps}] })` : `.add(${steps})`;
  return `import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export default ({ pipeline, actionStep, textArtifact }: any) => {
  const ticket = textArtifact("ticket.md");
  const branch = textArtifact("branch.json");
  const triage = textArtifact("triage.md");
  const plan = textArtifact("plan.md");
  const impl = textArtifact("impl.md");
  const commit = textArtifact("commit.sha");
  const mr = textArtifact("mr-url.txt");

  const step = (id: string, extra: object, produce: any[] = []) =>
    actionStep({
      id,
      name: id,
      describe: id,
      ...extra,
      run: async (ctx: any) => {
        appendFileSync(join(ctx.cwd, "trace.log"), id + "\\n");
        if (existsSync(join(ctx.cwd, "fail-" + id))) throw new Error(id + ": forced failure");
        // A pending promise alone does not keep the event loop alive.
        if (existsSync(join(ctx.cwd, "hang-" + id))) await new Promise(() => setInterval(() => {}, 1_000));
        for (const out of produce) await out.write(ctx, id + " " + Date.now() + "\\n");
      },
    });

  return pipeline("route")
    ${body}
    .build();
};
`;
}

/** Extension module registering the `fake` work-item provider, seeded with the
 *  tickets a `--scan` discovers. */
function scanExtensionSource(tickets: readonly string[]): string {
  const items = tickets.map((ref) => ({ ref, queues: ["bugTodo"], state: "todo" }));
  return `import { createFakeWorkItemGateway } from ${JSON.stringify(fakeWorkItems)};

export default {
  workItems: [{ id: "fake", create: () => createFakeWorkItemGateway({ items: ${JSON.stringify(items)} }) }],
};
`;
}

function workItemDir(cwd: string, ticket: string = TICKET): string {
  return join(cwd, ".lance-nuit", "work-items", ticket);
}

function ticketPath(cwd: string): string {
  return join(workItemDir(cwd), "artifacts", "ticket.md");
}

/** A committed repository holding the `route` pipeline and the `T-1` ticket. */
export function scratchRoute(options: RouteOptions = {}): string {
  const root = mkdtempSync(join(tmpdir(), "reconcile-"));
  const cwd = join(root, "repo");
  scratchRoots.set(cwd, root);
  mkdirSync(join(root, "kit-home"));
  writeFileSync(join(root, "empty-ignore"), "");
  writeFileSync(join(root, "gitconfig"), `[core]\n\texcludesFile = ${join(root, "empty-ignore")}\n`);
  mkdirSync(join(cwd, ".lance-nuit", "pipelines"), { recursive: true });
  writeFileSync(
    join(cwd, ".gitignore"),
    "trace.log\nfail-*\nhang-*\n.lance-nuit/run/\n.lance-nuit/work-items/\n.lance-nuit/pipeline-history/\n",
  );
  writeFileSync(join(cwd, "tracked.txt"), "v1\n");
  writeFileSync(join(cwd, ".lance-nuit", "pipelines", `${PIPELINE}.ts`), routeSource(options));
  mkdirSync(dirname(ticketPath(cwd)), { recursive: true });
  writeFileSync(ticketPath(cwd), "# T-1\n\nRoute the request.\n");
  git(cwd, "init", "-q");
  if (options.scan) {
    // Between tickets, a scan checks out the configured base branch, `main` by default.
    git(cwd, "symbolic-ref", "HEAD", "refs/heads/main");
    writeFileSync(join(cwd, ".lance-nuit", "extensions.mjs"), scanExtensionSource(options.scan));
    writeFileSync(
      join(cwd, ".lance-nuit", "config.json"),
      JSON.stringify({
        workItem: { provider: "fake", project: "T" },
        extensions: { module: "./.lance-nuit/extensions.mjs" },
      }),
    );
  }
  git(cwd, "config", "user.name", "lance-nuit acceptance");
  git(cwd, "config", "user.email", "acceptance@example.invalid");
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "fixture");
  return cwd;
}

/** Removes every scratch repository created so far. */
export function cleanupScratch(): void {
  for (const root of scratchRoots.values()) rmSync(root, { recursive: true, force: true });
  scratchRoots.clear();
}

function runnerArgs(args: readonly string[]): string[] {
  return [runnerEntry, TICKET, "--pipeline", PIPELINE, ...args];
}

/** One runner invocation on `T-1` with the `route` pipeline. */
export function run(cwd: string, ...args: string[]): RunResult {
  return runRaw(cwd, TICKET, "--pipeline", PIPELINE, ...args);
}

/** One runner invocation with exactly `args`: neither a ticket nor a pipeline is added. */
export function runRaw(cwd: string, ...args: string[]): RunResult {
  const result = spawnSync(process.execPath, [runnerEntry, ...args], {
    cwd,
    encoding: "utf8",
    timeout: RUN_TIMEOUT_MS,
    env: isolatedEnv(cwd),
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Ids of the steps whose action actually ran, in order, across invocations. */
export function trace(cwd: string): string[] {
  const path = join(cwd, "trace.log");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean);
}

function latestLink(cwd: string, ticket: string): string {
  return join(workItemDir(cwd, ticket), "runs", PIPELINE, "latest");
}

/** Id of the run `latest` points at. */
export function latestRunId(cwd: string, ticket: string = TICKET): string {
  return readlinkSync(latestLink(cwd, ticket));
}

function latestRunDir(cwd: string, ticket: string): string {
  return join(workItemDir(cwd, ticket), "runs", PIPELINE, latestRunId(cwd, ticket));
}

function journalLines(cwd: string, ticket: string): string[] {
  const path = join(latestRunDir(cwd, ticket), "events.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean);
}

/** How far the trace and the journal of the `latest` run went, so a scenario
 *  reads what the invocations after it added. */
export interface Mark {
  traceLength: number;
  runId?: string;
  journalLength: number;
}

export function mark(cwd: string, ticket: string = TICKET): Mark {
  const traceLength = trace(cwd).length;
  if (!existsSync(latestLink(cwd, ticket))) return { traceLength, journalLength: 0 };
  return { traceLength, runId: latestRunId(cwd, ticket), journalLength: journalLines(cwd, ticket).length };
}

/** Ids of the steps whose action ran since `since`, in order. */
export function traceSince(cwd: string, since: Mark): string[] {
  return trace(cwd).slice(since.traceLength);
}

export interface SkipEvent {
  stepId: string;
  reason: string;
  freshness?: string;
}

/**
 * Why admission skipped steps since `since`: the `step.skipped` events of the
 * `latest` run's journal. When `latest` is a new run since the mark, its whole
 * journal counts.
 */
export function skipsSince(cwd: string, since: Mark, ticket: string = TICKET): SkipEvent[] {
  const sameRun = since.runId !== undefined && since.runId === latestRunId(cwd, ticket);
  return journalLines(cwd, ticket)
    .slice(sameRun ? since.journalLength : 0)
    .map((line) => JSON.parse(line) as SkipEvent & { type?: string })
    .filter((event) => event.type === "step.skipped")
    .map(({ stepId, reason, freshness }) => ({ stepId, reason, ...(freshness ? { freshness } : {}) }));
}

export interface StepSnapshot {
  id: string;
  status: string;
  excluded?: boolean;
  [field: string]: unknown;
}

export interface RunSnapshot {
  status: string;
  steps: StepSnapshot[];
  outcome?: { stop?: { kind?: string; detail?: string }; [field: string]: unknown };
  [field: string]: unknown;
}

/** `state.json` of the `latest` run. */
export function snapshot(cwd: string, ticket: string = TICKET): RunSnapshot {
  const path = join(latestRunDir(cwd, ticket), "state.json");
  return JSON.parse(readFileSync(path, "utf8")) as RunSnapshot;
}

export function failAt(cwd: string, id: string): void {
  writeFileSync(join(cwd, `fail-${id}`), "");
}

export function heal(cwd: string, id: string): void {
  rmSync(join(cwd, `fail-${id}`), { force: true });
}

function occurrences(cwd: string, id: string): number {
  return trace(cwd).filter((traced) => traced === id).length;
}

/**
 * Runs the runner until step `id` starts, then SIGKILLs it: a hard death in the
 * middle of an attempt. The hang marker is removed afterwards so the next
 * invocation can replay the step.
 */
export async function killDuring(cwd: string, id: string, ...args: string[]): Promise<RunResult> {
  const hang = join(cwd, `hang-${id}`);
  // The trace accumulates across invocations: wait for a NEW occurrence of `id`.
  const runsBefore = occurrences(cwd, id);
  writeFileSync(hang, "");
  const child = spawn(process.execPath, runnerArgs(args), { cwd, env: isolatedEnv(cwd) });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise<void>((done) => child.on("close", () => done()));
  try {
    const deadline = Date.now() + KILL_WAIT_TIMEOUT_MS;
    while (occurrences(cwd, id) === runsBefore) {
      if (child.exitCode !== null || child.signalCode !== null || Date.now() > deadline) {
        throw new Error(
          `killDuring: step "${id}" did not start (trace.log: ${trace(cwd).join(",")})\n${stdout}\n${stderr}`,
        );
      }
      await Bun.sleep(20);
    }
  } finally {
    child.kill("SIGKILL");
    await exited;
    rmSync(hang, { force: true });
  }
  return { status: child.exitCode, stdout, stderr };
}

/** Changes the bytes of `ticket.md`, the pure input of `triage` and `plan`. */
export function touchTicket(cwd: string): void {
  appendFileSync(ticketPath(cwd), "\nThe human answered on the ticket.\n");
}

/**
 * Changes a tracked file and commits it: the repository state moves while the
 * tree stays clean, so the runner's clean tree guard still admits a new run.
 */
export function editTracked(cwd: string): void {
  appendFileSync(join(cwd, "tracked.txt"), "edited\n");
  git(cwd, "commit", "-qam", "edit tracked file");
}
