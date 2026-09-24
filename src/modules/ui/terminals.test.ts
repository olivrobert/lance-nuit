import { afterEach, expect, test } from "bun:test";
import { createDefaultWorkItemGatewayRegistry } from "../work-item/registry.ts";
import { cleanupTempDirs, makeProject } from "../read-model/test-harness.js";
import type { Item, ProjectEntry } from "../read-model/index.js";
import { ViewerRegistry } from "./terminal-viewers.js";
import {
  hasClaudeCli,
  isSessionId,
  listTerminals,
  operatorCommand,
  type PaneCommandBuilder,
  paneShell,
  sessionName,
  shellJoin,
  shellQuote,
  type StartRunDeps,
  startRun,
} from "./terminals.js";
import { FakeAttach, FakeTmuxServer } from "./test-harness.js";

afterEach(() => cleanupTempDirs());

const echoCommand: PaneCommandBuilder = (run) => ({ ok: true, words: ["echo", `run ${run.ticket}`] });

function project(): ProjectEntry {
  const cwd = makeProject("demo-app");
  return { name: "demo-app", cwd, provider: "jira", key: "PROJ", specPath: ".lance-nuit/work-items", found: true };
}

function deps(server: FakeTmuxServer, overrides: Partial<StartRunDeps> = {}): StartRunDeps {
  return {
    tmux: server.tmux(),
    workItems: createDefaultWorkItemGatewayRegistry(),
    listPipelines: () => ["default", "feature"],
    findItem: async () => undefined,
    paneCommand: echoCommand,
    shell: "/bin/bash",
    now: () => new Date("2026-09-24T08:00:00.000Z"),
    ...overrides,
  };
}

const request = (entry: ProjectEntry, overrides: Record<string, unknown> = {}) => ({
  project: entry,
  ticket: "PROJ-12",
  pipeline: "feature",
  worktree: true,
  by: "Olivier",
  ...overrides,
});

test("naming: a session name keeps only tmux-safe characters, and ids are checked", () => {
  expect(sessionName("demo.app", "PROJ-12")).toBe("ln-demo_app-PROJ-12");
  expect(isSessionId("ln-demo_app-PROJ-12")).toBe(true);
  expect(isSessionId("ln-a:b")).toBe(false);
  expect(isSessionId("other")).toBe(false);
});

test("quoting: a word with shell syntax stays one word", () => {
  expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  expect(shellJoin(["claude", "--agent", "x", "a b; rm -rf /"])).toBe(`claude --agent x 'a b; rm -rf /'`);
});

test("shell: $SHELL when it is a plain absolute path, bash otherwise", () => {
  expect(paneShell({ SHELL: "/usr/bin/zsh" })).toBe("/usr/bin/zsh");
  expect(paneShell({ SHELL: "zsh" })).toBe("/bin/bash");
  expect(paneShell({ SHELL: "/bin/sh -c evil" })).toBe("/bin/bash");
  expect(paneShell({})).toBe("/bin/bash");
});

test("operator: the claude CLI is looked up on PATH, and the prompt names the run", () => {
  expect(hasClaudeCli(() => null)).toBe(false);
  expect(hasClaudeCli(() => "/usr/local/bin/claude")).toBe(true);

  const built = operatorCommand({ ticket: "PROJ-12", pipeline: "feature", worktree: true });
  if (!hasClaudeCli()) {
    expect(built).toEqual({ ok: false, status: 503, reason: "claude CLI not found" });
    return;
  }
  expect(built).toEqual({
    ok: true,
    words: [
      "claude",
      "--agent",
      "lancenuit-operator",
      "Lance la pipeline : lancenuit run PROJ-12 --pipeline feature --worktree",
    ],
  });
});

test("start: the session runs the shell in the project, then the command is typed and entered", async () => {
  const server = new FakeTmuxServer();
  const entry = project();
  const started = await startRun(request(entry), deps(server));

  expect(started).toEqual({
    ok: true,
    terminal: {
      id: "ln-demo-app-PROJ-12",
      project: "demo-app",
      ticket: "PROJ-12",
      pipeline: "feature",
      worktree: true,
      by: "Olivier",
      createdAt: "2026-09-24T08:00:00.000Z",
      command: "echo 'run PROJ-12'",
      attach: "tmux -L fake attach -t ln-demo-app-PROJ-12",
    },
  });
  const session = server.sessions.get("ln-demo-app-PROJ-12");
  expect(session?.cwd).toBe(entry.cwd);
  expect(session?.shell).toBe("/bin/bash");
  expect(session?.env).toEqual({ LANCENUIT_ACTOR: "Olivier" });
  expect(session?.typed).toEqual(["echo 'run PROJ-12'", "<Enter>"]);
  // Every target is exact, so `ln-demo` never acts on `ln-demo-2`.
  const targets = server.calls.flatMap((call) => call.filter((_, i) => call[i - 1] === "-t"));
  expect(targets.every((value) => value.startsWith("="))).toBe(true);

  const listed = await listTerminals(server.tmux());
  expect(listed).toEqual([started.ok ? started.terminal : (undefined as never)]);
});

