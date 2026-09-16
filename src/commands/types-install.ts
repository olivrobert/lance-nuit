import { userKitDir } from "../env/kit-paths.js";
import { projectKitDirs } from "../project/dsl-types/layout.js";
import { installProjectTypes, installUserTypes } from "../project/dsl-types.js";
import type { RunnerArgs } from "../model/cli-options.js";
import { log } from "../runtime/logging.js";
import type { RunnerCommand } from "./runner-command.js";
import { errorMessage } from "./shared.js";

/** The single option `--types-install` reads. */
type TypesInstallArgs = Pick<RunnerArgs, "user">;

/** Install the generated DSL contract shipped by this runner package. */
export const typesInstallCommand: RunnerCommand = {
  id: "types-install",
  flag: "--types-install",
  label: "lancenuit types install",
  key: "typesInstall",
  desc: "Install generated DSL declarations for project pipelines.",
  run(args: TypesInstallArgs): number {
    try {
      if (args.user) {
        installUserTypes();
        log(`DSL types installed in ${userKitDir()}.`);
      } else {
        const root = process.cwd();
        installProjectTypes(root);
        log(`DSL types installed in ${projectKitDirs(root).join(", ")}.`);
      }
      return 0;
    } catch (error) {
      log(`Unable to install DSL types: ${errorMessage(error)}`);
      return 1;
    }
  },
};
