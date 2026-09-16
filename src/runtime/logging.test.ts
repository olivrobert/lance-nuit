import { afterEach, expect, test } from "bun:test";
import { log, setLogInterceptor } from "./logging.ts";

afterEach(() => setLogInterceptor(undefined));

/** What reached stderr, and how many times the interceptor ran — the hook the
 *  repainting status line relies on to erase itself before anyone else writes. */
function capture(write: () => void): { lines: string[]; intercepted: number } {
  const original = process.stderr.write.bind(process.stderr);
  const lines: string[] = [];
  let intercepted = 0;
  setLogInterceptor(() => {
    intercepted++;
  });
  process.stderr.write = ((chunk: string) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    write();
  } finally {
    process.stderr.write = original;
    setLogInterceptor(undefined);
  }
  return { lines, intercepted };
}

test("log carries severity as a glyph placed after the message indentation", () => {
  const plain = capture(() => log("nothing to report"));
  expect(plain.lines).toEqual(["nothing to report\n"]);

  const warned = capture(() => log.warn("  budget is close"));
  expect(warned.lines).toEqual(["  ⚠ budget is close\n"]);

  const failed = capture(() => log.error("Run refused: dirty tree"));
  expect(failed.lines).toEqual(["✗ Run refused: dirty tree\n"]);
});

test("the interceptor runs for all three severities, once per line", () => {
  const captured = capture(() => {
    log("info");
    log.warn("warn");
    log.error("error");
  });
  expect(captured.lines).toHaveLength(3);
  expect(captured.intercepted).toBe(3);
});