test("start: refusals come before any session exists", async () => {
  const entry = project();
  const cases: Array<[Record<string, unknown>, Partial<StartRunDeps>, number]> = [
    [{ ticket: "../x" }, {}, 400],
    [{ ticket: "PROJ" }, {}, 400],
    [{ pipeline: "Nope/x" }, {}, 400],
    [{ pipeline: "deploy" }, {}, 400],
    [{}, { paneCommand: () => ({ ok: false, status: 503, reason: "claude CLI not found" }) }, 503],
    [{}, { findItem: async () => ({ status: "RUNNING" }) as Item }, 409],
  ];
  for (const [overrides, depOverrides, status] of cases) {
    const server = new FakeTmuxServer();
    const result = await startRun(request(entry, overrides), deps(server, depOverrides));
    expect(result.ok ? 0 : result.status).toBe(status);
    expect(server.sessions.size).toBe(0);
  }
});

test("start: no tmux is 503, and an open session is 409 with that terminal", async () => {
  const entry = project();
  const absent = new FakeTmuxServer();
  absent.missing = true;
  expect(await startRun(request(entry), deps(absent))).toEqual({
    ok: false,
    status: 503,
    reason: "tmux is not installed",
  });

  const server = new FakeTmuxServer();
  const first = await startRun(request(entry), deps(server));
  const second = await startRun(request(entry, { pipeline: "default" }), deps(server));
  expect(second.ok).toBe(false);
  if (second.ok || !first.ok) throw new Error("unexpected");
  expect(second.status).toBe(409);
  expect(second.terminal).toEqual(first.terminal);
});

test("start: a session left half-made by a failing tmux call is removed", async () => {
  const server = new FakeTmuxServer();
  server.failOn = "send-keys";
  const result = await startRun(request(project()), deps(server));
  expect(result.ok ? 0 : result.status).toBe(500);
  expect(server.sessions.size).toBe(0);
});

test("list: sessions without our metadata are not terminals", async () => {
  const server = new FakeTmuxServer();
  server.addForeignSession("ln-hand-made");
  expect(await listTerminals(server.tmux())).toEqual([]);
  expect(await listTerminals(new FakeTmuxServer().tmux())).toEqual([]);
});

test("viewers: input and resize need the token of a viewer of that terminal", () => {
  const attach = new FakeAttach();
  const registry = new ViewerRegistry(attach.spawner);
  const exits: string[] = [];
  const opened = registry.open({
    terminal: "ln-a",
    argv: ["tmux", "attach"],
    cols: 80,
    rows: 24,
    onData: () => {},
    onExit: () => exits.push("a"),
  });

  expect(opened.viewer).toMatch(/^[A-Za-z0-9_-]{32}$/);
  expect(registry.input("ln-a", opened.viewer, "ls\r")).toBe(true);
  expect(registry.input("ln-b", opened.viewer, "ls\r")).toBe(false);
  expect(registry.input("ln-a", "guess", "ls\r")).toBe(false);
  expect(registry.resize("ln-a", opened.viewer, 120, 40)).toBe(true);
  expect(attach.clients[0]?.written).toEqual(["ls\r"]);
  expect(attach.clients[0]?.sizes).toEqual([
    [80, 24],
    [120, 40],
  ]);

  opened.close();
  expect(attach.clients[0]?.closed).toBe(true);
  expect(exits).toEqual(["a"]);
  expect(registry.size).toBe(0);
  expect(registry.input("ln-a", opened.viewer, "x")).toBe(false);
});

test("viewers: a client that ends on its own leaves the registry, and closeAll detaches the rest", () => {
  const attach = new FakeAttach();
  const registry = new ViewerRegistry(attach.spawner);
  const open = () =>
    registry.open({ terminal: "ln-a", argv: [], cols: 1, rows: 1, onData: () => {}, onExit: () => {} });
  open();
  open();
  attach.clients[0]?.exit();
  expect(registry.size).toBe(1);
  registry.closeAll();
  expect(registry.size).toBe(0);
  expect(attach.clients[1]?.closed).toBe(true);
});
