// modules/ui/terminals.ts
//
// Interactive runs: a tmux session the dashboard created in a project's main
// clone, in which the operator agent is asked to start one `lancenuit run`, and
// which the reader then watches and types into from the browser.
//
// Three rules shape this module.
//
// First, tmux is the authoritative state. There is no record file: a terminal
// exists while its session exists, and everything the dashboard shows about it
// (who, which pipeline, when) is read back from the session's own user options.
// A session killed from a shell disappears from the dashboard at the next read,
// and a dashboard restart finds every session still there.
//
// Second, the one string typed into a pane is built here, from values that were
// each validated as a token BEFORE being shell-quoted: the ticket by the read
// model and the project's provider, the pipeline against the project's own list.
// The request never supplies a character that reaches the shell unvalidated.
//
// Third, the pane runs the reader's shell, and the command is typed into it.
// When the command ends the shell stays, with the output on screen, so the
// reader can read it, relaunch, or exit — exactly what they would do in their
// own terminal. What is typed is a dependency (`PaneCommandBuilder`): the route
// passes `operatorCommand`, a test passes a harmless one.

import { isPipelineName } from "../../env/builtin-pipeline.js";
import type { WorkItemGatewayRegistry } from "../../contracts/registry.js";
import { type Item, isTicketToken, type ProjectEntry, validateTicketRef } from "../read-model/index.js";
import { isBusy } from "./actions.js";
import type { Tmux } from "./tmux.js";

/** What the browser is told about one interactive run. */
export interface TerminalInfo {
  id: string;
  project: string;
  ticket: string;
  pipeline: string;
  worktree: boolean;
  by: string;
  /** ISO timestamp. */
  createdAt: string;
  /** The command typed into the pane, as typed. */
  command: string;
  /** What a human types to join the same session from a shell. */
  attach: string;
}

/** Size of a session before any viewer attaches; the first client resizes it. */
const INITIAL_COLS = 200;
const INITIAL_ROWS = 50;

/** Every session this module creates starts with this prefix. */
const SESSION_PREFIX = "ln-";
const SESSION_ID = /^ln-[A-Za-z0-9_-]{1,200}$/;

/** Order of the fields in a `list-sessions` line; the metadata is stored as
 *  session user options under these keys. */
const OPTION_KEYS = [
  "ln-project",
  "ln-ticket",
  "ln-pipeline",
  "ln-worktree",
  "ln-by",
  "ln-created-at",
  "ln-command",
] as const;
const LIST_FORMAT = ["#{session_name}", ...OPTION_KEYS.map((key) => `#{@${key}}`)].join("\t");

/** A directory the pane may start in: absolute, and no control character. */
function isSafePath(value: string): boolean {
  return value.startsWith("/") && ![...value].some((char) => char.charCodeAt(0) < 0x20 || char === "\x7f");
}

/** The shell a pane runs: `$SHELL` when it is a plain absolute path, since
 *  tmux hands it to `sh -c`; `/bin/bash` otherwise. */
export function paneShell(env: NodeJS.ProcessEnv): string {
  const shell = env.SHELL;
  return shell && /^\/[\w./+-]+$/.test(shell) ? shell : "/bin/bash";
}

/** Session name of one project + ticket. Characters tmux or a URL would treat
 *  specially become `_`; the real names are in the session's options. */
export function sessionName(project: string, ticket: string): string {
  return `${SESSION_PREFIX}${project}-${ticket}`.replace(/[^A-Za-z0-9_-]/g, "_");
}

/** Whether `value` can name one of our sessions. Checked before any id from a
 *  URL reaches tmux. */
export function isSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID.test(value);
}

/** POSIX single quoting: the value is one word, whatever it contains. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Words joined into one command line; a word made only of characters no
 *  shell treats specially is left bare, every other one is single-quoted. */
export function shellJoin(words: string[]): string {
  return words.map((word) => (/^[\w@%+=:,./-]+$/.test(word) ? word : shellQuote(word))).join(" ");
}

/** The run a pane is opened for, every field already validated. */
export interface RunSpec {
  ticket: string;
  pipeline: string;
  worktree: boolean;
}

