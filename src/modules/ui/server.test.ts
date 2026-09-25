import { afterEach, expect, test } from "bun:test";
import { createDefaultWorkItemGatewayRegistry } from "../work-item/registry.ts";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  cleanupTempDirs,
  makeProject,
  makeTempDir,
  workItemDir,
  writeArtifact,
  writeProjectsFile,
  writeRun,
} from "../read-model/test-harness.js";
import { USER_COOKIE } from "./cookies.js";
import { type RunningUiServer, startUiServer } from "./server.js";

/** Every server in this file binds port 0: the kernel hands out a free port, so
 *  the suite never collides with a real dashboard or with itself. */
const running: RunningUiServer[] = [];

afterEach(async () => {
  for (const server of running.splice(0)) await server.close();
  cleanupTempDirs();
});

interface Fixture {
  home: string;
  project: string;
  server: RunningUiServer;
  url(path: string): string;
}

function declareUsers(home: string, users: string[]): void {
  mkdirSync(join(home, "ui"), { recursive: true });
  writeFileSync(join(home, "ui", "users.json"), `${JSON.stringify({ users }, null, 2)}\n`);
}

/** A disposable kit home, one listed project with one stopped work item, and a
 *  server pointed at that home through `PIPELINE_HOME`. */
async function fixture(options: { users?: string[]; listProject?: boolean } = {}): Promise<Fixture> {
  const home = makeTempDir("ui-home-");
  const project = makeProject("demo-app");
  if (options.listProject !== false) writeProjectsFile(home, [project]);
  declareUsers(home, options.users ?? ["Olivier"]);

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
  writeArtifact(project, "DEMO-1", "plan.md", "# Plan\n\n- [x] step one\n- [ ] step two\n");

  const server = await startUiServer({
    port: 0,
    env: { ...process.env, PIPELINE_HOME: home },
    workItems: createDefaultWorkItemGatewayRegistry(),
  });
  running.push(server);
  return { home, project, server, url: (path: string) => `${server.url}${path}` };
}

test("server: it binds loopback only, on the port the kernel handed out", async () => {
  const { server } = await fixture();
  expect(server.host).toBe("127.0.0.1");
  expect(server.port).toBeGreaterThan(0);
});

test("server: the dashboard files are created empty but valid on first start", async () => {
  const home = makeTempDir("ui-home-");
  const server = await startUiServer({
    port: 0,
    env: { ...process.env, PIPELINE_HOME: home },
    workItems: createDefaultWorkItemGatewayRegistry(),
  });
  running.push(server);

  expect(JSON.parse(readFileSync(join(home, "ui", "users.json"), "utf-8"))).toEqual({ users: [] });
  expect(JSON.parse(readFileSync(join(home, "ui", "projects.json"), "utf-8"))).toEqual({ projects: [] });
});

test("static: the index is served with its MIME type, no-cache, an ETag, and nosniff", async () => {
  const { url } = await fixture();
  const response = await fetch(url("/"));

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(response.headers.get("cache-control")).toBe("no-cache");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("etag")).toMatch(/^"[0-9a-f]{64}"$/);
  expect(await response.text()).toContain("lancenuit");
});

test("static: a matching If-None-Match gets 304 and no body", async () => {
  const { url } = await fixture();
  const first = await fetch(url("/"));
  const etag = first.headers.get("etag") as string;
  await first.text();

  const second = await fetch(url("/"), { headers: { "If-None-Match": etag } });
  expect(second.status).toBe(304);
  expect(second.headers.get("etag")).toBe(etag);
  expect(await second.text()).toBe("");

  const stale = await fetch(url("/"), { headers: { "If-None-Match": '"not-the-tag"' } });
  expect(stale.status).toBe(200);
});

test("static: each asset gets its own MIME type from the hand-written table", async () => {
  const { url } = await fixture();
  expect((await fetch(url("/app.css"))).headers.get("content-type")).toBe("text/css; charset=utf-8");
  expect((await fetch(url("/app.js"))).headers.get("content-type")).toBe("text/javascript; charset=utf-8");
});

