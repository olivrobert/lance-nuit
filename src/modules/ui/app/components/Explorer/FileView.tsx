// The read panel for one file of the explorer's selection.
//
// It is shown in two places with two different header styles — sticky next to
// the tree in the Files tab, flush at the top of the Document tab — hence
// `headerClass`: the caller (`Folder` or `DocumentView`) says which look
// applies, because the ancestor that used to carry that context in CSS
// (`.folder .view` vs `.document-content`) is split across two different
// components here.

import type { JSX } from "react";
import { mimeOf } from "../../lib/derive.js";
import { fmtSize } from "../../lib/format.js";
import { useActions, useUiSelector } from "../../store/store.js";
import styles from "./Explorer.module.css";

/** The fields every readable file carries, whether it fit under the size cap
 *  or not — enough for the header, regardless of the rest of the variant. */
interface WithHeader {
  path: string;
  relativePath: string;
  size: number;
}

function Header({ file, headerClass }: { file: WithHeader; headerClass: string }): JSX.Element {
  const actions = useActions();
  return (
    <div className={headerClass}>
      <code>{file.relativePath}</code>
      <span className="small mute">{fmtSize(file.size)}</span>
      <span className="grow" />
      <button type="button" className="small" title={file.path} onClick={() => void actions.copy(file.path)}>
        copy disk path
      </button>
    </div>
  );
}

export function FileView({ headerClass }: { headerClass: string }): JSX.Element {
  const filePath = useUiSelector((state) => state.filePath);
  const file = useUiSelector((state) => state.file);

  if (!filePath) return <p className={`mute ${styles.notice}`}>Choose a file.</p>;
  if (!file) return <p className={`mute ${styles.notice}`}>Loading…</p>;
  if (file.status === "error") return <p className={`mute ${styles.notice}`}>{`${filePath} : ${file.error}`}</p>;
  // The read model can also answer "not-found" or "denied" for a path the tree
  // no longer has, or refuses to serve — the vanilla renderer had no case for
  // either and fell through to an unstyled, mostly-blank body; TypeScript's
  // discriminated union forces an explicit branch, so this shows the same
  // one-line notice as the other empty states instead of reproducing the gap.
  if (file.status === "not-found") return <p className={`mute ${styles.notice}`}>{`${filePath} : not found`}</p>;
  if (file.status === "denied") return <p className={`mute ${styles.notice}`}>{`${filePath} : ${file.reason}`}</p>;

  if (file.status === "too-large") {
    return (
      <div>
        <Header file={file} headerClass={headerClass} />
        <p className="mute">{`File too large (${fmtSize(file.size)}, limit ${fmtSize(file.limit)}): open it from disk.`}</p>
        <pre>{file.path}</pre>
      </div>
    );
  }

  let body: JSX.Element;
  if (file.contentKind === "png") {
    body = <img alt={file.relativePath} src={`data:${mimeOf(file.relativePath)};base64,${file.content}`} />;
  } else if (file.contentKind === "md" && typeof file.html === "string") {
    // The ONLY place in the whole dashboard where raw HTML is inserted. The
    // server (`markdown.ts`, via `renderMarkdown`) escapes the file's source
    // before turning it into markup, so `file.html` is never a fragment of the
    // file itself — it is markup the server built. Every other value on this
    // screen, and every other screen, goes through JSX text instead.
    // biome-ignore lint/security/noDangerouslySetInnerHtml: the one exception documented above — server-built markup, source already escaped
    body = <div className={styles.md} dangerouslySetInnerHTML={{ __html: file.html }} />;
  } else if (file.contentKind === "json") {
    let pretty = file.content;
    try {
      pretty = JSON.stringify(JSON.parse(file.content), null, 2);
    } catch {
      // A malformed JSON file is still worth reading as it stands.
    }
    body = <pre>{pretty}</pre>;
  } else {
    body = <pre>{file.content}</pre>;
  }

  return (
    <div>
      <Header file={file} headerClass={headerClass} />
      {body}
    </div>
  );
}
