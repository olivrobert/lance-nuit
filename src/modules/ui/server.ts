// modules/ui/server.ts
//
// The dashboard's HTTP surface: `node:http`, no server framework. This file
// composes the ports the routes run against and binds the socket; the router
// and the routes answer the requests.
//
// Two rules shape everything below it.
//
// First, the host is passed to `listen` EXPLICITLY. Omitting it makes Node bind
// the unspecified address, which on most systems means every interface — a
// dashboard that drives a runner would then be reachable from the network
// instead of only through the SSH tunnel it is designed for.
//
// Second, no path from a request ever reaches the filesystem on trust. A project
// and a ticket are looked up in the read model's own results, so an unknown pair
// is a 404 before any directory is opened; a file path is resolved by the read
// model, which checks containment lexically and again after `realpath`.
//
// The module never imports `src/state`: every fact it serves comes from
// `src/modules/read-model/`, and a Semgrep `ERROR` rule fails the build if that
// direction is ever reversed.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { WorkItemGatewayRegistry } from "../../contracts/registry.js";
import { DEFAULT_UI_PORT, UI_HOST } from "../../lib/ui-defaults.js";
import { openDashboardHome } from "../dashboard-home/index.js";
import { createReadModel, type ProjectEntry } from "../read-model/index.js";
import type { UiDeps } from "./deps.js";
import { sendError } from "./http/respond.js";
import { VerbLauncher } from "./launcher.js";
import { route } from "./router.js";
import { projectPipelines } from "./routes/projects.js";
import { type AttachSpawner, bunAttachSpawner, ViewerRegistry } from "./terminal-viewers.js";
import {
  operatorCommand,
  type PaneCommandBuilder,
  paneShell,
  resumeCoderCommand,
  type SessionCommandBuilder,
} from "./terminals.js";
import { Tmux } from "./tmux.js";

export { DEFAULT_UI_PORT, UI_HOST } from "../../lib/ui-defaults.js";

export interface UiServerOptions {
  /** Work-item providers used to validate a ticket reference. The dashboard
   *  resolves providers, it does not compose them: the caller passes the
   *  registry it composed. */
  workItems: WorkItemGatewayRegistry;
  port?: number;
  host?: string;
  env?: NodeJS.ProcessEnv;
  /** Executable spawned by the actions; defaults to this installation's
   *  `bin/lancenuit`. Tests point it at a script of their own. */
  launcher?: string;
  /** tmux adapter of the interactive runs; defaults to the `lancenuit` socket.
   *  Tests pass one on a socket of their own, or over a fake runner. */
  tmux?: Tmux;
  /** How a viewer's tmux client is spawned; defaults to a Bun PTY. */
  attach?: AttachSpawner;
  /** What is typed into a new run's pane; defaults to the operator agent. */
  paneCommand?: PaneCommandBuilder;
  /** What is typed into a reopened coder session's pane; defaults to Claude. */
  sessionCommand?: SessionCommandBuilder;
  /** Pipeline names of a project; defaults to the kit chain's list. */
  listPipelines?: (project: ProjectEntry) => string[];
}

export interface RunningUiServer {
  server: Server;
  host: string;
  port: number;
  url: string;
  close(): Promise<void>;
}

/**
 * The ports of one server, bound to one environment.
 *
 * The two files the dashboard owns are created — empty but valid — here, before
 * the socket is bound, so the first request finds a `users.json` to read and a
 * `projects.json` to write to, and a human can start editing them by hand right
 * away (H2). Launches left open by a previous server are closed and the old
 * ones purged at the same moment (spec 5.2, H1).
 */
function composeDeps(options: UiServerOptions, env: NodeJS.ProcessEnv): UiDeps {
  const home = openDashboardHome(env);
  home.users.ensure();
  home.projects.ensure();
  home.launches.reconcile();
  return {
    readModel: createReadModel({ env }),
    home,
    launcher: new VerbLauncher({
      launches: home.launches,
      env,
      ...(options.launcher ? { executable: options.launcher } : {}),
    }),
    terminals: {
      tmux: options.tmux ?? new Tmux({ env }),
      viewers: new ViewerRegistry(options.attach ?? bunAttachSpawner(env)),
      paneCommand: options.paneCommand ?? operatorCommand,
      sessionCommand: options.sessionCommand ?? resumeCoderCommand,
      listPipelines: options.listPipelines ?? projectPipelines,
      shell: paneShell(env),
    },
    workItems: options.workItems,
  };
}

/** Start the dashboard. */
export function startUiServer(options: UiServerOptions): Promise<RunningUiServer> {
  const env = options.env ?? process.env;
  const host = options.host ?? UI_HOST;
  const requestedPort = options.port ?? DEFAULT_UI_PORT;
  const deps = composeDeps(options, env);

  const server = createServer((req, res) => {
    const port = (server.address() as AddressInfo | null)?.port ?? requestedPort;
    route(req, res, deps, { host, port }).catch((error: unknown) => {
      // A route that threw is a bug in this server, not something the reader can
      // act on: the request gets one honest line and the process keeps serving.
      // The cause goes to stderr for whoever maintains it — method and path
      // only, never the body, which may carry a budget or a project path.
      const path = (req.url ?? "").split("?")[0];
      console.error(
        `[ui] ${req.method ?? "?"} ${path} -> 500:`,
        error instanceof Error ? (error.stack ?? error.message) : error,
      );
      if (!res.headersSent) sendError(res, 500, "internal error");
      else res.end();
    });
  });

  return new Promise<RunningUiServer>((fulfil, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    // The host is explicit on purpose: without it Node binds every interface.
    server.listen(requestedPort, host, () => {
      server.removeListener("error", onError);
      const address = server.address() as AddressInfo;
      fulfil({
        server,
        host: address.address,
        port: address.port,
        url: `http://${host}:${address.port}`,
        close: () =>
          new Promise<void>((done) => {
            // Viewers detach; the tmux sessions themselves outlive the server.
            deps.terminals.viewers.closeAll();
            server.close(() => done());
            // A browser polling every 15 s holds keep-alive sockets open; without
            // this, `close()` would wait for them and Ctrl+C would appear to hang.
            server.closeAllConnections();
          }),
      });
    });
  });
}
