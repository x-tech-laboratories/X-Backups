// A repository's config as a form built from the fields the server lists, or read-only with its source named.

import { SECRET_MASK, type FieldKind, type FieldSpec } from "../api.ts";
import { h, type Child } from "../dom.ts";
import { facts, section, text_dialog, toolbar } from "../ui.ts";

// The fields in groups, in the order a reader looks for them; anything unlisted lands in Other.
export const field_groups: [title: string, fields: string[]][] = [
  ["Connection", ["name", "id", "host", "ssh_user", "repo", "borg_version", "rsh", "ssh_key", "borg_bin", "require_sudo", "passphrase", "passphrase_file", "passphrase_command", "lock_wait", "timeout", "interval", "skip_when_unreachable"]],
  ["Sources", ["source_paths", "exclude", "exclude_from", "exclude_caches", "exclude_if_present", "one_file_system", "compression", "archive_prefix"]],
  ["Retention", ["keep_within", "keep_last", "keep_secondly", "keep_minutely", "keep_hourly", "keep_daily", "keep_weekly", "keep_monthly", "keep_yearly", "prune_match", "prune_after_backup", "compact_after_backup"]],
  ["Checks", ["max_age", "warn_age", "check_units", "check_max_age", "check_warn_age", "check_kinds", "check_verify_data", "canary_path", "canary_interval", "canary_warn_age", "canary_max_age"]],
  ["Jobs", ["job_nice", "job_io_idle", "inhibit_sleep", "job_lock", "skip_while_active", "backup_lock_wait", "cache_dir", "restore_dir", "browse_limit", "list_archives", "collect_stats", "quota"]],
  ["Safety", ["allow_delete", "allow_purge", "purge_match"]],
];

// The groups a new repository opens with; the rest start folded.
const open_groups = new Set(["Connection", "Sources"]);

const secret_fields = new Set(["passphrase", "passphrase_command"]);

// A line under the fields people most often get wrong.
const field_hints: Record<string, string> = {
  name: "Letters, digits, '.', '_' or '-'. It names archives and units, so it cannot change later.",
  host: "The SSH host the borg commands run on. Leave empty for this machine.",
  ssh_user: "The user X-Backups logs in to the host as.",
  repo: "The repository as borg names it, such as ssh://borg@storage/./host or /srv/backups/host.",
  borg_version: "1 or 2, empty for 1. Borg 2 runs borg2 and needs ssh://host//srv/repo for an absolute path.",
  passphrase: "Stored once in the state directory, readable only by X-Backups, and never shown again.",
  passphrase_file: "A file on the host holding the passphrase.",
  passphrase_command: "A command on the host that prints the passphrase.",
  interval: "How often to poll, such as 1h. Empty takes the default from Settings.",
  max_age: "The newest archive older than this fails the repository, such as 1d.",
  warn_age: "The newest archive older than this gives a warning first, such as 20h. Empty leaves it off.",
  check_warn_age: "The oldest passing check older than this gives a warning first, such as 14d. Empty leaves it off.",
  canary_warn_age: "A restore canary that last ran longer ago than this gives a warning, such as 2d. Empty leaves it off.",
  canary_max_age: "A restore canary that last ran longer ago than this fails the repository, such as 3d. Empty leaves it off.",
  quota: "The most this repository should store, such as 500G or 2T, which its storage bar is drawn against. Empty uses the free space of a local repository's filesystem.",
  source_paths: "One path per line. Leave empty when the host's own backup job sets them.",
  exclude: "One borg pattern per line.",
  check_kinds: "One per line: a check kind (repository, archives, data, extract) and its maximum age, such as data 30d.",
  allow_delete: "Lets the page prune, delete archives and break locks.",
  allow_purge: "Lets the page rewrite archives without files the excludes now drop.",
};

const kind_placeholders: Partial<Record<FieldKind, string>> = {
  duration: "such as 1d, 12h or seconds",
  list: "one per line",
  durations: "kind duration, one per line",
};

// ── Form ─────────────────────────────────────────────────────────────────────

