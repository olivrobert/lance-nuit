import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createDefaultWorkItemGatewayRegistry } from "../work-item/registry.ts";
import { cleanupTempDirs, makeProject, makeTempDir, writeProjectsFile, writeRun } from "../read-model/test-harness.js";
import { USER_COOKIE } from "./cookies.js";
import { type RunningUiServer, startUiServer, type UiServerOptions } from "./server.js";
import type { PaneCommandBuilder } from "./terminals.js";
import { FakeAttach, FakeTmuxServer } from "./test-harness.js";
import { Tmux } from "./tmux.js";

/** Every server binds port 0, and a real-tmux test uses a socket of its own,
 *  never the dashboard's `lancenuit` one. */
const running: RunningUiServer[] = [];
const sockets: string[] = [];

afterEach(async () => {
  for (const server of running.splice(0)) await server.close();
  for (const socket of sockets.splice(0)) spawnSync("tmux", ["-L", socket, "kill-server"]);
  cleanupTempDirs();
});

const echoCommand: PaneCommandBuilder = (run) => ({ ok: true, words: ["echo", `marker-${run.ticket}`] });

const as = (user: string) => ({ Cookie: `${USER_COOKIE}=${user}`, "Content-Type": "application/json" });

interface Fixture {
  server: RunningUiServer;
  tmux: FakeTmuxServer;
  attach: FakeAttach;
  project: string;
  url(path: string): string;
}

async function fixture(options: Partial<UiServerOptions> = {}): Promise<Fixture> {
  const home = makeTempDir("ui-home-");
  const project = makeProject("demo-app");
  writeProjectsFile(home, [project]);
  mkdirSync(join(home, "ui"), { recursive: true });
  writeFileSync(join(home, "ui", "users.json"), JSON.stringify({ users: ["Olivier"] }));

  const tmux = new FakeTmuxServer();
  const attach = new FakeAttach();
  const server = await startUiServer({
    port: 0,
    env: { ...process.env, PIPELINE_HOME: home, SHELL: "/bin/bash" },
    workItems: createDefaultWorkItemGatewayRegistry(),
    tmux: tmux.tmux(),
    attach: attach.spawner,
    paneCommand: echoCommand,
    listPipelines: () => ["default", "feature"],
    ...options,
  });
  running.push(server);
  return { server, tmux, attach, project, url: (path) => `${server.url}${path}` };
}

function launch(url: (path: string) => string, body: Record<string, unknown> = {}, user = "Olivier") {
  return fetch(url("/api/runs"), {
    method: "POST",
    headers: as(user),
    body: JSON.stringify({ project: "demo-app", ticket: "PROJ-12", pipeline: "feature", worktree: false, ...body }),
  });
}

/** Read SSE events until `until` says stop, or the stream ends. */
async function readEvents(
  response: Response,
  until: (events: Array<{ event: string; data: string }>) => boolean,
  timeoutMs = 5000,
): Promise<Array<{ event: string; data: string }>> {
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const events: Array<{ event: string; data: string }> = [];
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  while (!until(events) && Date.now() < deadline) {
    const chunk = await Promise.race([reader.read(), Bun.sleep(deadline - Date.now()).then(() => undefined)]);
    if (!chunk || chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let cut = buffer.indexOf("\n\n");
    while (cut >= 0) {
      const frame = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const event = /^event: (.*)$/m.exec(frame)?.[1];
      const data = /^data: (.*)$/m.exec(frame)?.[1];
      if (event && data !== undefined) events.push({ event, data });
      cut = buffer.indexOf("\n\n");
    }
  }
  reader.cancel().catch(() => {});
  return events;
}

test("host: an /api request naming another host is refused, as DNS rebinding would", async () => {
  const { server } = await fixture();
  // `fetch` will not forge Host, so the raw request goes through node:http.
  const status = await new Promise<number>((done, fail) => {
    const { request } = require("node:http") as typeof import("node:http");
    const req = request(
      { host: "127.0.0.1", port: server.port, path: "/api/projects", headers: { Host: `evil.example:${server.port}` } },
      (res) => {
        res.resume();
        done(res.statusCode ?? 0);
      },
    );
    req.on("error", fail);
    req.end();
  });
  expect(status).toBe(403);
  expect((await fetch(`http://localhost:${server.port}/api/projects`)).status).toBe(200);
});

test("pipelines: a listed project gets its names, an unknown one is 404", async () => {
  const { url } = await fixture();
  const response = await fetch(url("/api/projects/demo-app/pipelines"));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ pipelines: ["default", "feature"] });
  expect((await fetch(url("/api/projects/nope/pipelines"))).status).toBe(404);
});

