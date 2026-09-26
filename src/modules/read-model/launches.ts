// modules/read-model/launches.ts
//
// Launches as the read model needs them. The records are owned by
// `dashboard-home/` (the server writes them when a verb is clicked); reading
// them is a read-model concern because an item's group depends on it — a work
// item whose runner was just spawned is "running" even before the runner has
// written a single byte of `state.json`.

import { openDashboardHome } from "../dashboard-home/index.js";
import type { ReadModelOptions } from "./projects.js";
import type { Launch } from "./types.js";

/** Every launch on disk, newest first. */
export function readLaunches(options: ReadModelOptions = {}): Launch[] {
  return openDashboardHome(options.env ?? process.env).launches.list();
}

/** Launches of one item, newest first. */
export function readLaunchesFor(projectName: string, ticket: string, options: ReadModelOptions = {}): Launch[] {
  return readLaunches(options).filter((launch) => launch.project === projectName && launch.ticket === ticket);
}

/** Latest launch per `project/ticket`, for one pass over the morning box. */
export function latestLaunchByItem(options: ReadModelOptions = {}): Map<string, Launch> {
  const latest = new Map<string, Launch>();
  // `readLaunches` is newest first, so the first one seen per key wins.
  for (const launch of readLaunches(options)) {
    const key = `${launch.project}/${launch.ticket}`;
    if (!latest.has(key)) latest.set(key, launch);
  }
  return latest;
}
