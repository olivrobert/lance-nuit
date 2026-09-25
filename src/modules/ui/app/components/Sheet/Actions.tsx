// The action row of the sheet.
//
// The verbs themselves are decided by `verbsFor`, which is the closed set of
// what the server accepts (spec 5.1); this component only draws them and asks
// the two questions that must be answered before a verb is posted. Those two
// questions live HERE and not in the store on purpose: `confirm` and `prompt`
// are a property of the browser, and the store — which the poll also drives —
// must stay callable without one. The store receives an amount already resolved.
//
// Every button is disabled while a run is in progress on the item and while any
// verb is being posted, which is what stops a double click from launching twice.

import type { JSX } from "react";
import type { Item, VerbAction } from "../../api/types.js";
import { cx } from "../../lib/cx.js";
import { isBusy, verbsFor } from "../../lib/derive.js";
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
      `Mark ${item.ticket} as closed?\n\nUse this when the ticket was finished by hand. The run keeps its ${item.status} status and leaves the attention queue; a later run on it brings it back.`,
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
  /** Extra class of the row, so the sticky header can tighten its margins. */
  className?: string;
}

export function Actions({ item, className }: ActionsProps): JSX.Element | null {
  const pending = useUiSelector(selectPending);
  const busy = isBusy(item);
  const verbs = verbsFor(item);
  if (verbs.length === 0) return null;

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
      onClick={() => run(verb)}
    >
      {pending === verb.verb ? `${verb.label}…` : verb.label}
    </button>
  );

  const primary = verbs.find((verb) => verb.primary);
  const secondary = verbs.filter((verb) => verb !== primary);

  return (
    <div className={cx(styles.actions, className)}>
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
