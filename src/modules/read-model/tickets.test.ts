import { afterEach, expect, test } from "bun:test";
import { createDefaultWorkItemGatewayRegistry } from "../work-item/registry.ts";
import { readProjects } from "./projects.ts";
import { cleanupTempDirs, makeProject, makeTempDir, writeProjectsFile } from "./test-harness.ts";
import { isTicketToken, validateTicketRef } from "./tickets.ts";

afterEach(() => cleanupTempDirs());

const registry = createDefaultWorkItemGatewayRegistry();

test("tickets: a token is one path segment without separators or dot-dots", () => {
  expect(isTicketToken("DEMO-12")).toBe(true);
  expect(isTicketToken("42")).toBe(true);
  expect(isTicketToken("../DEMO-1")).toBe(false);
  expect(isTicketToken("FOOD/1")).toBe(false);
  expect(isTicketToken("..")).toBe(false);
  expect(isTicketToken("")).toBe(false);
  expect(isTicketToken(12)).toBe(false);
});

test("tickets: the project's provider decides what a reference looks like", () => {
  const home = makeTempDir("read-model-home-");
  const jira = makeProject("demo-app", { provider: "jira" });
  const github = makeProject("site", { provider: "github" });
  writeProjectsFile(home, [jira, github]);
  const [jiraProject, githubProject] = readProjects({ env: { ...process.env, PIPELINE_HOME: home } });
  if (!jiraProject || !githubProject) throw new Error("projects not listed");

  expect(validateTicketRef(jiraProject, "DEMO-12", registry)).toEqual({ ok: true });
  expect(validateTicketRef(jiraProject, "food-12", registry).ok).toBe(false);
  expect(validateTicketRef(jiraProject, "12", registry).ok).toBe(false);
  expect(validateTicketRef(githubProject, "12", registry)).toEqual({ ok: true });
  expect(validateTicketRef(githubProject, "DEMO-12", registry).ok).toBe(false);
});

test("tickets: a project that is gone or whose provider is unknown refuses every reference", () => {
  const home = makeTempDir("read-model-home-");
  const odd = makeProject("odd", { provider: "carrier-pigeon" });
  writeProjectsFile(home, [odd, "/definitely/not/here"]);
  const [oddProject, goneProject] = readProjects({ env: { ...process.env, PIPELINE_HOME: home } });
  if (!oddProject || !goneProject) throw new Error("projects not listed");

  expect(validateTicketRef(oddProject, "DEMO-1", registry).ok).toBe(false);
  expect(validateTicketRef(goneProject, "DEMO-1", registry).ok).toBe(false);
});
