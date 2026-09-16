// modules/ui/markdown.ts
//
// Server-side markdown rendering, on top of `markdown-it`.
//
// Safety comes from the parser's own contract rather than from a pre-pass of
// ours: with `html: false` the source's raw markup is escaped and never
// reproduced, so the only tags in the output are the ones markdown-it emits for
// constructs it recognised.
//
// Three things stay ours, because they are policy and not parsing:
//
//   - which schemes may become an `href` (`isSafeHref`, wired into
//     `validateLink`): stricter than markdown-it's default, which permits some
//     `data:` images;
//   - `target`/`rel` on external links;
//   - task checkboxes, which GFM has and CommonMark does not.

import MarkdownIt, { type MarkdownIt as MarkdownItInstance, type StateCore } from "markdown-it";

/** Schemes a rendered link may point at. A `.md` file is written by an agent, so
 *  `javascript:` is a real possibility, not a theoretical one; an unlisted scheme
 *  makes the link render as plain text instead of an anchor. */
const SAFE_ABSOLUTE_SCHEME = /^(https?:)\/\//i;

/** A scheme is anything up to the first colon that precedes any `/`, `?` or `#`. */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** `[ ] ` or `[x] ` opening a list item's text. */
const TASK_MARK = /^\[([ xX])\]\s+/;

/**
 * True when a link target may become an `href`.
 *
 * Absolute targets are restricted to http(s). Everything else is accepted only
 * when it carries no scheme at all — a relative path, a query, a fragment — so
 * `javascript:`, `data:` and `vbscript:` are all refused by the same rule rather
 * than by a blocklist that the next scheme would escape.
 */
export function isSafeHref(target: string): boolean {
  const trimmed = target.trim();
  if (trimmed.length === 0) return false;
  // Control characters and spaces are how a newline is smuggled into the middle
  // of `javascript:` to slip past a scheme check; a target that needs one of them
  // is not a target this renderer turns into a link.
  for (let index = 0; index < trimmed.length; index++) {
    const code = trimmed.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f) return false;
  }
  if (SAFE_ABSOLUTE_SCHEME.test(trimmed)) return true;
  return !HAS_SCHEME.test(trimmed);
}

/**
 * Turn `- [x] done` into a disabled checkbox followed by its label.
 *
 * The rule runs after `inline`, on the token stream, so the label keeps whatever
 * emphasis, code or links markdown-it already parsed in it. The two tokens it
 * injects are `html_inline`: `html: false` stops the PARSER from producing those
 * from the source, it does not stop the renderer from writing the ones we build
 * here ourselves.
 */
function taskLists(md: MarkdownItInstance): void {
  md.core.ruler.after("inline", "task_lists", (state: StateCore) => {
    const tokens = state.tokens;
    for (let index = 0; index < tokens.length; index++) {
      if (tokens[index]?.type !== "list_item_open") continue;
      // A list item opens with its paragraph, whose `inline` token holds the text.
      const inline = tokens[index + 2];
      if (inline?.type !== "inline") continue;
      const mark = TASK_MARK.exec(inline.content);
      if (!mark) continue;

      const first = inline.children?.[0];
      if (first?.type !== "text") continue;
      first.content = first.content.replace(TASK_MARK, "");
      inline.content = inline.content.replace(TASK_MARK, "");

      const checked = (mark[1] as string).toLowerCase() === "x";
      // Disabled on purpose: the dashboard renders a file, it does not edit one.
      const open = new state.Token("html_inline", "", 0);
      open.content = `<input type="checkbox" disabled${checked ? " checked" : ""}> <span>`;
      const close = new state.Token("html_inline", "", 0);
      close.content = "</span>";
      inline.children = [open, ...(inline.children ?? []), close];

      tokens[index]?.attrJoin("class", "task");
    }
    return true;
  });
}

/**
 * Open external links in a new tab, and never leak the dashboard's URL doing it.
 *
 * A relative link stays in the tab: it points at another file of the same work
 * item, which the dashboard shows itself.
 */
function externalLinks(md: MarkdownItInstance): void {
  md.renderer.rules.link_open = (tokens, index, options, _env, self) => {
    const token = tokens[index];
    if (token && SAFE_ABSOLUTE_SCHEME.test(String(token.attrGet("href") ?? ""))) {
      token.attrSet("target", "_blank");
      token.attrSet("rel", "noreferrer noopener");
    }
    return self.renderToken(tokens, index, options);
  };
}

/**
 * `breaks: true` because a `.md` our pipelines write uses a newline as a
 * newline; `linkify: false` because a bare URL in a report is often a sample,
 * not a destination.
 */
const renderer = new MarkdownIt({ html: false, breaks: true, linkify: false, typographer: false })
  .use(taskLists)
  .use(externalLinks);

renderer.validateLink = isSafeHref;

/** Render markdown to HTML. The source's own markup is escaped, never rendered. */
export function renderMarkdown(source: string): string {
  return renderer.render(source);
}
