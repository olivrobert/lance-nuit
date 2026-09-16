import { describe, expect, it } from "bun:test";
import { redactProviderOutput } from "./index.js";
import { ko, messageOf, stubbed } from "./test-harness.js";

describe("jira gateway — redaction", () => {
  it("reports provider spawn failures", async () => {
    const { gateway } = stubbed(ko("spawn acli ENOENT", 127));
    const message = await messageOf(gateway.findCandidates({ queue: "bugTodo", state: "todo" }));
    expect(message).toMatch(/Jira/i);
    expect(message).toMatch(/acli/);
    expect(message).toMatch(/required/i);
  });

  it("filters secrets from provider output before propagating it", async () => {
    const leak =
      "401 Unauthorized — Authorization: Bearer ATATT3xFfGF0T4xSecretValue123 (https://bot:hunter2@corp.atlassian.net/rest/api/3/search?token=abcdef123456)";
    const { gateway } = stubbed(ko(leak));
    const message = await messageOf(gateway.findCandidates({ queue: "bugTodo", state: "todo" }));
    expect(message).not.toContain("ATATT3xFfGF0T4xSecretValue123");
    expect(message).not.toContain("hunter2");
    expect(message).not.toContain("abcdef123456");
    expect(message).toContain("[redacted]");
    // Keep the diagnostic readable: preserve the error code and host.
    expect(message).toContain("401 Unauthorized");
    expect(message).toContain("corp.atlassian.net");
  });

  it("direct redaction: tokens, headers, options, and URL identifiers", () => {
    expect(redactProviderOutput("token=ATCTT3xFfGF0abcdefgh")).toBe("token=[redacted]");
    expect(redactProviderOutput("--token 9f8e7d6c5b4a")).toBe("--token [redacted]");
    expect(redactProviderOutput("--api-key=zzzzzzzz")).toBe("--api-key=[redacted]");
    expect(redactProviderOutput("x-api-key: abc123")).toBe("x-api-key: [redacted]");
    expect(redactProviderOutput("https://u:p@jira.test/x")).toBe("https://[redacted]@jira.test/x");
    expect(redactProviderOutput("Basic dXNlcjpwYXNzd29yZA==")).toBe("Basic [redacted]");
  });

  it("truncates an unbounded output", () => {
    const message = redactProviderOutput(`java.lang.RuntimeException ${"at com.atlassian.Foo ".repeat(80)}`);
    expect(message.length).toBeLessThanOrEqual(401);
    expect(message.endsWith("…")).toBe(true);
  });

  it("flattens line breaks: an error remains on one log line", () => {
    expect(redactProviderOutput("  error\n  detail\n")).toBe("error detail");
  });
});
