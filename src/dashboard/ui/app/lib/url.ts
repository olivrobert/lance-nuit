// One question, asked of every URL the dashboard turns into a clickable link.
//
// The ticket URL of a project comes from a file on disk that the reader owns, so
// it is not hostile in the way a form field is. It is still the one string in
// this front end that becomes an `href`, and an `href` is the one attribute that
// can carry executable code: `javascript:` and `data:` links run in the page's
// own origin, next to the cookie that signs approvals. A hand-edited config, a
// project entry copied from somewhere else, or a provider that one day fills the
// field itself are all enough for that to matter.
//
// So the answer is a closed set rather than a blocklist: `http:` and `https:`
// are links, everything else is text.

const LINKABLE_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * The URL, if it is one this dashboard is willing to link to, and `undefined`
 * otherwise — including when it does not parse at all.
 */
export function linkableUrl(value: string | undefined | null): string | undefined {
  if (!value) return undefined;
  try {
    return LINKABLE_PROTOCOLS.has(new URL(value).protocol) ? value : undefined;
  } catch {
    // A relative path or plain nonsense: not something to hand to the browser.
    return undefined;
  }
}
