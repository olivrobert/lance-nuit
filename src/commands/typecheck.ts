import { typecheckProjectPipelines, typecheckUserPipelines } from "../project/dsl-types.js";
import type { RunnerArgs } from "../model/cli-options.js";
import { log } from "../runtime/logging.js";
import type { RunnerCommand } from "./runner-command.js";

/** The single option `--typecheck` reads. */
type TypecheckArgs = Pick<RunnerArgs, "user">;

export const typecheckCommand: RunnerCommand = {
  id: "typecheck",
  flag: "--typecheck",
  key: "typecheck",
  desc: "Typechecks project pipelines with the installed DSL declarations.",
  run(args: TypecheckArgs): number {
    const result = args.user ? typecheckUserPipelines() : typecheckProjectPipelines(process.cwd());
    log(result.output);
    return result.ok ? 0 : 1;
  },
};
