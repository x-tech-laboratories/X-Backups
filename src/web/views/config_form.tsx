// A host's, repository's, source's or job's config as a form built from the fields the server lists, or read-only with
// its source named.

import { text_dialog } from "@x-tech-laboratories/x-libs/web/react/dialog";
import { Facts, Section, Toolbar, type Fact } from "@x-tech-laboratories/x-libs/web/react/layout";
import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { SECRET_MASK, type FieldKind, type FieldSpec } from "../api.ts";

// The fields in groups, in the order a reader looks for them; anything unlisted lands in Other.
export const field_groups: [title: string, fields: string[]][] = [
  ["Connection", ["name", "kind", "address", "id", "host", "poll_via", "repo", "repo_by_host", "borg_version", "rsh", "ssh_key", "borg_bin", "require_sudo", "passphrase", "passphrase_file", "passphrase_command", "lock_wait", "timeout", "interval", "skip_when_unreachable"]],
  ["Sources", ["sources", "repositories", "source_paths", "exclude", "exclude_from", "exclude_caches", "exclude_if_present", "one_file_system", "compression", "archive_prefix"]],
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
  host: "The host the borg commands run on, through the X-Backups agent it runs. Leave empty for this machine.",
  repo: "The repository as borg names it, such as ssh://borg@storage/./host or /srv/backups/host.",
  borg_version: "1 or 2, empty for 1. Borg 2 runs borg2 and needs ssh://host//srv/repo for an absolute path.",
  passphrase: "Stored once in the state directory, readable only by X-Backups, and never shown again.",
  passphrase_file: "A file on the host holding the passphrase.",
  inhibit_sleep: "Keeps the host awake while a run goes, through systemd-inhibit where the host has it; without it the run goes unguarded.",
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
  strings: "name value, one per line",
};

// The values a field may take, picked from a list rather than typed: one, or any number.
export interface Choice {
  options: string[];
  multiple: boolean;
}

// ── Form ─────────────────────────────────────────────────────────────────────

// What a page does with its form: read what was typed, and show what the server refused.
export interface ConfigFormHandle {
  // The entry as typed, with empty fields left out.
  read: () => Record<string, unknown>;
  // Puts the server's message beside the field it names, or at the top when it names none.
  show_error: (message: string, field: string | null) => void;
}

interface ConfigFormProps {
  fields: FieldSpec[];
  values: Record<string, unknown>;
  adding: boolean;
  choices?: Record<string, Choice>;
  // Lines under fields that read differently on this kind, over the usual ones.
  hints?: Record<string, string>;
  // Filled with the form's handle while it is shown.
  handle: RefObject<ConfigFormHandle | null>;
}

