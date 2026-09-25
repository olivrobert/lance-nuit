// modules/ui/tmux.ts
//
// The dashboard's only way to reach tmux: a thin adapter over the `tmux` CLI,
// always on the dashboard's own socket (`tmux -L lancenuit`), so the reader's
// own tmux server and its sessions are never listed, typed into, or killed.
//
// Three rules shape this module.
//
// First, tmux is invoked with an argv array and no shell. Nothing here builds a
// command line; the one string typed into a pane is built and quoted by the
// caller (`terminals.ts`) from values it has already validated.
//
// Second, every session target is EXACT (`=<name>`). A bare `-t ln-demo` would
// let tmux fall back to a prefix or pattern match and act on `ln-demo-2`.
//
// Third, the process runner is a parameter. The adapter decides which tmux
// subcommand answers which question; tests hand it a fake runner and check the
// argv it produced, without a tmux binary.

import { execFile } from "node:child_process";

/** Socket every dashboard session lives on. */
export const TMUX_SOCKET = "lancenuit";

/** What one tmux invocation produced. `missing` means the binary itself could
 *  not be started, which the routes report as tmux not being installed. */
export type TmuxResult = { status: "missing" } | { status: "exited"; code: number; stdout: string; stderr: string };

/** Run `tmux` with these arguments (the socket flag already included). */
export type TmuxRunner = (args: string[]) => Promise<TmuxResult>;

/** Environment for tmux clients: without `TMUX`, a dashboard started inside a
 *  tmux pane can still attach to its own socket instead of being refused as a
 *  nested client. */
export function tmuxClientEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { TMUX: _tmux, TMUX_PANE: _pane, ...rest } = env;
  return rest;
}

/** The runner used outside tests: `execFile`, no shell, output bounded. */
export function execTmuxRunner(binary = "tmux", env: NodeJS.ProcessEnv = process.env): TmuxRunner {
  const childEnv = tmuxClientEnv(env);
  return (args) =>
    new Promise<TmuxResult>((done) => {
      execFile(binary, args, { env: childEnv, maxBuffer: 1024 * 1024, timeout: 10_000 }, (error, stdout, stderr) => {
        // `code` is a string when the binary could not be started and the exit
        // status when it ran and failed; a timeout kills it and leaves neither.
        const code: unknown = (error as { code?: unknown } | null)?.code;
        if (code === "ENOENT" || code === "EACCES") {
          done({ status: "missing" });
          return;
        }
        const exit = !error ? 0 : typeof code === "number" ? code : 1;
        done({ status: "exited", code: exit, stdout: String(stdout), stderr: String(stderr) });
      });
    });
}

export interface NewSession {
  name: string;
  cwd: string;
  /** Absolute path of the program the pane runs. */
  shell: string;
  /** Variables set in the session's environment (`new-session -e`). */
  env: Record<string, string>;
  cols: number;
  rows: number;
}

/** Outcome of a command whose only answer is success or a reason. */
export type TmuxOutcome = { ok: true } | { ok: false; missing: boolean; reason: string };

function outcome(result: TmuxResult): TmuxOutcome {
  if (result.status === "missing") return { ok: false, missing: true, reason: "tmux is not installed" };
  if (result.code === 0) return { ok: true };
  return { ok: false, missing: false, reason: result.stderr.trim() || `tmux exited with ${result.code}` };
}

/** `list-sessions` of a server that is not running is an empty list, not an
 *  error: tmux exits the server with its last session. */
function isNoServer(stderr: string): boolean {
  return /no server running|error connecting to|no sessions/i.test(stderr);
}

/** Exact session target: never a prefix or pattern match. */
function target(name: string): string {
  return `=${name}`;
}

/** The adapter. One instance per socket. */
export class Tmux {
  readonly socket: string;

  private readonly run: TmuxRunner;

  private readonly binary: string;

  constructor(options: { socket?: string; runner?: TmuxRunner; binary?: string; env?: NodeJS.ProcessEnv } = {}) {
    this.socket = options.socket ?? TMUX_SOCKET;
    this.binary = options.binary ?? "tmux";
    this.run = options.runner ?? execTmuxRunner(this.binary, options.env);
  }

  private exec(args: string[]): Promise<TmuxResult> {
    return this.run(["-L", this.socket, ...args]);
  }

  /** Detached session running `shell` in `cwd`. */
  async newSession(session: NewSession): Promise<TmuxOutcome> {
    const variables = Object.entries(session.env).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
    return outcome(
      await this.exec([
        "new-session",
        "-d",
        "-s",
        session.name,
        "-c",
        session.cwd,
        "-x",
        String(session.cols),
        "-y",
        String(session.rows),
        ...variables,
        session.shell,
      ]),
    );
  }

  /** Session user options (`@key value`), one invocation each. */
  async setOptions(name: string, options: Record<string, string>): Promise<TmuxOutcome> {
    for (const [key, value] of Object.entries(options)) {
      // `set-option -t` takes a pane target, where a bare `=name` does not
      // parse; the trailing colon makes it the session's current window.
      const result = outcome(await this.exec(["set-option", "-t", `${target(name)}:`, `@${key}`, value]));
      if (!result.ok) return result;
    }
    return { ok: true };
  }

  /** Type `text` into the session's active pane, literally (no key names). */
  async sendLiteral(name: string, text: string): Promise<TmuxOutcome> {
    return outcome(await this.exec(["send-keys", "-t", `${target(name)}:`, "-l", "--", text]));
  }

  async sendEnter(name: string): Promise<TmuxOutcome> {
    return outcome(await this.exec(["send-keys", "-t", `${target(name)}:`, "Enter"]));
  }

  /** Whether the session exists; `undefined` when tmux is not installed. */
  async hasSession(name: string): Promise<boolean | undefined> {
    const result = await this.exec(["has-session", "-t", target(name)]);
    if (result.status === "missing") return undefined;
    return result.code === 0;
  }

  /**
   * One line per session, formatted with `format` (tmux `#{…}` syntax), or
   * `undefined` when tmux is not installed. No server running is no session.
   */
  async listSessions(format: string): Promise<string[] | undefined> {
    const result = await this.exec(["list-sessions", "-F", format]);
    if (result.status === "missing") return undefined;
    if (result.code !== 0) {
      if (isNoServer(result.stderr)) return [];
      throw new Error(`tmux list-sessions failed: ${result.stderr.trim() || result.code}`);
    }
    return result.stdout.split("\n").filter((line) => line.length > 0);
  }

  async killSession(name: string): Promise<TmuxOutcome> {
    return outcome(await this.exec(["kill-session", "-t", target(name)]));
  }

  /** Argv of a client attached to the session, for a PTY. */
  attachArgv(name: string): string[] {
    return [this.binary, "-L", this.socket, "attach-session", "-t", target(name)];
  }

  /** What a human types in a shell of the same machine to join the session. */
  attachCommand(name: string): string {
    return `tmux -L ${this.socket} attach -t ${name}`;
  }
}
