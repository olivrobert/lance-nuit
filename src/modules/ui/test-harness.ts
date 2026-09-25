// modules/ui/test-harness.ts
//
// Test doubles for the terminal routes: a tmux runner that keeps its sessions in
// memory, and an attach spawner whose clients are driven by hand. Shared by the
// use-case and the route tests so both exercise the same fake, which answers
// the subcommands `Tmux` issues and nothing else.

import type { AttachedClient, AttachOptions, AttachSpawner } from "./terminal-viewers.js";
import { Tmux, type TmuxResult, type TmuxRunner } from "./tmux.js";

interface FakeSession {
  cwd: string;
  shell: string;
  env: Record<string, string>;
  options: Map<string, string>;
  typed: string[];
}

/** In-memory tmux: every invocation is recorded, sessions live in a map. */
export class FakeTmuxServer {
  readonly calls: string[][] = [];

  readonly sessions = new Map<string, FakeSession>();

  /** When true, every invocation answers as if the binary were absent. */
  missing = false;

  /** Subcommand made to fail once, to exercise the clean-up path. */
  failOn?: string;

  readonly runner: TmuxRunner = async (args) => this.handle(args);

  tmux(socket = "fake"): Tmux {
    return new Tmux({ socket, runner: this.runner });
  }

  /** A session created from outside the dashboard, with no metadata. */
  addForeignSession(name: string): void {
    this.sessions.set(name, { cwd: "/", shell: "/bin/sh", env: {}, options: new Map(), typed: [] });
  }

  private handle(args: string[]): TmuxResult {
    this.calls.push(args);
    if (this.missing) return { status: "missing" };
    const [, , command, ...rest] = args;
    if (command === this.failOn) {
      this.failOn = undefined;
      return fail("injected failure");
    }
    const target = (): FakeSession | undefined => {
      const index = rest.indexOf("-t");
      const name = rest[index + 1]?.replace(/^=/, "").replace(/:$/, "");
      return name === undefined ? undefined : this.sessions.get(name);
    };
    switch (command) {
      case "new-session": {
        const name = rest[rest.indexOf("-s") + 1] as string;
        if (this.sessions.has(name)) return fail(`duplicate session: ${name}`);
        const env: Record<string, string> = {};
        rest.forEach((value, index) => {
          if (rest[index - 1] === "-e") {
            const cut = value.indexOf("=");
            env[value.slice(0, cut)] = value.slice(cut + 1);
          }
        });
        this.sessions.set(name, {
          cwd: rest[rest.indexOf("-c") + 1] as string,
          shell: rest.at(-1) as string,
          env,
          options: new Map(),
          typed: [],
        });
        return ok();
      }
      case "has-session":
        return target() ? ok() : fail("can't find session");
      case "set-option": {
        const session = target();
        if (!session) return fail("no such session");
        session.options.set(rest.at(-2) as string, rest.at(-1) as string);
        return ok();
      }
      case "send-keys": {
        const session = target();
        if (!session) return fail("no such session");
        session.typed.push(rest.includes("-l") ? (rest.at(-1) as string) : `<${rest.at(-1)}>`);
        return ok();
      }
      case "kill-session": {
        const session = target();
        if (!session) return fail("no such session");
        this.sessions.delete(rest[rest.indexOf("-t") + 1]?.replace(/^=/, "") as string);
        return ok();
      }
      case "list-sessions": {
        if (this.sessions.size === 0) return fail("no server running on /tmp/tmux-1000/fake");
        const format = rest[rest.indexOf("-F") + 1] as string;
        const lines = [...this.sessions].map(([name, session]) =>
          format.replace(/#\{([^}]+)\}/g, (_match, key: string) =>
            key === "session_name" ? name : (session.options.get(key) ?? ""),
          ),
        );
        return ok(lines.map((line) => `${line}\n`).join(""));
      }
      default:
        return fail(`unknown command ${command}`);
    }
  }
}

function ok(stdout = ""): TmuxResult {
  return { status: "exited", code: 0, stdout, stderr: "" };
}

function fail(stderr: string): TmuxResult {
  return { status: "exited", code: 1, stdout: "", stderr };
}

/** One client spawned by `FakeAttach`, with what it received. */
export interface FakeClient {
  argv: string[];
  options: AttachOptions;
  written: string[];
  sizes: Array<[number, number]>;
  closed: boolean;
  /** End the client as tmux would when its session goes away. */
  exit(): void;
}

/** Attach spawner whose clients print only what a test makes them print. */
export class FakeAttach {
  readonly clients: FakeClient[] = [];

  readonly spawner: AttachSpawner = (argv, options): AttachedClient => {
    let exited = false;
    const client: FakeClient = {
      argv,
      options,
      written: [],
      sizes: [[options.cols, options.rows]],
      closed: false,
      exit: () => {
        if (exited) return;
        exited = true;
        options.onExit();
      },
    };
    this.clients.push(client);
    return {
      write: (data) => client.written.push(data),
      resize: (cols, rows) => client.sizes.push([cols, rows]),
      close: () => {
        client.closed = true;
        client.exit();
      },
    };
  };
}
