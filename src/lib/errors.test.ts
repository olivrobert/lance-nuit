import { expect, test } from "bun:test";
import { errnoCode, errorMessage, isErrno } from "./errors.js";

test("errorMessage keeps the message of an Error and stringifies anything else", () => {
  expect(errorMessage(new Error("boom"))).toBe("boom");
  expect(errorMessage(new TypeError("bad type"))).toBe("bad type");
  expect(errorMessage("plain string")).toBe("plain string");
  expect(errorMessage(42)).toBe("42");
  expect(errorMessage(null)).toBe("null");
  expect(errorMessage(undefined)).toBe("undefined");
});

test("errorMessage does not read `message` off a non-Error", () => {
  // A rejected value shaped like an error is not one: reporting its `message`
  // would hide that the thrown value was never an Error.
  expect(errorMessage({ message: "looks like an error" })).toBe("[object Object]");
});

test("isErrno matches the code of a system error", () => {
  const error: NodeJS.ErrnoException = new Error("no such file");
  error.code = "ENOENT";
  expect(isErrno(error, "ENOENT")).toBe(true);
  expect(isErrno(error, "EEXIST")).toBe(false);
});

test("isErrno rejects values that carry no usable code", () => {
  expect(isErrno(new Error("plain"), "ENOENT")).toBe(false);
  expect(isErrno({ path: "/tmp/x" }, "ENOENT")).toBe(false);
  expect(isErrno("ENOENT", "ENOENT")).toBe(false);
  expect(isErrno(null, "ENOENT")).toBe(false);
  expect(isErrno(undefined, "ENOENT")).toBe(false);
  expect(isErrno({ code: 2 }, "ENOENT")).toBe(false);
});

test("isErrno never narrows an error that carries no code at all", () => {
  // `code` is typed NonNullable so `isErrno(error, undefined)` does not compile.
  // This guards the runtime half of that promise: an errno-less Error must not
  // match, whatever code is asked for.
  const plain = new Error("no syscall involved");
  for (const code of ["ENOENT", "EEXIST", "EPERM", ""]) {
    expect(isErrno(plain, code)).toBe(false);
  }
  expect(errnoCode(plain)).toBeUndefined();
});

test("errnoCode reports the code without branching on it", () => {
  const error: NodeJS.ErrnoException = new Error("denied");
  error.code = "EPERM";
  expect(errnoCode(error)).toBe("EPERM");
  expect(errnoCode(new Error("plain"))).toBeUndefined();
  expect(errnoCode("EPERM")).toBeUndefined();
  expect(errnoCode(null)).toBeUndefined();
});
