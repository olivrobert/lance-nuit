// What the launch dialog can say about a ticket reference before the server does.
//
// The server is authoritative: it validates the reference through the project's
// work-item provider and refuses what it does not know. These two helpers only
// exist so that the most likely mistake — a `FOOD-` ticket typed while the
// dialog is on another project — is visible while typing, as a warning that
// never blocks the submit. A project may accept references the key does not
// predict, and the provider is the one that knows.

/** The placeholder of the ticket field: the project key, or a neutral stand-in
 *  for a project that declares none. */
export function ticketPlaceholder(key: string | undefined): string {
  return `${key?.trim() || "TICKET"}-123`;
}

/**
 * True when the ticket visibly belongs to another tracker project: its prefix,
 * up to the first `-`, is not the project key (case-insensitive).
 *
 * False when there is nothing to compare — no key declared, or nothing typed
 * yet — because a warning on an empty field is noise. Before the first `-`,
 * the text is judged as a prefix still being typed: `PAC` on the way to
 * `PACASEC-1` is not a mistake yet, `FOO` is.
 */
export function ticketPrefixMismatch(ticket: string, key: string | undefined): boolean {
  const expected = key?.trim().toUpperCase();
  const typed = ticket.trim().toUpperCase();
  if (!expected || !typed) return false;
  const cut = typed.indexOf("-");
  if (cut < 0) return !expected.startsWith(typed);
  return typed.slice(0, cut) !== expected;
}
