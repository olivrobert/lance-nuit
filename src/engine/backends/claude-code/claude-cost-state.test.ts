import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { netCumulative, readSessionCostBaseline } from "./cost-state.js";

const costState = (costUsd: number, apiDurationMs?: number) =>
  JSON.stringify({
    type: "cost-state",
    sessionId: "s1",
    totalCostUSD: costUsd,
    ...(apiDurationMs != null ? { totalAPIDuration: apiDurationMs } : {}),
  });

function transcript(lines: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "lance-nuit-cost-state-"));
  const path = join(dir, "s1.jsonl");
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

describe("Claude session cost baseline", () => {
  test("reads the last cost-state record of the transcript", () => {
    const path = transcript([
      JSON.stringify({ type: "user", uuid: "u1" }),
      costState(0.6408, 105191),
      JSON.stringify({ type: "assistant", uuid: "a1" }),
      costState(1.1493, 117116),
    ]);
    expect(readSessionCostBaseline("s1", () => path)).toEqual({ costUsd: 1.1493, apiDurationMs: 117116 });
  });

  test("omits an absent API duration and skips a malformed record", () => {
    const path = transcript(["{ not json", costState(0.25)]);
    expect(readSessionCostBaseline("s1", () => path)).toEqual({ costUsd: 0.25 });
  });

  test("returns null without a transcript, without a cost-state, or on a negative total", () => {
    expect(readSessionCostBaseline("s1", () => null)).toBeNull();
    expect(readSessionCostBaseline("s1", () => transcript([JSON.stringify({ type: "user" })]))).toBeNull();
    expect(readSessionCostBaseline("s1", () => transcript([costState(-1)]))).toBeNull();
    expect(readSessionCostBaseline("s1", () => join(tmpdir(), "lance-nuit-missing", "s1.jsonl"))).toBeNull();
  });

  test("netCumulative charges the difference, or the report when it is not cumulative", () => {
    expect(netCumulative(1.1, 0.4)).toBeCloseTo(0.7, 10);
    expect(netCumulative(0.4, 0.4)).toBe(0);
    // Below the baseline: the figure was never cumulative, so it is the real spend.
    expect(netCumulative(0.2, 0.4)).toBeCloseTo(0.2, 10);
  });
});