/** The words typed into the pane for a run, or why nothing can be typed. */
export type PaneCommandBuilder = (
  run: RunSpec,
) => { ok: true; words: string[] } | { ok: false; status: number; reason: string };

/** One `list-sessions` line back to a terminal; `undefined` for a session
 *  without our metadata, which this module did not create. */
function parseSessionLine(line: string, tmux: Tmux): TerminalInfo | undefined {
  const [id, project, ticket, pipeline, worktree, by, createdAt, command] = line.split("\t");
  if (!isSessionId(id) || !project || !ticket || !pipeline || !createdAt) return undefined;
  return {
    id,
    project,
    ticket,
    pipeline,
    worktree: worktree === "1",
    by: by ?? "",
    createdAt,
    command: command ?? "",
    attach: tmux.attachCommand(id),
  };
}

/** Every interactive run, oldest first; `undefined` when tmux is not installed. */
export async function listTerminals(tmux: Tmux): Promise<TerminalInfo[] | undefined> {
  const lines = await tmux.listSessions(LIST_FORMAT);
  if (!lines) return undefined;
  return lines
    .map((line) => parseSessionLine(line, tmux))
    .filter((info): info is TerminalInfo => info !== undefined)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export type TerminalLookup =
  | { status: "found"; terminal: TerminalInfo }
  | { status: "not-found" }
  | { status: "no-tmux" };

export async function findTerminal(tmux: Tmux, id: string): Promise<TerminalLookup> {
  if (!isSessionId(id)) return { status: "not-found" };
  const all = await listTerminals(tmux);
  if (!all) return { status: "no-tmux" };
  const terminal = all.find((entry) => entry.id === id);
  return terminal ? { status: "found", terminal } : { status: "not-found" };
}

export interface StartRunRequest {
  project: ProjectEntry;
  ticket: unknown;
  pipeline: unknown;
  worktree: boolean;
  /** Name from the identity cookie. */
  by: string;
}

export interface StartRunDeps {
  tmux: Tmux;
  workItems: WorkItemGatewayRegistry;
  /** Pipeline names the project can run. */
  listPipelines(project: ProjectEntry): string[];
  /** The item for this project + ticket, when one exists on disk. */
  findItem(project: ProjectEntry, ticket: string): Promise<Item | undefined>;
  /** What is typed into the pane. */
  paneCommand: PaneCommandBuilder;
  /** Program the pane runs. */
  shell: string;
  now?: () => Date;
}

export type StartRunResult =
  | { ok: true; terminal: TerminalInfo }
  | { ok: false; status: number; reason: string; terminal?: TerminalInfo };

/**
 * The ticket as the project's tracker spells it, or `undefined` when it names
 * another project. A provider validates the shape of a reference, not whose it
 * is, so a `FOOD-1` typed while on a `PACASEC` project would otherwise start a
 * run in the wrong repository. The key is matched case-insensitively and
 * rewritten as declared (`food-12` becomes `FOOD-12`); a project that declares
 * no key accepts any reference its provider accepts.
 */
export function ticketForProject(project: Pick<ProjectEntry, "key">, ticket: string): string | undefined {
  if (!project.key) return ticket;
  const prefix = `${project.key}-`;
  if (ticket.slice(0, prefix.length).toUpperCase() !== prefix.toUpperCase()) return undefined;
  return prefix + ticket.slice(prefix.length);
}

/**
 * Start an interactive run: create the session, record who and what on it, and
 * type the command.
 *
 * Every refusal is answered before tmux is asked to create anything, in this
 * order: the ticket, the pipeline, tmux itself, a session already open for the
 * same item, a run already in progress on it, and the command. The options are
 * set before the command is typed, so a terminal listed by the dashboard always
 * carries its metadata.
 */
export async function startRun(request: StartRunRequest, deps: StartRunDeps): Promise<StartRunResult> {
  const { project, worktree } = request;
  if (!isTicketToken(request.ticket)) return { ok: false, status: 400, reason: "field `ticket` is required" };
  const ticket = ticketForProject(project, request.ticket);
  if (!ticket) {
    return { ok: false, status: 400, reason: `ticket "${request.ticket}" does not belong to project "${project.name}"` };
  }
  const reference = validateTicketRef(project, ticket, deps.workItems);
  if (!reference.ok) return { ok: false, status: 400, reason: reference.reason };

  if (typeof request.pipeline !== "string" || !isPipelineName(request.pipeline)) {
    return { ok: false, status: 400, reason: "field `pipeline` must be a pipeline name" };
  }
  const pipeline = request.pipeline;
  if (!deps.listPipelines(project).includes(pipeline)) {
    return { ok: false, status: 400, reason: `project "${project.name}" has no pipeline "${pipeline}"` };
  }
  if (!isSafePath(project.cwd)) return { ok: false, status: 400, reason: "the project path is not usable" };

  const id = sessionName(project.name, ticket);
  const exists = await deps.tmux.hasSession(id);
  if (exists === undefined) return { ok: false, status: 503, reason: "tmux is not installed" };
  if (exists) {
    const existing = await findTerminal(deps.tmux, id);
    return {
      ok: false,
      status: 409,
      reason: "a terminal is already open for this item",
      ...(existing.status === "found" ? { terminal: existing.terminal } : {}),
    };
  }

  const item = await deps.findItem(project, ticket);
  if (item && isBusy(item)) return { ok: false, status: 409, reason: "a run is already in progress for this item" };

  const built = deps.paneCommand({ ticket, pipeline, worktree });
  if (!built.ok) return built;
  const command = shellJoin(built.words);

  const createdAt = (deps.now?.() ?? new Date()).toISOString();
  const created = await deps.tmux.newSession({
    name: id,
    cwd: project.cwd,
    shell: deps.shell,
    env: { LANCENUIT_ACTOR: request.by },
    cols: INITIAL_COLS,
    rows: INITIAL_ROWS,
  });
  if (!created.ok) {
    return { ok: false, status: created.missing ? 503 : 500, reason: `tmux refused the session: ${created.reason}` };
  }

  const options: Record<(typeof OPTION_KEYS)[number], string> = {
    "ln-project": project.name,
    "ln-ticket": ticket,
    "ln-pipeline": pipeline,
    "ln-worktree": worktree ? "1" : "0",
    "ln-by": request.by,
    "ln-created-at": createdAt,
    "ln-command": command,
  };
  const steps = [
    () => deps.tmux.setOptions(id, options),
    () => deps.tmux.sendLiteral(id, command),
    () => deps.tmux.sendEnter(id),
  ];
  for (const step of steps) {
    const done = await step();
    if (!done.ok) {
      // A half-made session would show up with no metadata or no command; it is
      // removed so the reader can simply try again.
      await deps.tmux.killSession(id);
      return { ok: false, status: 500, reason: `tmux failed: ${done.reason}` };
    }
  }

  return {
    ok: true,
    terminal: {
      id,
      project: project.name,
      ticket,
      pipeline,
      worktree,
      by: request.by,
      createdAt,
      command,
      attach: deps.tmux.attachCommand(id),
    },
  };
}

/** False when the `claude` CLI is not on PATH. Looked up at each launch, so
 *  installing it needs no dashboard restart. */
export function hasClaudeCli(which: (name: string) => string | null = (name) => Bun.which(name)): boolean {
  return which("claude") !== null;
}

/**
 * Default pane command: the interactive lancenuit-operator agent, told which run
 * to start. The prompt is French because it is addressed to the user's
 * French-speaking operator agent, not shown as product text.
 */
export const operatorCommand: PaneCommandBuilder = ({ ticket, pipeline, worktree }) => {
  if (!hasClaudeCli()) return { ok: false, status: 503, reason: "claude CLI not found" };
  return {
    ok: true,
    words: [
      "claude",
      "--agent",
      "lancenuit-operator",
      `Lance la pipeline : lancenuit run ${ticket} --pipeline ${pipeline}${worktree ? " --worktree" : ""}`,
    ],
  };
};
