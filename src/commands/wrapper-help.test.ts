import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FLAGS } from "../model/cli-options.js";
import { renderWrapperHelp, WRAPPER_COMMANDS } from "./wrapper-help.js";

const RUNNER_DIR = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/**
 * Verbs the wrapper actually routes, read from its `case` labels.
 *
 * `  run)` / `  help|--help|-h)` at two-space indentation; `*)` is the fallback
 * branch, not a verb.
 */
function wrapperVerbs(): Set<string> {
  const script = readFileSync(join(RUNNER_DIR, "bin", "lancenuit"), "utf8");
  const verbs = new Set<string>();
  for (const match of script.matchAll(/^ {2}([a-z|*-]+)\)$/gm)) {
    for (const label of (match[1] as string).split("|")) {
      if (label !== "*") verbs.add(label);
    }
  }
  return verbs;
}

test("wrapper registry: declared verbs are exactly the verbs the script routes", () => {
  const declared = new Set(WRAPPER_COMMANDS.flatMap((command) => [command.verb, ...(command.aliases ?? [])]));
  expect([...wrapperVerbs()].sort()).toEqual([...declared].sort());
});

test("wrapper registry: every declared flag exists in the FLAGS registry", () => {
  const known = new Set(FLAGS.map((flag) => flag.long));
  for (const command of WRAPPER_COMMANDS) {
    if (command.flag) expect(known).toContain(command.flag);
  }
});

test("wrapper help: options are derived, never duplicated as verbs", () => {
  const help = renderWrapperHelp();
  // Only the left column matters: a flag may legitimately be NAMED inside another
  // option's description (`--run` mentions `--inspect`).
  const listed = new Set(
    help
      .split("\n")
      .map((line) => line.match(/^ {2}(--[a-z-]+)/)?.[1])
      .filter((flag): flag is string => !!flag),
  );

  // A flag exposed as a verb is not repeated in the options list.
  for (const owned of ["--lint-pipeline", "--inspect", "--logs", "--clean", "--create", "--typecheck", "--approve"]) {
    expect(listed).not.toContain(owned);
  }
  // A flag with no verb still has to reach the wrapper user.
  expect(listed).toContain("--worktree");
  expect(listed).toContain("--allow-dirty");
  // Descriptions come from FLAGS itself.
  const worktree = FLAGS.find((flag) => flag.long === "--worktree");
  expect(help).toContain(worktree?.desc ?? "missing");
  // Hidden parser flags stay hidden.
  expect(listed).not.toContain("--wrapper-help");
  expect(listed).not.toContain("--types-install");
});

test("wrapper help: the script delegates instead of carrying its own text", () => {
  const script = readFileSync(join(RUNNER_DIR, "bin", "lancenuit"), "utf8");
  expect(script).toContain("--wrapper-help");
  expect(script).not.toContain("Common options (passed to the runner)");
});