test("static: an unknown asset and an escaping path never leave the asset directory", async () => {
  const { url } = await fixture();
  expect((await fetch(url("/nope.css"))).status).toBe(404);
  // An encoded traversal segment survives URL normalization; it is refused as a
  // name that matches no asset.
  expect((await fetch(url("/%2e%2e/package.json"))).status).toBe(404);
  // An encoded separator would smuggle a second segment past the split, so the
  // request is rejected as malformed before any path is built.
  expect((await fetch(url("/%2e%2e%2fpackage.json"))).status).toBe(400);
});

test("static: a POST to a static path is refused as a method, not served", async () => {
  const { url } = await fixture();
  expect((await fetch(url("/app.css"), { method: "POST" })).status).toBe(405);
});

test("identity: no cookie yet means no user, and the declared names are offered", async () => {
  const { url } = await fixture({ users: ["Olivier", "Marie"] });
  const response = await fetch(url("/api/me"));

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ user: null, users: ["Olivier", "Marie"] });
});

test("identity: choosing a declared name sets the cookie, and the cookie is read back", async () => {
  const { url } = await fixture();
  const chosen = await fetch(url("/api/me"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user: "Olivier" }),
  });

  expect(chosen.status).toBe(200);
  const header = chosen.headers.get("set-cookie") as string;
  expect(header).toContain(`${USER_COOKIE}=Olivier`);
  expect(header).toContain("HttpOnly");
  expect(header).toContain("SameSite=Strict");

  const me = await fetch(url("/api/me"), { headers: { Cookie: `${USER_COOKIE}=Olivier` } });
  expect(me.status).toBe(200);
  expect(await me.json()).toMatchObject({ user: "Olivier" });
});

test("identity: a name outside the list is refused with 401", async () => {
  const { url } = await fixture({ users: ["Olivier"] });
  const posted = await fetch(url("/api/me"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user: "Mallory" }),
  });

  expect(posted.status).toBe(401);
  expect(await posted.json()).toMatchObject({ user: null, error: "unknown user" });
});

test("identity: a cookie naming someone who left the list is refused and cleared", async () => {
  const { url } = await fixture({ users: ["Olivier"] });
  const response = await fetch(url("/api/me"), { headers: { Cookie: `${USER_COOKIE}=Gone` } });

  expect(response.status).toBe(401);
  expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
});

test("api: the morning box lists the fixture item", async () => {
  const { url } = await fixture();
  const response = await fetch(url("/api/items"));

  expect(response.status).toBe(200);
  const body = (await response.json()) as { items: Array<{ key: string; group: string; stop?: { subject?: string } }> };
  expect(body.items).toHaveLength(1);
  expect(body.items[0]?.key).toBe("demo-app/DEMO-1");
  expect(body.items[0]?.group).toBe("decision");
  expect(body.items[0]?.stop?.subject).toBe("plan");
});

test("api: one item carries its tree, its steps, and its recap", async () => {
  const { url } = await fixture();
  const response = await fetch(url("/api/items/demo-app/DEMO-1"));

  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    item: { ticket: string };
    tree: { gatePath?: string } | null;
    steps: { steps: Array<{ id: string }> } | null;
    recap: { runId: string; steps: Array<{ id: string }> } | null;
  };
  expect(body.item.ticket).toBe("DEMO-1");
  expect(body.tree?.gatePath).toBe("artifacts/plan.md");
  expect(body.steps?.steps.map((step) => step.id)).toEqual(["plan"]);
  expect(body.recap?.runId).toBe("r-stopped");
  expect(body.recap?.steps.map((step) => step.id)).toEqual(["plan"]);
});

test("api: an unknown project or ticket is 404, never a filesystem lookup", async () => {
  const { url } = await fixture();
  expect((await fetch(url("/api/items/unknown/DEMO-1"))).status).toBe(404);
  expect((await fetch(url("/api/items/demo-app/NOPE-9"))).status).toBe(404);
});

