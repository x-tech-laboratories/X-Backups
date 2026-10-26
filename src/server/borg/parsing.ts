// Pure readers for borg's JSON and text output.

import { shell_quote, split_lines_of } from "./shell.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

export interface ArchiveEntry {
  name: string;
  epoch: number;
  original?: number;
  compressed?: number;
  deduplicated?: number;
  nfiles?: number;
}

export type RepositoryInfo = Record<string, string>;

export interface ListingEntry {
  name: string;
  path: string;
  dir: boolean;
  type: string;
  size: number | null;
  mtime: string;
}

export interface BrowserRow {
  name: string;
  path: string;
  dir: boolean;
  size: string;
  size_bytes: number | null;
  mtime: string;
}

// One path a `borg diff --json-lines` reports, reduced to what it means for the files' contents.
export interface DiffChange {
  path: string;
  // Metadata is a change of mode, owner or times only; other is a line that was not borg's JSON.
  kind: "added" | "removed" | "modified" | "metadata" | "other";
  added_bytes: number;
  removed_bytes: number;
  // The other change types borg named for the path, such as mode, owner or changed link.
  details: string[];
}

export const PRUNE_LINE = new RegExp(
  String.raw`^(?:Keeping archive \(rule: (?<rule>[^)]+)\)|(?<prune>Would prune)):\s+` +
  String.raw`(?<name>\S+)\s+(?<date>.+?)\s+\[[0-9a-f]+\]\s*$`,
);

// ── Values ───────────────────────────────────────────────────────────────────

// Formats a raw byte count.
export function format_size(size: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  for (const unit of units) {
    if (Math.abs(size) < 1024 || unit === "TB") {
      return unit === "B" ? `${Math.trunc(size)} B` : `${size.toFixed(1)} ${unit}`;
    }
    size /= 1024;
  }
  return `${size.toFixed(1)} TB`;
}

const iso_time = new RegExp(
  String.raw`^(\d{4})-(\d{2})-(\d{2})` +
  String.raw`(?:[T ](\d{2})(?::(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?)?)?` +
  String.raw`(?:([+-])(\d{2}):?(\d{2})(?::?(\d{2}))?)?$`,
);

// Reads an ISO timestamp as epoch seconds, treating one without an offset as local time; 0 when it cannot.
export function parse_archive_time(value: string | null | undefined): number {
  if (!value) return 0;
  let text = value.trim();
  if (text.endsWith("Z")) text = text.slice(0, -1) + "+00:00";
  const match = iso_time.exec(text);
  if (!match) return 0;

  const [, year, month, day, hour = "0", minute = "0", second = "0", fraction = "", sign, offset_hours, offset_minutes, offset_seconds] = match;
  const [year_number, month_number, day_number] = [Number(year), Number(month), Number(day)];
  const [hour_number, minute_number, second_number] = [Number(hour), Number(minute), Number(second)];
  const days_in_month = new Date(Date.UTC(year_number, month_number, 0)).getUTCDate();
  if (month_number < 1 || month_number > 12 || day_number < 1 || day_number > days_in_month ||
    hour_number > 23 || minute_number > 59 || second_number > 59) {
    return 0;
  }

  const milliseconds = Number((fraction + "000").slice(0, 3));
  const parts = [year_number, month_number - 1, day_number, hour_number, minute_number, second_number, milliseconds] as const;
  if (!sign) return Math.trunc(new Date(...parts).getTime() / 1000);

  const offset = Number(offset_hours) * 3600 + Number(offset_minutes) * 60 + Number(offset_seconds ?? 0);
  const epoch_milliseconds = Date.UTC(...parts) - (sign === "-" ? -1 : 1) * offset * 1000;
  return Math.trunc(epoch_milliseconds / 1000);
}

// Decodes a borg --json payload, giving {} when it is not a JSON object.
export function decode_json(stdout: string): Record<string, unknown> {
  try {
    const data: unknown = JSON.parse(stdout);
    return is_object(data) ? data : {};
  } catch {
    return {};
  }
}

export function is_object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ── Repository listing ───────────────────────────────────────────────────────

// Decoded `borg list --json` output.
export class RepoView {
  readonly valid: boolean;
  readonly raw_count: number;
  readonly newest_epoch: number;
  readonly archives: ArchiveEntry[];
  readonly info: RepositoryInfo;

  constructor(fields: Partial<Pick<RepoView, "valid" | "raw_count" | "newest_epoch" | "archives" | "info">> = {}) {
    this.valid = fields.valid ?? false;
    this.raw_count = fields.raw_count ?? 0;
    this.newest_epoch = fields.newest_epoch ?? 0;
    this.archives = fields.archives ?? [];
    this.info = fields.info ?? {};
  }

  // Parses the payload once, giving an invalid view on malformed output.
  static from_stdout(stdout: string): RepoView {
    let data: unknown;
    try {
      data = JSON.parse(stdout);
    } catch {
      return new RepoView();
    }
    if (!is_object(data)) return new RepoView();
    const raw = data.archives || [];
    if (!Array.isArray(raw)) return new RepoView();

    const archives: ArchiveEntry[] = [];
    for (const archive of raw) {
      if (!is_object(archive)) continue;
      archives.push({
        name: String(archive.name || archive.archive || "?"),
        epoch: parse_archive_time(String(archive.start || archive.time || "")),
      });
    }
    archives.sort((left, right) => right.epoch - left.epoch);
    const newest = Math.max(0, ...archives.map((archive) => archive.epoch).filter((epoch) => epoch > 0));

    const info: RepositoryInfo = {};
    const repository = data.repository;
    if (is_object(repository)) {
      info.location = String(repository.location || "");
      info.last_modified = String(repository.last_modified || "");
    }
    const encryption = data.encryption;
    if (is_object(encryption)) info.encryption = String(encryption.mode || "");

    return new RepoView({ valid: true, raw_count: raw.length, newest_epoch: newest, archives, info });
  }
}

