// The Report tab: what a finished run delivered, read from `artifacts/report.json`.
//
// Six blocks, in the order a morning reader acts on them: what is left for
// them, what was delivered, the acceptance criteria and their proofs, the
// screenshots, the list for the product owner, and folded links to the
// narrative documents. Each block is drawn only when the report fills it.
//
// Nothing here interprets pipeline prose: statuses, proofs and reserves are the
// report's own fields, shown as written, in the pipeline's language. The
// narrative stays in the markdown files, one click away in the Files tab.

import type { JSX } from "react";
import { rawFileUrl } from "../../api/client.js";
import type { Item, RunReport, RunReportCriterion } from "../../api/types.js";
import { cx } from "../../lib/cx.js";
import { captureNumbers, capturePath, leftForYou, reviewText } from "../../lib/derive.js";
import { linkableUrl } from "../../lib/url.js";
import { actions } from "../../store/store.js";
import styles from "./Report.module.css";

/** Id of a criterion's row, so a reserve in "Left for you" can point at it. */
function criterionAnchor(id: string): string {
  return `report-criterion-${id.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

function showCriterion(id: string): void {
  const row = document.getElementById(criterionAnchor(id));
  if (row instanceof HTMLDetailsElement) row.open = true;
  row?.scrollIntoView({ behavior: "smooth", block: "center" });
}

function openInFiles(path: string): void {
  actions.openFile(path);
  actions.setSheetTab("files");
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    // `linkableUrl` already parsed it; an unparsable value never gets here.
    return "";
  }
}

function LeftForYou({ report }: { report: RunReport }): JSX.Element | null {
  const entries = leftForYou(report);
  if (entries.length === 0) return null;
  return (
    <section className={styles.todo}>
      <h3>
        {`Left for you · ${entries.length}`} <small>from the run's own report</small>
      </h3>
      <ol>
        {entries.map((entry) => (
          <li key={`${entry.criterion ?? ""}|${entry.text}|${entry.detail ?? ""}`}>
            <span className={styles.box} aria-hidden="true" />
            <div>
              {entry.text}
              {entry.detail ? <div className={styles.why}>{entry.detail}</div> : null}
            </div>
            {entry.criterion ? (
              <button type="button" className={styles.go} onClick={() => showCriterion(entry.criterion ?? "")}>
                {`See ${entry.criterion} ↓`}
              </button>
            ) : entry.source ? (
              <span className={styles.source}>{entry.source}</span>
            ) : (
              <span />
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

function Delivered({ report }: { report: RunReport }): JSX.Element | null {
  const cells = report.delivered ?? [];
  const links = (report.links ?? []).filter((link) => !link.primary && linkableUrl(link.url));
  if (cells.length === 0 && links.length === 0) return null;
  return (
    <section className={styles.deliver}>
      {cells.map((cell) => (
        <div key={`${cell.label}|${cell.value}`}>
          <span className={styles.label}>{cell.label}</span>
          <span className={styles.value}>
            {cell.copy ? <code>{cell.value}</code> : cell.value}
            {cell.copy ? (
              <button
                type="button"
                className={styles.copy}
                title={`Copy ${cell.value}`}
                onClick={() => void actions.copy(cell.value)}
              >
                Copy
              </button>
            ) : null}
          </span>
          {cell.hint ? <span className={styles.hint}>{cell.hint}</span> : null}
        </div>
      ))}
      {links.map((link) => (
        <div key={link.url}>
          <span className={styles.label}>Link</span>
          <a className={styles.value} href={linkableUrl(link.url)} target="_blank" rel="noreferrer">
            {`${link.label} ↗`}
          </a>
          <span className={styles.hint}>{hostOf(link.url)}</span>
        </div>
      ))}
    </section>
  );
}

function Proofs({ criterion, numbers }: { criterion: RunReportCriterion; numbers: Map<string, string> }): JSX.Element {
  const shots = (criterion.captures ?? []).flatMap((path) => {
    const number = numbers.get(path);
    return number ? [{ name: path, number }] : [];
  });
  return (
    <span className={styles.proofs}>
      {criterion.proof.map((proof) => (
        <span key={proof} className={cx(styles.chip, proof === "test" && styles.chipTest)}>
          {proof}
        </span>
      ))}
      {shots.map((shot) => (
        <span key={shot.name} className={cx(styles.chip, styles.chipShot)} title={shot.name}>
          {shot.number}
        </span>
      ))}
      {criterion.reserve ? <span className={cx(styles.chip, styles.chipReserve)}>reserve</span> : null}
    </span>
  );
}

function CriterionRow({
  criterion,
  numbers,
}: {
  criterion: RunReportCriterion;
  numbers: Map<string, string>;
}): JSX.Element {
  const head = (
    <>
      <span
        className={cx(styles.mark, !criterion.met && styles.markFail)}
        role="img"
        aria-label={criterion.met ? "met" : "not met"}
      >
        {criterion.met ? "✓" : "✗"}
      </span>
      <span className={styles.acid}>{criterion.id}</span>
      <span className={criterion.met ? "" : styles.failText}>{criterion.text}</span>
      <Proofs criterion={criterion} numbers={numbers} />
    </>
  );
  const captures = criterion.captures ?? [];
  if (!criterion.reserve && captures.length === 0) {
    return (
      <div id={criterionAnchor(criterion.id)} className={styles.critRow}>
        <div className={styles.critHead}>{head}</div>
      </div>
    );
  }
  return (
    <details
      id={criterionAnchor(criterion.id)}
      className={styles.critRow}
      open={Boolean(criterion.reserve) || !criterion.met}
    >
      <summary className={styles.critHead}>{head}</summary>
      <div className={styles.critBody}>
        {criterion.reserve ? (
          <p>
            <b>Reserve:</b> {criterion.reserve}
          </p>
        ) : null}
        {captures.length > 0 ? (
          <p>
            {"Captures: "}
            {captures.map((name, index) => (
              <span key={name}>
                {index > 0 ? ", " : ""}
                <code title={name}>{name.slice(name.lastIndexOf("/") + 1)}</code>
              </span>
            ))}
          </p>
        ) : null}
      </div>
    </details>
  );
}

function Criteria({ report, numbers }: { report: RunReport; numbers: Map<string, string> }): JSX.Element | null {
  const criteria = report.criteria ?? [];
  if (criteria.length === 0) return null;
  const met = criteria.filter((criterion) => criterion.met).length;
  return (
    <section className={styles.block}>
      <div className={styles.head}>
        <h3>Acceptance criteria</h3>
        <span className={cx(styles.count, met < criteria.length && styles.countFail)}>
          {`${met} / ${criteria.length} met`}
        </span>
      </div>
      <div className={styles.crit}>
        {criteria.map((criterion) => (
          <CriterionRow key={criterion.id} criterion={criterion} numbers={numbers} />
        ))}
      </div>
    </section>
  );
}

/** A capture's name after its number, unless the name already starts with it
 *  (`01-list.png` is not written `01 01-list.png`). */
function captureLabel(number: string | undefined, name: string): string {
  return number && !name.startsWith(number) ? `${number} ${name}` : name;
}

function Captures({
  item,
  report,
  numbers,
}: {
  item: Item;
  report: RunReport;
  numbers: Map<string, string>;
}): JSX.Element | null {
  const groups = (report.captures ?? []).filter((group) => group.files.length > 0);
  if (groups.length === 0) return null;
  return (
    <>
      {groups.map((group) => {
        const dir = group.dir.replace(/\/+$/, "");
        return (
          <section key={group.dir} className={styles.block}>
            <div className={styles.head}>
              <h3>Screenshots</h3>
              <span className={styles.src}>
                <code>{dir}</code>
                {` · ${group.files.length}`}
              </span>
            </div>
            <div className={styles.shots}>
              {group.files.map((file) => {
                const path = capturePath(group.dir, file.name);
                const src = rawFileUrl(item, path);
                return (
                  <a
                    key={file.name}
                    className={styles.shot}
                    href={src}
                    target="_blank"
                    rel="noreferrer"
                    title={file.caption}
                  >
                    <img src={src} alt={file.caption ?? file.name} loading="lazy" />
                    <span className={styles.caption}>
                      {file.acs.length > 0 ? <span className={styles.acs}>{file.acs.join(" · ")}</span> : null}
                      <code>{captureLabel(numbers.get(path), file.name)}</code>
                      {file.caption ? <span className={styles.hint}>{file.caption}</span> : null}
                    </span>
                  </a>
                );
              })}
            </div>
          </section>
        );
      })}
    </>
  );
}

function ForReview({ report }: { report: RunReport }): JSX.Element | null {
  const review = report.forReview;
  if (!review || review.items.length === 0) return null;
  return (
    <section className={styles.block}>
      <div className={styles.head}>
        <h3>{review.title}</h3>
        <button type="button" className={styles.copy} onClick={() => void actions.copy(reviewText(review))}>
          Copy
        </button>
      </div>
      <div className={styles.review}>
        {review.items.map((entry) => (
          <div key={`${entry.ref ?? ""}|${entry.text}`}>
            <span className={styles.acid}>{entry.ref ?? ""}</span>
            <p>{entry.text}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function Notes({ report }: { report: RunReport }): JSX.Element | null {
  const notes = report.notes ?? [];
  if (notes.length === 0) return null;
  return (
    <>
      {notes.map((note) => (
        <details key={note.path} className={styles.fold}>
          <summary>
            <b>{note.title}</b>
            <span className={styles.hint}>
              {note.summary ? `${note.summary} · ` : ""}
              <code>{note.path}</code>
            </span>
          </summary>
          <div className={styles.foldBody}>
            <p>
              <button type="button" className="small" onClick={() => openInFiles(note.path)}>
                {`Open ${note.path}`}
              </button>
            </p>
          </div>
        </details>
      ))}
    </>
  );
}

export interface ReportProps {
  item: Item;
  report: RunReport;
  /** Entries of `report.json` the read model dropped, one reason each. */
  warnings?: string[];
}

export function Report({ item, report, warnings }: ReportProps): JSX.Element {
  const numbers = captureNumbers(report);
  const blocks = [
    <LeftForYou key="left" report={report} />,
    <Delivered key="delivered" report={report} />,
    <Criteria key="criteria" report={report} numbers={numbers} />,
    <Captures key="captures" item={item} report={report} numbers={numbers} />,
    <ForReview key="review" report={report} />,
    <Notes key="notes" report={report} />,
  ];
  const empty =
    leftForYou(report).length === 0 &&
    !report.delivered?.length &&
    !report.links?.some((link) => !link.primary) &&
    !report.criteria?.length &&
    !report.captures?.some((group) => group.files.length > 0) &&
    !report.forReview?.items.length &&
    !report.notes?.length;
  return (
    <div className={styles.report}>
      {blocks}
      {empty ? <p className="mute small">The report lists nothing beyond its links.</p> : null}
      {warnings && warnings.length > 0 ? (
        <p className="mute small" title={warnings.join("\n")}>
          {`${warnings.length} ${warnings.length === 1 ? "entry" : "entries"} of report.json ignored: ${warnings[0]}${warnings.length > 1 ? "…" : ""}`}
        </p>
      ) : null}
    </div>
  );
}
