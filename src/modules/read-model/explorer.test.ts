import { afterEach, expect, test } from "bun:test";
import { existsSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  IMAGE_LIMIT_BYTES,
  RAW_IMAGE_LIMIT_BYTES,
  readFile,
  readImage,
  readTree,
  TEXT_LIMIT_BYTES,
} from "./explorer.ts";
import {
  cleanupTempDirs,
  makeProject,
  makeTempDir,
  workItemDir,
  writeArtifact,
  writeDecision,
  writeProjectsFile,
  writeRun,
  writeWorkItemFile,
} from "./test-harness.ts";
import type { TreeNode } from "./types.ts";

const originalHome = process.env.PIPELINE_HOME;

function home(): string {
  const dir = makeTempDir("read-model-home-");
  process.env.PIPELINE_HOME = dir;
  return dir;
}

afterEach(() => {
  if (originalHome === undefined) delete process.env.PIPELINE_HOME;
  else process.env.PIPELINE_HOME = originalHome;
  cleanupTempDirs();
});

function listedProject(name = "demo-app"): string {
  const kit = home();
  const project = makeProject(name);
  writeProjectsFile(kit, [project]);
  return project;
}

/** Every file path of a tree, in walk order. */
function filePaths(nodes: readonly TreeNode[]): string[] {
  return nodes.flatMap((node) => (node.kind === "file" ? [node.path] : filePaths(node.children)));
}

function find(nodes: readonly TreeNode[], path: string): TreeNode | undefined {
  for (const node of nodes) {
    if (node.path === path) return node;
    if (node.kind === "directory") {
      const found = find(node.children, path);
      if (found) return found;
    }
  }
  return undefined;
}

/** A stopped run waiting on `subject`, with the four usual sections filled in. */
function stoppedWorkItem(project: string, ticket: string, subject?: string): string {
  const runDir = writeRun(project, ticket, "feature", {
    runId: "r-1",
    status: "STOPPED",
    updatedAt: "2026-09-05T08:00:00.000Z",
    outcome: {
      phase: "plan",
      reason: "plan needs approval",
      logPath: null,
      resumable: true,
      stop: { ...(subject ? { subject } : {}), kind: "needs-decision", detail: "plan needs approval" },
    },
  });
  writeArtifact(project, ticket, "plan.md", "# plan\n");
  writeWorkItemFile(project, ticket, join("reports", "audit.json"), '{"ok":true}\n');
  writeWorkItemFile(project, ticket, "ticket.md", "# DEMO-1\n");
  return runDir;
}

test("tree: the four sections come first, in reading order, with the run inside", () => {
  const project = listedProject();
  stoppedWorkItem(project, "DEMO-1", "plan");

  const tree = readTree("demo-app", "DEMO-1");

  expect(tree?.root).toBe(workItemDir(project, "DEMO-1"));
  expect(tree?.pipeline).toBe("feature");
  expect(tree?.runId).toBe("r-1");
  expect(filePaths(tree?.children ?? [])).toEqual([
    "artifacts/plan.md",
    "reports/audit.json",
    "runs/feature/r-1/state.json",
    "ticket.md",
  ]);
});

test("tree: a missing section is simply absent, and the `latest` link is never listed", () => {
  const project = listedProject();
  writeRun(project, "DEMO-1", "feature", { runId: "r-1", status: "PASS", updatedAt: "2026-09-05T08:00:00.000Z" });

  const tree = readTree("demo-app", "DEMO-1");

  expect(existsSync(join(workItemDir(project, "DEMO-1"), "runs", "feature", "latest"))).toBe(true);
  expect((tree?.children ?? []).map((node) => node.name)).toEqual(["runs"]);
  expect(filePaths(tree?.children ?? [])).toEqual(["runs/feature/r-1/state.json"]);
});

test("tree: the runner's own bookkeeping stays out of the reader's way", () => {
  const project = listedProject();
  stoppedWorkItem(project, "DEMO-1", "plan");
  writeWorkItemFile(project, "DEMO-1", join("artifacts", ".provenance", "plan.md.json"), "{}\n");

  const tree = readTree("demo-app", "DEMO-1");

  expect(filePaths(tree?.children ?? [])).not.toContain("artifacts/.provenance/plan.md.json");
});

test("tree: the gate artifact is flagged and opened by default", () => {
  const project = listedProject();
  stoppedWorkItem(project, "DEMO-1", "plan");

  const tree = readTree("demo-app", "DEMO-1");
  const gate = find(tree?.children ?? [], "artifacts/plan.md");

  expect(tree?.gatePath).toBe("artifacts/plan.md");
  expect(tree?.defaultPath).toBe("artifacts/plan.md");
  expect(gate).toMatchObject({ kind: "file", gate: true, defaultOpen: true, contentKind: "md", size: 7 });
});

