import { expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import {
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
import { join, resolve } from "node:path";

const runnerEntry = resolve(import.meta.dir, "../../src/runner.ts");
setDefaultTimeout(60_000);

function git(cwd: string, ...args: string[]) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function runRunner(cwd: string, ...args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [runnerEntry, ...args], {
      cwd,
      env: { ...process.env, PIPELINE_HOME: join(cwd, "shared-kit") },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 25_000);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      rejectPromise(err);
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolvePromise({ status, stdout, stderr });
    });
  });
}

/** The reproduction of issue #1: `publish` fails until a manual fix creates `fixed`. */
function scratchProject() {
  const cwd = mkdtempSync(join(tmpdir(), "start-at-cli-"));
  mkdirSync(join(cwd, ".lance-nuit", "pipelines"), { recursive: true });
  writeFileSync(
    join(cwd, ".gitignore"),
    "trace.log\nfixed\n.lance-nuit/run/\n.lance-nuit/work-items/\n.lance-nuit/pipeline-history/\n",
  );
  writeFileSync(
    join(cwd, ".lance-nuit", "pipelines", "default.ts"),
    `// Each step leaves a receipt, so a resume finds the steps already done.
const traced = (bashStep: any, textArtifact: any, id: string, check = "true") =>
  bashStep({
    id,
    name: id,
    output: [textArtifact(id + ".done")],
    command: (ctx: any) => {
      const out = ctx.paths.artifact(id + ".done");
      return "echo " + id + " >> trace.log && " + check + " && mkdir -p '" + out.slice(0, out.lastIndexOf("/")) + "' && touch '" + out + "'";
    },
  });
export default ({ pipeline, bashStep, textArtifact }: any) => pipeline("startat")
  .approval("receipt", textArtifact("implement.done"))
  .add(traced(bashStep, textArtifact, "implement"))
  .add(traced(bashStep, textArtifact, "acceptance"))
  .add(traced(bashStep, textArtifact, "commit"))
  .add(traced(bashStep, textArtifact, "publish", "test -f fixed"))
  .build();
`,
  );
  git(cwd, "init", "-q");
  git(cwd, "config", "user.name", "lance-nuit acceptance");
  git(cwd, "config", "user.email", "acceptance@example.invalid");
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "fixture");
  return cwd;
}

function trace(cwd: string): string[] {
  return readFileSync(join(cwd, "trace.log"), "utf8").trim().split("\n");
}

function latestRunId(cwd: string): string {
  return readlinkSync(join(cwd, ".lance-nuit", "work-items", "T-1", "runs", "startat", "latest"));
}

function runsDir(cwd: string): string {
  return join(cwd, ".lance-nuit", "work-items", "T-1", "runs", "startat");
}

function runDirs(cwd: string): string[] {
  return readdirSync(runsDir(cwd))
    .filter((name) => name !== "latest")
    .sort();
}

function stateOf(cwd: string, runId: string): Record<string, any> {
  return JSON.parse(readFileSync(join(runsDir(cwd), runId, "state.json"), "utf8"));
}

