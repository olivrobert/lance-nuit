// Who started or resumed a run, as the caller's environment names it (an app's
// thread, say), so that the app finds the runs it launched without parsing
// commands. `tools/night-vm/night.sh` does the same for a night, next to it.
//
// The record is an index under the user kit, one file per run, because run
// directories sit in each project under a configurable `specPath`: the app could
// not list them. The last caller wins; a caller without the variable leaves the
// previous record.
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { userKitDir } from "../../shared/env/kit-paths.js";
import { writeFileAtomic } from "../../shared/lib/atomic-write.js";
import { errorMessage } from "../../shared/lib/errors.js";
import { log } from "../../shared/runtime/logging.js";

export const RUN_ORIGIN_VARIABLE = "LANCENUIT_ORIGIN";
export const RUN_ORIGINS_DIR = "run-origins";

const PLAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;

export interface RunOriginRecord {
  origin: string;
  runId: string;
  runDir: string;
  recordedAt: string;
}

/** Best effort: a run never stops because its origin could not be recorded. */
export function recordRunOrigin(
  run: { runId?: string; run_dir: string },
  env: NodeJS.ProcessEnv = process.env,
  now: () => Date = () => new Date(),
): string | null {
  const origin = env[RUN_ORIGIN_VARIABLE]?.trim();
  if (!origin) return null;
  if (!PLAIN_NAME.test(origin)) {
    log.warn(`Ignoring ${RUN_ORIGIN_VARIABLE}, not a plain name: ${origin}`);
    return null;
  }
  const kit = userKitDir(env);
  const { runId } = run;
  if (kit === null || runId === undefined || !PLAIN_NAME.test(runId)) return null;
  const dir = join(kit, RUN_ORIGINS_DIR);
  const file = join(dir, `${runId}.json`);
  const record: RunOriginRecord = {
    origin,
    runId,
    runDir: resolve(run.run_dir),
    recordedAt: now().toISOString(),
  };
  try {
    mkdirSync(dir, { recursive: true });
    writeFileAtomic(file, `${JSON.stringify(record)}\n`);
    return file;
  } catch (error) {
    log.warn(`Could not record the origin of run ${runId}: ${errorMessage(error)}`);
    return null;
  }
}