test("tree: a decision names the artifact its subject does not", () => {
  const project = listedProject();
  stoppedWorkItem(project, "DEMO-1", "reuse");
  writeArtifact(project, "DEMO-1", "plan-audit.json", '{"audited":true}\n');
  writeDecision(project, "DEMO-1", "reuse", "plan-audit.json", '{"audited":true}\n');

  const tree = readTree("demo-app", "DEMO-1");

  expect(tree?.gatePath).toBe("artifacts/plan-audit.json");
  expect(find(tree?.children ?? [], "artifacts/plan-audit.json")).toMatchObject({ gate: true, contentKind: "json" });
});

test("tree: a stop with no identifiable artifact flags nothing", () => {
  const project = listedProject();
  stoppedWorkItem(project, "DEMO-1");

  const tree = readTree("demo-app", "DEMO-1");

  expect(tree?.gatePath).toBeUndefined();
  expect(tree?.defaultPath).toBeUndefined();
});

test("tree: a failed run opens on the state of its run", () => {
  const project = listedProject();
  writeRun(project, "DEMO-1", "feature", {
    runId: "r-1",
    status: "FAIL",
    updatedAt: "2026-09-05T08:00:00.000Z",
    outcome: { phase: "tests", reason: "3 tests failed", logPath: null, resumable: true },
  });

  const tree = readTree("demo-app", "DEMO-1");

  expect(tree?.defaultPath).toBe("runs/feature/r-1/state.json");
  expect(find(tree?.children ?? [], "runs/feature/r-1/state.json")).toMatchObject({ defaultOpen: true });
});

test("tree: the runs of a nested work item appear under their parent", () => {
  const project = listedProject();
  writeRun(project, "DEMO-28", "feature", { runId: "r-1", status: "PASS", updatedAt: "2026-09-05T08:00:00.000Z" });
  writeRun(project, join("DEMO-28", "US-01"), "lot", {
    runId: "r-2",
    status: "STOPPED",
    updatedAt: "2026-09-05T09:00:00.000Z",
  });

  const tree = readTree("demo-app", "DEMO-28");

  expect(filePaths(tree?.children ?? [])).toEqual(["runs/feature/r-1/state.json", "US-01/runs/lot/r-2/state.json"]);
});

test("tree: a run directory outside the effective work item is reachable under `run/`", () => {
  const project = listedProject();
  const worktree = join(makeTempDir("read-model-worktree-"), "demo-app");
  writeRun(project, "DEMO-1", "feature", {
    runId: "r-1",
    status: "FAIL",
    updatedAt: "2026-09-05T08:00:00.000Z",
    worktree: true,
    cwd: worktree,
    outcome: { phase: "tests", reason: "3 tests failed", logPath: null, resumable: true },
  });
  writeArtifact(worktree, "DEMO-1", "plan.md", "# plan in the worktree\n");

  const tree = readTree("demo-app", "DEMO-1");

  expect(tree?.root).toBe(workItemDir(worktree, "DEMO-1"));
  expect(filePaths(tree?.children ?? [])).toEqual(["artifacts/plan.md", "run/state.json"]);
  expect(tree?.defaultPath).toBe("run/state.json");
  expect(readFile("demo-app", "DEMO-1", "run/state.json")).toMatchObject({ status: "ok", contentKind: "json" });
  expect(readFile("demo-app", "DEMO-1", "run/../../../etc/passwd").status).toBe("denied");
});

test("tree: an unknown project or work item has no tree", () => {
  const project = listedProject();
  writeRun(project, "DEMO-1", "feature", { runId: "r-1", status: "PASS", updatedAt: "2026-09-05T08:00:00.000Z" });

  expect(readTree("demo-app", "DEMO-404")).toBeUndefined();
  expect(readTree("unknown", "DEMO-1")).toBeUndefined();
});

test("readFile: a text file comes back with its kind and its absolute path", () => {
  const project = listedProject();
  stoppedWorkItem(project, "DEMO-1", "plan");

  const result = readFile("demo-app", "DEMO-1", "artifacts/plan.md");

  expect(result).toMatchObject({
    status: "ok",
    contentKind: "md",
    encoding: "text",
    content: "# plan\n",
    relativePath: "artifacts/plan.md",
  });
  expect(result.status === "ok" && result.path.endsWith(join("artifacts", "plan.md"))).toBe(true);
});

test("readFile: a run journal reads as a log, an image as base64", () => {
  const project = listedProject();
  const runDir = stoppedWorkItem(project, "DEMO-1", "plan");
  writeFileSync(join(runDir, "events.jsonl"), '{"ts":"2026-09-05T08:00:00.000Z","type":"run.started"}\n');
  const png = Buffer.from("89504e470d0a1a0a", "hex");
  writeFileSync(join(workItemDir(project, "DEMO-1"), "reports", "shot.png"), png);

  expect(readFile("demo-app", "DEMO-1", "runs/feature/r-1/events.jsonl")).toMatchObject({
    status: "ok",
    contentKind: "log",
    encoding: "text",
  });
  expect(readFile("demo-app", "DEMO-1", "reports/shot.png")).toMatchObject({
    status: "ok",
    contentKind: "png",
    encoding: "base64",
    content: png.toString("base64"),
  });
});

