import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { projectKitDir, userKitDir } from "../env/kit-paths.js";
import { isErrno } from "../lib/errors.js";
import {
  installProjectTypes,
  installUserTypes,
  typecheckProjectPipelines,
  typecheckUserPipelines,
} from "../project/dsl-types.js";
import type { RunnerArgs } from "../model/cli-options.js";
import { log } from "../runtime/logging.js";
import type { RunnerCommand } from "./runner-command.js";
import { renderPipelineTemplate } from "./pipeline-templates.js";
import { errorMessage } from "./shared.js";

/** The four options `--create` reads. Narrowing the parameter keeps the command's
 *  dependency on the 35-field `RunnerArgs` visible and lets a test build its input. */
type CreateArgs = Pick<RunnerArgs, "ticket" | "user" | "createCommand" | "createTemplate">;

export interface CreateProjectPipelineOptions {
  projectRoot: string;
  name: string;
  /** Required by templates that run a project command. */
  command?: string;
  /** Template id; defaults to the single shell step. */
  template?: string;
  /** Target the shared kit directory instead of the project directory. */
  shared?: boolean;
}

/**
 * Create a project pipeline without replacing an existing file.
 * Return the absolute path of the new definition.
 */
export function createProjectPipeline(options: CreateProjectPipelineOptions): string {
  const { projectRoot, name, command, template, shared } = options;
  // Rendering validates the name, the template id, and the command, and it runs
  // before anything touches the filesystem: a rejected creation must not leave a
  // half-created kit directory behind.
  const source = renderPipelineTemplate(name, command, template);

  const kitDir = shared ? userKitDir() : projectKitDir(projectRoot);
  if (!kitDir) {
    throw new Error("Shared kit directory not found: neither $PIPELINE_HOME nor HOME is set.");
  }
  const pipelinesDir = resolve(kitDir, "pipelines");
  const target = resolve(pipelinesDir, `${name}.ts`);
  if (dirname(target) !== pipelinesDir) {
    throw new Error(`Pipeline target rejected: ${target}`);
  }

  mkdirSync(pipelinesDir, { recursive: true });
  if (existsSync(target)) {
    throw new Error(`Pipeline already exists; refusing to overwrite: ${target}`);
  }

  try {
    writeFileSync(target, source, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (isErrno(error, "EEXIST")) {
      throw new Error(`Pipeline already exists; refusing to overwrite: ${target}`, { cause: error });
    }
    throw error;
  }
  return target;
}

export const createPipelineCommand: RunnerCommand = {
  id: "create-pipeline",
  flag: "--create",
  key: "create",
  desc: "Create a project pipeline, then install and verify its DSL declarations.",
  run(args: CreateArgs): number {
    const name = args.ticket;
    if (!name) {
      // parseRunnerArgs() normally enforces this, but keep the command safe when
      // called directly by a test.
      log("--create requires a pipeline name.");
      return 1;
    }

    const shared = args.user;
    let target: string;
    try {
      target = createProjectPipeline({
        projectRoot: process.cwd(),
        name,
        command: args.createCommand,
        template: args.createTemplate,
        shared,
      });
    } catch (error) {
      log(errorMessage(error));
      return 1;
    }

    // A shared pipeline is displayed as an absolute path because it is unrelated
    // to the project from which the command was launched.
    const displayPath = shared ? target : relative(process.cwd(), target) || target;
    try {
      if (shared) installUserTypes();
      else installProjectTypes(process.cwd());
    } catch (error) {
      log(`Pipeline created, but type installation failed: ${displayPath}`);
      log(errorMessage(error));
      return 1;
    }

    const result = shared ? typecheckUserPipelines() : typecheckProjectPipelines(process.cwd());
    if (!result.ok) {
      log(`Pipeline created, but project typecheck failed: ${displayPath}`);
      log(result.output);
      return 1;
    }

    log(`Pipeline created and typechecked: ${displayPath}`);
    return 0;
  },
};
