import { describe, expect, test } from "bun:test";
import { linkableUrl } from "./url.js";

describe("linkableUrl", () => {
  test("keeps http and https", () => {
    expect(linkableUrl("https://jira.example.com/browse/AB-12")).toBe("https://jira.example.com/browse/AB-12");
    expect(linkableUrl("http://localhost:8080/issues/3")).toBe("http://localhost:8080/issues/3");
  });

  test("refuses protocols that execute in the page", () => {
    expect(linkableUrl("javascript:alert(document.cookie)")).toBeUndefined();
    expect(linkableUrl("data:text/html,<script>alert(1)</script>")).toBeUndefined();
    expect(linkableUrl("vbscript:msgbox(1)")).toBeUndefined();
  });

  test("refuses protocols that are simply not links", () => {
    expect(linkableUrl("file:///etc/passwd")).toBeUndefined();
    expect(linkableUrl("mailto:someone@example.com")).toBeUndefined();
  });

  test("refuses what does not parse, and the absent value", () => {
    expect(linkableUrl("/browse/AB-12")).toBeUndefined();
    expect(linkableUrl("not a url")).toBeUndefined();
    expect(linkableUrl("")).toBeUndefined();
    expect(linkableUrl(undefined)).toBeUndefined();
    expect(linkableUrl(null)).toBeUndefined();
  });
});
