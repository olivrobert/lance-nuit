import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type LiveFeed, liveFeedPathFromEnvironment } from "../runtime/live-feed.js";
import { runEventsFilePath } from "../state/stores/file-run-event-store.js";

export type FileLiveFeedOptions = { filePath: string; runDir?: never } | { runDir: string; filePath?: never };

/** Local JSONL adapter. Observability errors never block the run. */
export class FileLiveFeed implements LiveFeed {
  private readonly filePath: string;

  constructor(filePath: string);
  constructor(options: FileLiveFeedOptions);
  constructor(filePathOrOptions: string | FileLiveFeedOptions) {
    this.filePath =
      typeof filePathOrOptions === "string"
        ? filePathOrOptions
        : filePathOrOptions.filePath !== undefined
          ? filePathOrOptions.filePath
          : runEventsFilePath(filePathOrOptions.runDir);
  }

  path(): string {
    return this.filePath;
  }

  ensure(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, "", { flag: "a" });
    } catch {
      // The live feed never decides a run's outcome.
    }
  }

  append(event: unknown): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      appendFileSync(this.filePath, `${JSON.stringify(event)}\n`, { encoding: "utf-8" });
    } catch {
      // Serialization and filesystem writes are best effort by contract.
    }
  }
}

/** Build the feed a child process inherited through the environment. `entry/`
 * installs it before boot so the bus keeps writing where the parent expects. */
export function liveFeedFromEnvironment(env: NodeJS.ProcessEnv = process.env): LiveFeed | undefined {
  const filePath = liveFeedPathFromEnvironment(env);
  return filePath ? new FileLiveFeed(filePath) : undefined;
}