test("api: a markdown file comes back as text, and as HTML on request", async () => {
  const { url } = await fixture();
  const raw = await fetch(url("/api/items/demo-app/DEMO-1/file?path=artifacts/plan.md"));
  expect(raw.status).toBe(200);
  const rawBody = (await raw.json()) as { content: string; html?: string };
  expect(rawBody.content).toContain("# Plan");
  expect(rawBody.html).toBeUndefined();

  const rendered = await fetch(url("/api/items/demo-app/DEMO-1/file?path=artifacts/plan.md&render=html"));
  const body = (await rendered.json()) as { html: string };
  expect(body.html).toContain("<h1>Plan</h1>");
  expect(body.html).toContain('<input type="checkbox" disabled checked>');
});

test("api: a traversing file path is refused with 403", async () => {
  const { url } = await fixture();
  const response = await fetch(url("/api/items/demo-app/DEMO-1/file?path=../../../../etc/passwd"));

  expect(response.status).toBe(403);
  expect((await response.json()) as { error: string }).toMatchObject({ error: expect.any(String) });
});

test("api: a missing file is 404 and a missing `path` is 400", async () => {
  const { url } = await fixture();
  expect((await fetch(url("/api/items/demo-app/DEMO-1/file?path=artifacts/absent.md"))).status).toBe(404);
  expect((await fetch(url("/api/items/demo-app/DEMO-1/file"))).status).toBe(400);
});

test("api: an image comes back as raw bytes; anything else is refused", async () => {
  const { project, url } = await fixture();
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  writeFileSync(join(workItemDir(project, "DEMO-1"), "artifacts", "shot.png"), png);

  const image = await fetch(url("/api/items/demo-app/DEMO-1/raw?path=artifacts/shot.png"));
  expect(image.status).toBe(200);
  expect(image.headers.get("content-type")).toBe("image/png");
  expect(image.headers.get("x-content-type-options")).toBe("nosniff");
  expect(Buffer.from(await image.arrayBuffer()).equals(png)).toBe(true);

  expect((await fetch(url("/api/items/demo-app/DEMO-1/raw?path=artifacts/plan.md"))).status).toBe(403);
  expect((await fetch(url("/api/items/demo-app/DEMO-1/raw?path=../../../../etc/passwd"))).status).toBe(403);
  expect((await fetch(url("/api/items/demo-app/DEMO-1/raw?path=artifacts/absent.png"))).status).toBe(404);
  expect((await fetch(url("/api/items/demo-app/DEMO-1/raw"))).status).toBe(400);
});

test("projects: adding one writes projects.json and shows up in the list", async () => {
  const { home, url } = await fixture({ listProject: false });
  const added = makeProject("other");

  const response = await fetch(url("/api/projects"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `${USER_COOKIE}=Olivier` },
    body: JSON.stringify({ action: "add", path: added }),
  });

  expect(response.status).toBe(200);
  expect(JSON.parse(readFileSync(join(home, "ui", "projects.json"), "utf-8"))).toEqual({
    projects: [{ path: added }],
  });
  const listed = (await response.json()) as { projects: Array<{ name: string; found: boolean }> };
  expect(listed.projects).toEqual([expect.objectContaining({ name: "other", found: true })]);
});

test("projects: removing one drops it, and removing it twice is not an error", async () => {
  const { home, project, url } = await fixture();
  const remove = async (): Promise<number> =>
    (
      await fetch(url("/api/projects"), {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: `${USER_COOKIE}=Olivier` },
        body: JSON.stringify({ action: "remove", path: project }),
      })
    ).status;

  expect(await remove()).toBe(200);
  expect(JSON.parse(readFileSync(join(home, "ui", "projects.json"), "utf-8"))).toEqual({ projects: [] });
  expect(await remove()).toBe(200);
});

test("projects: a path that is not a directory is refused with 400", async () => {
  const { url } = await fixture();
  const response = await fetch(url("/api/projects"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `${USER_COOKIE}=Olivier` },
    body: JSON.stringify({ action: "add", path: "/definitely/not/here" }),
  });

  expect(response.status).toBe(400);
});

test("projects: changing the list without an identity is refused with 403", async () => {
  const { url } = await fixture();
  const response = await fetch(url("/api/projects"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "add", path: "/tmp" }),
  });

  expect(response.status).toBe(403);
});

