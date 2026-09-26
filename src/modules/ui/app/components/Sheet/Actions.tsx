// The action row of the sheet.
//
// The verbs themselves are decided by `verbsFor`, which is the closed set of
// what the server accepts (spec 5.1); this component only draws them and asks
// the two questions that must be answered before a verb is posted. Those two
// questions live HERE and not in the store on purpose: `confirm` and `prompt`
// are a property of the browser, and the store — which the poll also drives —
// must stay callable without one. The store receives an amount already resolved.
//
// A delivered run with a report (`deliveryActions`) leads with what the report
// delivered instead: its merge request as the primary link and a copy button for
// its branch. Its verbs are unchanged, and all of them go behind "More".
//
// Every button is disabled while a run is in progress on the item and while any
// verb is being posted, which is what stops a double click from launching twice.

import type { JSX } from "react";
import type { Item, RunReport, VerbAction } from "../../api/types.js";
import { cx } from "../../lib/cx.js";
import { deliveryActions, isBusy, verbsFor } from "../../lib/derive.js";
import type { UiState } from "../../store/store.js";
import { actions, useUiSelector } from "../../store/store.js";
import styles from "./Actions.module.css";

const selectPending = (state: UiState): string | null => state.pending;

/** Ask before abandoning or closing a run, and ask for the amount a budget verb needs.
 *  Returns the options to post with, or `null` when the reader backed out. */
function askFor(item: Item, verb: VerbAction): { budget?: number } | null {
  if (verb.verb === "fresh") {
    const sure = window.confirm(
      `Start ${item.ticket} fresh?\n\nThe current run will be abandoned and pipeline ${item.pipeline} will restart from the beginning. Existing approvals remain on disk.`,
    );
    return sure ? {} : null;
  }
  if (verb.verb === "close") {
    const sure = window.confirm(
      `Mark ${item.ticket} as closed?\n\nUse this when the ticket was finished by hand. The run keeps its ${item.status} status and leaves Needs you; a later run on it brings it back.`,
    );
    return sure ? {} : null;
  }
  if (verb.verb === "budget") {
    const answer = window.prompt(`New cost limit for ${item.ticket}, in dollars:`, "");
    if (answer === null) return null;
    const amount = Number(answer.replace(",", ".").trim());
    if (!Number.isFinite(amount) || amount <= 0) {
      actions.toast("Invalid amount.");
      return null;
    }
    return { budget: amount };
  }
  return {};
}

export interface ActionsProps {
  item: Item;
  /** The run's report, when the sheet has one: it supplies the delivery
   *  actions of a finished run. */
  report?: RunReport | null;
  /** Extra class of the row, so the sticky header can tighten its margins. */
  className?: string;
}

export function Actions({ item, report, className }: ActionsProps): JSX.Element | null {
  const pending = useUiSelector(selectPending);
  const busy = isBusy(item);
  const verbs = verbsFor(item);
  const delivery = deliveryActions(item, report);
  if (verbs.length === 0 && !delivery) return null;

  const run = (verb: VerbAction): void => {
    const options = askFor(item, verb);
    if (options === null) return;
    void actions.runVerb(item, verb, options);
  };

  const button = (verb: VerbAction): JSX.Element => (
    <button
      key={verb.verb}
      type="button"
      disabled={busy || pending !== null}
      className={verb.primary ? "primary" : verb.danger ? "danger" : undefined}
      title={verb.command}
      onClick={(event) => {
        // Fold the menu the verb was picked from: left open, it covers the
        // callout that is about to say the run started.
        event.currentTarget.closest("details")?.removeAttribute("open");
        run(verb);
      }}
    >
      {pending === verb.verb ? `${verb.label}…` : verb.label}
    </button>
  );

  const primary = delivery ? undefined : verbs.find((verb) => verb.primary);
  const secondary = verbs.filter((verb) => verb !== primary);
  const copy = delivery?.copy;

  return (
    <div className={cx(styles.actions, className)}>
      {delivery?.link ? (
        <a className={styles.primaryLink} href={delivery.link.url} target="_blank" rel="noreferrer">
          {`${delivery.link.label} ↗`}
        </a>
      ) : null}
      {copy ? (
        <button type="button" title={copy.value} onClick={() => void actions.copy(copy.value)}>
          {copy.label} <span className={styles.copyValue}>{copy.value}</span>
        </button>
      ) : null}
      {primary ? button(primary) : null}
      {secondary.length > 0 ? (
        <details className={styles.actionMenu}>
          <summary>More actions</summary>
          <div className={styles.actionOptions}>{secondary.map(button)}</div>
        </details>
      ) : null}
      {busy ? <span className="small mute">Run in progress: no action available.</span> : null}
    </div>
  );
}
