import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  return spawnSync(process.execPath, [runnerEntry, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 25_000,
    env: { ...process.env, PIPELINE_HOME: join(cwd, "shared-kit") },
  });
}

/** The reproduction of issue #9: `check` fails and is absorbed, `gate` fails
 *  until `ok` exists. */
function scratchProject() {
  const cwd = mkdtempSync(join(tmpdir(), "absorbed-resume-cli-"));
  scratchRoots.push(cwd);
  mkdirSync(join(cwd, ".lance-nuit", "pipelines"), { recursive: true });
  writeFileSync(
    join(cwd, ".gitignore"),
    "trace.log\nok\n.lance-nuit/run/\n.lance-nuit/work-items/\n.lance-nuit/pipeline-history/\n",
  );
  writeFileSync(
    join(cwd, ".lance-nuit", "pipelines", "absorbed.ts"),
    `export default ({ pipeline, bashStep, textArtifact }: any) => {
  const source = textArtifact("source.txt");
  const report = textArtifact("report.txt");
  return pipeline("absorbed")
    .add(bashStep({ id: "make", name: "make", output: [source],
      command: (ctx: any) => \`mkdir -p "$(dirname '\${ctx.paths.artifact("source.txt")}')" && echo v1 > '\${ctx.paths.artifact("source.txt")}'\` }))
    .add(bashStep({ id: "check", name: "check", input: [source], output: [report], blocking: false,
      command: "echo check >> trace.log && exit 1" }))
    .add(bashStep({ id: "gate", name: "gate", command: "test -f ok" }))
    .build();
};
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

test("an absorbed non-blocking check runs once across a resume", () => {
  const cwd = scratchProject();

  const first = runRunner(cwd, "T-1", "--pipeline", "absorbed");
  expect(first.status).not.toBe(0);
  writeFileSync(join(cwd, "ok"), "");
  const resumed = runRunner(cwd, "T-1", "--pipeline", "absorbed");

  expect(resumed.status).toBe(0);
  expect(trace(cwd)).toEqual(["check"]);
});