test("security: a POST from another origin is refused before it is read", async () => {
  const { url } = await fixture();
  const response = await fetch(url("/api/me"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://evil.test" },
    body: JSON.stringify({ user: "Olivier" }),
  });

  expect(response.status).toBe(403);
  expect(response.headers.get("set-cookie")).toBeNull();
});

test("security: a cross-site fetch is refused even without an Origin header", async () => {
  const { url } = await fixture();
  const response = await fetch(url("/api/me"), {
    method: "POST",
    headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site" },
    body: JSON.stringify({ user: "Olivier" }),
  });

  expect(response.status).toBe(403);
});

// ───────────────────────── actions ─────────────────────────

/** A stand-in for `bin/lancenuit` that records what it received and exits. */
function fakeLauncher(): string {
  const path = join(makeTempDir("ui-bin-"), "fake-lancenuit");
  writeFileSync(
    path,
    ["#!/usr/bin/env bash", 'echo "argv: $*"', 'echo "actor: $LANCENUIT_ACTOR"', 'exit "$FAKE_EXIT"', ""].join("\n"),
  );
  chmodSync(path, 0o755);
  return path;
}

async function actionFixture(options: { fakeExit?: string } = {}): Promise<Fixture & { launcher: string }> {
  const home = makeTempDir("ui-home-");
  const project = makeProject("demo-app");
  writeProjectsFile(home, [project]);
  declareUsers(home, ["Olivier"]);
  writeRun(project, "DEMO-1", "feature", {
    runId: "r-stopped",
    status: "STOPPED",
    worktree: true,
    updatedAt: "2026-09-05T08:00:00.000Z",
    outcome: {
      phase: "review",
      reason: "waiting for the plan",
      logPath: null,
      resumable: true,
      stop: { subject: "plan", kind: "needs-decision", detail: "waiting for the plan" },
    },
  });
  writeRun(project, "DEMO-2", "feature", { runId: "r-running", status: "RUNNING" });

  const launcher = fakeLauncher();
  const env = { ...process.env, PIPELINE_HOME: home, FAKE_EXIT: options.fakeExit ?? "0" };
  const server = await startUiServer({ port: 0, env, launcher, workItems: createDefaultWorkItemGatewayRegistry() });
  running.push(server);
  return { home, project, server, launcher, url: (path: string) => `${server.url}${path}` };
}

function post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `${USER_COOKIE}=Olivier`, ...headers },
    body: JSON.stringify(body),
  });
}

async function waitForExit(path: string): Promise<{ exitCode?: number | null }> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const record = JSON.parse(readFileSync(path, "utf-8")) as { exitCode?: number | null };
    if (record.exitCode !== undefined) return record;
    if (Date.now() > deadline) throw new Error("launch never finished");
    await new Promise((done) => setTimeout(done, 25));
  }
}

test("actions: approve and rerun spawns the runner with the run's argv and records the launch", async () => {
  const { home, url } = await actionFixture();
  const response = await post(url("/api/actions/approve-and-rerun"), {
    project: "demo-app",
    ticket: "DEMO-1",
    pipeline: "feature",
    runId: "r-stopped",
    subject: "plan",
  });

  expect(response.status).toBe(202);
  const { launch } = (await response.json()) as { launch: { id: string; argv: string[]; by: string } };
  expect(launch.by).toBe("Olivier");
  expect(launch.argv).toEqual(["run", "DEMO-1", "--pipeline", "feature", "--approve", "plan", "--worktree"]);

  const dir = join(home, "ui", "launches");
  const record = await waitForExit(join(dir, `${launch.id}.json`));
  expect(record.exitCode).toBe(0);
  expect(readFileSync(join(dir, `${launch.id}.log`), "utf-8")).toContain("actor: Olivier");

  const listed = await fetch(url("/api/launches?item=demo-app/DEMO-1"));
  expect(listed.status).toBe(200);
  const body = (await listed.json()) as { launches: Array<{ id: string }> };
  expect(body.launches.map((entry) => entry.id)).toEqual([launch.id]);

  const tail = await fetch(url(`/api/launches/${launch.id}/log?lines=5`));
  expect(tail.status).toBe(200);
  expect(((await tail.json()) as { lines: string[] }).lines.join("\n")).toContain("argv: run DEMO-1");
});

