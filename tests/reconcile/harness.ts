// Drives the fictitious `route` pipeline through the real CLI (`src/runner.ts`),
// in a throwaway git repository, so a scenario sees exactly what an operator sees:
// run selection, selectors, resume and verdicts included.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
  /** Declares `.reconcile()` on the pipeline, between `pipeline("route")` and its steps. */
  reconcile?: boolean;
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
  /**
   * Adds `tree`, a `dsl.source` over the repository state, to the input of
   * `implement` (L4). `"failable"`: its command exits non-zero while
   * `fail-tree` exists (`failAt(cwd, "tree")`). `"output"`: `implement`
   * also declares it as output, which the build refuses. `"written"`:
   * `implement` also edits `tracked.txt`, as an implementation changes the
   * tree it reads; the tree is then dirty after its first pass.
   */
  source?: boolean | "failable" | "output" | "written";
  /**
   * Adds `review` after `plan`: it revises `plan.md` in place
   * (`input: [notes, plan]`, `output: [plan]`), from `notes.md`, which the
   * fixture writes. `"absorbed"`: `review` is `blocking: false`, so its failure
   * is absorbed and the run goes on. `"retried"`: `review` declares
   * `onFail: { retries: 1 }`, and `partialAt(cwd, "review")` applies to its
   * first attempt only, so the retry revises the partial bytes and succeeds.
   */
  review?: boolean | "absorbed" | "retried";
  /** `review` also reads `ticket.md` and `triage.md`: its pure inputs cover
   *  every input of `plan`, the step that produced what it revises. */
  reviewReadsAll?: boolean;
  /** Adds `rbranch` after `branch`: it revises `branch.json` in place from
   *  `notes.md` (`input: [notes, branch]`), so the output it revises comes
   *  from a step without input. `"retried"`: as `review: "retried"`, for `rbranch`. */
  branchReview?: boolean | "retried";
  /** Id of the step producing `plan.md`, `plan` by default: a pipeline that
   *  renamed it. */
  planId?: string;
  /** `plan` declares `plan.md` as input too: the step that produces the output
   *  is also the one revising it, as a step amending its own deliverable does. */
  planRevisesItself?: boolean;
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

const TREE_COMMAND = "git rev-parse HEAD; git diff HEAD --binary";

/** Declaration of `tree`, the external source of `route` (empty without one). */
function treeDeclaration(source: RouteOptions["source"]): string {
  if (!source) return "";
  const command =
    source === "failable"
      ? `test ! -e fail-tree || { echo "tree: forced failure" >&2; exit 1; }; ${TREE_COMMAND}`
      : TREE_COMMAND;
  return `\n  const tree = source("tree", { command: ${JSON.stringify(command)} });`;
}

