// modules/dashboard-home/index.ts
//
// Public surface of the dashboard's home: the files it owns under
// `~/.lance-nuit/ui/`. The read model reads them to describe items; the
// dashboard server writes them. Each file has exactly one owner below, and
// nothing here touches a project's `.lance-nuit/` — every write inside a
// project goes through the CLI.

import { FileLaunchStore } from "./launch-store.js";
import { type DashboardPaths, dashboardPaths } from "./paths.js";
import { FileProjectList } from "./project-list.js";
import { FileUserList } from "./user-list.js";

export {
  describeLaunch,
  FileLaunchStore,
  isPidAlive,
  isValidLaunchId,
  LAUNCH_RETENTION_DAYS,
  type Launch,
  type LaunchFiles,
  type LaunchRecord,
  type LogTail,
} from "./launch-store.js";
export { type DashboardPaths, dashboardPaths } from "./paths.js";
export { FileProjectList, type ProjectWrite } from "./project-list.js";
export { FileUserList, isValidUserName } from "./user-list.js";

export interface DashboardHome {
  /** `null` when no home directory is resolvable: every read is then empty and
   *  every write refused. */
  paths: DashboardPaths | null;
  users: FileUserList;
  projects: FileProjectList;
  launches: FileLaunchStore;
}

/** The three stores, bound to one resolved home. */
export function openDashboardHome(env: NodeJS.ProcessEnv = process.env): DashboardHome {
  const paths = dashboardPaths(env);
  return {
    paths,
    users: new FileUserList(paths),
    projects: new FileProjectList(paths),
    launches: new FileLaunchStore(paths),
  };
}
