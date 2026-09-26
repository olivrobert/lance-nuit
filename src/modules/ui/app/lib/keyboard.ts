// The list's single-key shortcuts, as pure rules.
//
// `useListKeyboard` owns the listener, the DOM lookups and the store calls; what
// is decided here is which key means what, where the selection lands, and when
// a key press belongs to something else (a field being typed in, a dialog, a
// chord with a modifier). Kept apart from the hook so it is testable without a
// document.

/** What a key press asks the list to do, or `null` when it is not ours. */
export type ListKey = "next" | "previous" | "search";

export function listKeyOf(key: string): ListKey | null {
  if (key === "j" || key === "ArrowDown") return "next";
  if (key === "k" || key === "ArrowUp") return "previous";
  if (key === "/") return "search";
  return null;
}

/** The facts about a key press the guard needs, lifted out of the DOM event. */
export interface KeyContext {
  /** `KeyboardEvent.key`. */
  key: string;
  /** Upper-case tag name of the event target, as the DOM reports it. */
  targetTag: string | null;
  targetEditable: boolean;
  /** True when the target is in the list, or is the page itself (nothing
   *  focused). Elsewhere — the sheet, the file view — the arrows scroll. */
  targetInList: boolean;
  dialogOpen: boolean;
  /** False on the terminal screen: every key belongs to the shell there. */
  inbox: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

const TYPING_TAGS: readonly string[] = ["INPUT", "TEXTAREA", "SELECT"];

const ARROWS: readonly string[] = ["ArrowDown", "ArrowUp"];

/** True when the list must leave the key alone. The arrows keep their browser
 *  meaning, scrolling, outside the list: only `j` and `k` reach it from the
 *  sheet. */
export function ignoresKey(context: KeyContext): boolean {
  if (!context.inbox || context.dialogOpen) return true;
  if (context.altKey || context.ctrlKey || context.metaKey) return true;
  if (context.targetEditable) return true;
  if (ARROWS.includes(context.key) && !context.targetInList) return true;
  return context.targetTag !== null && TYPING_TAGS.includes(context.targetTag);
}

/**
 * The key the selection moves to.
 *
 * Moving stops at either end rather than wrapping: a reader holding `j` wants the
 * bottom of the list, not the top again. A selection that is not among the rows
 * (hidden in a closed section, filtered out) starts from the first row going
 * down and from the last going up.
 */
export function stepSelection(
  rows: readonly string[],
  current: string | null,
  direction: "next" | "previous",
): string | null {
  if (rows.length === 0) return null;
  const at = current === null ? -1 : rows.indexOf(current);
  if (at < 0) return (direction === "next" ? rows[0] : rows[rows.length - 1]) ?? null;
  const target = direction === "next" ? Math.min(at + 1, rows.length - 1) : Math.max(at - 1, 0);
  return rows[target] ?? null;
}
