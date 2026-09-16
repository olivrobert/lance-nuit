import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAssumptionsArtifact, parseTriageArtifact, read } from "./artifacts.ts";

function tmpFile(content: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), "artifacts-"));
  const file = join(dir, "triage.json");
  if (content != null) writeFileSync(file, content);
  return file;
}

test("read: valid file → typed object", () => {
  const file = tmpFile(JSON.stringify({ verdict: "proceed", complexity: "trivial" }));
  const t = read(file, parseTriageArtifact);
  expect(t?.verdict).toBe("proceed");
  expect(t?.complexity).toBe("trivial");
});

test("read: missing file → undefined", () => {
  expect(read(tmpFile(null), parseTriageArtifact)).toBeUndefined();
});

test("read: corrupt JSON → throw (precondition fails with a reason)", () => {
  const file = tmpFile("{not json");
  expect(() => read(file, parseTriageArtifact)).toThrow();
});

test("read: unsafe slug → throw before any git branch", () => {
  const file = tmpFile(JSON.stringify({ slug: "../../hors-repo" }));
  expect(() => read(file, parseTriageArtifact)).toThrow(/invalid slug/);
});

test("parseAssumptionsArtifact: typed assumptions", () => {
  const a = parseAssumptionsArtifact({
    blocking: [{ ac: "AC-3", subject: "quota exceeded", assumed: "silent refusal" }],
  });
  expect(a.blocking).toEqual([{ ac: "AC-3", subject: "quota exceeded", assumed: "silent refusal" }]);
});

test("parseAssumptionsArtifact: missing or malformed blocking → throw (never default to zero assumptions)", () => {
  // Unlike triage.json, a run decision depends on this artifact. Degrading to
  // undefined would mean "no assumptions" and let the ticket pass.
  expect(() => parseAssumptionsArtifact({})).toThrow(/blocking/);
  expect(() => parseAssumptionsArtifact({ blocking: "oui" })).toThrow(/blocking/);
  expect(() => parseAssumptionsArtifact({ blocking: [{ subject: "a" }, "b"] })).toThrow();
});

test("parseAssumptionsArtifact: resolved carries the code answer and evidence", () => {
  // Counterpart to `blocking`: an ambiguity already settled by the repo need not
  // remove the ticket from automation. The field makes the search verifiable.
  const a = parseAssumptionsArtifact({
    blocking: [],
    resolved: [{ subject: "duplicate email", answer: "409 rejection", evidence: "src/User.php:88" }],
  });
  expect(a.resolved).toEqual([{ subject: "duplicate email", answer: "409 rejection", evidence: "src/User.php:88" }]);
});

test("parseAssumptionsArtifact: informational resolved — malformed shape does not break the step", () => {
  // No gate reads it: unreadable `resolved` must not fail a step that correctly
  // produced `blocking`, or qualification becomes a risk.
  expect(parseAssumptionsArtifact({ blocking: [], resolved: "oui" }).resolved).toBeUndefined();
  expect(parseAssumptionsArtifact({ blocking: [], resolved: ["x"] }).resolved).toBeUndefined();
  expect(parseAssumptionsArtifact({ blocking: [], resolved: [{ subject: 3 }] }).resolved).toEqual([
    { subject: undefined, answer: undefined, evidence: undefined },
  ]);
});

test("parseAssumptionsArtifact: malformed entry → undefined fields, degraded note", () => {
  const a = parseAssumptionsArtifact({ blocking: [{ ac: 3, subject: null }] });
  expect(a.blocking).toEqual([{ subject: undefined, assumed: undefined, ac: undefined }]);
});
