// The repositories' state in Prometheus' text format, for a scraper holding a read-only API token.

import type { Watched } from "./poller.ts";

const status_values: Record<string, number> = { online: 0, info: 0, warning: 1, unavailable: 2, failed: 3 };

interface Metric {
  name: string;
  help: string;
  type: "gauge";
  value: (watched: Watched, now: number) => number | null;
}

const metrics: Metric[] = [
  {
    name: "x_backups_repository_status", type: "gauge",
    help: "0 when the last poll was fine, 1 warning, 2 unreachable, 3 failed, -1 not polled yet",
    value: (watched) => watched.status === null ? -1 : status_values[watched.status] ?? -1,
  },
  {
    name: "x_backups_last_backup_age_seconds", type: "gauge", help: "Seconds since the newest archive was made",
    value: (watched, now) => watched.repository.state.last_backup_epoch ? now - watched.repository.state.last_backup_epoch : null,
  },
  {
    name: "x_backups_max_age_seconds", type: "gauge", help: "The age past which the newest archive fails the repository",
    value: (watched) => watched.repository.max_age,
  },
  {
    name: "x_backups_last_poll_age_seconds", type: "gauge", help: "Seconds since the repository was last polled",
    value: (watched, now) => watched.repository.state.last_poll_epoch ? now - watched.repository.state.last_poll_epoch : null,
  },
  { name: "x_backups_archives", type: "gauge", help: "Archives in the repository", value: (watched) => watched.repository.state.archive_count },
  {
    name: "x_backups_original_bytes", type: "gauge", help: "Size of all archives before compression and deduplication",
    value: (watched) => watched.repository.state.stats?.original_size ?? null,
  },
  {
    name: "x_backups_stored_bytes", type: "gauge", help: "Size the repository takes after compression and deduplication",
    value: (watched) => watched.repository.state.stats?.deduplicated_size ?? null,
  },
  {
    name: "x_backups_checks_passed", type: "gauge", help: "1 when every tracked check is fresh and passed, 0 when not",
    value: (watched) => flag(watched.repository.state.checks?.passed),
  },
  {
    name: "x_backups_canary_passed", type: "gauge", help: "1 when the last restore canary matched, 0 when not",
    value: (watched) => flag(watched.repository.state.canary?.ok),
  },
  {
    name: "x_backups_job_running", type: "gauge", help: "1 while a job runs on the repository",
    value: (watched) => watched.repository.jobs?.running() ? 1 : 0,
  },
];

// Every metric for the repositories given, leaving out a value nothing has measured yet.
export function metrics_text(repositories: Watched[], now = Math.floor(Date.now() / 1000)): string {
  const lines: string[] = [];
  for (const metric of metrics) {
    lines.push(`# HELP ${metric.name} ${metric.help}`, `# TYPE ${metric.name} ${metric.type}`);
    for (const watched of repositories) {
      const value = metric.value(watched, now);
      if (value === null || value === undefined) continue;
      lines.push(`${metric.name}{repository="${label(watched.repository.id)}",host="${label(watched.config.host ?? "local")}"} ${value}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function flag(value: boolean | null | undefined): number | null {
  return value === null || value === undefined ? null : value ? 1 : 0;
}

// A label value with the characters Prometheus' format escapes.
function label(text: string): string {
  return text.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"").replaceAll("\n", "\\n");
}
