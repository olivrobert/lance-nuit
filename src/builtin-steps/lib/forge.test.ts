import { describe, expect, it } from "bun:test";
import { mergeRequestUrlAsync } from "./forge.js";

const ok = (output: string) => async () => ({ ok: true, output });

describe("mergeRequestUrlAsync", () => {
  it("queries the GitLab API filtered by source branch, not `mr view --output`", async () => {
    let seen = "";
    await mergeRequestUrlAsync(async (cmd: string) => {
      seen = cmd;
      return { ok: true, output: "[]" };
    });
    expect(seen).toStartWith("glab api ");
    expect(seen).toContain("source_branch=:branch");
    // Regression: this flag does not exist in glab and broke every delivery.
    expect(seen).not.toContain("--output");
  });

  it("extracts the first web_url from an MR array", async () => {
    const output = `[{"iid":12,"web_url":"https://git.example/g/p/-/merge_requests/12"}]`;
    expect(await mergeRequestUrlAsync(ok(output))).toBe("https://git.example/g/p/-/merge_requests/12");
  });

  it("also accepts a single object", async () => {
    expect(await mergeRequestUrlAsync(ok(`{"web_url":"https://git.example/mr/3"}`))).toBe("https://git.example/mr/3");
  });

  it("returns an empty string when no MR matches the branch", async () => {
    expect(await mergeRequestUrlAsync(ok("[]"))).toBe("");
  });

  it("ignores the stderr block appended by runBashAsync", async () => {
    const output = `[{"web_url":"https://git.example/mr/3"}]\n--- stderr ---\nwarn: token expires soon\n`;
    expect(await mergeRequestUrlAsync(ok(output))).toBe("https://git.example/mr/3");
  });

  // All four degraded cases return "": code is already pushed, so a missing URL is
  // information to publish, never a failure.
  it("returns an empty string when glab fails", async () => {
    expect(await mergeRequestUrlAsync(async () => ({ ok: false, output: "no merge request found" }))).toBe("");
  });

  it("diagnoses missing glab by injection without failing the best-effort path", async () => {
    const warnings: string[] = [];
    const result = await mergeRequestUrlAsync(async () => ({ ok: false, output: "bash: glab: command not found" }), {
      warn: (message) => warnings.push(message),
    });
    expect(result).toBe("");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/GitLab/i);
    expect(warnings[0]).toMatch(/glab/);
    expect(warnings[0]).toMatch(/required/i);
  });

  it("returns an empty string for invalid JSON", async () => {
    expect(await mergeRequestUrlAsync(ok("not json"))).toBe("");
  });

  it("returns an empty string when web_url is missing", async () => {
    expect(await mergeRequestUrlAsync(ok(`[{"iid":12}]`))).toBe("");
  });

  it("returns an empty string when web_url is not a string", async () => {
    expect(await mergeRequestUrlAsync(ok(`[{"web_url":null}]`))).toBe("");
  });

  it("returns an empty string for JSON that is not an object", async () => {
    expect(await mergeRequestUrlAsync(ok("42"))).toBe("");
    expect(await mergeRequestUrlAsync(ok("null"))).toBe("");
  });
});
