import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { type IncomingHttpHeaders, request } from "node:http";
import { join } from "node:path";
import { AgentBackendRegistry } from "../../contracts/backends.js";
import { createDefaultWorkItemGatewayRegistry } from "../../work-items/providers/registry.ts";
import { RunDetailSchema, RunListSchema } from "../read-model/read-api.schema.ts";
import { cleanupTempDirs, makeProject, makeTempDir, writeProjectsFile, writeRun } from "../read-model/test-harness.js";
import { type RunningUiServer, startUiServer } from "./server.js";
import { reopenSessionCommand } from "./terminals.js";

const sessionCommand = reopenSessionCommand(new AgentBackendRegistry());
const running: RunningUiServer[] = [];

afterEach(async () => {
  for (const server of running.splice(0)) await server.close();
  cleanupTempDirs();
});

const DASHBOARD_ORIGIN = "http://localhost:3000";

/** One listed project with a stopped run and a passed one, served with
 *  `DASHBOARD_ORIGIN` allowed to read the API. */
async function fixture(): Promise<RunningUiServer> {
  const home = makeTempDir("ui-home-");
  const project = makeProject("demo-app");
  writeProjectsFile(home, [project]);
  writeRun(project, "DEMO-1", "feature", {
    runId: "r-stopped",
    status: "STOPPED",
    updatedAt: "2026-09-05T08:00:00.000Z",
    steps: [{ id: "plan", status: "done", retries: 0 }],
    outcome: {
      phase: "review",
      reason: "waiting for the plan",
      logPath: null,
      resumable: true,
      stop: { subject: "plan", kind: "needs-decision", detail: "waiting for the plan" },
    },
  });
  writeRun(project, "DEMO-2", "feature", { runId: "r-pass", status: "PASS", updatedAt: "2026-09-04T08:00:00.000Z" });

  const server = await startUiServer({
    port: 0,
    env: { ...process.env, PIPELINE_HOME: home },
    workItems: createDefaultWorkItemGatewayRegistry(),
    sessionCommand,
    corsOrigins: [DASHBOARD_ORIGIN],
  });
  running.push(server);
  return server;
}

