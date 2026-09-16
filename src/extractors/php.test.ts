import { describe, expect, test } from "bun:test";
import { extract as infection } from "./infection.js";
import { extract as phpstan } from "./phpstan.js";
import { extract as phpunit } from "./phpunit.js";

// The runner merges stdout and stderr into one buffer: the fixtures reproduce
// that noise, otherwise the extractors are tested against a stream that never
// occurs in practice.
const STDERR_NOISE = "PHP Deprecated: Implicit conversion in vendor/foo.php on line 12\n";

const PHPSTAN_REPORT = {
  totals: { errors: 0, file_errors: 1 },
  files: { "src/Foo.php": { errors: 1, messages: [{ message: "Invalid type", line: 12, ignorable: true }] } },
  errors: [],
};

// Real `--logger-json` shape: arrays per status, coordinates under `mutator`.
const INFECTION_REPORT = {
  stats: { totalMutantsCount: 3, killedCount: 2, escapedCount: 1, timeOutCount: 0, msi: 66.67 },
  escaped: [
    {
      mutator: {
        mutatorName: "Plus",
        originalSourceCode: "$a + $b",
        mutatedSourceCode: "$a - $b",
        originalFilePath: "src/Foo.php",
        originalStartingLine: 18,
      },
      diff: "--- Original\n+++ New\n-        return $a + $b;\n+        return $a - $b;",
    },
  ],
  timeouted: [],
  killed: [],
  errored: [],
  notCovered: [],
};

describe("phpstan extractor", () => {
  test("reads the JSON report despite stderr noise", () => {
    const result = phpstan(STDERR_NOISE + JSON.stringify(PHPSTAN_REPORT));
    expect(result).toMatchObject({ hasErrors: true });
    expect(result.errors).toContain("src/Foo.php:12 Invalid type");
  });

  test("empty report yields no errors", () => {
    const clean = { totals: { errors: 0, file_errors: 0 }, files: {}, errors: [] };
    expect(phpstan(STDERR_NOISE + JSON.stringify(clean)).hasErrors).toBe(false);
  });

  test("non-JSON output extracts nothing but keeps the output for the fix", () => {
    const result = phpstan("PHP Fatal error: Allowed memory size exhausted");
    expect(result.hasErrors).toBe(false);
    expect(result.errors).toContain("memory size exhausted");
  });

  test("errors outside any file are reported too", () => {
    const report = { totals: { errors: 1, file_errors: 0 }, files: {}, errors: ["Broken autoload"] };
    const result = phpstan(JSON.stringify(report));
    expect(result.hasErrors).toBe(true);
    expect(result.errors).toContain("Broken autoload");
  });
});

