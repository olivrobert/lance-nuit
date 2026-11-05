import { describe, expect, test } from "bun:test";
import { ignoresKey, type KeyContext, listKeyOf, stepSelection } from "./keyboard.js";

describe("listKeyOf", () => {
  test("j and the down arrow go to the next row, k and the up arrow to the previous one", () => {
    expect(listKeyOf("j")).toBe("next");
    expect(listKeyOf("ArrowDown")).toBe("next");
    expect(listKeyOf("k")).toBe("previous");
    expect(listKeyOf("ArrowUp")).toBe("previous");
  });

  test("slash asks for the search box; anything else is not ours", () => {
    expect(listKeyOf("/")).toBe("search");
    expect(listKeyOf("J")).toBeNull();
    expect(listKeyOf("Enter")).toBeNull();
  });
});

describe("ignoresKey", () => {
  const onList: KeyContext = {
    key: "j",
    targetTag: "BUTTON",
    targetEditable: false,
    targetInList: true,
    dialogOpen: false,
    inbox: true,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
  };

  test("a key on the page or on a row is the list's", () => {
    expect(ignoresKey(onList)).toBe(false);
    expect(ignoresKey({ ...onList, targetTag: "BODY" })).toBe(false);
    expect(ignoresKey({ ...onList, targetTag: null })).toBe(false);
  });

  test("a key typed in a field belongs to the field", () => {
    expect(ignoresKey({ ...onList, targetTag: "INPUT" })).toBe(true);
    expect(ignoresKey({ ...onList, targetTag: "TEXTAREA" })).toBe(true);
    expect(ignoresKey({ ...onList, targetTag: "DIV", targetEditable: true })).toBe(true);
  });

  test("outside the list the arrows keep scrolling, while j and k still move the selection", () => {
    const inSheet = { ...onList, targetTag: "SUMMARY", targetInList: false };
    expect(ignoresKey({ ...inSheet, key: "ArrowDown" })).toBe(true);
    expect(ignoresKey({ ...inSheet, key: "ArrowUp" })).toBe(true);
    expect(ignoresKey({ ...inSheet, key: "j" })).toBe(false);
    expect(ignoresKey({ ...inSheet, key: "/" })).toBe(false);
    expect(ignoresKey({ ...onList, key: "ArrowDown" })).toBe(false);
  });

  test("an open dialog, the terminal screen and any modifier leave the key alone", () => {
    expect(ignoresKey({ ...onList, dialogOpen: true })).toBe(true);
    expect(ignoresKey({ ...onList, inbox: false })).toBe(true);
    expect(ignoresKey({ ...onList, ctrlKey: true })).toBe(true);
    expect(ignoresKey({ ...onList, metaKey: true })).toBe(true);
    expect(ignoresKey({ ...onList, altKey: true })).toBe(true);
  });
});

describe("stepSelection", () => {
  const rows = ["a", "b", "c"];

  test("moves one row either way", () => {
    expect(stepSelection(rows, "b", "next")).toBe("c");
    expect(stepSelection(rows, "b", "previous")).toBe("a");
  });

  test("stops at either end instead of wrapping", () => {
    expect(stepSelection(rows, "c", "next")).toBe("c");
    expect(stepSelection(rows, "a", "previous")).toBe("a");
  });

  test("a selection outside the rows starts from the end the key points at", () => {
    expect(stepSelection(rows, null, "next")).toBe("a");
    expect(stepSelection(rows, "hidden", "previous")).toBe("c");
  });

  test("no row, no selection", () => {
    expect(stepSelection([], "a", "next")).toBeNull();
  });
});
