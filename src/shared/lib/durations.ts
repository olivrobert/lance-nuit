//
// The one way the CLI and the dashboard spell a relative duration: `30d`,
// `12h`, `45m`, `90s`, `2w`. A reader that accepts `--since 30d` on the command
// line accepts `since=30d` over HTTP with the same meaning.

/** Milliseconds in `value`; throws on anything but `<integer><s|m|h|d|w>`. */
export function parseAge(value = "30d"): number {
  const match = value.trim().match(/^(\d+)([smhdw])$/i);
  if (!match) throw new Error(`Invalid duration: ${value} (expected: 30d, 12h, 45m...)`);
  const amount = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  const factor = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[unit]!;
  return amount * factor;
}