test("actions: a launch that fails before any run is recorded with its exit code", async () => {
  const { home, url } = await actionFixture({ fakeExit: "2" });
  const response = await post(url("/api/actions/fresh"), { project: "demo-app", ticket: "DEMO-1" });
  expect(response.status).toBe(202);
  const { launch } = (await response.json()) as { launch: { id: string } };
  const record = await waitForExit(join(home, "ui", "launches", `${launch.id}.json`));
  expect(record.exitCode).toBe(2);

  const item = await fetch(url("/api/items/demo-app/DEMO-1"));
  const body = (await item.json()) as { item: { launch?: { exitCode?: number | null; alive: boolean } } };
  expect(body.item.launch).toMatchObject({ exitCode: 2, alive: false });
});

test("actions: every rule of spec 5.3 refuses before a process exists", async () => {
  const { home, url } = await actionFixture();
  const cases: Array<[string, Record<string, unknown>, Record<string, string>, number]> = [
    ["approve", { project: "demo-app", ticket: "DEMO-1", subject: "plan" }, { Cookie: "" }, 403],
    ["approve", { project: "demo-app", ticket: "DEMO-1", subject: "plan" }, { Origin: "http://evil.test" }, 403],
    ["approve", { project: "demo-app", ticket: "DEMO-1", subject: "plan" }, { "Sec-Fetch-Site": "cross-site" }, 403],
    ["deploy", { project: "demo-app", ticket: "DEMO-1" }, {}, 404],
    ["approve", { project: "other", ticket: "DEMO-1", subject: "plan" }, {}, 404],
    ["approve", { project: "demo-app", ticket: "food-1", subject: "plan" }, {}, 400],
    ["approve", { project: "demo-app", ticket: "../DEMO-1", subject: "plan" }, {}, 400],
    ["approve", { project: "demo-app", ticket: "DEMO-9", subject: "plan" }, {}, 404],
    ["approve", { project: "demo-app", ticket: "DEMO-1", subject: "spec" }, {}, 400],
    ["approve", { project: "demo-app", ticket: "DEMO-1", subject: "plan", pipeline: "bugfix" }, {}, 409],
    ["approve", { project: "demo-app", ticket: "DEMO-1", subject: "plan", runId: "r-old" }, {}, 409],
    ["budget", { project: "demo-app", ticket: "DEMO-1", budget: -5 }, {}, 409],
    ["rerun", { project: "demo-app", ticket: "DEMO-2" }, {}, 409],
    ["fresh", { project: "demo-app", ticket: "DEMO-2" }, {}, 409],
  ];
  for (const [verb, body, headers, status] of cases) {
    const response = await post(url(`/api/actions/${verb}`), body, headers);
    expect([verb, JSON.stringify(body), JSON.stringify(headers), response.status]).toEqual([
      verb,
      JSON.stringify(body),
      JSON.stringify(headers),
      status,
    ]);
  }
  expect(existsSync(join(home, "ui", "launches"))).toBe(false);
});

test("actions: GET on the action route and a malformed launches query are refused", async () => {
  const { url } = await actionFixture();
  expect((await fetch(url("/api/actions/rerun"))).status).toBe(404);
  expect((await fetch(url("/api/launches"))).status).toBe(400);
  expect((await fetch(url("/api/launches?item=demo-app"))).status).toBe(400);
  expect((await fetch(url("/api/launches/nope/log"))).status).toBe(404);
  expect((await fetch(url("/api/launches/..%2Fusers/log"))).status).toBe(400);
});

test("routes: an unknown API path is 404", async () => {
  const { url } = await fixture();
  expect((await fetch(url("/api/nope"))).status).toBe(404);
});

test("server: closing it twice is safe, which is what Ctrl+C twice does", async () => {
  const { server } = await fixture();
  await server.close();
  await server.close();
});
