// modules/dashboard-home/paths.ts
//
// Where the dashboard's own files live: `~/.lance-nuit/ui/`. This is the one
// place that knows the layout, so `PIPELINE_HOME` moves the read model (which
// reads these files) and the server (which writes them) together.

import { join } from "node:path";
import { userKitDir } from "../../env/kit-paths.js";

export interface DashboardPaths {
  dir: string;
  users: string;
  projects: string;
  launches: string;
}

/** The dashboard's files, or `null` when no home directory is resolvable — the
 *  one case with nothing to read and nowhere to write. */
export function dashboardPaths(env: NodeJS.ProcessEnv = process.env): DashboardPaths | null {
  const kit = userKitDir(env);
  if (!kit) return null;
  const dir = join(kit, "ui");
  return {
    dir,
    users: join(dir, "users.json"),
    projects: join(dir, "projects.json"),
    launches: join(dir, "launches"),
  };
}