test.concurrent("--start-at forks the failed run: the start step runs, later steps follow the lock, the source is superseded", async () => {
  const cwd = scratchProject();
  try {
    expect((await runRunner(cwd, "T-1")).status).not.toBe(0);
    const source = latestRunId(cwd);
    writeFileSync(join(cwd, "fixed"), "");

    const forked = await runRunner(cwd, "T-1", "--start-at", "acceptance");

    expect(forked.status).toBe(0);
    expect(forked.stderr + forked.stdout).toContain(`Forked from ${source} at acceptance`);
    // `commit` is fresh in the lock: only the failed `publish` runs after the start step.
    expect(trace(cwd)).toEqual(["implement", "acceptance", "commit", "publish", "acceptance", "publish"]);
    const fork = latestRunId(cwd);
    expect(fork).not.toBe(source);
    expect(stateOf(cwd, fork)).toMatchObject({ status: "PASS", forkedFrom: source, startAt: "acceptance" });
    expect(stateOf(cwd, source)).toMatchObject({ status: "SUPERSEDED", supersededBy: fork });

    const superseded = readFileSync(join(runsDir(cwd), source, "state.json"));
    const resumed = await runRunner(cwd, "T-1", "--run", source);
    expect(resumed.status).not.toBe(0);
    expect(resumed.stderr).toContain(`Run ${source} is finished (SUPERSEDED) and is never written again`);
    expect(readFileSync(join(runsDir(cwd), source, "state.json"))).toEqual(superseded);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test.concurrent("--start-at on a PASS run forks a new run and leaves the source's bytes unchanged (F1)", async () => {
  const cwd = scratchProject();
  try {
    writeFileSync(join(cwd, "fixed"), "");
    expect((await runRunner(cwd, "T-1")).status).toBe(0);
    const runId = latestRunId(cwd);
    const before = readFileSync(join(runsDir(cwd), runId, "state.json"));

    const again = await runRunner(cwd, "T-1", "--run", runId, "--start-at", "publish");

    expect(again.status).toBe(0);
    expect(trace(cwd)).toEqual(["implement", "acceptance", "commit", "publish", "publish"]);
    expect(readFileSync(join(runsDir(cwd), runId, "state.json"))).toEqual(before);
    expect(latestRunId(cwd)).not.toBe(runId);
    expect(runDirs(cwd)).toHaveLength(2);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test.concurrent("--start-at forks on a dirty tree: a fork has no clean-tree guard (F6)", async () => {
  const cwd = scratchProject();
  try {
    writeFileSync(join(cwd, "fixed"), "");
    expect((await runRunner(cwd, "T-1")).status).toBe(0);
    writeFileSync(join(cwd, ".gitignore"), "edited by hand\n", { flag: "a" });

    const forked = await runRunner(cwd, "T-1", "--start-at", "publish");

    expect(forked.status).toBe(0);
    expect(trace(cwd).at(-1)).toBe("publish");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test.concurrent("--start-at refusals write nothing: unknown step, stale step before it, no run, older --run (F4)", async () => {
  const cwd = scratchProject();
  try {
    const none = await runRunner(cwd, "T-1", "--start-at", "publish");
    expect(none.status).not.toBe(0);
    expect(none.stderr).toContain("has no run to fork");

    expect((await runRunner(cwd, "T-1")).status).not.toBe(0);
    const older = latestRunId(cwd);
    writeFileSync(join(cwd, "fixed"), "");
    expect((await runRunner(cwd, "T-1", "--start-at", "publish")).status).toBe(0);
    const latest = latestRunId(cwd);
    // The fork passed, so the latest is finished: start a run left unfinished on top of it.
    rmSync(join(cwd, "fixed"));
    writeFileSync(join(cwd, ".lance-nuit", "work-items", "T-1", "artifacts", "publish.done"), "edited");
    expect((await runRunner(cwd, "T-1", "--fresh", "--allow-dirty")).status).not.toBe(0);
    const unfinished = latestRunId(cwd);
    expect(unfinished).not.toBe(latest);
    const dirs = runDirs(cwd);
    const snapshots = dirs.map((dir) => readFileSync(join(runsDir(cwd), dir, "state.json"), "utf8"));
    // Dirty on purpose: the unknown step must be reported before any git check.
    writeFileSync(join(cwd, ".gitignore"), "edited by hand\n", { flag: "a" });

    const typo = await runRunner(cwd, "T-1", "--start-at", "acceptanse", "--approve", "receipt");
    expect(typo.stderr).toContain('--start-at: step "acceptanse" not found');
    expect(existsSync(join(cwd, ".lance-nuit", "work-items", "T-1", "decisions"))).toBe(false);

    const olderFork = await runRunner(cwd, "T-1", "--run", older, "--start-at", "publish");
    expect(olderFork.stderr).toContain(`run ${unfinished} is the latest run`);

    writeFileSync(join(cwd, ".lance-nuit", "work-items", "T-1", "artifacts", "implement.done"), "edited");
    const stale = await runRunner(cwd, "T-1", "--start-at", "publish");
    expect(stale.stderr).toContain('step "implement" is stale');

    for (const refused of [typo, olderFork, stale]) expect(refused.status).not.toBe(0);
    expect(runDirs(cwd)).toEqual(dirs);
    expect(latestRunId(cwd)).toBe(unfinished);
    expect(dirs.map((dir) => readFileSync(join(runsDir(cwd), dir, "state.json"), "utf8"))).toEqual(snapshots);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
