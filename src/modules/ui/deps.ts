// modules/ui/deps.ts
//
// The ports the dashboard's routes run against, composed once by the server.
// A route reads through `readModel`, writes the dashboard's own files through
// `home`, spawns a verb through `launcher`, and reaches tmux through
// `terminals`; it never sees `env`.

import type { WorkItemGatewayRegistry } from "../../contracts/registry.js";
import type { DashboardHome } from "../dashboard-home/index.js";
import type { ProjectEntry, ReadModel } from "../read-model/index.js";
import type { VerbLauncher } from "./launcher.js";
import type { ViewerRegistry } from "./terminal-viewers.js";
import type { PaneCommandBuilder, SessionCommandBuilder } from "./terminals.js";
import type { Tmux } from "./tmux.js";

/** Everything the terminal routes share for the lifetime of the server. The
 *  viewer registry in particular is ONE per server: a token handed out by one
 *  request is looked up by the next. */
export interface TerminalDeps {
  tmux: Tmux;
  viewers: ViewerRegistry;
  paneCommand: PaneCommandBuilder;
  sessionCommand: SessionCommandBuilder;
  listPipelines: (project: ProjectEntry) => string[];
  shell: string;
}

export interface UiDeps {
  readModel: ReadModel;
  home: DashboardHome;
  launcher: VerbLauncher;
  terminals: TerminalDeps;
  /** Work-item providers used to validate a ticket reference. */
  workItems: WorkItemGatewayRegistry;
}
