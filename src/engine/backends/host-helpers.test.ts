import { expect, test } from "bun:test";
import { lineSplitter } from "./host-helpers.js";

// `lineSplitter` is the single line reassembler of the three agent backends: the
// stdout of `claude`, `codex exec` and `opencode run` is NDJSON, and a pipe
// delivers bytes, not lines. Every fragmentation shape a pipe can produce is
// exercised here, because the runtime — not the runner — decides where a chunk
// ends: a cut line loses one usage record, a duplicated line charges a cost
// twice, and both are invisible in the transcript.

/** Deterministic chunker: identical boundaries on every run, so a failure
 *  reproduces instead of appearing once in a hundred suites. */
function chunksOf(text: string, seed: number, maxSize: number): string[] {
  const parts: string[] = [];
  let state = seed;
  let index = 0;
  while (index < text.length) {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    const size = 1 + (state % maxSize);
    parts.push(text.slice(index, index + size));
    index += size;
  }
  return parts;
}

function collect(chunks: readonly string[], flush = true): string[] {
  const lines: string[] = [];
  const splitter = lineSplitter((line) => lines.push(line));
  for (const chunk of chunks) splitter.push(chunk);
  if (flush) splitter.flush();
  return lines;
}

test("lineSplitter: a JSON line cut between two chunks is delivered once, whole", () => {
  const event = '{"type":"step_finish","part":{"cost":0.25}}';
  const cut = Math.floor(event.length / 2);

  const lines = collect([event.slice(0, cut), `${event.slice(cut)}\n`]);

  expect(lines).toEqual([event]);
  expect(JSON.parse(lines[0]!)).toMatchObject({ type: "step_finish" });
});

test("lineSplitter: a chunk holding several lines delivers them in order", () => {
  const events = ['{"n":1}', '{"n":2}', '{"n":3}'];

  // One write carrying three complete lines plus the head of a fourth: the tail
  // must wait rather than reach the parser truncated.
  const lines = collect([`${events.join("\n")}\n{"n":4`], false);

  expect(lines).toEqual(events);
});

test("lineSplitter: a stream ending without a trailing newline delivers its last line on flush", () => {
  // `printf` without `\n`, or a CLI killed mid-write: the last event holds the
  // final cost and would be dropped if only `\n` released a line.
  const delivered: string[] = [];
  const splitter = lineSplitter((line) => delivered.push(line));

  splitter.push('{"n":1}\n{"n":2}');
  expect(delivered).toEqual(['{"n":1}']);

  splitter.flush();
  expect(delivered).toEqual(['{"n":1}', '{"n":2}']);
});

test("lineSplitter: flush after a newline-terminated stream delivers nothing", () => {
  // Finalization always flushes, including after a clean stream. A flush that
  // re-emitted the buffer would charge the last event's usage twice.
  const delivered: string[] = [];
  const splitter = lineSplitter((line) => delivered.push(line));

  splitter.push('{"n":1}\n');
  splitter.flush();
  splitter.flush();

  expect(delivered).toEqual(['{"n":1}']);
});

test("lineSplitter: a blank tail is dropped, a blank line between events is not swallowed", () => {
  const delivered: string[] = [];
  const splitter = lineSplitter((line) => delivered.push(line));

  splitter.push('{"n":1}\n\n{"n":2}\n   \n  ');
  splitter.flush();

  // The empty line reaches the parser (it costs nothing there: no JSON record),
  // while a whitespace-only tail is not announced as an event.
  expect(delivered).toEqual(['{"n":1}', "", '{"n":2}', "   "]);
});

test("lineSplitter: an NDJSON stream over 1 MB survives arbitrary chunk boundaries", () => {
  // A long agent run streams megabytes of NDJSON through a 64 KB pipe: no line
  // may be lost, duplicated, or reordered whatever the chunk sizes.
  const filler = "x".repeat(180);
  const source = Array.from(
    { length: 6_000 },
    (_unused, index) => `{"type":"text","part":{"id":"prt_${index}","text":"${filler}"}}`,
  );
  const payload = `${source.join("\n")}\n`;
  expect(payload.length).toBeGreaterThan(1_048_576);

  const parts = chunksOf(payload, 7, 70_000);
  expect(parts.length).toBeGreaterThan(20);
  const lines = collect(parts);

  expect(lines).toHaveLength(source.length);
  // Reported as an index rather than a 6000-line diff: a regression names the
  // first line that moved.
  expect(lines.findIndex((line, index) => line !== source[index])).toBe(-1);
});

test("lineSplitter: single-byte chunks reassemble the same lines as one big write", () => {
  const source = ['{"n":1}', '{"n":2}', '{"n":3}'];
  const payload = source.join("\n");

  const byteByByte = collect([...payload]);
  const oneWrite = collect([payload]);

  expect(byteByByte).toEqual(source);
  expect(oneWrite).toEqual(source);
});
