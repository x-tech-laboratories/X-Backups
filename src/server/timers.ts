// Reads a host's backup timers: when each last fired and fires next, and how its service last ended.

// ── Shapes ───────────────────────────────────────────────────────────────────

export interface Timer {
  unit: string;
  service: string;
  next_epoch: number | null;
  last_epoch: number | null;
  // systemd's verdict on the service's last run, such as success or exit-code.
  result: string | null;
  exit_status: number | null;
  // When its OnCalendar fires over the coming week, empty for a timer that counts from its last run instead.
  upcoming: number[];
}

// Timers whose service names borg, which covers borgmatic and NixOS borgbackup jobs.
const BACKUP_SERVICE = /borg/i;

const SERVICES_MARK = "===XBACKUPS_SERVICES===";
const CALENDAR_MARK = "===XBACKUPS_CALENDAR===";
const CALENDAR_UNIT_MARK = "@@";

// How far ahead the upcoming elapses reach, and how many systemd-analyze lists to get there for an hourly timer.
export const upcoming_span_in_seconds = 8 * 86400;
const calendar_iterations = 200;

// ── Command ──────────────────────────────────────────────────────────────────

// One command listing every timer as JSON, then the state of each backup service they start, then the coming elapses of each backup timer's OnCalendar.
export function timers_command(): string {
  const list = "systemctl list-timers --all --output=json --no-pager";
  const services = `${list} | grep -o '"activates": *"[^"]*borg[^"]*"' | sed 's/.*"\\([^"]*\\)"$/\\1/'`;
  const timer_units = `${list} | grep -o '"unit": *"[^"]*", *"activates": *"[^"]*borg[^"]*"' | sed 's/"unit": *"\\([^"]*\\)".*/\\1/'`;
  // systemctl prints each OnCalendar as "{ OnCalendar=<spec> ; next_elapse=... }"; systemd-analyze lists its elapses, in UTC on the lines that end in UTC.
  const calendar = `for timer in $(${timer_units}); do echo "${CALENDAR_UNIT_MARK}$timer"; ` +
    `systemctl show -P TimersCalendar -- "$timer" | sed -n 's/.*OnCalendar=\\(.*\\) ; next_elapse=.*/\\1/p' | ` +
    `while IFS= read -r spec; do systemd-analyze calendar --iterations=${calendar_iterations} -- "$spec" 2>/dev/null | grep ' UTC$'; done; done`;
  return `${list}; echo ${SERVICES_MARK}; ` +
    `units=$(${services}); [ -n "$units" ] && systemctl show --timestamp=unix -p Id -p Result -p ExecMainStatus -- $units; ` +
    `echo ${CALENDAR_MARK}; ${calendar}`;
}

// ── Reading ──────────────────────────────────────────────────────────────────

export function parse_timers(stdout: string, now = Date.now() / 1000): Timer[] | null {
  const [head, calendar_text = ""] = stdout.split(CALENDAR_MARK);
  const [list_text, services_text = ""] = head.split(SERVICES_MARK);
  let listed: unknown;
  try {
    listed = JSON.parse(list_text);
  } catch {
    return null;
  }
  if (!Array.isArray(listed)) return null;

  const services = parse_services(services_text);
  const calendars = parse_calendars(calendar_text, now);
  return listed
    .filter((timer) => typeof timer?.activates === "string" && BACKUP_SERVICE.test(timer.activates))
    .map((timer) => {
      const service = services.get(timer.activates);
      return {
        unit: String(timer.unit),
        service: timer.activates,
        next_epoch: microseconds_to_epoch(timer.next),
        last_epoch: microseconds_to_epoch(timer.last),
        result: service?.Result ?? null,
        exit_status: service?.ExecMainStatus === undefined ? null : Number(service.ExecMainStatus),
        upcoming: calendars.get(String(timer.unit)) ?? [],
      };
    });
}

// Reads each "@@<timer>" block of systemd-analyze lines into its elapses within the coming week, in order and once each.
function parse_calendars(text: string, now: number): Map<string, number[]> {
  const calendars = new Map<string, number[]>();
  let elapses: number[] | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith(CALENDAR_UNIT_MARK)) {
      elapses = [];
      calendars.set(line.slice(CALENDAR_UNIT_MARK.length).trim(), elapses);
      continue;
    }
    const stamp = /(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) UTC$/.exec(line);
    if (elapses === null || stamp === null) continue;
    const epoch = Date.parse(`${stamp[1]}T${stamp[2]}Z`) / 1000;
    if (epoch >= now && epoch <= now + upcoming_span_in_seconds) elapses.push(epoch);
  }
  for (const [unit, found] of calendars) calendars.set(unit, [...new Set(found)].sort((a, b) => a - b));
  return calendars;
}

// Reads systemctl show's blank-line separated blocks of key=value lines, keyed by each block's Id.
function parse_services(text: string): Map<string, Record<string, string>> {
  const services = new Map<string, Record<string, string>>();
  for (const block of text.trim().split(/\n\s*\n/)) {
    const fields: Record<string, string> = {};
    for (const line of block.split("\n")) {
      const at = line.indexOf("=");
      if (at > 0) fields[line.slice(0, at).trim()] = line.slice(at + 1).trim();
    }
    if (fields.Id) services.set(fields.Id, fields);
  }
  return services;
}

function microseconds_to_epoch(value: unknown): number | null {
  return typeof value === "number" && value > 0 ? Math.floor(value / 1_000_000) : null;
}
