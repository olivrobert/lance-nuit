// The local dashboard, served for as long as the command runs.
//
// Unlike every other `RunnerCommand` this one does not return promptly: it binds
// a socket and resolves only once the server is shut down, which is exactly what
// makes `lancenuit ui` a foreground process a human can Ctrl+C in a tmux pane
// (spec 10). It launches no pipeline, so like the other commands it takes
// neither the runner lock nor the clean-tree guard.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { createDefaultWorkItemGatewayRegistry } from "../modules/work-item/registry.js";
import { DEFAULT_UI_PORT, startUiServer, staticDir } from "../modules/ui/index.js";
import type { RunnerArgs } from "../model/cli-options.js";
import { log } from "../runtime/logging.js";
import type { RunnerCommand } from "./runner-command.js";
import { errorMessage } from "./shared.js";

/** Options this command reads. */
type UiArgs = Pick<RunnerArgs, "port">;

/**
 * Signals a foreground command is expected to honour.
 *
 * The entry point installs its own handler for both and owns the exit code (130
 * for SIGINT, 143 for SIGTERM), which is what a shell expects from an
 * interrupted foreground process. This handler owns what that one cannot know
 * about: closing the listening socket, and saying out loud that the runs already
 * launched are detached and keep going (spec 5.2).
 */
const SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM"] as const;

/**
 * The front end is a build product.
 *
 * `static/app.js` and `static/app.css` are bundled from `src/modules/ui/app/`
 * and are not in the repository, so a fresh clone has an HTML shell pointing at
 * two files that do not exist. The dashboard would start, serve a blank page and
 * say nothing. It refuses instead, and names the command that fixes it — building
 * implicitly here would hide a missing step from a packaged installation, where
 * no bundler is available at all.
 */
function missingBundle(): string | undefined {
  const missing = ["app.js", "app.css"].filter((name) => !existsSync(join(staticDir(), name)));
  if (missing.length === 0) return undefined;
  return `Dashboard assets are missing (${missing.join(", ")}). Run \`bun run ui:build\` first.`;
}

export async function serveUi(args: UiArgs): Promise<number> {
  const missing = missingBundle();
  if (missing) {
    log(missing);
    return 1;
  }

  let running: Awaited<ReturnType<typeof startUiServer>>;
  try {
    running = await startUiServer({
      port: args.port ?? DEFAULT_UI_PORT,
      workItems: createDefaultWorkItemGatewayRegistry(),
    });
  } catch (error) {
    log(`Dashboard failed to start: ${errorMessage(error)}`);
    return 1;
  }

  log(`Dashboard listening on ${running.url} (Ctrl+C to stop).`);
  log(`Tunnel it with: ssh -L ${running.port}:127.0.0.1:${running.port} <host>`);

  await new Promise<void>((done) => {
    let stopping = false;
    const stop = (signal: string): void => {
      if (stopping) return;
      stopping = true;
      log(`Received ${signal}; stopping the dashboard. Detached runs keep going.`);
      running.close().then(
        () => done(),
        () => done(),
      );
    };
    for (const signal of SHUTDOWN_SIGNALS) process.once(signal, () => stop(signal));
    // A socket closed from elsewhere (a test, a port conflict resolved late) ends
    // the command just as a signal would.
    running.server.once("close", () => done());
  });

  return 0;
}

export const uiCommand: RunnerCommand = {
  id: "ui",
  flag: "--ui",
  key: "ui",
  desc: "Serve the local dashboard on 127.0.0.1 until interrupted.",
  run(args: RunnerArgs): Promise<number> {
    return serveUi(args);
  },
};
