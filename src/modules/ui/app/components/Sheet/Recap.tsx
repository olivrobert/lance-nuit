// The recap of a run: how long it took, what it cost, and what it showed.
//
// Three blocks, all read from data the sheet already holds. The figures come
// from `RunRecap`, which translates the runner's own ledger — nothing here adds
// a step's cost to another, so the total on screen is the one the budget was
// enforced against. The run's cost is `Item.cost`, printed by the same
// `fmtCost` as the header, latches included. The screenshots come from the
// folder tree, and each one is loaded as raw bytes, lazily, so a long gallery
// costs nothing until it is scrolled to.

import type { JSX } from "react";
import { rawFileUrl } from "../../api/client.js";
import type { Item, RunRecap, RunRecapStep, WorkItemTree } from "../../api/types.js";
import { screenshotGroups } from "../../lib/derive.js";
import { fmtCost, fmtDuration, fmtTokens } from "../../lib/format.js";
import { actions } from "../../store/store.js";
import styles from "./Recap.module.css";

/** Under this, a step is plumbing — a gate, a guard, a copy — and listing it
 *  would bury the steps that actually took the time. */
const NOTABLE_MS = 1000;

function isNotable(step: RunRecapStep): boolean {
  if (step.status === "failed" || step.status === "aborted") return true;
  if (typeof step.costUsd === "number" && step.costUsd > 0) return true;
  return (step.durationMs ?? 0) >= NOTABLE_MS;
}

function spanMs(recap: RunRecap): number | undefined {
  const start = recap.startedAt ? Date.parse(recap.startedAt) : Number.NaN;
  const end = recap.endedAt ? Date.parse(recap.endedAt) : Number.NaN;
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : undefined;
}

function stepCost(step: RunRecapStep): string {
  if (typeof step.costUsd !== "number" && !step.costUnknown) return "";
  return fmtCost({
    ...(typeof step.costUsd === "number" ? { usd: step.costUsd } : {}),
    estimated: step.costEstimated === true,
    ...(step.costUnknown ? { unknown: true } : {}),
  });
}

/** Model cell of a step: its own model, or — for a node composing pipelines —
 *  what each model of its children cost. */
function stepModel(step: RunRecapStep): string {
  const models = step.models?.map((split) =>
    typeof split.costUsd === "number"
      ? `${split.model} ${fmtCost({ usd: split.costUsd, estimated: false })}`
      : split.model,
  );
  return [step.profile, ...(models ?? [step.model])].filter(Boolean).join(" · ");
}

function Figures({ item, recap }: { item: Item; recap: RunRecap }): JSX.Element {
  const tokens = recap.tokens;
  return (
    <dl className={styles.figures}>
      <div>
        <dt>Cost</dt>
        <dd>{fmtCost(item.cost)}</dd>
      </div>
      <div>
        <dt>Active time</dt>
        <dd>{fmtDuration(recap.activeMs)}</dd>
      </div>
      <div title="From the first to the last write of the run, pauses included">
        <dt>Elapsed</dt>
        <dd>{fmtDuration(spanMs(recap))}</dd>
      </div>
      <div
        title={tokens ? `cache read ${fmtTokens(tokens.cacheRead)} · cache write ${fmtTokens(tokens.cacheWrite)}` : ""}
      >
        <dt>Tokens in / out</dt>
        <dd>
          {tokens
            ? `${fmtTokens(tokens.input + tokens.cacheRead + tokens.cacheWrite)} / ${fmtTokens(tokens.output)}`
            : "—"}
        </dd>
      </div>
      <div>
        <dt>Models</dt>
        <dd className={styles.models}>{recap.models.length ? recap.models.join(", ") : "—"}</dd>
      </div>
    </dl>
  );
}

function StepTable({ recap }: { recap: RunRecap }): JSX.Element {
  const notable = recap.steps.filter(isNotable);
  const hidden = recap.steps.length - notable.length;
  // Bars are scaled on cost when anything was paid for, on time otherwise: a
  // run made only of commands still has somewhere its minutes went.
  const byCost = notable.some((step) => (step.costUsd ?? 0) > 0);
  const measure = (step: RunRecapStep): number => (byCost ? (step.costUsd ?? 0) : (step.durationMs ?? 0));
  const max = Math.max(...notable.map(measure), 0);

  if (notable.length === 0) return <p className="mute small">No step took measurable time.</p>;

  return (
    <div>
      <table className={styles.steps}>
        <thead>
          <tr>
            <th>Step</th>
            <th>Model</th>
            <th className={styles.num}>Time</th>
            <th className={styles.num}>Cost</th>
            <th aria-label={byCost ? "Share of the cost" : "Share of the time"} />
          </tr>
        </thead>
        <tbody>
          {notable.map((step) => (
            <tr key={step.id} className={styles[step.status]}>
              <td>
                <code>{step.id}</code>
                {step.retries ? <span className="small mute">{` · ${step.retries} retries`}</span> : null}
              </td>
              <td className="small mute">{stepModel(step)}</td>
              <td className={styles.num}>{fmtDuration(step.durationMs)}</td>
              <td className={styles.num}>{stepCost(step)}</td>
              <td className={styles.barCell}>
                {max > 0 && measure(step) > 0 ? (
                  <span className={styles.bar} style={{ width: `${(measure(step) / max) * 100}%` }} />
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {hidden > 0 ? <p className="small mute">{`${hidden} other steps took under a second or were skipped.`}</p> : null}
    </div>
  );
}

function Screenshots({ item, tree }: { item: Item; tree: WorkItemTree | null }): JSX.Element | null {
  const groups = screenshotGroups(tree);
  if (groups.length === 0) return null;

  const openSummary = (path: string): void => {
    actions.openFile(path);
    actions.setSheetTab("files");
  };

  return (
    <section className={styles.block}>
      <h3>Screenshots</h3>
      {groups.map((group) => (
        <div key={group.dir} className={styles.group}>
          <div className="row">
            <code className="small mute">{group.dir}</code>
            <span className="grow" />
            {group.summary ? (
              <button type="button" className="small" onClick={() => openSummary(group.summary?.path ?? "")}>
                {`Open ${group.summary.name}`}
              </button>
            ) : null}
          </div>
          <div className={styles.gallery}>
            {group.images.map((image) => {
              const src = rawFileUrl(item, image.path);
              return (
                <a key={image.path} href={src} target="_blank" rel="noreferrer" title={image.name}>
                  <img src={src} alt={image.name} loading="lazy" />
                  <span className="small">{image.name}</span>
                </a>
              );
            })}
          </div>
        </div>
      ))}
    </section>
  );
}

export function Recap({ item, recap, tree }: { item: Item; recap: RunRecap; tree: WorkItemTree | null }): JSX.Element {
  return (
    <div>
      <Figures item={item} recap={recap} />
      <section className={styles.block}>
        <h3>Where the time and money went</h3>
        <StepTable recap={recap} />
      </section>
      <Screenshots item={item} tree={tree} />
    </div>
  );
}
