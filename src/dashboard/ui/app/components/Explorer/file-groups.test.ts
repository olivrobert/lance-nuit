import { describe, expect, test } from "bun:test";
import type { TreeDirectory, TreeFile, TreeNode } from "../../api/types.js";
import { groupFiles, isMachineFoldOpen, machineFoldKey } from "./file-groups.js";

function file(path: string, extra: Partial<TreeFile> = {}): TreeFile {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return { kind: "file", name, path, size: 1, contentKind: "other", ...extra };
}

function dir(path: string, children: TreeNode[] = []): TreeDirectory {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return { kind: "directory", name, path, children };
}

const names = (nodes: readonly TreeNode[]) => nodes.map((node) => node.name);

describe("groupFiles", () => {
  test("markdown first, other text next, machine files last, each in the listed order", () => {
    const groups = groupFiles([
      dir("lots"),
      file("branch.txt"),
      file("coherence.json"),
      file("plan.md"),
      file("inputs.sha"),
      file("acceptance-report.md"),
      file("screen.png"),
    ]);
    expect(names(groups.documents)).toEqual(["plan.md", "acceptance-report.md"]);
    expect(names(groups.others)).toEqual(["lots", "branch.txt", "screen.png"]);
    expect(names(groups.machine)).toEqual(["coherence.json", "inputs.sha"]);
  });

  test("runs/, .provenance/ and the detached run/ root are machine directories", () => {
    const groups = groupFiles([dir("artifacts"), dir("runs"), dir(".provenance"), dir("run"), file("ticket.md")]);
    expect(names(groups.documents)).toEqual(["ticket.md"]);
    expect(names(groups.others)).toEqual(["artifacts"]);
    expect(names(groups.machine)).toEqual(["runs", ".provenance", "run"]);
  });

  test("a nested directory named run is not the detached run root", () => {
    expect(names(groupFiles([dir("artifacts/run"), file("artifacts/a.md")]).others)).toEqual(["run"]);
  });

  test("extensions match whatever their case", () => {
    const groups = groupFiles([file("NOTES.MD"), file("STATE.JSON"), file("a.txt")]);
    expect(names(groups.documents)).toEqual(["NOTES.MD"]);
    expect(names(groups.machine)).toEqual(["STATE.JSON"]);
  });

  test("the artifact a gate waits on is never folded", () => {
    const groups = groupFiles([file("plan.md"), file("decision.json", { gate: true })]);
    expect(names(groups.others)).toEqual(["decision.json"]);
    expect(groups.machine).toEqual([]);
  });

  test("a directory holding only machine files is listed flat, not folded", () => {
    const groups = groupFiles([file("state.json"), file("run.sha")]);
    expect(groups.machine).toEqual([]);
    expect(names(groups.others)).toEqual(["state.json", "run.sha"]);
  });

  test("an empty directory yields empty groups", () => {
    expect(groupFiles([])).toEqual({ documents: [], others: [], machine: [] });
  });
});

describe("isMachineFoldOpen", () => {
  const machine = [file("artifacts/lots.json"), dir("runs")];

  test("closed by default", () => {
    expect(isMachineFoldOpen("", machine, [], null)).toBe(false);
  });

  test("open when the reader expanded it, keyed by its directory", () => {
    expect(isMachineFoldOpen("", machine, [machineFoldKey("")], null)).toBe(true);
    expect(isMachineFoldOpen("", machine, [machineFoldKey("artifacts")], null)).toBe(false);
  });

  test("open when it holds the selected file, directly or in a folded directory", () => {
    expect(isMachineFoldOpen("", machine, [], "artifacts/lots.json")).toBe(true);
    expect(isMachineFoldOpen("", machine, [], "runs/feature/state.json")).toBe(true);
  });

  test("not open for a sibling that merely shares a prefix", () => {
    expect(isMachineFoldOpen("", machine, [], "runs-old/state.json")).toBe(false);
    expect(isMachineFoldOpen("", machine, [], "plan.md")).toBe(false);
  });

  test("the fold key never collides with a directory path", () => {
    expect(machineFoldKey("runs")).not.toBe("runs");
    expect(machineFoldKey("")).not.toBe("");
  });
});
