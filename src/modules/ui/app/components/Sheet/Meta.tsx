// The identity card of the run, as a definition list.
//
// Everything here answers "which run am I actually looking at": the project and
// its provider, the pipeline and the run id, where the branch is. It sits inside
// the collapsed panel because a reader needs it when something is surprising and
// never when it is not.

import type { JSX } from "react";
import type { Item } from "../../api/types.js";
import { reasonOf } from "../../lib/derive.js";
import { fmtAge, fmtCost, fmtDate } from "../../lib/format.js";
import { linkableUrl } from "../../lib/url.js";
import { ProjectBadge } from "../ProjectBadge.js";
import { StatusTag } from "../StatusTag.js";
import styles from "./Sheet.module.css";

export function Meta({ item }: { item: Item }): JSX.Element {
  // The only string of this front end that becomes an `href`, so it is the only
  // one that has to name the protocols it is allowed to use.
  const ticketHref = linkableUrl(item.project.ticketUrl);

  return (
    <dl className={styles.kv}>
      <dt>Project</dt>
      <dd>
        <span>
          <ProjectBadge name={item.project.name} />
          <code className="mute">{item.project.cwd}</code>
          <span className="mute">{` · ${item.project.provider}`}</span>
        </span>
      </dd>

      <dt>Pipeline</dt>
      <dd>
        <span>
          {item.pipeline}
          <span className="mute">{` · run ${item.runId}`}</span>
          {item.worktree ? <span className="mute"> · worktree</span> : null}
        </span>
      </dd>

      <dt>State</dt>
      <dd>
        <span>
          <StatusTag item={item} />
          {` ${reasonOf(item)}`}
        </span>
      </dd>

      <dt>Last activity</dt>
      <dd>
        <span>
          {fmtAge(item.updatedAt)}
          <span className="mute">{` · ${fmtDate(item.updatedAt)}`}</span>
        </span>
      </dd>

      <dt>Run cost</dt>
      <dd>
        <span>{fmtCost(item.cost)}</span>
      </dd>

      {item.branch ? (
        <>
          <dt>Branch</dt>
          <dd>
            <code>{item.branch}</code>
          </dd>
        </>
      ) : null}

      {ticketHref ? (
        <>
          <dt>Ticket</dt>
          <dd>
            <a href={ticketHref} target="_blank" rel="noreferrer">
              {ticketHref}
            </a>
          </dd>
        </>
      ) : null}
    </dl>
  );
}
