// Copies X-Monitor's borg history into X-Backups' database, run once on the host that holds both.
// Usage: node import_x_monitor.ts <x-monitor.db> <x-backups.sqlite> <monitor>=<target id>... [--dry-run]

import { DatabaseSync } from "node:sqlite";
import { import_x_monitor_history } from "./x_monitor_history.ts";

const args = process.argv.slice(2);
const dry_run = args.includes("--dry-run");
const [source_path, target_path, ...pairs] = args.filter((arg) => arg !== "--dry-run");
const mapping = new Map(pairs.map((pair) => pair.split("=") as [string, string]));
if (!source_path || !target_path || mapping.size === 0 || [...mapping].some(([monitor, id]) => !monitor || !id)) {
  process.stderr.write("Usage: node import_x_monitor.ts <x-monitor.db> <x-backups.sqlite> <monitor>=<target id>... [--dry-run]\n");
  process.exit(2);
}

const source = new DatabaseSync(source_path, { readOnly: true });
const target = new DatabaseSync(target_path);
// X-Backups keeps running during the import, so a write waits for its lock rather than failing.
target.exec("PRAGMA busy_timeout = 10000");

const stamp = (epoch: number | null) => epoch === null ? "—" : new Date(epoch * 1000).toISOString().slice(0, 16).replace("T", " ");
for (const report of import_x_monitor_history(source, target, mapping, dry_run)) {
  process.stdout.write(`${report.monitor} → ${report.target_id}: ${report.found} polls found, ${report.written} ${dry_run ? "would be written" : "written"}, ${stamp(report.first_epoch)} to ${stamp(report.last_epoch)}\n`);
}
source.close();
target.close();
