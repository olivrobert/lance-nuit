/** Shared compact formats used by the console and live-stream surfaces. */
export function formatDuration(durationMs?: number): string | undefined {
  if (durationMs == null || !Number.isFinite(durationMs) || durationMs < 0) return undefined;
  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return `${minutes}m${String(rest).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** Stream durations are always finite event values and clamp negative drift. */
export function formatCompactDuration(durationMs: number): string {
  return formatDuration(Math.max(0, durationMs)) ?? "0s";
}

export function formatContextShare(pct: number): string {
  return `ctx ${Math.round(pct * 100)}%`;
}
