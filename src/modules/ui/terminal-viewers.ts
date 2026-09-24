// modules/ui/terminal-viewers.ts
//
// The browser side of a terminal: one tmux client per viewer.
//
// Every open stream spawns its own `tmux attach-session` inside a pseudo-
// terminal and relays that client's output. tmux already knows how to show one
// session to several clients at once — scrollback, redraw, the size of the
// smallest client — so nothing here multiplexes; closing a viewer detaches ONE
// client and never touches the session.
//
// Two rules shape this module.
//
// First, a viewer is addressed by an unguessable token handed out on the stream
// and required by input and resize. Knowing a session id, which the attach
// command displays, is not enough to type into it.
//
// Second, every viewer's client is closed when its stream closes. A client left
// behind holds a PTY and a process for nothing, and keeps the session at its
// size; `closeAll` is what the server calls when it stops.

import { randomBytes } from "node:crypto";
import { tmuxClientEnv } from "./tmux.js";

/** One attached client, as the registry needs it. */
export interface AttachedClient {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** Detach: end the client. `onExit` still fires once it is gone. */
  close(): void;
}

export interface AttachOptions {
  cols: number;
  rows: number;
  onData(bytes: Uint8Array): void;
  onExit(): void;
}

/** Start a client running `argv` in a PTY. Injected so tests need no tmux. */
export type AttachSpawner = (argv: string[], options: AttachOptions) => AttachedClient;

/** Grace given to a client after its terminal closed, before it is killed. */
const KILL_GRACE_MS = 1000;

/** The spawner used outside tests: Bun's PTY support (`Bun.spawn` `terminal`). */
export function bunAttachSpawner(env: NodeJS.ProcessEnv = process.env): AttachSpawner {
  const childEnv = { ...tmuxClientEnv(env), TERM: "xterm-256color" };
  return (argv, options) => {
    let exited = false;
    const child = Bun.spawn(argv, {
      env: childEnv,
      terminal: {
        cols: options.cols,
        rows: options.rows,
        data(_terminal, bytes) {
          options.onData(bytes);
        },
      },
    });
    child.exited.then(
      () => {
        exited = true;
        options.onExit();
      },
      () => {
        exited = true;
        options.onExit();
      },
    );
    const terminal = child.terminal;
    return {
      write: (data) => terminal?.write(data),
      resize: (cols, rows) => terminal?.resize(cols, rows),
      close: () => {
        // Closing the PTY ends a tmux client on its own; the kill is for a
        // client that ignores the hang-up.
        terminal?.close();
        setTimeout(() => {
          if (!exited) child.kill();
        }, KILL_GRACE_MS).unref();
      },
    };
  };
}

interface Viewer {
  terminal: string;
  client: AttachedClient;
}

export interface OpenViewer {
  terminal: string;
  argv: string[];
  cols: number;
  rows: number;
  onData(bytes: Uint8Array): void;
  onExit(): void;
}

/** Every live viewer of this server, by token. */
export class ViewerRegistry {
  private readonly viewers = new Map<string, Viewer>();

  private readonly spawn: AttachSpawner;

  constructor(spawn: AttachSpawner) {
    this.spawn = spawn;
  }

  /** Attach a new client; returns the viewer token and a function that
   *  detaches it. The viewer leaves the registry when its client exits. */
  open(request: OpenViewer): { viewer: string; close(): void } {
    const token = randomBytes(24).toString("base64url");
    const client = this.spawn(request.argv, {
      cols: request.cols,
      rows: request.rows,
      onData: request.onData,
      onExit: () => {
        this.viewers.delete(token);
        request.onExit();
      },
    });
    this.viewers.set(token, { terminal: request.terminal, client });
    return {
      viewer: token,
      close: () => {
        if (!this.viewers.delete(token)) return;
        client.close();
      },
    };
  }

  /** The viewer, only when it belongs to that terminal. */
  private find(terminal: string, token: unknown): Viewer | undefined {
    if (typeof token !== "string") return undefined;
    const viewer = this.viewers.get(token);
    return viewer?.terminal === terminal ? viewer : undefined;
  }

  input(terminal: string, token: unknown, data: string): boolean {
    const viewer = this.find(terminal, token);
    if (!viewer) return false;
    viewer.client.write(data);
    return true;
  }

  resize(terminal: string, token: unknown, cols: number, rows: number): boolean {
    const viewer = this.find(terminal, token);
    if (!viewer) return false;
    viewer.client.resize(cols, rows);
    return true;
  }

  get size(): number {
    return this.viewers.size;
  }

  closeAll(): void {
    for (const [token, viewer] of [...this.viewers]) {
      this.viewers.delete(token);
      viewer.client.close();
    }
  }
}
