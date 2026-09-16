import { afterEach, expect, test } from "bun:test";
import { detectColor, dim, isColorEnabled, red, setColorEnabled, visibleLength } from "./color.js";

afterEach(() => setColorEnabled(false));

test("NO_COLOR wins over a TTY and over FORCE_COLOR", () => {
  expect(detectColor({ NO_COLOR: "1", FORCE_COLOR: "1" }, { isTTY: true })).toBe(false);
  expect(detectColor({ NO_COLOR: "1" }, { isTTY: true })).toBe(false);
});

test("FORCE_COLOR overrides a non-TTY, and 0 disables", () => {
  expect(detectColor({ FORCE_COLOR: "1" }, { isTTY: false })).toBe(true);
  expect(detectColor({ FORCE_COLOR: "0" }, { isTTY: true })).toBe(false);
});

test("without an override the stream decides, and a dumb terminal declines", () => {
  expect(detectColor({}, { isTTY: true })).toBe(true);
  expect(detectColor({}, { isTTY: false })).toBe(false);
  expect(detectColor({}, {})).toBe(false);
  expect(detectColor({ TERM: "dumb" }, { isTTY: true })).toBe(false);
});

test("disabled styles are the identity function, so text is never altered", () => {
  setColorEnabled(false);
  expect(isColorEnabled()).toBe(false);
  expect(red("FAILURE")).toBe("FAILURE");
  expect(dim("2m05s")).toBe("2m05s");
});

test("enabled styles wrap the text and always reset", () => {
  setColorEnabled(true);
  expect(red("x")).toBe("\x1b[31mx\x1b[0m");
  // Styling nothing must not leave a dangling sequence on the line.
  expect(red("")).toBe("");
});

test("visible length ignores the escapes, which is what layout must measure", () => {
  setColorEnabled(true);
  expect(visibleLength(red("stats"))).toBe(5);
  expect(red("stats").length).toBeGreaterThan(5);
  expect(visibleLength("plain")).toBe(5);
});