export interface ConfigForm {
  element: HTMLElement;
  // The entry as typed, with empty fields left out.
  read: () => Record<string, unknown>;
  // Puts the server's message beside the field it names, or at the top when it names none.
  show_error: (message: string, field: string | null) => void;
}

export function config_form(fields: FieldSpec[], values: Record<string, unknown>, options: { adding: boolean }): ConfigForm {
  const readers = new Map<string, () => unknown>();
  const notes = new Map<string, HTMLElement>();
  const groups = new Map<string, HTMLDetailsElement>();
  const banner = h("div", { class: "failure", role: "alert", hidden: true });
  const kinds = new Map(fields.map((field) => [field.name, field.kind]));

  const field_row = (name: string, kind: FieldKind): HTMLElement => {
    const id = `field-${name}`;
    const note = h("p", { class: "field-error tone-bad small", id: `${id}-error`, hidden: true });
    notes.set(name, note);
    const [input, read] = input_for(name, kind, values[name], id, options.adding);
    readers.set(name, read);
    return h("div", { class: "form-row" },
      h("label", { for: id }, h("code", {}, name)),
      h("div", {}, input, field_hints[name] && h("p", { class: "muted small" }, field_hints[name]), note),
    );
  };

  const listed = new Set(field_groups.flatMap(([, names]) => names));
  const other = fields.map((field) => field.name).filter((name) => !listed.has(name));
  const element = h("div", { class: "stack" }, banner,
    ...[...field_groups, ["Other", other] as [string, string[]]].map(([title, names]) => {
      const present = names.filter((name) => kinds.has(name));
      if (present.length === 0) return null;
      const has_values = present.some((name) => values[name] !== undefined && values[name] !== null);
      const group = h("details", { class: "panel form-group", open: open_groups.has(title) || (!options.adding && has_values) },
        h("summary", {}, h("h2", {}, title)),
        h("div", { class: "form-rows" }, ...present.map((name) => field_row(name, kinds.get(name)!))),
      ) as HTMLDetailsElement;
      for (const name of present) groups.set(name, group);
      return group;
    }));

  return {
    element,
    read: () => {
      const entry: Record<string, unknown> = {};
      for (const [name, read] of readers) {
        const value = read();
        if (value !== undefined) entry[name] = value;
      }
      return entry;
    },
    show_error: (message, field) => {
      for (const note of notes.values()) note.hidden = true;
      const note = field ? notes.get(field) : undefined;
      if (note === undefined) {
        banner.textContent = message;
        banner.hidden = false;
        banner.scrollIntoView({ block: "center" });
        return;
      }
      banner.hidden = true;
      note.textContent = message;
      note.hidden = false;
      const group = groups.get(field!);
      if (group) group.open = true;
      const input = document.getElementById(`field-${field}`);
      input?.setAttribute("aria-describedby", `field-${field}-error`);
      input?.scrollIntoView({ block: "center" });
      input?.focus();
    },
  };
}

