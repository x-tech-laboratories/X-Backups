// Reading and writing spans of time the way the config and the logs spell them.

// ── Units ────────────────────────────────────────────────────────────────────

// Seconds a timed-out command gets to exit before it is killed outright.
export const KILL_GRACE_SECONDS = 5;

const parse_units: Record<string, number> = {
  w: 7 * 24 * 3600,
  d: 24 * 3600,
  h: 3600,
  m: 60,
  s: 1,
};

const format_units: [seconds: number, name: string][] = [
  [7 * 24 * 3600, "Week"],
  [24 * 3600, "Day"],
  [3600, "Hour"],
  [60, "Minute"],
  [1, "Second"],
];

// ── Parsing ──────────────────────────────────────────────────────────────────

export function parse_duration(value: number | string): number {
  if (typeof value === "number") return Math.trunc(value);
  const text = value.trim();
  if (/^\d+$/.test(text)) return Number(text);
  const matches = [...text.toLowerCase().matchAll(/(\d+)([wdhms])/g)];
  if (matches.length === 0) {
    throw new Error(`Unrecognised duration: '${text}'. Use e.g. '1w', '7d', '2h30m', '60s'.`);
  }
  return matches.reduce((total, [, count, unit]) => total + Number(count) * parse_units[unit], 0);
}

// ── Formatting ───────────────────────────────────────────────────────────────

// The two largest whole units, such as "1 Day 2 Hours".
export function format_duration(seconds: number): string {
  if (seconds <= 0) return "0 Seconds";
  const parts: string[] = [];
  let remaining = seconds;
  for (const [unit_seconds, name] of format_units) {
    if (remaining >= unit_seconds) {
      const count = Math.floor(remaining / unit_seconds);
      remaining %= unit_seconds;
      parts.push(`${count} ${name}${count !== 1 ? "s" : ""}`);
    }
  }
  return parts.slice(0, 2).join(" ");
}

export function format_age(seconds: number): string {
  if (seconds < 0) return "Never";
  return `${format_duration(seconds)} ago`;
}
