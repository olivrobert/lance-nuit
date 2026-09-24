import { describe, expect, test } from "bun:test";
import { ticketPlaceholder, ticketPrefixMismatch } from "./ticket.js";

describe("ticketPlaceholder", () => {
  test("uses the project key, or a neutral stand-in", () => {
    expect(ticketPlaceholder("PACASEC")).toBe("PACASEC-123");
    expect(ticketPlaceholder(undefined)).toBe("TICKET-123");
    expect(ticketPlaceholder("  ")).toBe("TICKET-123");
  });
});

describe("ticketPrefixMismatch", () => {
  test("a ticket of the project's key matches, whatever the case", () => {
    expect(ticketPrefixMismatch("PACASEC-123", "PACASEC")).toBe(false);
    expect(ticketPrefixMismatch("pacasec-123", "PacaSec")).toBe(false);
    expect(ticketPrefixMismatch("  PACASEC-1  ", "PACASEC")).toBe(false);
  });

  test("another project's ticket is flagged", () => {
    expect(ticketPrefixMismatch("FOOD-456", "PACASEC")).toBe(true);
    expect(ticketPrefixMismatch("PACA-456", "PACASEC")).toBe(true);
    expect(ticketPrefixMismatch("PACASECX-1", "PACASEC")).toBe(true);
  });

  test("a prefix still being typed is not flagged, a wrong one is", () => {
    expect(ticketPrefixMismatch("PAC", "PACASEC")).toBe(false);
    expect(ticketPrefixMismatch("FOO", "PACASEC")).toBe(true);
  });

  test("nothing to compare means no warning", () => {
    expect(ticketPrefixMismatch("", "PACASEC")).toBe(false);
    expect(ticketPrefixMismatch("FOOD-1", undefined)).toBe(false);
    expect(ticketPrefixMismatch("FOOD-1", "")).toBe(false);
  });
});
