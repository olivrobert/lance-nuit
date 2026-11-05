import { expect, test } from "bun:test";
import { clearedUserCookie, parseCookies, serializeCookie, USER_COOKIE, userCookie } from "./cookies.js";

test("cookies: a header with several pairs is split on name", () => {
  const cookies = parseCookies("a=1; lancenuit_ui_user=Olivier; b=2");
  expect(cookies.get("a")).toBe("1");
  expect(cookies.get(USER_COOKIE)).toBe("Olivier");
  expect(cookies.get("b")).toBe("2");
});

test("cookies: absent header, empty pairs, and malformed pairs are skipped", () => {
  expect(parseCookies(undefined).size).toBe(0);
  const cookies = parseCookies("; =orphan; novalue; ok=1");
  expect(cookies.get("ok")).toBe("1");
  expect(cookies.size).toBe(1);
});

test("cookies: values are percent-decoded and unquoted", () => {
  expect(parseCookies(`${USER_COOKIE}=Marie%20Curie`).get(USER_COOKIE)).toBe("Marie Curie");
  expect(parseCookies(`${USER_COOKIE}="quoted"`).get(USER_COOKIE)).toBe("quoted");
});

test("cookies: an invalid percent-encoding is kept verbatim rather than dropped", () => {
  expect(parseCookies(`${USER_COOKIE}=100%`).get(USER_COOKIE)).toBe("100%");
});

test("cookies: the first occurrence of a name wins", () => {
  expect(parseCookies("x=first; x=second").get("x")).toBe("first");
});

test("cookies: the identity cookie carries the attributes the spec fixes", () => {
  const header = userCookie("Olivier");
  expect(header).toBe(`${USER_COOKIE}=Olivier; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`);
});

test("cookies: a name with a space cannot break the header it travels in", () => {
  const header = userCookie("Marie Curie");
  expect(header.startsWith(`${USER_COOKIE}=Marie%20Curie;`)).toBe(true);
  expect(parseCookies(header.split(";")[0] as string).get(USER_COOKIE)).toBe("Marie Curie");
});

test("cookies: clearing expires the cookie immediately", () => {
  expect(clearedUserCookie()).toContain("Max-Age=0");
});

test("cookies: attributes are written only when asked for", () => {
  expect(serializeCookie("a", "1")).toBe("a=1");
  expect(serializeCookie("a", "1", { path: "/", sameSite: "Lax" })).toBe("a=1; Path=/; SameSite=Lax");
});