// The fields in their groups; the inputs keep what is typed themselves, so the page reads them only when it saves.
export function ConfigForm({ fields, values, adding, choices, hints, handle }: ConfigFormProps) {
  const [error, set_error] = useState<{ message: string; field: string | null; shown: number } | null>(null);
  const banner = useRef<HTMLDivElement>(null);
  const kinds = new Map(fields.map((field) => [field.name, field.kind]));

  handle.current = {
    read: () => {
      const entry: Record<string, unknown> = {};
      for (const [name, kind] of kinds) {
        const value = read_field(name, kind, choices?.[name]);
        if (value !== undefined) entry[name] = value;
      }
      return entry;
    },
    show_error: (message, field) => set_error({ message, field: field !== null && kinds.has(field) ? field : null, shown: Date.now() }),
  };

  useLayoutEffect(() => {
    if (error === null) return;
    if (error.field === null) {
      banner.current?.scrollIntoView({ block: "center" });
      return;
    }
    const input = document.getElementById(`field-${error.field}`);
    const group = input?.closest("details");
    if (group) group.open = true;
    input?.scrollIntoView({ block: "center" });
    input?.focus();
  }, [error]);

  const listed = new Set(field_groups.flatMap(([, names]) => names));
  const other = fields.map((field) => field.name).filter((name) => !listed.has(name));
  return (
    <div className="stack">
      <div ref={banner} className="failure" role="alert" hidden={error === null || error.field !== null}>{error?.field === null ? error.message : ""}</div>
      {[...field_groups, ["Other", other] as [string, string[]]].map(([title, names]) => {
        const present = names.filter((name) => kinds.has(name));
        if (present.length === 0) return null;
        const has_values = present.some((name) => values[name] !== undefined && values[name] !== null);
        return (
          <details key={title} className="panel form-group" open={open_groups.has(title) || (!adding && has_values)}>
            <summary><h2>{title}</h2></summary>
            <div className="form-rows">
              {present.map((name) => {
                const id = `field-${name}`;
                const at_fault = error?.field === name;
                const choice = choices?.[name];
                const hint = hints?.[name] ?? field_hints[name];
                return (
                  <div key={name} className="form-row">
                    <label htmlFor={id}><code>{name}</code></label>
                    <div>
                      {choice
                        ? <ChoiceInput name={name} choice={choice} value={values[name]} id={id} at_fault={at_fault} />
                        : <FieldInput name={name} kind={kinds.get(name)!} value={values[name]} id={id} adding={adding} at_fault={at_fault} />}
                      {hint && <p className="muted small">{hint}</p>}
                      <p className="field-error tone-bad small" id={`${id}-error`} hidden={!at_fault}>{at_fault ? error.message : ""}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </details>
        );
      })}
    </div>
  );
}

// One input for a field; it keeps what is typed itself, read back by read_field.
function FieldInput({ name, kind, value, id, adding, at_fault }: { name: string; kind: FieldKind; value: unknown; id: string; adding: boolean; at_fault: boolean }) {
  const described = at_fault ? `${id}-error` : undefined;
  if (kind === "boolean") {
    return (
      <select id={id} aria-describedby={described} defaultValue={value === true ? "true" : value === false ? "false" : ""}>
        <option value="">default</option>
        <option value="true">yes</option>
        <option value="false">no</option>
      </select>
    );
  }
  if (kind === "list" || kind === "durations" || kind === "strings") {
    const text = kind === "list"
      ? (Array.isArray(value) ? value.join("\n") : typeof value === "string" ? value : "")
      : value && typeof value === "object" ? Object.entries(value).map(([key, item]) => `${key} ${item}`).join("\n") : "";
    return <textarea id={id} rows={Math.max(2, text.split("\n").length)} placeholder={kind_placeholders[kind]} defaultValue={text} aria-describedby={described} />;
  }
  const secret = secret_fields.has(name);
  return (
    <input
      id={id}
      type={secret ? "password" : kind === "number" ? "number" : "text"}
      autoComplete={secret ? "new-password" : "off"}
      placeholder={kind_placeholders[kind]}
      // A name names archives and units, so an existing repository keeps it.
      readOnly={name === "name" && !adding}
      defaultValue={value === undefined || value === null ? "" : String(value)}
      aria-describedby={described}
    />
  );
}

// A pick of one value from a list, or a set of checkboxes for any number; a value no longer listed stays shown.
function ChoiceInput({ name, choice, value, id, at_fault }: { name: string; choice: Choice; value: unknown; id: string; at_fault: boolean }) {
  const current = Array.isArray(value) ? value.map(String) : typeof value === "string" && value !== "" ? [value] : [];
  const options = [...new Set([...choice.options, ...current])];
  const described = at_fault ? `${id}-error` : undefined;
  if (!choice.multiple) {
    return (
      <select id={id} aria-describedby={described} defaultValue={current[0] ?? ""}>
        <option value="">none</option>
        {options.map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
    );
  }
  return (
    <fieldset className="check-group" id={id} tabIndex={-1} aria-describedby={described}>
      <legend className="visually-hidden">{name}</legend>
      {options.length === 0
        ? <p className="muted small">None to pick from yet.</p>
        : options.map((option) => <label key={option} className="check"><input type="checkbox" value={option} defaultChecked={current.includes(option)} />{` ${option}`}</label>)}
    </fieldset>
  );
}

// A field's value in the JSON shape, read from its input, or undefined when empty.
function read_field(name: string, kind: FieldKind, choice: Choice | undefined): unknown {
  const element = document.getElementById(`field-${name}`);
  if (element === null) return undefined;
  if (choice?.multiple) {
    const picked = [...element.querySelectorAll<HTMLInputElement>("input[type=checkbox]")].filter((box) => box.checked).map((box) => box.value);
    return picked.length === 0 ? undefined : picked;
  }
  const raw = (element as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).value;
  if (choice) return raw === "" ? undefined : raw;
  if (kind === "boolean") return raw === "" ? undefined : raw === "true";
  if (kind === "list" || kind === "durations" || kind === "strings") {
    const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0) return undefined;
    if (kind === "list") return lines;
    return Object.fromEntries(lines.map((line) => {
      const [key, ...rest] = line.split(/\s+/);
      const item = rest.join(" ");
      return [key, kind === "durations" && /^\d+$/.test(item) ? Number(item) : item];
    }));
  }
  const text = raw.trim();
  if (text === "") return undefined;
  if (secret_fields.has(name)) return raw;
  if (kind === "number") return Number(text);
  // A duration or count given as digits alone is seconds or a number, as the JSON file takes it.
  if ((kind === "number_or_string" || kind === "duration") && /^\d+$/.test(text)) return Number(text);
  return text;
}

// ── Read-only ────────────────────────────────────────────────────────────────

export function ConfigTools({ fields, kind = "repositories" }: { fields: Record<string, unknown>; kind?: string }) {
  return (
    <Toolbar>
      <button onClick={() => text_dialog("Config as JSON", JSON.stringify(fields, null, 2))}>Show as JSON</button>
      <button onClick={() => text_dialog("Config as Nix", as_nix(fields, kind))}>Show as Nix</button>
    </Toolbar>
  );
}

export function ConfigReadOnly({ fields }: { fields: Record<string, unknown> }) {
  const listed = new Set(field_groups.flatMap(([, names]) => names));
  const other = Object.keys(fields).filter((name) => !listed.has(name));
  return <>{[...field_groups, ["Other", other] as [string, string[]]]
    .map(([title, names]) => [title, names.filter((name) => fields[name] !== undefined && fields[name] !== null)] as [string, string[]])
    .filter(([, names]) => names.length > 0)
    .map(([title, names]) => (
      <Section key={title} title={title}>
        <Facts layout="rows" rows={names.map((name): Fact => [name, config_value(fields[name])])} />
      </Section>
    ))}</>;
}

function config_value(value: unknown): ReactNode {
  if (value === SECRET_MASK) return <span className="muted">set, not shown</span>;
  if (Array.isArray(value)) return value.length === 0 ? "none" : <ul className="paths">{value.map((item, index) => <li key={index}><code>{String(item)}</code></li>)}</ul>;
  if (typeof value === "object" && value !== null) return <code>{JSON.stringify(value)}</code>;
  if (typeof value === "boolean") return value ? "yes" : "no";
  return <code>{String(value)}</code>;
}

// The entry as a Nix attribute set for services.x-backups.<kind>, with secrets left as a comment.
export function as_nix(fields: Record<string, unknown>, kind = "repositories"): string {
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
  return `services.x-backups.${kind}.${nix_key(String(name))} = {\n${lines.join("\n")}\n};\n`;
}

function nix_key(key: string): string {
  return /^[A-Za-z_][A-Za-z0-9_'-]*$/.test(key) ? key : JSON.stringify(key);
}

// ── Reloads ──────────────────────────────────────────────────────────────────

const load_keys = new WeakMap<object, number>();
let next_load_key = 1;

// A number for each answer a resource loads, which keys a form so a reload draws it afresh with the saved values.
export function load_key(answer: object): number {
  let key = load_keys.get(answer);
  if (key === undefined) {
    key = next_load_key++;
    load_keys.set(answer, key);
  }
  return key;
}
