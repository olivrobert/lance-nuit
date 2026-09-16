# Output extractors

An extractor turns machine output into the normalized error shape used by a fix
loop:

```ts
export function extract(output: string): { hasErrors: boolean; errors: string } {
  const errors = output
    .split("\n")
    .filter((line) => line.startsWith("ERROR:"))
    .join("\n");
  return { hasErrors: errors.length > 0, errors };
}
```

## Where extractors live

The current registry discovers flat `.ts`/`.js` modules in the runner's
`extractors/` directory. A module must export `extract`; test files and
`registry.ts` are excluded. The project configuration does not currently add a
project-local extractor directory, so a custom extractor must be distributed with
the runner/kit and pass normal pipeline validation before it can be referenced.

Five extractors ship with the runner:

- `tsc` — keeps `error TSxxxx` diagnostics (and their continuation lines) from
  TypeScript compiler output.
- `tests-json` — collects failed assertions from a JSON test report
  (jest/vitest `testResults`, mocha-style `failures`, or a flat `tests` array).
- `phpstan` — reads `phpstan --error-format=json`, rendering one
  `file:line message` per error. Point it at the JSON report, never at the human
  table: on the table it parses nothing, and the fix pass gets a truncated stdout
  dump instead of the error list.
- `phpunit` — reads the JUnit XML PHPUnit writes, rendering each failure as
  `Class::test` plus its message and the head of its trace. Prefer a `report`
  path here: a raw suite output is mostly green tests.
- `infection` — reads Infection's `--logger-json` report and lists the surviving
  mutants (file, line, mutator, diff). With no survivor but a failing exit code
  (MSI below threshold) it lists the uncovered mutants instead, which says what
  to test.

The three PHP extractors tolerate the stdout/stderr noise the runner merges into
a single buffer (PHP deprecations, progress lines): they isolate the report
object rather than parsing the whole stream. When no report is found they return
`hasErrors: false` with the raw output, so the failing exit code stands and the
fix prompt still has material.

## Reports and missing reports

An extractor returns `hasErrors`, the `errors` text, and `reportFound`.
`reportFound` separates the two situations that `hasErrors: false` used to
collapse: `true` says a report was read and holds nothing actionable (a green
suite behind a crashing command), `false` says no report was produced at all (the
declared file was never written, or nothing parsable was found). A report
declared with `report` and missing on disk is `reportFound: false` whatever the
extractor made of the stdout fallback: the file is the evidence.

The field is optional. An extractor that does not set it — `tsc`, which reads
compiler output and has no report to find, or a third-party extractor written
before the field existed — leaves it `undefined`, meaning "does not
distinguish".

Nothing in the runner turns a verdict on `reportFound`: the exit code stays
authoritative and the default behavior above is unchanged. Only the opt-in
`onFail.fixOnlyWhenExtracted` policy reads it, to fail a step without paying for
a repair when there was no error to repair, and to say which of the two cases it
faced. See
[failures, retries, and escalation](failures-retries-escalation.md#repair-only-what-the-extractor-could-read).

If a step names an unavailable extractor, loading/validation fails
with the list of available names. There is no runtime fallback to a different
parser.

## Use from a step

```ts
bashStep({
  id: "tests",
  name: "Tests",
  command: "npm test -- --reporter json",
  report: "reports/tests.json",
  errorExtractor: "tests-json",
  onFail: {
    fix: (ctx) => `Fix the reported failures:\n${ctx.errors}`,
    retries: 2,
  },
});
```

`report` requires `errorExtractor`. Before extraction, the runner reads each
declared report path; if no report contains text (for example, the command crashed
before writing it), it falls back to stdout/stderr output. The extractor's `errors`
are truncated for the default fix context, while the full step output remains in
the attempt log.

The extractor does not decide whether the original command succeeded, and it
cannot suppress a non-zero exit status.