test("runs: no identity and cross-origin are 403, before any session", async () => {
  const { url, tmux } = await fixture();
  expect((await launch(url, {}, "Stranger")).status).toBe(403);
  const cross = await fetch(url("/api/runs"), {
    method: "POST",
    headers: { ...as("Olivier"), Origin: "http://evil.example" },
    body: JSON.stringify({ project: "demo-app", ticket: "PROJ-12", pipeline: "feature", worktree: false }),
  });
  expect(cross.status).toBe(403);
  expect(tmux.sessions.size).toBe(0);
});

test("runs: 201 with the terminal, then 409 with the same terminal", async () => {
  const { url, tmux, project } = await fixture();
  const created = await launch(url, { worktree: true });
  expect(created.status).toBe(201);
  const { terminal } = (await created.json()) as { terminal: Record<string, unknown> };
  expect(terminal).toMatchObject({
    id: "ln-demo-app-PROJ-12",
    project: "demo-app",
    ticket: "PROJ-12",
    pipeline: "feature",
    worktree: true,
    by: "Olivier",
    command: "echo marker-PROJ-12",
  });
  expect(tmux.sessions.get("ln-demo-app-PROJ-12")?.cwd).toBe(project);

  const again = await launch(url);
  expect(again.status).toBe(409);
  const body = (await again.json()) as { error: string; terminal: unknown };
  expect(body.error).toContain("already open");
  expect(body.terminal).toEqual(terminal);
});

test("runs: a bad body, ticket or pipeline is 400, an unknown project 404, a busy item 409", async () => {
  const { url, project, tmux } = await fixture();
  expect((await launch(url, { ticket: "PROJ" })).status).toBe(400);
  expect((await launch(url, { pipeline: "deploy" })).status).toBe(400);
  expect((await launch(url, { worktree: "yes" })).status).toBe(400);
  expect((await launch(url, { project: "nope" })).status).toBe(404);

  writeRun(project, "PROJ-7", "feature", { runId: "r-1", status: "RUNNING", steps: [] });
  const busy = await launch(url, { ticket: "PROJ-7" });
  expect(busy.status).toBe(409);
  expect(((await busy.json()) as { error: string }).error).toContain("in progress");
  expect(tmux.sessions.size).toBe(0);
});

test("runs: a builder refusal reaches the reader, tmux missing is 503", async () => {
  const refusing = await fixture({ paneCommand: () => ({ ok: false, status: 503, reason: "claude CLI not found" }) });
  const response = await launch(refusing.url);
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "claude CLI not found" });

  const { url, tmux } = await fixture();
  tmux.missing = true;
  expect((await launch(url)).status).toBe(503);
  expect((await fetch(url("/api/terminals"), { headers: as("Olivier") })).status).toBe(503);
});

test("terminals: listed, read bare, 404 when unknown, and killed", async () => {
  const { url, tmux } = await fixture();
  expect((await fetch(url("/api/terminals"))).status).toBe(403);
  await launch(url);

  const list = (await (await fetch(url("/api/terminals"), { headers: as("Olivier") })).json()) as {
    terminals: Array<{ id: string }>;
  };
  expect(list.terminals.map((entry) => entry.id)).toEqual(["ln-demo-app-PROJ-12"]);

  const one = await fetch(url("/api/terminals/ln-demo-app-PROJ-12"), { headers: as("Olivier") });
  expect(((await one.json()) as { id: string }).id).toBe("ln-demo-app-PROJ-12");
  expect((await fetch(url("/api/terminals/ln-nope"), { headers: as("Olivier") })).status).toBe(404);
  expect((await fetch(url("/api/terminals/not-ours"), { headers: as("Olivier") })).status).toBe(404);

  const killed = await fetch(url("/api/terminals/ln-demo-app-PROJ-12/kill"), {
    method: "POST",
    headers: as("Olivier"),
  });
  expect(killed.status).toBe(204);
  expect(tmux.sessions.size).toBe(0);
  const twice = await fetch(url("/api/terminals/ln-demo-app-PROJ-12/kill"), { method: "POST", headers: as("Olivier") });
  expect(twice.status).toBe(404);
});

