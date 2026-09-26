import { describe, expect, test } from "bun:test";
import type { TreeFile, TreeNode, WorkItemTree } from "../api/types.js";
import { splitKey } from "./items.js";
import { countFiles, findAssumptions, hasAssumptionContent, mimeOf, screenshotGroups } from "./work-item-tree.js";
import { TREE } from "./testing.js";

describe("screenshotGroups", () => {
  function file(path: string, contentKind: TreeFile["contentKind"] = "png"): TreeFile {
    return { kind: "file", name: path.split("/").at(-1) ?? path, path, size: 1, contentKind };
  }

  test("images of reports/ are grouped by directory, with the summary beside them", () => {
    const tree: WorkItemTree = {
      ...TREE,
      children: [
        { kind: "directory", name: "artifacts", path: "artifacts", children: [file("artifacts/mockup.png")] },
        {
          kind: "directory",
          name: "reports",
          path: "reports",
          children: [
            {
              kind: "directory",
              name: "screenshots",
              path: "reports/screenshots",
              children: [
                file("reports/screenshots/01.png"),
                file("reports/screenshots/summary.md", "md"),
                file("reports/screenshots/02.png"),
              ],
            },
            file("reports/constraints.md", "md"),
          ],
        },
      ],
    };

    expect(screenshotGroups(tree)).toEqual([
      {
        dir: "reports/screenshots",
        images: [file("reports/screenshots/01.png"), file("reports/screenshots/02.png")],
        summary: file("reports/screenshots/summary.md", "md"),
      },
    ]);
  });

  test("no tree, or no reports/, means no screenshots", () => {
    expect(screenshotGroups(null)).toEqual([]);
    expect(screenshotGroups(TREE)).toEqual([]);
  });
});

describe("the explorer helpers", () => {
  const nodes: TreeNode[] = [
    { kind: "file", name: "ticket.md", path: "ticket.md", size: 10, contentKind: "md" },
    {
      kind: "directory",
      name: "artifacts",
      path: "artifacts",
      children: [
        { kind: "file", name: "plan.md", path: "artifacts/plan.md", size: 20, contentKind: "md" },
        {
          kind: "directory",
          name: "deep",
          path: "artifacts/deep",
          children: [
            {
              kind: "file",
              name: "assumptions.json",
              path: "artifacts/deep/assumptions.json",
              size: 5,
              contentKind: "json",
            },
          ],
        },
      ],
    },
  ];

  test("countFiles walks the whole subtree", () => {
    expect(countFiles(nodes[1] as TreeNode)).toBe(2);
    expect(countFiles(nodes[0] as TreeNode)).toBe(1);
  });

  test("findAssumptions reaches a nested file, and answers undefined when there is none", () => {
    expect(findAssumptions(nodes)?.path).toBe("artifacts/deep/assumptions.json");
    expect(findAssumptions([nodes[0] as TreeNode])).toBeUndefined();
  });

  test("hasAssumptionContent is false for an empty or absent file", () => {
    expect(hasAssumptionContent(null)).toBe(false);
    expect(hasAssumptionContent({ blocking: [], resolved: [] })).toBe(false);
    expect(hasAssumptionContent({ resolved: [{ subject: "s" }] })).toBe(true);
  });
});

describe("splitKey and mimeOf", () => {
  test("a key splits on its first separator", () => {
    expect(splitKey("web/ABC-1")).toEqual(["web", "ABC-1"]);
    expect(splitKey("web/nested/ABC-1")).toEqual(["web", "nested/ABC-1"]);
    expect(splitKey("web")).toEqual(["web", ""]);
  });

  test("an image extension picks its type, and anything else is a PNG", () => {
    expect(mimeOf("a/b.JPG")).toBe("image/jpeg");
    expect(mimeOf("a/b.jpeg")).toBe("image/jpeg");
    expect(mimeOf("a/b.gif")).toBe("image/gif");
    expect(mimeOf("a/b.webp")).toBe("image/webp");
    expect(mimeOf("a/b.png")).toBe("image/png");
  });
});
