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
import { readRunJourney } from "./run-journey.js";
import { type ReportRead, readReport } from "./report.js";
import { readStats } from "./stats.js";
import { readStepDetail, readStepSession } from "./step-detail.js";
import { readCoderSession, readSteps } from "./steps.js";
import type {
  CoderSessionRead,
  FileRead,
  ImageRead,
  Item,
  Launch,
  RunJourney,
  RunRecap,
  RunStepsView,
  StatsRead,
  StepDetail,
  WorkItemTree,
} from "./types.js";

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
  /** One step opened from the timeline; `attempt` defaults to the last one. */
  step(project: string, ticket: string, stepId: string, attempt?: number): StepDetail | undefined;
  coderSession(project: string, ticket: string): CoderSessionRead | undefined;
  /** The agent session one attempt of a step left, to reopen as a fork. */
  stepSession(project: string, ticket: string, stepId: string, attempt: number): CoderSessionRead | undefined;
  recap(project: string, ticket: string): RunRecap | undefined;
  /** Every attempt and pause of the run, for the Run tab. */
  journey(project: string, ticket: string): RunJourney | undefined;
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
    step: (project, ticket, stepId, attempt) => readStepDetail(project, ticket, stepId, attempt, options),
    coderSession: (project, ticket) => readCoderSession(project, ticket, options),
    stepSession: (project, ticket, stepId, attempt) => readStepSession(project, ticket, stepId, attempt, options),
    recap: (project, ticket) => readRecap(project, ticket, options),
    journey: (project, ticket) => readRunJourney(project, ticket, options),
    report: (project, ticket) => readReport(project, ticket, options),
    file: (project, ticket, path) => readFile(project, ticket, path, options),
    image: (project, ticket, path) => readImage(project, ticket, path, options),
    launches: (project, ticket) => readLaunchesFor(project, ticket, options),
    stats: () => readStats(options),
  };
}
