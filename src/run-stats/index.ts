// runner/run-stats/index.ts
//
// Entry of the run statistics: the summary of a finished run appended to the
// central history (`pipeline-history/runs.jsonl`), and the readers that roll that
// history up for `lancenuit stats` and the dashboard. Code outside this folder
// imports this file only (`module-run-stats-entry-only` in
// `.dependency-cruiser.cjs`); the other files are internals.

// Writing a finished run to the history.
export { emitRunStats } from "./run-stats.js";

// Reading the history.
export {
  type HistoryAggregate,
  type HistoryEntry,
  type HistoryFilter,
  type PipelineTotals,
  pricingTable,
  readHistory,
  summarizeHistory,
} from "./history-reader.js";

// Rendering.
export { currencyOf, fmtInt, statusBadge } from "./stats-core.js";