// ── Archive browsing ─────────────────────────────────────────────────────────

// Tab-separated with the path last, so a path containing a tab still reads back whole.
export const LIST_FORMAT = "{type}\t{size}\t{isomtime}\t{path}{NL}";

// Keeps a folder's direct children and stands in one folder line for anything deeper, since borg stores no parent it was not asked to back up.
const children_awk = String.raw`BEGIN { FS = "\t"; n = length(p) }
{
    path = $0
    for (k = 0; k < 3; k++) path = substr(path, index(path, "\t") + 1)
    if (substr(path, 1, n) != p) next
    rest = substr(path, n + 1)
    if (rest == "") next
    i = index(rest, "/")
    if (i == 0) { print; next }
    d = substr(rest, 1, i - 1)
    if (!(d in seen)) { seen[d] = 1; print "d\t\t\t" p d }
}`;

// A shell filter reducing a `borg list` of the member to that folder's direct children.
export function children_filter(member: string): string {
  const prefix = member ? `${member}/` : "";
  return `awk -v p=${shell_quote(prefix)} ${shell_quote(children_awk)}`;
}

// One entry per child, folders first, where a real item wins over a folder made up from a deeper path.
export function parse_listing(stdout: string): ListingEntry[] {
  const entries = new Map<string, ListingEntry>();
  for (const line of split_lines_of(stdout)) {
    const fields = split_limited(line, "\t", 3);
    if (fields.length !== 4 || !fields[3]) continue;
    const [kind, size, mtime, path] = fields;
    const name = path.slice(path.lastIndexOf("/") + 1);
    if (entries.has(name) && !size) continue;
    entries.set(name, {
      name,
      path,
      dir: kind === "d",
      type: kind,
      size: /^\d+$/.test(size) ? Number(size) : null,
      mtime: mtime.replaceAll("T", " ").slice(0, 16),
    });
  }
  return [...entries.values()].sort((left, right) => {
    if (left.dir !== right.dir) return left.dir ? -1 : 1;
    const left_name = left.name.toLowerCase();
    const right_name = right.name.toLowerCase();
    return left_name < right_name ? -1 : left_name > right_name ? 1 : 0;
  });
}

// The browser table's rows for a listed folder, cut at the limit.
export function browser_rows(entries: ListingEntry[], limit: number): BrowserRow[] {
  return entries.slice(0, limit).map((entry) => ({
    name: entry.name,
    path: entry.path,
    dir: entry.dir,
    size: entry.dir || entry.size === null ? "" : format_size(entry.size),
    size_bytes: entry.dir ? null : entry.size,
    mtime: entry.mtime,
  }));
}

// ── Diff ─────────────────────────────────────────────────────────────────────

// Reads `borg diff --json-lines`, keeping a line that is not JSON as it is so nothing is lost.
export function parse_diff(stdout: string): DiffChange[] {
  return split_lines_of(stdout).filter((line) => line.trim()).map((line) => {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      entry = null;
    }
    if (!is_object(entry) || typeof entry.path !== "string" || !Array.isArray(entry.changes)) {
      return { path: line.trim(), kind: "other", added_bytes: 0, removed_bytes: 0, details: [] };
    }
    return diff_change(entry.path, entry.changes.filter(is_object));
  });
}

function diff_change(path: string, changes: Record<string, unknown>[]): DiffChange {
  const change: DiffChange = { path, kind: "metadata", added_bytes: 0, removed_bytes: 0, details: [] };
  for (const item of changes) {
    const type = String(item.type ?? "");
    const bytes = (value: unknown) => typeof value === "number" ? value : 0;
    if (type === "added" || type === "added directory" || type === "added link") {
      change.kind = "added";
      change.added_bytes += bytes(item.size);
    } else if (type === "removed" || type === "removed directory" || type === "removed link") {
      change.kind = "removed";
      change.removed_bytes += bytes(item.size);
    } else if (type === "modified") {
      change.kind = "modified";
      change.added_bytes += bytes(item.added);
      change.removed_bytes += bytes(item.removed);
    } else if (type === "changed link") {
      if (change.kind === "metadata") change.kind = "modified";
      change.details.push(type);
    } else if (type) {
      change.details.push(type);
    }
  }
  return change;
}

// One line of text for a change, in the shape `borg diff` prints without JSON.
export function diff_line(change: DiffChange): string {
  if (change.kind === "other") return change.path;
  const sizes = change.kind === "added" ? format_size(change.added_bytes)
    : change.kind === "removed" ? format_size(change.removed_bytes)
    : change.kind === "modified" ? `+${format_size(change.added_bytes)} -${format_size(change.removed_bytes)}` : "";
  const details = change.details.length > 0 ? `[${change.details.join(", ")}]` : "";
  return [change.kind, sizes, details].filter(Boolean).concat(change.path).join(" ");
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// Splits at most `limit` times, keeping the rest of the text whole in the last field.
function split_limited(text: string, separator: string, limit: number): string[] {
  const fields: string[] = [];
  let rest = text;
  while (fields.length < limit) {
    const at = rest.indexOf(separator);
    if (at === -1) break;
    fields.push(rest.slice(0, at));
    rest = rest.slice(at + separator.length);
  }
  fields.push(rest);
  return fields;
}
