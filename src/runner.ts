// runner/runner.ts
//
// Entry point. Its only responsibility is orchestration; each stage lives in its
// registry or in `entry/`:
//
//   parse argv
//     ↓
//   COMMANDS[]   launch no pipeline (--help, --lint-config)
//     ↓
//   BOOT[]       worktree -> pipeline -> config/context -> lock
//     ↓
//   loadPipelineDefinition        once per process
//     ↓
//   selectDispatch()              decision point
//     ├── strategy → runDispatch → exit (the parent runs no steps)
//     └── none     → Git guard → normal run
//
// Everything above `selectDispatch` lives in `entry/startup.ts`, the normal run
// in `entry/execution.ts`. Those phases RETURN their outcome; this file owns the
// process boundary — the single `process.exit` — which is what lets the phases be
// tested without one.

import { announceRun, prepareRun, reportRun, wireRunOutputs } from "./entry/execution.js";
import { installChildKillHandlers } from "./entry/signals.js";
import { startup } from "./entry/startup.js";
import type { Run } from "./model/run.js";
import { createAbortScope } from "./runtime/abort.js";
import { log } from "./runtime/logging.js";
import { executeRunSteps, stepLoopDeps } from "./step/step-loop.js";

async function main() {
  let activeRun: Run | undefined;
  // One abort scope per process: the signal handler requests on it, the step loop
  // and every in-process child run read it. Child pipeline runs never receive
  // `run.aborted`; the shared scope is what stops their loops.
  const abort = createAbortScope();
  installChildKillHandlers(abort, () => activeRun);

  const started = await startup(process.argv.slice(2));
  if (started.kind === "exit") process.exit(started.code);

  const prepared = await prepareRun(started.ready, (run) => {
    activeRun = run;
  });
  if (prepared.kind === "exit") process.exit(prepared.code);
  const { run, context, resuming } = prepared;

  const outputs = wireRunOutputs(run, started.ready.args);
  announceRun(run, started.ready.args);

  const outcome = await executeRunSteps(
    run,
    started.ready.args.ticket,
    started.ready.args.baseBranch,
    { resuming, abort },
    stepLoopDeps(outputs.output),
    context,
  );

  outputs.release();
  process.exit(reportRun(run, outcome, context, abort));
}

main().catch((err) => {
  log(err);
  process.exit(1);
});