/** Source of `.lance-nuit/pipelines/route.ts`. */
export function routeSource(options: RouteOptions = {}): string {
  const comment = options.unclassified ? `\n      step("comment", {}),` : "";
  const reviewExtra =
    options.review === "absorbed"
      ? ", blocking: false"
      : options.review === "retried"
        ? ", onFail: { retries: 1 }"
        : "";
  const reviewInput = options.reviewReadsAll ? "[ticket, triage, notes, plan]" : "[notes, plan]";
  const review = options.review
    ? `\n      step("review", { input: ${reviewInput}, output: [plan]${reviewExtra} }, [plan]),`
    : "";
  const branchRetry = options.branchReview === "retried" ? ", onFail: { retries: 1 }" : "";
  const branchReview = options.branchReview
    ? `\n      step("rbranch", { input: [notes, branch], output: [branch]${branchRetry} }, [branch]),`
    : "";
  const planInput = options.planRevisesItself ? "[ticket, triage, plan]" : "[ticket, triage]";
  const retried = [
    ...(options.review === "retried" ? ["review"] : []),
    ...(options.branchReview === "retried" ? ["rbranch"] : []),
  ];
  const partialOnce =
    retried.length > 0
      ? `\n        if (partial && ${JSON.stringify(retried)}.includes(id)) rmSync(join(ctx.cwd, "partial-" + id));`
      : "";
  const notes = options.review || options.branchReview;
  const implementInput = options.source ? "[plan, tree]" : "[plan]";
  const implementOutput = options.source === "output" ? "[impl, tree]" : "[impl]";
  const implementEdits =
    options.source === "written"
      ? `\n        if (id === "implement") appendFileSync(join(ctx.cwd, "tracked.txt"), "implemented " + Date.now() + "\\n");`
      : "";
  const steps = `
      step("context", { rerunOnResume: true }),
      step("branch", { output: [branch] }, [branch]),${branchReview}
      step("triage", { input: [ticket], output: [triage] }, [triage]),
      step(${JSON.stringify(options.planId ?? "plan")}, { input: ${planInput}, output: [plan] }, [plan]),${review}
      step("prepare", { rerunOnResume: true }),
      step("implement", { input: ${implementInput}, output: ${implementOutput} }, [impl]),
      step("quality", { rerunOnResume: true }),
      step("commit", { input: [impl], output: [commit] }, [commit]),
      step("publish", { input: [commit], output: [mr] }, [mr]),${comment}
      step("report", { rerunOnResume: true }),
    `;
  const mode = options.reconcile ? ".reconcile()" : "";
  const body = options.scan ? `.forEachWorkItem({ queue: "bugTodo", scan: {}, do: [${steps}] })` : `.add(${steps})`;
  return `import { appendFileSync, existsSync${retried.length > 0 ? ", rmSync" : ""} } from "node:fs";
import { join } from "node:path";

export default ({ pipeline, actionStep, textArtifact${options.source ? ", source" : ""} }: any) => {
  const ticket = textArtifact("ticket.md");
  const branch = textArtifact("branch.json");
  const triage = textArtifact("triage.md");
  const plan = textArtifact("plan.md");
  const impl = textArtifact("impl.md");
  const commit = textArtifact("commit.sha");
  const mr = textArtifact("mr-url.txt");${notes ? `\n  const notes = textArtifact("notes.md");` : ""}${treeDeclaration(options.source)}

  const step = (id: string, extra: object, produce: any[] = []) =>
    actionStep({
      id,
      name: id,
      describe: id,
      ...extra,
      run: async (ctx: any) => {
        const partial = existsSync(join(ctx.cwd, "partial-" + id));
        const hang = existsSync(join(ctx.cwd, "hang-" + id));
        // Written before the trace line: killDuring kills as soon as it reads the
        // trace, and the partial outputs must already be on disk by then.
        if (partial) for (const out of produce) await out.write(ctx, "partial " + id + "\\n");${partialOnce}
        appendFileSync(join(ctx.cwd, "trace.log"), id + "\\n");
        if (partial && !hang) throw new Error(id + ": failed after a partial write");
        if (existsSync(join(ctx.cwd, "fail-" + id))) throw new Error(id + ": forced failure");
        // A pending promise alone does not keep the event loop alive.
        if (hang) await new Promise(() => setInterval(() => {}, 1_000));${implementEdits}
        for (const out of produce) await out.write(ctx, id + " " + Date.now() + "\\n");
      },
    });

  return pipeline("route")${mode}
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
    "trace.log\nfail-*\nhang-*\npartial-*\n.lance-nuit/run/\n.lance-nuit/work-items/\n.lance-nuit/pipeline-history/\n",
  );
  writeFileSync(join(cwd, "tracked.txt"), "v1\n");
  writeFileSync(join(cwd, ".lance-nuit", "pipelines", `${PIPELINE}.ts`), routeSource(options));
  mkdirSync(dirname(ticketPath(cwd)), { recursive: true });
  writeFileSync(ticketPath(cwd), "# T-1\n\nRoute the request.\n");
  if (options.review || options.branchReview)
    writeFileSync(join(dirname(ticketPath(cwd)), "notes.md"), "Review the plan.\n");
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

/** Rewrites and commits the `route` pipeline of `cwd` for `options`: the
 *  definition an operator changed between two invocations. */
export function redefineRoute(cwd: string, options: RouteOptions): void {
  writeFileSync(join(cwd, ".lance-nuit", "pipelines", `${PIPELINE}.ts`), routeSource(options));
  git(cwd, "commit", "-qam", "redefine route");
}

/** Rewrites `notes.md`, the pure input of the revising steps. */
export function touchNotes(cwd: string): void {
  appendFileSync(join(dirname(ticketPath(cwd)), "notes.md"), "Review it again.\n");
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

/**
 * Makes step `id` write every output it declares with the content `partial <id>`,
 * then fail: an attempt that leaves a partial deliverable behind. Combined with
 * `killDuring`, the step writes, then hangs until it is killed.
 */
export function partialAt(cwd: string, id: string): void {
  writeFileSync(join(cwd, `partial-${id}`), "");
}

/** Undoes `failAt` and `partialAt` on step `id`. */
export function heal(cwd: string, id: string): void {
  rmSync(join(cwd, `fail-${id}`), { force: true });
  rmSync(join(cwd, `partial-${id}`), { force: true });
}

function occurrences(cwd: string, id: string): number {
  return trace(cwd).filter((traced) => traced === id).length;
}

/**
 * Runs the runner until step `id` starts, then SIGKILLs it: a hard death in the
 * middle of an attempt. The hang marker is removed afterwards so the next
 * invocation can replay the step.
 */
export function killDuring(cwd: string, id: string, ...args: string[]): Promise<RunResult> {
  return signalDuring("SIGKILL", cwd, id, args);
}

/**
 * Same as `killDuring`, with SIGINT: the operator interrupting the run, which the
 * runner records as `aborted` before it exits.
 */
export function interruptDuring(cwd: string, id: string, ...args: string[]): Promise<RunResult> {
  return signalDuring("SIGINT", cwd, id, args);
}

async function signalDuring(signal: NodeJS.Signals, cwd: string, id: string, args: string[]): Promise<RunResult> {
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
          `${signal} during: step "${id}" did not start (trace.log: ${trace(cwd).join(",")})\n${stdout}\n${stderr}`,
        );
      }
      await Bun.sleep(20);
    }
  } finally {
    child.kill(signal);
    await exited;
    rmSync(hang, { force: true });
  }
  return { status: child.exitCode, stdout, stderr };
}

/** Deletes artifact `name` of `T-1` by hand, as an operator discarding a deliverable would. */
export function removeArtifact(cwd: string, name: string): void {
  const path = join(workItemDir(cwd), "artifacts", name);
  if (!existsSync(path)) throw new Error(`removeArtifact: ${name} does not exist`);
  rmSync(path);
}

/** Changes the bytes of `ticket.md`, the pure input of `triage` and `plan`. */
export function touchTicket(cwd: string): void {
  appendFileSync(ticketPath(cwd), "\nThe human answered on the ticket.\n");
}

/**
 * Changes a tracked file and commits it: the repository state moves while the
 * tree stays clean, so the runner's clean tree guard still admits a new run.
 * `{ commit: false }` leaves the change in the working tree: a new run then
 * needs `--allow-dirty`.
 */
export function editTracked(cwd: string, { commit = true }: { commit?: boolean } = {}): void {
  appendFileSync(join(cwd, "tracked.txt"), "edited\n");
  if (commit) git(cwd, "commit", "-qam", "edit tracked file");
}

/**
 * Replaces the pipelines of the scratch repository with `files` (name → source,
 * under `.lance-nuit/pipelines/`) and commits them, so the clean tree guard
 * still admits a new run.
 */
export function writePipelines(cwd: string, files: Record<string, string>): void {
  for (const [name, source] of Object.entries(files)) {
    writeFileSync(join(cwd, ".lance-nuit", "pipelines", name), source);
  }
  git(cwd, "add", "-f", "-A", ".lance-nuit/pipelines");
  git(cwd, "commit", "-qm", "replace pipelines");
}

/** The provenance record of artifact `name` of `T-1`: the input fingerprints it was produced from. */
export function provenanceInputs(cwd: string, name: string): Record<string, string | null> {
  const path = join(workItemDir(cwd), "artifacts", ".provenance", `${name}.json`);
  return (JSON.parse(readFileSync(path, "utf8")) as { inputs: Record<string, string | null> }).inputs;
}

/** Content of artifact `name` of `T-1`. */
export function readArtifact(cwd: string, name: string): string {
  return readFileSync(join(workItemDir(cwd), "artifacts", name), "utf8");
}

/** Writes artifact `name` of `T-1` by hand, as a step that died mid-write would have left it. */
export function writeArtifact(cwd: string, name: string, content: string): void {
  writeFileSync(join(workItemDir(cwd), "artifacts", name), content);
}

/** Deletes the provenance record of artifact `name` of `T-1`, as an operator keeping a hand repair does. */
export function removeProvenanceRecord(cwd: string, name: string): void {
  rmSync(join(workItemDir(cwd), "artifacts", ".provenance", `${name}.json`));
}

/** Every provenance record of `T-1`, keyed by file name under `.provenance/`. */
export function provenanceRecords(cwd: string): Record<string, Record<string, unknown>> {
  const dir = join(workItemDir(cwd), "artifacts", ".provenance");
  if (!existsSync(dir)) return {};
  return Object.fromEntries(
    readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => [name, JSON.parse(readFileSync(join(dir, name), "utf8")) as Record<string, unknown>]),
  );
}

/** Events of type `type` in the journal of the `latest` run since `since` (whole journal for a new run). */
export function eventsSince(
  cwd: string,
  since: Mark,
  type: string,
  ticket: string = TICKET,
): Record<string, unknown>[] {
  const sameRun = since.runId !== undefined && since.runId === latestRunId(cwd, ticket);
  return journalLines(cwd, ticket)
    .slice(sameRun ? since.journalLength : 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((event) => event.type === type);
}
