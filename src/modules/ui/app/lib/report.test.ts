import { describe, expect, test } from "bun:test";
import type { RunReport } from "../api/types.js";
import { captureNumbers, capturePath, leftForYou, reviewText } from "./report.js";

describe("report helpers", () => {
  const report: RunReport = {
    version: 1,
    runId: "run-1",
    followUps: [{ text: "Run quality-push", detail: "full mutation still to play", source: "retrospective.md" }],
    criteria: [
      { id: "AC-1", text: "grouped", met: true, proof: ["test"], captures: ["reports/a/02.png"] },
      { id: "AC-3", text: "last action", met: true, proof: ["test"], reserve: "only one upload played" },
      { id: "AC-4", text: "creation date", met: false, proof: [], reserve: "not proved" },
    ],
    captures: [
      {
        dir: "reports/a",
        files: [
          { name: "01.png", acs: ["AC-2"] },
          { name: "02.png", acs: ["AC-1"] },
        ],
      },
      {
        dir: "reports/b",
        files: [
          { name: "01.png", acs: [] },
          { name: "03.png", acs: ["AC-6"] },
        ],
      },
    ],
  };

  test("left for you lists the follow-ups, then every reserve with its criterion", () => {
    expect(leftForYou(report)).toEqual([
      { text: "Run quality-push", detail: "full mutation still to play", source: "retrospective.md" },
      { text: "Reserve on AC-3", detail: "only one upload played", criterion: "AC-3" },
      { text: "Reserve on AC-4", detail: "not proved", criterion: "AC-4" },
    ]);
    expect(leftForYou({ version: 1, runId: "run-1" })).toEqual([]);
  });

  test("captures are numbered in report order by path, so two lots' same file name stay distinct", () => {
    expect([...captureNumbers(report)]).toEqual([
      ["reports/a/01.png", "01"],
      ["reports/a/02.png", "02"],
      ["reports/b/01.png", "03"],
      ["reports/b/03.png", "04"],
    ]);
    expect(captureNumbers({ version: 1, runId: "run-1" }).size).toBe(0);
    expect(
      captureNumbers({
        version: 1,
        runId: "run-1",
        captures: [
          { dir: "shots/", files: [{ name: "a.png", acs: [] }] },
          { dir: "shots", files: [{ name: "a.png", acs: [] }] },
        ],
      }),
    ).toEqual(new Map([["shots/a.png", "01"]]));
  });

  test("a capture path joins the directory and the name", () => {
    expect(capturePath("reports/screens/", "01.png")).toBe("reports/screens/01.png");
    expect(capturePath("", "01.png")).toBe("01.png");
  });

  test("the review list copies as plain text", () => {
    const text = reviewText({
      title: "Assumptions for the PO",
      items: [{ ref: "AC-1", text: "kept" }, { text: "tie" }],
    });
    expect(text).toBe("Assumptions for the PO\n\n- AC-1: kept\n- tie");
  });
});