test("stream: hello, then data as base64, input and resize through the token, exit at the end", async () => {
  const { url, attach } = await fixture();
  await launch(url);
  const stream = await fetch(url("/api/terminals/ln-demo-app-PROJ-12/stream?cols=100&rows=30"), {
    headers: as("Olivier"),
  });
  expect(stream.status).toBe(200);
  expect(stream.headers.get("content-type")).toContain("text/event-stream");

  const hello = await readEvents(stream.clone(), (events) => events.length >= 1);
  const { viewer } = JSON.parse(hello[0]?.data ?? "{}") as { viewer: string };
  expect(hello[0]?.event).toBe("hello");
  const client = attach.clients[0];
  expect(client?.argv.slice(-2)).toEqual(["-t", "=ln-demo-app-PROJ-12"]);
  expect(client?.sizes[0]).toEqual([100, 30]);

  const post = (path: string, body: unknown) =>
    fetch(url(`/api/terminals/ln-demo-app-PROJ-12/${path}`), {
      method: "POST",
      headers: as("Olivier"),
      body: JSON.stringify(body),
    });
  expect((await post("input", { viewer, data: "ls\r" })).status).toBe(204);
  expect((await post("input", { viewer: "guess", data: "ls\r" })).status).toBe(404);
  expect((await post("resize", { viewer, cols: 120, rows: 40 })).status).toBe(204);
  expect((await post("resize", { viewer, cols: 0, rows: 40 })).status).toBe(400);
  expect(client?.written).toEqual(["ls\r"]);
  expect(client?.sizes.at(-1)).toEqual([120, 40]);

  client?.options.onData(new TextEncoder().encode("h─llo"));
  client?.exit();
  const events = await readEvents(stream, (all) => all.some((event) => event.event === "exit"));
  expect(events.map((event) => event.event)).toEqual(["hello", "data", "exit"]);
  expect(Buffer.from(JSON.parse(events[1]?.data ?? '""') as string, "base64").toString("utf-8")).toBe("h─llo");
});

test("stream: a bad size is 400, and closing the stream detaches the viewer", async () => {
  const { url, attach } = await fixture();
  await launch(url);
  const bad = await fetch(url("/api/terminals/ln-demo-app-PROJ-12/stream?cols=900"), { headers: as("Olivier") });
  expect(bad.status).toBe(400);

  const controller = new AbortController();
  const stream = await fetch(url("/api/terminals/ln-demo-app-PROJ-12/stream"), {
    headers: as("Olivier"),
    signal: controller.signal,
  });
  await readEvents(stream.clone(), (events) => events.length >= 1);
  controller.abort();
  const deadline = Date.now() + 2000;
  while (!attach.clients[0]?.closed && Date.now() < deadline) await Bun.sleep(20);
  expect(attach.clients[0]?.closed).toBe(true);
});

const hasTmux = spawnSync("tmux", ["-V"]).status === 0;

test.skipIf(!hasTmux)("real tmux: the command runs in the pane and the viewer can type into it", async () => {
  const socket = `ln-test-${process.pid}-${Date.now()}`;
  sockets.push(socket);
  const { url } = await fixture({
    tmux: new Tmux({ socket }),
    attach: undefined,
  });

  const created = await launch(url);
  expect(`${created.status} ${await created.text()}`).toStartWith("201");
  const stream = await fetch(url("/api/terminals/ln-demo-app-PROJ-12/stream?cols=80&rows=24"), {
    headers: as("Olivier"),
  });
  const text = (events: Array<{ event: string; data: string }>) =>
    events
      .filter((event) => event.event === "data")
      .map((event) => Buffer.from(JSON.parse(event.data) as string, "base64").toString("utf-8"))
      .join("");

  const reader = stream.clone();
  const first = await readEvents(reader, (events) => text(events).includes("marker-PROJ-12"));
  expect(text(first)).toContain("marker-PROJ-12");
  const { viewer } = JSON.parse(first[0]?.data ?? "{}") as { viewer: string };

  const input = await fetch(url("/api/terminals/ln-demo-app-PROJ-12/input"), {
    method: "POST",
    headers: as("Olivier"),
    body: JSON.stringify({ viewer, data: "echo typed-$((40+2))\r" }),
  });
  expect(input.status).toBe(204);
  const after = await readEvents(stream, (events) => text(events).includes("typed-42"));
  expect(text(after)).toContain("typed-42");

  const actor = spawnSync("tmux", ["-L", socket, "show-environment", "-t", "=ln-demo-app-PROJ-12", "LANCENUIT_ACTOR"]);
  expect(actor.stdout.toString().trim()).toBe("LANCENUIT_ACTOR=Olivier");
});
