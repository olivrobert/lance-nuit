// End-to-end acceptance of the strict cost accounting stop.
//
// Everything here runs the real CLI in a child process against a real project:
// the only fixture is an agent backend, registered through the ordinary extension
// manifest, that reports a successful turn plus tokens no pricing table covers.
// No paid provider is invoked and no network is touched.
//
// The proof is a shell counter. A step that "did not execute" is not something a
// snapshot can be trusted to say — the file on disk can. Each scenario asserts
// the counter, so an accounting stop that leaked one step of real work would be
// visible as `1` where the test expects `0`.

import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const runnerEntry = resolve(import.meta.dir, "../../src/runner.ts");
setDefaultTimeout(60_000);
const scratchRoots: string[] = [];

afterEach(() => {
  for (const root of scratchRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function runRunner(cwd: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [runnerEntry, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 50_000,
    env: { ...process.env, PIPELINE_HOME: join(cwd, "shared-kit") },
  });
  return { ...result, out: `${result.stdout}${result.stderr}` };
}

function counter(cwd: string): string {
  return readFileSync(join(cwd, ".counter"), "utf8").trim();
}

/** The journal of the run of `pipeline`, as a post-mortem tool would read it:
 *  `events.jsonl` on disk, parsed, with nothing but the run directory known. The
 *  pipeline name is in the path, which is what keeps a composed child's journal
 *  out of its parent's. */
function journalEvents(cwd: string, pipeline: string): Array<Record<string, unknown>> {
  const files = readdirSync(cwd, { recursive: true, encoding: "utf8" }).filter(
    (entry) =>
      entry.endsWith("events.jsonl") &&
      entry.includes(`${pipeline}/`) &&
      // The `latest` symlink points at the run directory the walk already
      // visited; reading both would count every event twice.
      !entry.includes("/latest/"),
  );
  expect(files).toHaveLength(1);
  return readFileSync(join(cwd, files[0]!), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function eventsOfType(cwd: string, pipeline: string, type: string): Array<Record<string, unknown>> {
  return journalEvents(cwd, pipeline).filter((event) => event.type === type);
}

/** The stop kind of the LAST finalization, which is the one describing the
 *  invocation that just ran. */
function lastStopKind(cwd: string, pipeline: string): string | undefined {
  const finished = eventsOfType(cwd, pipeline, "run.finished");
  const outcome = finished.at(-1)?.outcome as { stopKind?: string } | undefined;
  return outcome?.stopKind;
}

/** A backend that reports a successful turn with tokens and no price at all. It
 *  is the shape `splitAttemptStats` normalizes into `cost_unknown`: no table can
 *  cover it, so a capped run that used it can only continue under an explicit
 *  authorization. `ok` is a parameter because the retry/fix scenario needs the
 *  same unpriceable spend on a FAILED attempt. */
const EXTENSIONS = `
const capabilities = {
  structuredOutput: true,
  streaming: false,
  resume: false,
  usageTokens: true,
  cost: "none",
};

function unpriced(id, ok) {
  return {
    id,
    capabilities,
    create() {
      return {
        id,
        capabilities,
        async run() {
          return {
            provider: id,
            output: ok ? "done" : "the command failed",
            ok,
            ...(ok ? {} : { failReason: "unpriced failure", failKind: "technical" }),
            stats: { duration_ms: 1, input_tokens: 1000, output_tokens: 100 },
          };
        },
      };
    },
  };
}

export default { backends: [unpriced("unpriced-ok", true), unpriced("unpriced-fail", false)] };
`;

const COUNT_COMMAND = "n=$(cat .counter); printf '%s\\\\n' $((n + 1)) > .counter";

/** A project whose default pipeline is `pipelineSource`. Extra pipelines are
 *  written next to it so a composed scenario can name a child by path. */
function scratchProject(pipelines: Record<string, string>): string {
  const cwd = mkdtempSync(join(tmpdir(), "strict-cost-cli-"));
  scratchRoots.push(cwd);
  mkdirSync(join(cwd, ".lance-nuit", "pipelines"), { recursive: true });
  writeFileSync(
    join(cwd, ".gitignore"),
    ".counter\n.lance-nuit/run/\n.lance-nuit/work-items/\n.lance-nuit/pipeline-history/\n",
  );
  writeFileSync(join(cwd, ".counter"), "0\n");
  writeFileSync(join(cwd, ".lance-nuit", "extensions.mjs"), EXTENSIONS);
  writeFileSync(
    join(cwd, ".lance-nuit", "config.json"),
    `${JSON.stringify(
      {
        extensions: { module: "./.lance-nuit/extensions.mjs" },
        // `profile-coherence` refuses a step whose profile does not name its
        // backend, so the fixture declares the pair like any real project would.
        profiles: { coder: { backends: { "unpriced-ok": {}, "unpriced-fail": {} } } },
      },
      null,
      2,
    )}\n`,
  );
  for (const [name, source] of Object.entries(pipelines)) {
    writeFileSync(join(cwd, ".lance-nuit", "pipelines", `${name}.ts`), source);
  }
  git(cwd, "init", "-q");
  git(cwd, "config", "user.name", "lance-nuit acceptance");
  git(cwd, "config", "user.email", "acceptance@example.invalid");
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "fixture");
  return cwd;
}

/** Spend at an unknown price, count once, then fail on purpose.
 *
 * The trailing failure is what makes the run resumable AFTER the authorization
 * lifted the accounting stop: a run that reached PASS is replaced by a fresh run
 * on the next invocation, and a fresh run deliberately inherits no
 * authorization. Without it there would be no resume left to prove the
 * authorization persisted. */
const SPEND_COUNT_FAIL = `export default ({ pipeline, llmStep, bashStep }: any) => pipeline("strict-cost")
  .maxCost(5)
  .add(llmStep({ id: "spend", name: "Spend unpriced", profile: "coder", backend: "unpriced-ok", command: "go" }))
  .add(bashStep({ id: "count", name: "Count once", command: "${COUNT_COMMAND}" }))
  .add(bashStep({ id: "stop", name: "Stop here", command: "exit 17" }))
  .build();
`;

test("a capped run stops on unpriceable spend, and only --allow-unmetered lets the next step run", () => {
  const cwd = scratchProject({ default: SPEND_COUNT_FAIL });

  // 1. First run: the agent step spends at an unknown price, so the shell step
  //    that follows is never admitted.
  const first = runRunner(cwd, "COST-1");
  expect(first.status).toBe(1);
  expect(counter(cwd)).toBe("0");
  expect(first.out).toContain("Spending is unaccounted");
  expect(first.out).toContain("--allow-unmetered");
  // The final report gets its own headline and the exact recovery command, not
  // the generic failure wording and not the budget one.
  expect(first.out).toContain("COST UNACCOUNTED");
  expect(first.out).toContain("Spending unaccounted");
  expect(first.out).toContain("lancenuit run COST-1 --pipeline strict-cost --allow-unmetered");
  expect(first.out).not.toContain("Budget exceeded");
  // Never an exact `$0`: the ledger is a floor from the unpriced attempt on.
  expect(first.out).toContain("Budget ≥ $0.00 / $5.00");
  // The console is transient; the journal is what a post-mortem reads. One event
  // for the stop, with the figures the gate decided on, and the typed reason on
  // `run.finished` — no string parsing anywhere.
  expect(eventsOfType(cwd, "strict-cost", "run.cost.unaccounted")).toHaveLength(1);
  expect(eventsOfType(cwd, "strict-cost", "run.cost.unaccounted")[0]).toMatchObject({
    stepId: "count",
    maxCostUsd: 5,
    remainingSteps: 2,
  });
  expect(eventsOfType(cwd, "strict-cost", "run.budget.exceeded")).toHaveLength(0);
  expect(lastStopKind(cwd, "strict-cost")).toBe("cost-unaccounted");

  // 2. A plain resume changes nothing: the uncertainty is latched on the run.
  const plain = runRunner(cwd, "COST-1");
  expect(plain.status).toBe(1);
  expect(counter(cwd)).toBe("0");
  expect(plain.out).toContain("Spending is unaccounted");
  // A new generation took the decision again, so the append-only journal carries
  // a second fact — one per stop, not one per gate that saw it.
  expect(eventsOfType(cwd, "strict-cost", "run.cost.unaccounted")).toHaveLength(2);

  // 3. `--budget` raises the amount and authorizes nothing: no amount prices a
  //    closed attempt.
  const raised = runRunner(cwd, "COST-1", "--budget", "50");
  expect(raised.status).toBe(1);
  expect(counter(cwd)).toBe("0");
  expect(raised.out).toContain("Spending is unaccounted");
  expect(raised.out).toContain("/ $50");
  expect(eventsOfType(cwd, "strict-cost", "run.cost.unaccounted")).toHaveLength(3);
  expect(eventsOfType(cwd, "strict-cost", "run.cost.unaccounted")[2]).toMatchObject({ maxCostUsd: 50 });

  // 4. The explicit authorization runs the pending step — exactly once. The run
  //    still ends red on its last step, which is a failure of its own and reads
  //    as one: the authorization lifted the accounting stop, not the ceiling and
  //    not the pipeline's own verdict.
  const authorized = runRunner(cwd, "COST-1", "--allow-unmetered");
  expect(authorized.status).toBe(1);
  expect(counter(cwd)).toBe("1");
  expect(authorized.out).not.toContain("Spending is unaccounted");
  expect(authorized.out).not.toContain("COST UNACCOUNTED");
  expect(authorized.out).toContain("FAILURE");
  // The lower-bound convention outlives the authorization: it authorizes the
  // unknown spend, it does not make the total exact. The ceiling is the $50 the
  // earlier `--budget` persisted — that flag did move the amount, it just never
  // authorized anything.
  expect(authorized.out).toContain("Budget ≥ $0.00 / $50.00");
  // Nothing was withheld this time: no new event, and the run that ends red for
  // its own reason claims no cost stop.
  expect(eventsOfType(cwd, "strict-cost", "run.cost.unaccounted")).toHaveLength(3);
  expect(lastStopKind(cwd, "strict-cost")).toBeUndefined();

  // 5. And the authorization persisted on the run: a flagless resume neither
  //    stops again nor replays the step it already paid for.
  const again = runRunner(cwd, "COST-1");
  expect(again.status).toBe(1);
  expect(counter(cwd)).toBe("1");
  expect(again.out).not.toContain("Spending is unaccounted");
});

test("a failed unpriceable attempt is not retried, and its repair loop does not resume the run", () => {
  const cwd = scratchProject({
    default: `export default ({ pipeline, llmStep, bashStep }: any) => pipeline("strict-cost-fix")
  .maxCost(5)
  .add(llmStep({
    id: "spend",
    name: "Spend unpriced and fail",
    profile: "coder",
    backend: "unpriced-fail",
    command: "go",
    onFail: { retries: 3, fix: "repair it" },
  }))
  .add(bashStep({ id: "count", name: "Count once", command: "${COUNT_COMMAND}" }))
  .build();
`,
  });

  const first = runRunner(cwd, "COST-2");
  expect(first.status).toBe(1);
  // The retry and fix loops read the same decision as the admission gate: neither
  // repairs its way past an accounting stop, and neither reaches the next step.
  expect(counter(cwd)).toBe("0");
  // Three attempts and a repair prompt were declared; none of them ran. The
  // stop is reported as an accounting stop, not as the technical failure the
  // step also is: relabeling it would send an operator into a fix loop for
  // something no code change repairs.
  expect(first.out).toContain("Spending unaccounted, stopping retries");
  expect(first.out).toContain("COST UNACCOUNTED");
  expect(first.out).toContain("after 0 attempts");
  expect(first.out).not.toContain("Budget exceeded");
  // The retry gate breaks the loop without reporting upward, so the journal and
  // the outcome kind are the only machine-readable trace of what it refused.
  const withheld = eventsOfType(cwd, "strict-cost-fix", "run.cost.unaccounted");
  expect(withheld).toHaveLength(1);
  expect(withheld[0]).toMatchObject({ stepId: "spend", maxCostUsd: 5 });
  expect(lastStopKind(cwd, "strict-cost-fix")).toBe("cost-unaccounted");

  // The stop survives a plain resume, then lifts on the authorization. The step
  // itself still fails on its own merits, so the run stays red — what the
  // authorization proves is that the loop got past the accounting stop and
  // actually replayed the failing step.
  const plain = runRunner(cwd, "COST-2");
  expect(plain.status).toBe(1);
  expect(counter(cwd)).toBe("0");

  const authorized = runRunner(cwd, "COST-2", "--allow-unmetered");
  expect(authorized.status).toBe(1);
  expect(authorized.out).not.toContain("Spending unaccounted, stopping retries");
  expect(authorized.out).not.toContain("COST UNACCOUNTED");
  expect(counter(cwd)).toBe("0");
});

test("a child run's unpriceable spend stops its parent, and the root authorization lifts it", () => {
  const cwd = scratchProject({
    child: `export default ({ pipeline, llmStep }: any) => pipeline("strict-cost-child")
  .add(llmStep({ id: "spend", name: "Spend unpriced", profile: "coder", backend: "unpriced-ok", command: "go" }))
  .build();
`,
    default: `export default ({ pipeline, runPipeline, bashStep }: any) => pipeline("strict-cost-parent")
  .maxCost(5)
  .add(runPipeline({ id: "sub", name: "Sub run", pipeline: "./child.ts" }))
  .add(bashStep({ id: "count", name: "Count once", command: "${COUNT_COMMAND}" }))
  .build();
`,
  });

  // Composed spend counts toward the parent's ledger, uncertainty included: the
  // parent stops on a price only its child failed to establish.
  const first = runRunner(cwd, "COST-3");
  expect(first.status).toBe(1);
  expect(counter(cwd)).toBe("0");
  expect(first.out).toContain("COST UNACCOUNTED");
  expect(first.out).toContain("lancenuit run COST-3 --pipeline strict-cost-parent --allow-unmetered");
  // The stop belongs to the scope that owns the ceiling: it is journaled on the
  // PARENT, whose ledger the child's unpriced spend made unenforceable.
  expect(eventsOfType(cwd, "strict-cost-parent", "run.cost.unaccounted")).toHaveLength(1);
  expect(lastStopKind(cwd, "strict-cost-parent")).toBe("cost-unaccounted");

  const plain = runRunner(cwd, "COST-3");
  expect(plain.status).toBe(1);
  expect(counter(cwd)).toBe("0");

  // The authorization is given to the ROOT and propagates down its budget scope.
  const authorized = runRunner(cwd, "COST-3", "--allow-unmetered");
  expect(authorized.status).toBe(0);
  expect(counter(cwd)).toBe("1");
});