describe("phpunit extractor", () => {
  test("reads failures and errors from the JUnit XML", () => {
    const junit = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="App" tests="2" failures="1" errors="0">
    <testcase name="it works" class="App\\FooTest"/>
    <testcase name="it fails" class="App\\FooTest">
      <failure type="PHPUnit\\Framework\\ExpectationFailedException">Failed asserting that false is true.</failure>
    </testcase>
  </testsuite>
</testsuites>`;
    const result = phpunit(`PHPUnit 11.0.0 by Sebastian Bergmann.\n${junit}`);
    expect(result).toMatchObject({ hasErrors: true });
    expect(result.errors).toContain("Failed asserting that false is true.");
  });

  // PHPUnit >= 9: the <testsuites> root has NO attribute, the counters live on
  // the nested <testsuite>. With no detailed block at all, only the counter can
  // reveal the failure, and the raw output is all the fix pass gets.
  test("a nested testsuite counter without a detailed block still fails", () => {
    const junit = `<testsuites>
  <testsuite name="App" tests="2" failures="1" errors="0"/>
</testsuites>`;
    const result = phpunit(junit);
    expect(result.hasErrors).toBe(true);
    expect(result.errors).toContain('failures="1"');
  });

  // A <failure/> written self-closing carries no message, but it does name a
  // failing test, which is more than a counter says.
  test("a self-closing failure is still named", () => {
    const junit = `<testsuites>
  <testsuite name="App" tests="2" failures="1" errors="0">
    <testcase name="it fails" class="App\\FooTest"><failure type="X"/></testcase>
  </testsuite>
</testsuites>`;
    const result = phpunit(junit);
    expect(result.hasErrors).toBe(true);
    expect(result.errors).toContain("App\\FooTest::it fails");
  });

  test("a CDATA section carries the message of a failure and of an error", () => {
    const junit = `<testsuites><testsuite name="App" tests="2" failures="1" errors="1">
    <testcase name="test_render" class="App\\ViewTest"><failure type="X"><![CDATA[Failed asserting that <p>a & b</p> is empty.]]></failure></testcase>
    <testcase name="test_boot" class="App\\BootTest"><error type="Y"><![CDATA[Undefined index "id" & no fallback.]]></error></testcase>
  </testsuite></testsuites>`;
    const errors = phpunit(junit).errors;
    expect(errors).toContain("App\\ViewTest::test_render");
    expect(errors).toContain("Failed asserting that <p>a & b</p> is empty.");
    expect(errors).toContain("App\\BootTest::test_boot");
    expect(errors).toContain('Undefined index "id" & no fallback.');
  });

  // A data provider label can hold a `>`: it ends no tag, it is attribute text.
  test("a greater-than sign inside an attribute does not end the tag", () => {
    const junit = `<testsuites><testsuite name="App" tests="1" failures="1">
    <testcase name="test_sort with data set &quot;a > b&quot;" class="App\\SortTest"><failure type="X">Failed asserting that false is true.</failure></testcase>
  </testsuite></testsuites>`;
    const errors = phpunit(junit).errors;
    expect(errors).toContain('App\\SortTest::test_sort with data set "a > b"');
    expect(errors).toContain("Failed asserting that false is true.");
  });

  test("the attribute order on a testcase does not matter", () => {
    const junit = `<testsuites><testsuite name="App" tests="2" failures="2">
    <testcase time="0.01" class="App\\OneTest" line="7" name="test_one"><failure type="X">first</failure></testcase>
    <testcase name="test_two" file="/app/tests/TwoTest.php" class="App\\TwoTest"><failure type="X">second</failure></testcase>
  </testsuite></testsuites>`;
    const errors = phpunit(junit).errors;
    expect(errors).toContain("App\\OneTest::test_one");
    expect(errors).toContain("App\\TwoTest::test_two");
  });

  test("a testcase without class nor name falls back to its file, then to a placeholder", () => {
    const junit = `<testsuites><testsuite name="App" tests="2" failures="2">
    <testcase file="/app/tests/BootTest.php"><failure type="X">boot failed</failure></testcase>
    <testcase><failure type="X">nameless</failure></testcase>
  </testsuite></testsuites>`;
    const errors = phpunit(junit).errors;
    expect(errors).toContain("/app/tests/BootTest.php");
    expect(errors).toContain("unknown test");
  });

  // The runner kills a suite that hangs: the report is then cut mid-write. The
  // extractor must not throw, and must keep the testcases already written.
  test("XML cut in the middle of a failure body keeps the complete testcases", () => {
    const junit = `<testsuites><testsuite name="App" tests="9" failures="2">
    <testcase name="test_first" class="App\\CartTest"><failure type="X">Failed asserting that 12 matches expected 10.</failure></testcase>
    <testcase name="test_second" class="App\\CartTest"><failure type="X">Failed asserting that`;
    const result = phpunit(junit);
    expect(result.hasErrors).toBe(true);
    expect(result.errors).toContain("App\\CartTest::test_first");
    expect(result.errors).toContain("matches expected 10");
  });

  test("XML cut in the middle of a tag falls back instead of throwing", () => {
    const junit = `<testsuites><testsuite name="App" tests="9" failures="2">
    <testcase name="test_first" class="App\\CartTest"><failure type="X">Failed asserting that 12 matches expected 10.</failure></testcase>
    <testcase name="test_second" cla`;
    const result = phpunit(junit);
    expect(result.hasErrors).toBe(true);
    expect(result.errors).toContain("App\\CartTest::test_first");
  });

  // Nothing parsable is left, but the counter written before the cut is.
  test("XML cut before any testcase still reports the suite counter", () => {
    const junit = '<testsuites><testsuite name="App" tests="9" failures="2"><testcas';
    const result = phpunit(junit);
    expect(result.hasErrors).toBe(true);
    expect(result.errors).toContain('failures="2"');
  });

  // A bare assertion message does not say what to fix: the test name lives on
  // the parent <testcase>, never inside the <failure> block.
  test("every failure is named by its class and test", () => {
    const junit = `<testsuites><testsuite name="App" tests="1" failures="1">
    <testcase name="test_total_ht" class="App\\CartTest" line="42">
      <failure type="X">Failed asserting that 12 matches expected 10.</failure>
    </testcase>
  </testsuite></testsuites>`;
    const result = phpunit(junit);
    expect(result.errors).toContain("App\\CartTest::test_total_ht");
    expect(result.errors).toContain("matches expected 10");
  });

  // Green tests are written `<testcase ... />`: their tag must not open the
  // block of the next failure, which would inherit a wrong name.
  test("a self-closing green test before a failure does not steal its name", () => {
    const junit = `<testsuites><testsuite name="App" tests="2" failures="1">
    <testcase name="test_green" class="App\\OtherTest" assertions="3" time="0.001"/>
    <testcase name="test_red" class="App\\CartTest">
      <failure type="X">Failed asserting that false is true.</failure>
    </testcase>
  </testsuite></testsuites>`;
    const errors = phpunit(junit).errors;
    expect(errors).toContain("App\\CartTest::test_red");
    expect(errors).not.toContain("OtherTest");
    expect(errors).not.toContain("test_green");
  });

  // PHPUnit opens the <failure> block with the test name the header carries.
  test("the test name is not paid for twice", () => {
    const junit = `<testsuites><testsuite name="App" tests="1" failures="1">
    <testcase name="test_total" class="App\\CartTest"><failure type="X">App\\CartTest::test_total
Failed asserting that 12 matches expected 10.</failure></testcase>
  </testsuite></testsuites>`;
    const errors = phpunit(junit).errors;
    expect(errors.match(/App\\CartTest::test_total/g)).toHaveLength(1);
    expect(errors).toContain("matches expected 10");
  });

  test("the total precedes truncation, so a fix cannot believe the list complete", () => {
    const cases = Array.from(
      { length: 40 },
      (_, i) =>
        `<testcase name="test_${i}" class="App\\BigTest"><failure type="X">${"verbose failure ".repeat(20)}</failure></testcase>`,
    ).join("");
    const result = phpunit(
      `<testsuites><testsuite name="App" tests="40" failures="40">${cases}</testsuite></testsuites>`,
    );
    expect(result.errors.startsWith("40 failing tests:")).toBe(true);
    expect(result.errors).toContain("truncated");
  });

  test("a long trace is cut, the message stays", () => {
    const trace = ["Failure message", ...Array.from({ length: 30 }, (_, i) => `#${i} /app/vendor/frame.php:1`)].join(
      "\n",
    );
    const junit = `<testsuites><testsuite name="App" tests="1" failures="1">
    <testcase name="t" class="App\\T"><failure type="X">${trace}</failure></testcase>
  </testsuite></testsuites>`;
    const result = phpunit(junit);
    expect(result.errors).toContain("Failure message");
    expect(result.errors).toContain("trace lines");
    expect(result.errors).not.toContain("#29");
  });

  test("XML entities in the message are rendered as readable PHP", () => {
    const junit = `<testsuites><testsuite name="App" tests="1" failures="1">
    <testcase name="t" class="App\\T"><failure type="X">Expected &lt;p&gt;ok&lt;/p&gt; &amp;&amp; true</failure></testcase>
  </testsuite></testsuites>`;
    expect(phpunit(junit).errors).toContain("Expected <p>ok</p> && true");
  });

  test("numeric character references are rendered too", () => {
    const junit = `<testsuites><testsuite name="App" tests="1" failures="1">
    <testcase name="t" class="App\\T"><failure type="X">Expected &#960; got &#x41;</failure></testcase>
  </testsuite></testsuites>`;
    expect(phpunit(junit).errors).toContain("Expected π got A");
  });

  test("a green suite yields no errors", () => {
    const junit =
      '<testsuites><testsuite name="App" tests="2" failures="0" errors="0"><testcase name="ok"/></testsuite></testsuites>';
    expect(phpunit(junit).hasErrors).toBe(false);
  });

  test("output that is not JUnit XML falls back to the raw output", () => {
    const result = phpunit("PHP Fatal error: class not found");
    expect(result.hasErrors).toBe(false);
    expect(result.errors).toContain("class not found");
  });
});

