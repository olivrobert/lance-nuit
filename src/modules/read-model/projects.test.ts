import { afterEach, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectsFile, readProjects, ticketUrl, uiDir } from "./projects.ts";
import { cleanupTempDirs, makeProject, makeTempDir, writeProjectsFile } from "./test-harness.ts";

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

test("projects: no file yet means no project, not an error", () => {
  const dir = home();

  expect(uiDir()).toBe(join(dir, "ui"));
  expect(projectsFile()).toBe(join(dir, "ui", "projects.json"));
  expect(readProjects()).toEqual([]);
});

test("projects: name comes from the path, provider and key from the project config", () => {
  const kit = home();
  const project = makeProject("demo-app", {
    provider: "jira",
    project: "FOOD",
    baseUrl: "https://jira.example/browse/",
  });
  writeProjectsFile(kit, [project]);

  const [entry] = readProjects();

  expect(entry.name).toBe("demo-app");
  expect(entry.cwd).toBe(project);
  expect(entry.provider).toBe("jira");
  expect(entry.key).toBe("FOOD");
  expect(entry.specPath).toBe(".lance-nuit/work-items");
  expect(entry.found).toBe(true);
  expect(ticketUrl(entry, "DEMO-123")).toBe("https://jira.example/browse/DEMO-123");
});

test("projects: a path that disappeared stays listed and is reported as not found", () => {
  const kit = home();
  const project = makeProject("gone");
  rmSync(project, { recursive: true, force: true });
  writeProjectsFile(kit, [project]);

  expect(readProjects()).toEqual([
    { name: "gone", cwd: project, provider: "unknown", specPath: ".lance-nuit/work-items", found: false },
  ]);
});

test("projects: duplicates, blanks, and a malformed file never break the list", () => {
  const kit = home();
  const project = makeProject("demo-app");
  writeProjectsFile(kit, [project, project, "   "]);

  expect(readProjects().map((entry) => entry.name)).toEqual(["demo-app"]);

  writeFileSync(join(kit, "ui", "projects.json"), "{ not json");
  expect(readProjects()).toEqual([]);
});

test("projects: a project without a base URL exposes no ticket URL", () => {
  const kit = home();
  writeProjectsFile(kit, [makeProject("demo-app")]);

  const [entry] = readProjects();

  expect(entry.ticketBaseUrl).toBeUndefined();
  expect(ticketUrl(entry, "DEMO-1")).toBeUndefined();
});
