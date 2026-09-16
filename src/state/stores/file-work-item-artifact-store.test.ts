import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArtifactRef } from "../../model/artifact-ports.ts";
import { FileWorkItemArtifactStore } from "./file-work-item-artifact-store.ts";

const roots: string[] = [];
const root = (): string => {
  const value = mkdtempSync(join(tmpdir(), "artifact-store-"));
  roots.push(value);
  return value;
};
const store = (cwd: string, ticket: string, ticketDir = ticket) =>
  new FileWorkItemArtifactStore({
    cwd,
    config: { specPath: "work-items" },
    ticket,
    ticketDir,
  });

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

test("file-work-item-artifact-store: validates the integration contract", async () => {
  const cwd = root();
  const parent = store(cwd, "PROJ-1");
  const other = store(cwd, "PROJ-2");
  const subUs = store(cwd, "PROJ-1-01", "PROJ-1/US-01");
  const parentRef = createArtifactRef("PROJ-1", "same.txt");
  const otherRef = createArtifactRef("PROJ-2", "same.txt");
  const subUsRef = createArtifactRef("PROJ-1-01", "same.txt");

  await parent.writeText(parentRef, "parent");
  await other.writeText(otherRef, "other");
  await subUs.writeText(subUsRef, "sub-US");
  expect(await parent.readText(parentRef)).toBe("parent");
  expect(await other.readText(otherRef)).toBe("other");
  expect(await subUs.readText(subUsRef)).toBe("sub-US");
  expect(parent.readText(otherRef)).rejects.toThrow(/outside the current work item/);
  expect(parent.readText(subUsRef)).rejects.toThrow(/outside the current work item/);
  expect(subUs.readText(parentRef)).rejects.toThrow(/outside the current work item/);
});

test("file-work-item-artifact-store: validates the integration contract", async () => {
  const artifacts = store(root(), "PROJ-1");
  const text = createArtifactRef("PROJ-1", "empty.txt");
  const valid = createArtifactRef("PROJ-1", "valid.json");
  const corrupt = createArtifactRef("PROJ-1", "corrupt.json");

  expect(await artifacts.readText(text)).toBeUndefined();
  await artifacts.writeText(text, "");
  expect(await artifacts.readText(text)).toBe("");
  await artifacts.writeText(valid, '{"ok":true}');
  expect(await artifacts.readJson(valid, (value) => value)).toEqual({ ok: true });
  await artifacts.writeText(corrupt, "{ invalid");
  // Truncated JSON (crash mid-write) degrades to "absent" so the pipeline can
  // regenerate the artifact instead of failing every subsequent run.
  expect(await artifacts.readJson(corrupt, (value) => value)).toBeUndefined();
});

test("file-work-item-artifact-store: validates the integration contract", async () => {
  const artifacts = store(root(), "PROJ-1");
  const ref = createArtifactRef("PROJ-1", "reports/result.txt");

  await artifacts.writeText(ref, "ok");
  expect(await artifacts.exists(ref)).toBe(true);
  await artifacts.remove(ref);
  expect(await artifacts.exists(ref)).toBe(false);
  await expect(artifacts.remove(ref)).resolves.toBeUndefined();
  await expect(artifacts.readText({ ticket: "PROJ-1", name: "../state.json" })).rejects.toThrow();
  await expect(artifacts.readText({ ticket: "PROJ-1", name: "/tmp/state.json" })).rejects.toThrow();
});

test("file-work-item-artifact-store: rejects symlinked artifact paths", async () => {
  const cwd = root();
  const outside = root();
  const link = join(cwd, "work-items", "PROJ-1", "artifacts", "link");
  mkdirSync(join(cwd, "work-items", "PROJ-1", "artifacts"), { recursive: true });
  symlinkSync(outside, link, "dir");

  const artifacts = store(cwd, "PROJ-1");
  const ref = createArtifactRef("PROJ-1", "link/escaped.txt");

  await expect(artifacts.writeText(ref, "outside")).rejects.toThrow(/symbolic link/);
  expect(existsSync(join(outside, "escaped.txt"))).toBe(false);
});

test("file-work-item-artifact-store: writes through the shared artifacts link of a worktree run", async () => {
  const cwd = root();
  const shared = join(root(), "artifacts");
  mkdirSync(shared, { recursive: true });
  mkdirSync(join(cwd, "work-items", "PROJ-1"), { recursive: true });
  symlinkSync(shared, join(cwd, "work-items", "PROJ-1", "artifacts"), "dir");

  const artifacts = store(cwd, "PROJ-1");
  const ref = createArtifactRef("PROJ-1", "workflow-version.txt");

  await artifacts.writeText(ref, "shared");
  expect(readFileSync(join(shared, "workflow-version.txt"), "utf-8")).toBe("shared");
  expect(await artifacts.exists(ref)).toBe(true);
  expect(await artifacts.readText(ref)).toBe("shared");
});
