import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RUNNER_DIR = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

function productionPipelineSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return productionPipelineSources(path);
    return entry.isFile() && path.endsWith(".ts") && !path.endsWith(".test.ts") ? [path] : [];
  });
}

// `authoring`: forms still exported for out-of-repository project pipelines, but
// banned from everything the kit writes or documents—`dsl.ts` still defines them.
const FORBIDDEN_AUTHORING_FORMS: Array<[string, RegExp, ("all" | "authoring")?]> = [
  ["claudeStep", /claudeStep\s*\(/],
  ["when", /\.when\s*\(/],
  ["precondition", /\.precondition\s*\(/],
  ["withClaude", /withClaude\s*\(/],
  ["withCodex", /withCodex\s*\(/],
  ["addAll", /\.addAll\s*\(/],
  ["workItemSourceStep", /\bworkItemSourceStep\b/],
  ["scan.queue", /scan\s*:\s*\{\s*queue/],
  ["_dsl", /_dsl/],
  ["gateStep", /\bgateStep\s*\(/, "authoring"],
  ["preflight", /\.preflight\s*\(/, "authoring"],
  // Failure policies: `onFail` in options is the only form. The six chained methods
  // were removed from `dsl.ts`, not merely deprecated.
  ["withEscalation", /\.withEscalation\s*\(/],
  ["rerunOnFail", /\.rerunOnFail\s*\(/],
  ["fixAndRetry", /\.fixAndRetry\s*\(/],
  ["fixOnly", /\.fixOnly\s*\(/],
  ["fixOnce", /\.fixOnce\s*\(/],
  ["resumeOnce", /\.resumeOnce\s*\(/],
  ["resumeAndFix", /\.resumeAndFix\s*\(/],
  ["llmStep(id, name)", /\bllmStep\s*\(\s*["']/],
  ["bashStep(id, name)", /\bbashStep\s*\(\s*["']/],
  ["actionStep(id, name)", /\bactionStep\s*\(\s*["']/],
];

test("DSL surface: removed authoring forms do not reappear", () => {
  const internalWorkItemSource = join(RUNNER_DIR, "src", "builtin-steps", "lib", "work-item-steps.ts");
  const files = [
    join(RUNNER_DIR, "src", "dsl.ts"),
    join(RUNNER_DIR, "src", "pipeline", "loader.ts"),
    join(RUNNER_DIR, "src", "commands", "create-pipeline.ts"),
    join(RUNNER_DIR, "README.md"),
    ...productionPipelineSources(join(RUNNER_DIR, "src", "builtin-steps")),
  ];
  const violations = files.flatMap((file) => {
    const source = readFileSync(file, "utf8");
    return FORBIDDEN_AUTHORING_FORMS.filter(
      ([name, pattern, scope]) =>
        !(name === "workItemSourceStep" && file === internalWorkItemSource) &&
        (scope !== "authoring" || file !== join(RUNNER_DIR, "src", "dsl.ts")) &&
        pattern.test(source),
    ).map(([name]) => `${file}: ${name}`);
  });

  expect(violations).toEqual([]);
});
