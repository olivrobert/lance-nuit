import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, makeTempDir } from "../read-model/test-harness.js";
import { addProject, ensureUiFiles, isKnownUser, readUsers, removeProject } from "./store.js";

afterEach(() => {
  cleanupTempDirs();
});

function kit(): { home: string; env: NodeJS.ProcessEnv } {
  const home = makeTempDir("ui-store-");
  return { home, env: { ...process.env, PIPELINE_HOME: home } };
}

test("store: a hand-edited users.json that is invalid JSON reads as no users", () => {
  const { home, env } = kit();
  mkdirSync(join(home, "ui"), { recursive: true });
  writeFileSync(join(home, "ui", "users.json"), "{ broken");
  expect(readUsers(env)).toEqual([]);
});

test("store: names are deduplicated and shape-checked", () => {
  const { home, env } = kit();
  mkdirSync(join(home, "ui"), { recursive: true });
  writeFileSync(
    join(home, "ui", "users.json"),
    JSON.stringify({ users: ["Olivier", "Olivier", "", 42, "a;b", "Marie Curie"] }),
  );

  expect(readUsers(env)).toEqual(["Olivier", "Marie Curie"]);
  expect(isKnownUser("Olivier", env)).toBe(true);
  expect(isKnownUser("a;b", env)).toBe(false);
  expect(isKnownUser(undefined, env)).toBe(false);
});

test("store: ensureUiFiles never rewrites a file a human just edited", () => {
  const { home, env } = kit();
  ensureUiFiles(env);
  writeFileSync(join(home, "ui", "users.json"), JSON.stringify({ users: ["Olivier"] }));
  ensureUiFiles(env);

  expect(readUsers(env)).toEqual(["Olivier"]);
});

test("store: a project write leaves no temporary file behind", () => {
  const { home, env } = kit();
  const project = makeTempDir("ui-project-");

  expect(addProject(project, env)).toEqual({ status: "ok", paths: [project] });
  expect(readdirSync(join(home, "ui")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  expect(JSON.parse(readFileSync(join(home, "ui", "projects.json"), "utf-8"))).toEqual({
    projects: [{ path: project }],
  });
});

test("store: adding the same path twice lists it once", () => {
  const { env } = kit();
  const project = makeTempDir("ui-project-");
  addProject(project, env);
  const second = addProject(project, env);

  expect(second).toEqual({ status: "ok", paths: [project] });
});

test("store: a relative path is stored absolute, so the reader and the writer agree", () => {
  const { home, env } = kit();
  addProject(".", env);
  const stored = JSON.parse(readFileSync(join(home, "ui", "projects.json"), "utf-8")) as {
    projects: Array<{ path: string }>;
  };

  expect(stored.projects[0]?.path).toBe(process.cwd());
});

test("store: removing an unlisted path is a no-op, not an error", () => {
  const { env } = kit();
  expect(removeProject("/nowhere", env)).toEqual({ status: "ok", paths: [] });
});
