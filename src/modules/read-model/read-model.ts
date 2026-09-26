// modules/read-model/read-model.ts
//
// The read model as one port: every dashboard read, bound once to the
// environment it reads. The server holds one `ReadModel` and never passes `env`
// around; a test may hand it another implementation.

import { readFile, readImage, readTree } from "./explorer.js";
import { listItems, readItem } from "./items.js";
import { readLaunchesFor } from "./launches.js";
import { type ProjectEntry, type ReadModelOptions, readProjects } from "./projects.js";
import { readRecap } from "./recap.js";
import { type ReportRead, readReport } from "./report.js";
import { readStats } from "./stats.js";
import { readSteps } from "./steps.js";
import type { FileRead, ImageRead, Item, Launch, RunRecap, RunStepsView, StatsRead, WorkItemTree } from "./types.js";

export interface ReadModel {
  projects(): ProjectEntry[];
  /** The project listed under `name`, or `undefined`. */
  project(name: string): ProjectEntry | undefined;
  items(): Promise<Item[]>;
  /** Answers from the projects the read model itself lists, so an unlisted
   *  project or an unknown ticket is simply not found. */
  item(project: string, ticket: string): Promise<Item | undefined>;
  tree(project: string, ticket: string): WorkItemTree | undefined;
  steps(project: string, ticket: string): RunStepsView | undefined;
  recap(project: string, ticket: string): RunRecap | undefined;
  report(project: string, ticket: string): ReportRead | undefined;
  file(project: string, ticket: string, path: string): FileRead;
  image(project: string, ticket: string, path: string): ImageRead;
  launches(project: string, ticket: string): Launch[];
  stats(): StatsRead;
}

export function createReadModel(options: ReadModelOptions = {}): ReadModel {
  return {
    projects: () => readProjects(options),
    project: (name) => readProjects(options).find((entry) => entry.name === name),
    items: () => listItems(options),
    item: (project, ticket) => readItem(project, ticket, options),
    tree: (project, ticket) => readTree(project, ticket, options),
    steps: (project, ticket) => readSteps(project, ticket, options),
    recap: (project, ticket) => readRecap(project, ticket, options),
    report: (project, ticket) => readReport(project, ticket, options),
    file: (project, ticket, path) => readFile(project, ticket, path, options),
    image: (project, ticket, path) => readImage(project, ticket, path, options),
    launches: (project, ticket) => readLaunchesFor(project, ticket, options),
    stats: () => readStats(options),
  };
}