interface RawAnswer {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

/** A request with exactly the headers given: `fetch` will not forge Host, and
 *  a browser's Origin is what the CORS rules read. */
function raw(
  server: RunningUiServer,
  path: string,
  options: { method?: string; headers?: Record<string, string> } = {},
): Promise<RawAnswer> {
  return new Promise((done, fail) => {
    const req = request(
      { host: "127.0.0.1", port: server.port, path, method: options.method ?? "GET", headers: options.headers ?? {} },
      (res) => {
        let body = "";
        res.setEncoding("utf-8");
        res.on("data", (chunk: string) => {
          body += chunk;
        });
        res.on("end", () => done({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", fail);
    req.end();
  });
}

test("read api: the run list answers the published contract, newest first", async () => {
  const server = await fixture();
  const answer = await raw(server, "/api/v1/runs");

  expect(answer.status).toBe(200);
  expect(answer.headers["content-type"]).toBe("application/json; charset=utf-8");
  const list = RunListSchema.parse(JSON.parse(answer.body));
  expect(list.runs.map((run) => run.runId)).toEqual(["r-stopped", "r-pass"]);
  expect(list.runs[0]).toMatchObject({ project: "demo-app", ticket: "DEMO-1", status: "STOPPED", current: true });
});

test("read api: the query string narrows the list, and a bad filter is a 400 naming it", async () => {
  const server = await fixture();
  const ids = async (query: string) =>
    RunListSchema.parse(JSON.parse((await raw(server, `/api/v1/runs?${query}`)).body)).runs.map((run) => run.runId);

  expect(await ids("status=pass")).toEqual(["r-pass"]);
  expect(await ids("status=PASS,STOPPED")).toEqual(["r-stopped", "r-pass"]);
  expect(await ids("status=FAIL&status=PASS")).toEqual(["r-pass"]);
  expect(await ids("ticket=DEMO-1")).toEqual(["r-stopped"]);
  expect(await ids("since=2026-09-05T00:00:00Z")).toEqual(["r-stopped"]);
  expect(await ids("current=true&limit=1")).toEqual(["r-stopped"]);
  expect(await ids("unknown=ignored")).toEqual(["r-stopped", "r-pass"]);

  for (const [query, parameter] of [
    ["status=DONE", "status"],
    ["since=yesterday", "since"],
    ["current=yes", "current"],
    ["limit=0", "limit"],
    ["limit=1001", "limit"],
    ["limit=2.5", "limit"],
  ]) {
    const answer = await raw(server, `/api/v1/runs?${query}`);
    expect(answer.status).toBe(400);
    expect(JSON.parse(answer.body).error).toStartWith(`${parameter}:`);
  }
});

test("read api: one run answers its detail, anything else under /api/v1 is not found", async () => {
  const server = await fixture();
  const answer = await raw(server, "/api/v1/runs/demo-app/DEMO-1/r-stopped");

  expect(answer.status).toBe(200);
  const detail = RunDetailSchema.parse(JSON.parse(answer.body));
  expect(detail.run.runId).toBe("r-stopped");
  expect(detail.steps).toEqual([{ id: "plan", status: "done" }]);

  for (const path of [
    "/api/v1/runs/demo-app/DEMO-1/r-unknown",
    "/api/v1/runs/demo-app/DEMO-1",
    "/api/v1/runs/demo-app/DEMO-1/r-stopped/steps",
    "/api/v1/items",
    "/api/v1",
  ]) {
    expect((await raw(server, path)).status).toBe(404);
  }
  expect((await raw(server, "/api/v1/runs", { method: "POST" })).status).toBe(404);
});

test("cors: only a listed origin may read the answer, and never with credentials", async () => {
  const server = await fixture();

  const allowed = await raw(server, "/api/v1/runs", { headers: { Origin: DASHBOARD_ORIGIN } });
  expect(allowed.status).toBe(200);
  expect(allowed.headers["access-control-allow-origin"]).toBe(DASHBOARD_ORIGIN);
  expect(allowed.headers.vary).toBe("Origin");
  expect(allowed.headers["access-control-allow-credentials"]).toBeUndefined();

  // The answer is the same; only the browser keeps it from the page.
  const other = await raw(server, "/api/v1/runs", { headers: { Origin: "http://evil.example" } });
  expect(other.status).toBe(200);
  expect(other.headers["access-control-allow-origin"]).toBeUndefined();

  const notFound = await raw(server, "/api/v1/runs/demo-app/DEMO-9/r-1", { headers: { Origin: DASHBOARD_ORIGIN } });
  expect(notFound.status).toBe(404);
  expect(notFound.headers["access-control-allow-origin"]).toBe(DASHBOARD_ORIGIN);

  // The dashboard's own API never opens to another origin.
  const items = await raw(server, "/api/items", { headers: { Origin: DASHBOARD_ORIGIN } });
  expect(items.status).toBe(200);
  expect(items.headers["access-control-allow-origin"]).toBeUndefined();
});

test("cors: a preflight is answered for a listed origin under /api/v1 only", async () => {
  const server = await fixture();
  const preflight = (path: string, origin: string) =>
    raw(server, path, {
      method: "OPTIONS",
      headers: { Origin: origin, "Access-Control-Request-Method": "GET" },
    });

  const allowed = await preflight("/api/v1/runs", DASHBOARD_ORIGIN);
  expect(allowed.status).toBe(204);
  expect(allowed.headers["access-control-allow-origin"]).toBe(DASHBOARD_ORIGIN);
  expect(allowed.headers["access-control-allow-methods"]).toBe("GET");
  expect(allowed.headers["access-control-allow-credentials"]).toBeUndefined();

  expect((await preflight("/api/v1/runs", "http://evil.example")).status).toBe(403);
  expect((await preflight("/api/items", DASHBOARD_ORIGIN)).status).toBe(405);
});

test("cors: a listed origin does not lift the Host guard", async () => {
  const server = await fixture();
  const answer = await raw(server, "/api/v1/runs", {
    headers: { Host: `evil.example:${server.port}`, Origin: DASHBOARD_ORIGIN },
  });

  expect(answer.status).toBe(403);
  expect(answer.headers["access-control-allow-origin"]).toBeUndefined();
});

test("cors: an origin that is not one origin stops the server before it touches its files", async () => {
  for (const origin of ["*", "null", "https://dash.example/app", "http://localhost:3000/", "localhost:3000"]) {
    const home = makeTempDir("ui-home-");
    const start = startUiServer({
      port: 0,
      env: { ...process.env, PIPELINE_HOME: home },
      workItems: createDefaultWorkItemGatewayRegistry(),
      sessionCommand,
      corsOrigins: [origin],
    });
    await expect(start).rejects.toThrow("--cors-origin");
    expect(existsSync(join(home, "ui"))).toBe(false);
  }
});

test("cors: origins are compared the way a browser spells them", async () => {
  const home = makeTempDir("ui-home-");
  const server = await startUiServer({
    port: 0,
    env: { ...process.env, PIPELINE_HOME: home },
    workItems: createDefaultWorkItemGatewayRegistry(),
    sessionCommand,
    corsOrigins: [" HTTP://LocalHost:5173 ", "http://[::1]:8080"],
  });
  running.push(server);

  const vite = await raw(server, "/api/v1/runs", { headers: { Origin: "http://localhost:5173" } });
  const ipv6 = await raw(server, "/api/v1/runs", { headers: { Origin: "http://[::1]:8080" } });

  expect(vite.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
  expect(ipv6.headers["access-control-allow-origin"]).toBe("http://[::1]:8080");
});