test("readFile: a traversal is refused, whether spelled with `..` or with a slash", () => {
  const project = listedProject();
  stoppedWorkItem(project, "DEMO-1", "plan");

  expect(readFile("demo-app", "DEMO-1", "../DEMO-2/artifacts/plan.md").status).toBe("denied");
  expect(readFile("demo-app", "DEMO-1", "artifacts/../../../etc/passwd").status).toBe("denied");
  expect(readFile("demo-app", "DEMO-1", join(project, "artifacts", "plan.md")).status).toBe("denied");
});

test("readFile: a symbolic link pointing out of the work item is refused", () => {
  const project = listedProject();
  stoppedWorkItem(project, "DEMO-1", "plan");
  const outside = join(makeTempDir("read-model-outside-"), "secret.md");
  writeFileSync(outside, "not yours\n");
  symlinkSync(outside, join(workItemDir(project, "DEMO-1"), "artifacts", "escape.md"));

  const result = readFile("demo-app", "DEMO-1", "artifacts/escape.md");

  expect(result.status).toBe("denied");
  expect(result.status === "denied" && result.reason).toBe("path resolves outside the work item");
});

test("readFile: past the cap the reader gets the path, not the bytes", () => {
  const project = listedProject();
  stoppedWorkItem(project, "DEMO-1", "plan");
  writeArtifact(project, "DEMO-1", "huge.md", "x".repeat(TEXT_LIMIT_BYTES + 1));
  // The same size is fine for an image, which has its own, larger cap.
  writeFileSync(join(workItemDir(project, "DEMO-1"), "artifacts", "shot.png"), Buffer.alloc(TEXT_LIMIT_BYTES + 1));

  const tooLarge = readFile("demo-app", "DEMO-1", "artifacts/huge.md");

  expect(tooLarge).toMatchObject({ status: "too-large", size: TEXT_LIMIT_BYTES + 1, limit: TEXT_LIMIT_BYTES });
  expect(tooLarge.status === "too-large" && tooLarge.path.endsWith("huge.md")).toBe(true);
  expect(readFile("demo-app", "DEMO-1", "artifacts/shot.png").status).toBe("ok");
  expect(IMAGE_LIMIT_BYTES).toBe(2 * TEXT_LIMIT_BYTES);
});

test("readFile: an absent file, a directory, and an unknown item all read as missing", () => {
  const project = listedProject();
  stoppedWorkItem(project, "DEMO-1", "plan");

  expect(readFile("demo-app", "DEMO-1", "artifacts/nope.md").status).toBe("not-found");
  expect(readFile("demo-app", "DEMO-1", "artifacts").status).toBe("not-found");
  expect(readFile("demo-app", "DEMO-404", "artifacts/plan.md").status).toBe("not-found");
});

test("readImage: an image comes back as bytes with the MIME of its extension", () => {
  const project = listedProject();
  stoppedWorkItem(project, "DEMO-1", "plan");
  const bytes = Buffer.alloc(IMAGE_LIMIT_BYTES + 1, 7);
  writeWorkItemFile(project, "DEMO-1", "reports/screenshots/01-home.jpg", "");
  writeFileSync(join(workItemDir(project, "DEMO-1"), "reports", "screenshots", "01-home.jpg"), bytes);

  const result = readImage("demo-app", "DEMO-1", "reports/screenshots/01-home.jpg");

  // Past the JSON cap: the raw route exists so a screenshot this size still shows.
  expect(result.status).toBe("ok");
  expect(result.status === "ok" && result.mime).toBe("image/jpeg");
  expect(result.status === "ok" && result.bytes.byteLength).toBe(IMAGE_LIMIT_BYTES + 1);
});

test("readImage: a text file, a traversal, and an oversized image are refused", () => {
  const project = listedProject();
  stoppedWorkItem(project, "DEMO-1", "plan");
  writeFileSync(join(workItemDir(project, "DEMO-1"), "artifacts", "huge.png"), Buffer.alloc(RAW_IMAGE_LIMIT_BYTES + 1));

  expect(readImage("demo-app", "DEMO-1", "artifacts/plan.md")).toEqual({ status: "denied", reason: "not an image" });
  expect(readImage("demo-app", "DEMO-1", "../../../etc/passwd").status).toBe("denied");
  expect(readImage("demo-app", "DEMO-1", "artifacts/huge.png")).toEqual({
    status: "denied",
    reason: "image too large",
  });
  expect(readImage("demo-app", "DEMO-1", "artifacts/absent.png").status).toBe("not-found");
});
