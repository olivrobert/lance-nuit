import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, makeTempDir } from "../read-model/test-harness.js";
import { type DashboardHome, openDashboardHome } from "./index.js";

afterEach(() => {
  cleanupTempDirs();
});

function kit(): { home: string; store: DashboardHome } {
  const home = makeTempDir("ui-store-");
  return { home, store: openDashboardHome({ ...process.env, PIPELINE_HOME: home }) };
}

test("dashboard home: a hand-edited users.json that is invalid JSON reads as no users", () => {
  const { home, store } = kit();
  mkdirSync(join(home, "ui"), { recursive: true });
  writeFileSync(join(home, "ui", "users.json"), "{ broken");
  expect(store.users.list()).toEqual([]);
});

test("dashboard home: names are deduplicated and shape-checked", () => {
  const { home, store } = kit();
  mkdirSync(join(home, "ui"), { recursive: true });
  writeFileSync(
    join(home, "ui", "users.json"),
    JSON.stringify({ users: ["Olivier", "Olivier", "", 42, "a;b", "Marie Curie"] }),
  );

  expect(store.users.list()).toEqual(["Olivier", "Marie Curie"]);
  expect(store.users.isKnown("Olivier")).toBe(true);
  expect(store.users.isKnown("a;b")).toBe(false);
  expect(store.users.isKnown(undefined)).toBe(false);
});

test("dashboard home: ensureUiFiles never rewrites a file a human just edited", () => {
  const { home, store } = kit();
  store.users.ensure();
  store.projects.ensure();
  writeFileSync(join(home, "ui", "users.json"), JSON.stringify({ users: ["Olivier"] }));
  store.users.ensure();
  store.projects.ensure();

  expect(store.users.list()).toEqual(["Olivier"]);
});

test("dashboard home: a project write leaves no temporary file behind", () => {
  const { home, store } = kit();
  const project = makeTempDir("ui-project-");

  expect(store.projects.add(project)).toEqual({ status: "ok", paths: [project] });
  expect(readdirSync(join(home, "ui")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  expect(JSON.parse(readFileSync(join(home, "ui", "projects.json"), "utf-8"))).toEqual({
    projects: [{ path: project }],
  });
});

test("dashboard home: adding the same path twice lists it once", () => {
  const { store } = kit();
  const project = makeTempDir("ui-project-");
  store.projects.add(project);
  const second = store.projects.add(project);

  expect(second).toEqual({ status: "ok", paths: [project] });
});

test("dashboard home: a relative path is stored absolute, so the reader and the writer agree", () => {
  const { home, store } = kit();
  store.projects.add(".");
  const stored = JSON.parse(readFileSync(join(home, "ui", "projects.json"), "utf-8")) as {
    projects: Array<{ path: string }>;
  };

  expect(stored.projects[0]?.path).toBe(process.cwd());
});

test("dashboard home: removing an unlisted path is a no-op, not an error", () => {
  const { store } = kit();
  expect(store.projects.remove("/nowhere")).toEqual({ status: "ok", paths: [] });
});
