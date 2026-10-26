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
}

// Timers whose service names borg, which covers borgmatic and NixOS borgbackup jobs.
const BACKUP_SERVICE = /borg/i;

const SERVICES_MARK = "===XBACKUPS_SERVICES===";

// ── Command ──────────────────────────────────────────────────────────────────

// One command listing every timer as JSON, then the state of each backup service they start.
export function timers_command(): string {
  const list = "systemctl list-timers --all --output=json --no-pager";
  const services = `${list} | grep -o '"activates": *"[^"]*borg[^"]*"' | sed 's/.*"\\([^"]*\\)"$/\\1/'`;
  return `${list}; echo ${SERVICES_MARK}; ` +
    `units=$(${services}); [ -n "$units" ] && systemctl show --timestamp=unix -p Id -p Result -p ExecMainStatus -- $units`;
}

// ── Reading ──────────────────────────────────────────────────────────────────

export function parse_timers(stdout: string): Timer[] | null {
  const [list_text, services_text = ""] = stdout.split(SERVICES_MARK);
  let listed: unknown;
  try {
    listed = JSON.parse(list_text);
  } catch {
    return null;
  }
  if (!Array.isArray(listed)) return null;

  const services = parse_services(services_text);
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
      };
    });
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
