import { describe, expect, it } from "bun:test";
import { parseGithubIssueRefs, parseGithubPayload } from "./index.js";

describe("github payload parsing", () => {
  it("reads issue numbers in appearance order and removes duplicates", () => {
    expect(parseGithubIssueRefs('[{"number":24},{"number":7},{"number":24}]')).toEqual(["24", "7"]);
  });

  it("ignores malformed issue entries", () => {
    expect(parseGithubIssueRefs('[{"number":"abc"},{"number":0},{"title":"missing number"},{"number":8}]')).toEqual([
      "8",
    ]);
  });

  it("rejects invalid JSON with an operation-specific error", () => {
    expect(() => parseGithubPayload("proxy error", "listing issues")).toThrow(/listing issues/);
  });
});