describe("infection extractor", () => {
  test("reads escaped mutants from a real --logger-json report", () => {
    const result = infection(`Running initial test suite...\n.....\n${JSON.stringify(INFECTION_REPORT)}`);
    expect(result).toMatchObject({ hasErrors: true });
    expect(result.errors).toContain("src/Foo.php:18");
    expect(result.errors).toContain("Plus");
  });

  test("no escaped mutant yields no errors", () => {
    const report = { ...INFECTION_REPORT, stats: { ...INFECTION_REPORT.stats, escapedCount: 0 }, escaped: [] };
    expect(infection(`progress\n${JSON.stringify(report)}`).hasErrors).toBe(false);
  });

  // Key actually emitted by Infection's JsonReporter: `originalStartLine`.
  test("the mutant line is read whichever key the logger uses", () => {
    const withStartLine = {
      stats: { escapedCount: 1 },
      escaped: [{ mutator: { mutatorName: "Multiplication", originalFilePath: "src/Vat.php", originalStartLine: 14 } }],
    };
    expect(infection(JSON.stringify(withStartLine)).errors).toContain("src/Vat.php:14");
  });

  test("with no survivor, the uncovered mutants say what to test", () => {
    const report = {
      stats: { escapedCount: 0, notCoveredCount: 1, msi: 98 },
      escaped: [],
      timeouted: [],
      uncovered: [{ mutator: { mutatorName: "Plus", originalFilePath: "src/New.php", originalStartLine: 8 } }],
    };
    const result = infection(JSON.stringify(report));
    // The exit code (MSI below threshold) stays the sole judge of the failure.
    expect(result.hasErrors).toBe(false);
    expect(result.errors).toContain("not covered");
    expect(result.errors).toContain("src/New.php:8");
  });

  test("an escaped counter without detail still fails", () => {
    const result = infection(JSON.stringify({ stats: { escapedCount: 2 } }));
    expect(result.hasErrors).toBe(true);
    expect(result.errors).toContain("2 escaped mutant");
  });

  test("a flat mutants array is tolerated", () => {
    const report = {
      mutants: [
        { status: "killed", mutator: { mutatorName: "Plus", originalFilePath: "src/A.php", originalStartLine: 1 } },
        { status: "escaped", mutator: { mutatorName: "Minus", originalFilePath: "src/B.php", originalStartLine: 2 } },
      ],
    };
    const result = infection(JSON.stringify(report));
    expect(result.hasErrors).toBe(true);
    expect(result.errors).toContain("src/B.php:2");
    expect(result.errors).not.toContain("src/A.php");
  });
});
