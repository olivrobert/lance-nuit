// runner/runner.ts
//
// Entry point. Its only responsibility is orchestration; each stage lives in its
// registry or in `entry/`:
//
//   parse argv
//     ↓
//   COMMANDS[]   launch no pipeline (--help, --lint-config)
//     ↓
//   BOOT[]       worktree -> pipeline -> config/context -> lock -> stack -> worktree-ready
//     ↓
//   loadPipelineDefinition        once per process
//     ↓
//   selectDispatch()              decision point
//     ├── strategy → runDispatch → exit (the parent runs no steps)
//     └── none     → Git guard → normal run → report
//                                                  ↓
//                                stack stop (worktree-stop.sh) unless PASS
//
// Everything above `selectDispatch` lives in `entry/startup.ts`, the normal run
// in `entry/execution.ts`. Those phases RETURN their outcome; this file owns the
// process boundary — the single `process.exit` — which is what lets the phases be
// tested without one.

import { announceRun, prepareRun, reportRun, wireRunOutputs } from "./entry/execution.js";
import { installChildKillHandlers } from "./entry/signals.js";
import { createStackStop, NO_STACK_STOP, type StackStop, stopsStack } from "./entry/stack-stop.js";
import { startup } from "./entry/startup.js";
import type { Run } from "./model/run.js";
import { createAbortScope } from "./runtime/abort.js";
import { log } from "./runtime/logging.js";
import { executeRunSteps, stepLoopDeps } from "./step/step-loop.js";

// Module-level so `main().catch` and the signal handler, both installed before
// startup returns, reach the stop of the worktree this process entered.
let stackStop: StackStop = NO_STACK_STOP;

async function main() {
  let activeRun: Run | undefined;
  // One abort scope per process: the signal handler requests on it, the step loop
  // and every in-process child run read it. Child pipeline runs never receive
  // `run.aborted`; the shared scope is what stops their loops.
  const abort = createAbortScope();
  installChildKillHandlers(
    abort,
    () => activeRun,
    () => stackStop,
  );

  const started = await startup(process.argv.slice(2));
  if (started.kind === "exit") process.exit(started.code);
  stackStop = createStackStop(started.ready.enteredWorktree);

  const prepared = await prepareRun(started.ready, (run) => {
    activeRun = run;
  });
  if (prepared.kind === "exit") {
    await stackStop.run();
    process.exit(prepared.code);
  }
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
  const code = reportRun(run, outcome, context, abort);
  // The run is finalized: a signal during the stop must not rewrite it as ABORTED.
  activeRun = undefined;
  if (stopsStack(run.status)) await stackStop.run();
  // A signal during the stop leaves the exit to this line, which keeps the reported code.
  process.exit(code);
}

main().catch(async (err) => {
  log(err);
  await stackStop.run();
  process.exit(1);
});