// One input for a field and a reader giving its value back in the JSON shape, or undefined when empty.
function input_for(name: string, kind: FieldKind, value: unknown, id: string, adding: boolean): [HTMLElement, () => unknown] {
  if (kind === "boolean") {
    const select = h("select", { id },
      h("option", { value: "", selected: value === undefined }, "default"),
      h("option", { value: "true", selected: value === true }, "yes"),
      h("option", { value: "false", selected: value === false }, "no"));
    return [select, () => select.value === "" ? undefined : select.value === "true"];
  }
  if (kind === "list" || kind === "durations") {
    const text = kind === "list"
      ? (Array.isArray(value) ? value.join("\n") : typeof value === "string" ? value : "")
      : value && typeof value === "object" ? Object.entries(value).map(([key, item]) => `${key} ${item}`).join("\n") : "";
    const area = h("textarea", { id, rows: Math.max(2, text.split("\n").length), placeholder: kind_placeholders[kind] ?? null });
    area.value = text;
    return [area, () => {
      const lines = area.value.split("\n").map((line) => line.trim()).filter(Boolean);
      if (lines.length === 0) return undefined;
      if (kind === "list") return lines;
      return Object.fromEntries(lines.map((line) => {
        const [key, ...rest] = line.split(/\s+/);
        const age = rest.join(" ");
        return [key, /^\d+$/.test(age) ? Number(age) : age];
      }));
    }];
  }
  const secret = secret_fields.has(name);
  const input = h("input", {
    id,
    type: secret ? "password" : kind === "number" ? "number" : "text",
    autocomplete: secret ? "new-password" : "off",
    placeholder: kind_placeholders[kind] ?? null,
    // A name names archives and units, so an existing repository keeps it.
    readonly: name === "name" && !adding,
  });
  input.value = value === undefined || value === null ? "" : String(value);
  return [input, () => {
    const text = input.value.trim();
    if (text === "") return undefined;
    if (secret) return input.value;
    if (kind === "number") return Number(text);
    // A duration or count given as digits alone is seconds or a number, as the JSON file takes it.
    if ((kind === "number_or_string" || kind === "duration") && /^\d+$/.test(text)) return Number(text);
    return text;
  }];
}

// ── Read-only ────────────────────────────────────────────────────────────────

export function config_tools(fields: Record<string, unknown>): HTMLElement {
  return toolbar(
    h("button", { onclick: () => text_dialog("Config as JSON", JSON.stringify(fields, null, 2)) }, "Show as JSON"),
    h("button", { onclick: () => text_dialog("Config as Nix", as_nix(fields)) }, "Show as Nix"),
  );
}

export function config_read_only(fields: Record<string, unknown>): HTMLElement[] {
  const listed = new Set(field_groups.flatMap(([, names]) => names));
  const other = Object.keys(fields).filter((name) => !listed.has(name));
  return [...field_groups, ["Other", other] as [string, string[]]]
    .map(([title, names]) => [title, names.filter((name) => fields[name] !== undefined && fields[name] !== null)] as [string, string[]])
    .filter(([, names]) => names.length > 0)
    .map(([title, names]) => section(title, facts(names.map((name): [string, Child] => [name, config_value(fields[name])]), "rows")));
}

function config_value(value: unknown): Child {
  if (value === SECRET_MASK) return h("span", { class: "muted" }, "set, not shown");
  if (Array.isArray(value)) return value.length === 0 ? "none" : h("ul", { class: "paths" }, ...value.map((item) => h("li", {}, h("code", {}, String(item)))));
  if (typeof value === "object" && value !== null) return h("code", {}, JSON.stringify(value));
  if (typeof value === "boolean") return value ? "yes" : "no";
  return h("code", {}, String(value));
}

// The repository as a Nix attribute set for services.x-backups.repositories, with secrets left as a comment.
export function as_nix(fields: Record<string, unknown>): string {
  const { name, ...rest } = fields;
  const value = (item: unknown, indent: string): string => {
    if (typeof item === "string") return JSON.stringify(item);
    if (typeof item === "number" || typeof item === "boolean") return String(item);
    if (Array.isArray(item)) return `[ ${item.map((entry) => value(entry, indent)).join(" ")} ]`;
    if (typeof item === "object" && item !== null) {
      const inner = Object.entries(item).map(([key, entry]) => `${indent}  ${nix_key(key)} = ${value(entry, `${indent}  `)};`);
      return `{\n${inner.join("\n")}\n${indent}}`;
    }
    return "null";
  };
  const lines = Object.entries(rest)
    .filter(([, item]) => item !== null && item !== undefined)
    .map(([key, item]) => item === SECRET_MASK ? `  # ${key} is set; keep it in a file outside the Nix store and use passphraseFile.` : `  ${nix_key(key)} = ${value(item, "  ")};`);
  return `services.x-backups.repositories.${nix_key(String(name))} = {\n${lines.join("\n")}\n};\n`;
}

function nix_key(key: string): string {
  return /^[A-Za-z_][A-Za-z0-9_'-]*$/.test(key) ? key : JSON.stringify(key);
}
