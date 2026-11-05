// Conditional class names.
//
// Three components had written the same four-line helper, because a CSS Module
// gives back hashed strings and `styles.a + " " + styles.b` is unreadable the
// moment one of the two is conditional. It lives here so the components stay
// free of a utility none of them owns, and so a `false` branch can never leak
// the string "false" into a `class` attribute.

export function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}
