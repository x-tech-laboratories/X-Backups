// Each host, repository, source and job as written: a list per kind in Settings, and one entry's page, a form in mixed
// and page modes with a job's sources and repositories picked from lists and its tasks edited with their schedules in
// words, or read-only with its source named.

import { describe_error } from "@x-tech-laboratories/x-libs/web/errors";
import { Chip } from "@x-tech-laboratories/x-libs/web/react/badges";
import { confirm_dialog } from "@x-tech-laboratories/x-libs/web/react/dialog";
import { Crumbs, Section } from "@x-tech-laboratories/x-libs/web/react/layout";
import { Empty, Loaded, use_resource } from "@x-tech-laboratories/x-libs/web/react/states";
import { toast } from "@x-tech-laboratories/x-libs/web/react/toasts";
import { stamp } from "@x-tech-laboratories/x-libs/web/format";
import { link } from "@x-tech-laboratories/x-libs/web/router";
import { useEffect, useRef, useState, type ChangeEvent, type RefObject } from "react";
import { api, ApiError, query, send, type EntityConfig, type EntityEntry, type EntityKind, type HostRow, type SchedulePreview, type SourceRow } from "../api.ts";
import { use_changes } from "../ui.tsx";
import { ConfigForm, ConfigReadOnly, ConfigTools, load_key, type Choice, type ConfigFormHandle } from "./config_form.tsx";
import { touches } from "./shared.tsx";

const kinds: EntityKind[] = ["hosts", "repositories", "sources", "jobs"];

const labels: Record<EntityKind, [one: string, many: string]> = {
  hosts: ["host", "Hosts"],
  repositories: ["repository", "Repositories"],
  sources: ["source", "Sources"],
  jobs: ["job", "Jobs"],
};

const kind_text: Record<EntityKind, string> = {
  hosts: "A managed host runs the X-Backups agent; a storage-only host only holds repositories reached through borg serve.",
  repositories: "A borg repository on a host, with its passphrase, quota and checks.",
  sources: "Paths and excludes on one managed host.",
  jobs: "Backs any number of sources up to any number of repositories, with retention and its tasks.",
};

// Lines under the fields that read differently on an entity than on an older flat entry.
const entity_hints: Record<string, string> = {
  host: "The configured host it is on.",
  kind: "managed runs the agent; storage-only holds repositories only.",
  address: "The host's network name. Leave empty only for this server's own host.",
  agent_public_key: "The ssh-ed25519 line of the key its agent logs in with; with one set, tokens are refused. Empty logs in with a token.",
  poll_via: "The managed host that polls the repository when no job writes to it. Empty is the host it is on.",
  repo_by_host: "One per line: a host's name and the URL that host reaches the repository by, where it differs from repo.",
  sources: "The sources this job backs up; each host's sources go into one archive.",
  repositories: "The repositories it backs up to; each source host and repository is one target.",
  interval: "How often to poll the repository, such as 1h. Empty takes the default from Settings.",
};

const schedule_presets = ["hourly", "daily", "weekly", "monthly", "daily 02:00", "weekly sun 03:00", "6h", "1d", "7d"];

// Where an entry is shown once saved: its own page, or Settings for a repository, which has a page per target.
function entity_page(kind: EntityKind, name: string): string {
  return kind === "repositories" ? link(["settings"]) : link([kind, name]);
}

// ── Settings panels ──────────────────────────────────────────────────────────

// A panel per kind, listing each entry with where it came from, and Add when the page may change the config.
export function EntityPanels() {
  const all = use_resource(() => Promise.all(kinds.map((kind) => api<EntityConfig>(`/api/config/${kind}`))), []);
  return (
    <div className="stack">
      <Loaded resource={all} lines={4}>
        {(infos) => infos.map((info) => (
          <Section key={info.kind} title={labels[info.kind][1]}>
            <div className="stack">
              <p className="muted small">{kind_text[info.kind]}</p>
              {info.entries.length === 0
                ? <p className="muted">{`No ${labels[info.kind][1].toLowerCase()} written yet.`}</p>
                : <ul className="plain-list">{info.entries.map((entry) => <li key={entry.name}><a href={entry_link(info.kind, entry)}>{entry.name}</a> <SourceChip entry={entry} /></li>)}</ul>}
            </div>
            {info.editable && <a className="button" href={link(["settings", "new", info.kind])}>{`Add ${labels[info.kind][0]}`}</a>}
          </Section>
        ))}
      </Loaded>
    </div>
  );
}

function entry_link(kind: EntityKind, entry: EntityEntry): string {
  return entry.flat ? link(["repositories", String(entry.fields.id ?? entry.name), "config"]) : link(["settings", kind, entry.name]);
}

function SourceChip({ entry }: { entry: EntityEntry }) {
  if (entry.shadowed) return <Chip title="Added here, but a declared entry of the same name replaces it">hidden</Chip>;
  if (entry.flat) return <Chip title="One entry that is a host, repository, source and job at once">{entry.source === "declared" ? "declared, older shape" : "added here, older shape"}</Chip>;
  return entry.source === "declared"
    ? <Chip title="Set in the Nix configuration; change it there">declared</Chip>
    : <Chip title="Added from this page">added here</Chip>;
}

// ── One entry ────────────────────────────────────────────────────────────────

function kind_of(kind_text_given: string): EntityKind | undefined {
  return kinds.find((item) => item === kind_text_given);
}

// The page's title: the entry's name, Add and the kind for a new one, or Not found for a kind there is none of.
export function entity_title(kind_text_given: string, name: string | null): string {
  const kind = kind_of(kind_text_given);
  return kind === undefined ? "Not found" : name ?? `Add ${labels[kind][0]}`;
}

export function EntityView({ kind: kind_text_given, name }: { kind: string; name: string | null }) {
  const kind = kind_of(kind_text_given);
  const title = entity_title(kind_text_given, name);
  const loaded = use_resource(async () => {
    if (kind === undefined) return null;
    const [info, choices] = await Promise.all([api<EntityConfig>(`/api/config/${kind}`), choices_for(kind)]);
    return { info, choices };
  }, [kind_text_given, name]);
  const shown = loaded.data && kind !== undefined ? shown_for(name, loaded.data.info) : null;
  // A refresh while the form is open would throw away what was typed, so only a save or a reload redraws it.
  const editing = shown?.show === "editor";
  use_changes((changes) => { if (!editing && touches(changes, null, ["config"])) loaded.reload(true); });

  return (
    <div className="page">
      <Crumbs items={[["Settings", link(["settings"])], [kind ? labels[kind][1] : kind_text_given, null], [title, null]]} />
      <h1>{title}</h1>
      <div className="stack">
        <Loaded resource={loaded} lines={6}>
          {(answer) => {
            if (answer === null || kind === undefined) return <Empty title={`No kind ${kind_text_given}.`} hint={<a href={link(["settings"])}>Settings</a>} />;
            const { info, choices } = answer;
            const entry = shown!.entry;
            if (shown!.show === "missing") return <Empty title={`No ${labels[kind][0]} named ${name} is written in the config.`} hint={<a href={link(["settings"])}>Settings</a>} />;
            if (shown!.show === "flat") {
              return <div className="banner" role="note">This repository is an entry of the older shape, a host, repository, source and job in one, so it is changed on <a href={entry_link(kind, entry!)}>its Config tab</a>.</div>;
            }
            if (shown!.show === "declarative") {
              return <Empty title={`The config is declarative here, so ${labels[kind][1].toLowerCase()} are added in the Nix configuration.`}
                hint={`Declare them under services.x-backups.${kind}, or set services.x-backups.configMode to mixed to add them here too.`} />;
            }
            if (shown!.show === "read_only") return <ReadOnly kind={kind} entry={entry!} />;
            return <Editor key={load_key(answer)} kind={kind} info={info} entry={entry} choices={choices} reload={() => loaded.reload(true)} />;
          }}
        </Loaded>
      </div>
    </div>
  );
}

type Shown = { show: "missing" | "flat" | "declarative" | "read_only" | "editor"; entry: EntityEntry | null };

// What the page shows for the entry: a form, the entry read-only, or why there is neither.
function shown_for(name: string | null, info: EntityConfig): Shown {
  const entry = name === null ? null : info.entries.find((item) => item.name === name && !item.shadowed) ?? info.entries.find((item) => item.name === name) ?? null;
  if (name !== null && entry === null) return { show: "missing", entry };
  if (entry?.flat) return { show: "flat", entry };
  if (name === null && !info.editable) return { show: "declarative", entry };
  if (entry !== null && (entry.source === "declared" || !info.editable)) return { show: "read_only", entry };
  return { show: "editor", entry };
}

function ReadOnly({ kind, entry }: { kind: EntityKind; entry: EntityEntry }) {
  return <>
    {entry.source === "declared"
      ? <div className="banner" role="note"><strong>Declared in the Nix configuration.</strong>{` Change it under services.x-backups.${kind}.${entry.name} and switch the system to apply it.`}</div>
      : <div className="banner" role="note"><strong>Added from this page,</strong> but the config is declarative now, so the page shows it read-only.</div>}
    <ConfigTools fields={entry.fields} kind={kind} />
    <ConfigReadOnly fields={entry.fields} />
  </>;
}

// The names a field may pick from: hosts for a host, managed hosts for a source's host and a poll_via, and a job's
// sources and repositories.
async function choices_for(kind: EntityKind): Promise<Record<string, Choice>> {
  if (kind === "hosts") return { kind: { options: ["managed", "storage-only"], multiple: false } };
  const hosts = await api<HostRow[]>("/api/hosts").catch((): HostRow[] => []);
  const managed = hosts.filter((host) => host.kind === "managed").map((host) => host.name);
  if (kind === "sources") return { host: { options: managed, multiple: false } };
  if (kind === "repositories") return { host: { options: hosts.map((host) => host.name), multiple: false }, poll_via: { options: managed, multiple: false } };
  const [sources, repositories] = await Promise.all([
    api<SourceRow[]>("/api/sources").catch((): SourceRow[] => []),
    api<EntityConfig>("/api/config/repositories").catch(() => null),
  ]);
  return {
    sources: { options: sources.map((source) => source.name), multiple: true },
    repositories: { options: (repositories?.entries ?? []).map((entry) => entry.name), multiple: true },
  };
}

interface EditorProps {
  kind: EntityKind;
  info: EntityConfig;
  entry: EntityEntry | null;
  choices: Record<string, Choice>;
  reload: () => void;
}

function Editor({ kind, info, entry, choices, reload }: EditorProps) {
  const adding = entry === null;
  const [values] = useState(() => entry?.fields ?? (kind === "hosts" ? { kind: "managed" } : {}));
  const form = useRef<ConfigFormHandle>(null);
  const tasks = useRef<TasksHandle>(null);
  const [busy, set_busy] = useState(false);
  const label = labels[kind][0];
  const has_tasks = info.tasks.kinds.length > 0;

  async function save(): Promise<void> {
    const body: Record<string, unknown> = { ...form.current!.read(), ...(has_tasks ? { tasks: tasks.current!.read() } : {}) };
    set_busy(true);
    try {
      const saved_name = String(body.name ?? "");
      if (adding) await api(`/api/config/${kind}`, body);
      else await send("PUT", `/api/config/${kind}/${encodeURIComponent(entry.name)}`, body);
      toast(adding ? `${saved_name} added.` : "Saved. It applies at once.", { tone: "good" });
      location.hash = entity_page(kind, saved_name);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      if (error.field === "tasks" && has_tasks) tasks.current!.show_error(error.message);
      else form.current!.show_error(error.message, error.field);
    } finally {
      set_busy(false);
    }
  }

  function remove(removed: EntityEntry): void {
    confirm_dialog({
      title: `Remove the ${label} ${removed.name}?`,
      message: <div>
        <p>{`X-Backups forgets this ${label}. Nothing on disk is touched: borg repositories and their archives stay.`}</p>
        <p className="muted">Anything still naming it must be changed first; the history it made stays in X-Backups' state.</p>
      </div>,
      confirm_label: `Remove ${label}`,
      busy_label: "Removing…",
      danger: true,
      type_to_confirm: removed.name,
      run: async () => {
        try {
          await send("DELETE", `/api/config/${kind}/${encodeURIComponent(removed.name)}`);
          toast(`${removed.name} removed.`, { tone: "warn" });
          location.hash = kind === "repositories" ? link(["settings"]) : link([kind]);
        } catch (error) {
          toast(`Could not remove it: ${describe_error(error)}`, { tone: "bad" });
        }
      },
    });
  }

  return <>
    {entry?.shadowed && <div className="banner" role="note"><strong>Hidden.</strong> A declared entry of the same name replaces this one; remove it here or rename the declared one.</div>}
    <p className="muted">{kind_text[kind]}{adding ? " Empty fields take their defaults." : " Saving applies the change at once; nothing restarts."}</p>
    {entry && <ConfigTools fields={entry.fields} kind={kind} />}
    <ConfigForm fields={info.fields} values={values} adding={adding} choices={choices} hints={entity_hints} handle={form} />
    {has_tasks && <TasksEditor allowed={info.tasks} written={(values.tasks ?? {}) as Record<string, unknown>} handle={tasks} />}
    <div className="form-actions">
      <button className="accent solid" disabled={busy} onClick={save}>{busy ? "Saving…" : adding ? `Add ${label}` : "Save"}</button>
      <button onClick={reload}>Discard changes</button>
      {!adding && <button className="danger" onClick={() => remove(entry)}>{`Remove ${label}`}</button>}
    </div>
  </>;
}

// ── Tasks editor ─────────────────────────────────────────────────────────────

interface TasksHandle {
  read: () => Record<string, unknown> | undefined;
  show_error: (message: string) => void;
}

interface TaskDraft {
  schedule: string;
  enabled: "" | "true" | "false";
  after: boolean;
  check: string;
}

function draft_of(given: unknown): TaskDraft {
  const task = (typeof given === "string" || typeof given === "number" ? { schedule: given } : given ?? {}) as Record<string, unknown>;
  return {
    schedule: task.schedule === undefined ? "" : String(task.schedule),
    enabled: task.enabled === true ? "true" : task.enabled === false ? "false" : "",
    after: task.after === "backup",
    check: typeof task.kind === "string" ? task.kind : "",
  };
}

function read_draft(draft: TaskDraft): Record<string, unknown> | undefined {
  const result: Record<string, unknown> = {};
  const text = draft.schedule.trim();
  if (text) result.schedule = /^\d+$/.test(text) ? Number(text) : text;
  if (draft.enabled) result.enabled = draft.enabled === "true";
  if (draft.after) result.after = "backup";
  if (draft.check) result.kind = draft.check;
  return Object.keys(result).length === 0 ? undefined : result;
}

interface TasksEditorProps {
  allowed: EntityConfig["tasks"];
  written: Record<string, unknown>;
  handle: RefObject<TasksHandle | null>;
}

// A row per task the kind takes, and one per check with a button to add another: its schedule with presets and its
// meaning in words as it is typed, whether it is switched on, whether it runs after each backup, and what a check checks.
function TasksEditor({ allowed, written, handle }: TasksEditorProps) {
  const [drafts, set_drafts] = useState<Record<string, TaskDraft>>(() => Object.fromEntries(allowed.kinds.filter((kind) => kind !== "check").map((kind) => [kind, draft_of(written[kind])])));
  const [checks, set_checks] = useState<TaskDraft[]>(() => (Array.isArray(written.check) ? written.check : [written.check]).map(draft_of));
  const [error, set_error] = useState<string | null>(null);
  const note = useRef<HTMLParagraphElement>(null);

  handle.current = {
    read: () => {
      const tasks: Record<string, unknown> = {};
      for (const kind of allowed.kinds) {
        if (kind !== "check") {
          const value = read_draft(drafts[kind]);
          if (value !== undefined) tasks[kind] = value;
          continue;
        }
        // One check is written as an object, several as a list, each naming its kind.
        const values = checks.map(read_draft).filter((value) => value !== undefined);
        const value = values.length <= 1 ? values[0] : values;
        if (value !== undefined) tasks[kind] = value;
      }
      return Object.keys(tasks).length === 0 ? undefined : tasks;
    },
    show_error: (message) => {
      set_error(message);
      requestAnimationFrame(() => note.current?.scrollIntoView({ block: "center" }));
    },
  };

  return (
    <section className="panel">
      <div className="panel-head"><h2>Tasks</h2></div>
      <p className="muted small">{"Each takes a duration from its last run, hourly, daily, weekly, monthly, daily HH:MM, weekly <day> HH:MM or a cron line."}</p>
      <p ref={note} className="field-error tone-bad small" role="alert" hidden={error === null}>{error}</p>
      <datalist id="schedule-presets">{schedule_presets.map((preset) => <option key={preset} value={preset} />)}</datalist>
      <div className="form-rows">
        {allowed.kinds.map((kind) => kind !== "check"
          ? <TaskRow key={kind} kind={kind} id={`task-${kind}`} draft={drafts[kind]} allowed={allowed} on_change={(draft) => set_drafts({ ...drafts, [kind]: draft })} />
          : (
            <div key={kind} className="stack">
              <div className="form-rows">
                {checks.map((draft, index) => (
                  <TaskRow key={index} kind={kind} id={`task-check-${index}`} draft={draft} allowed={allowed}
                    on_change={(next) => set_checks(checks.map((other, at) => at === index ? next : other))} />
                ))}
              </div>
              <div className="toolbar"><button type="button" onClick={() => set_checks([...checks, draft_of(undefined)])}>Add a check</button></div>
            </div>
          ))}
      </div>
    </section>
  );
}

interface TaskRowProps {
  kind: string;
  id: string;
  draft: TaskDraft;
  allowed: EntityConfig["tasks"];
  on_change: (draft: TaskDraft) => void;
}

// One task's row: its schedule, whether it is switched on, and whether it runs after a backup or what it checks.
function TaskRow({ kind, id, draft, allowed, on_change }: TaskRowProps) {
  const change = (part: Partial<TaskDraft>) => on_change({ ...draft, ...part });
  const value = (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => event.currentTarget.value;
  return (
    <div className="form-row">
      <label htmlFor={id}><code>{kind}</code></label>
      <div className="stack">
        <input id={id} type="text" list="schedule-presets" autoComplete="off" placeholder="such as daily 02:00, 6h or a cron line"
          aria-describedby={`${id}-preview`} value={draft.schedule} onChange={(event) => change({ schedule: value(event) })} />
        <SchedulePreviewLine id={`${id}-preview`} text={draft.schedule.trim()} />
        <div className="toolbar">
          <label className="field">
            <span className="field-label">Switched</span>
            <select aria-label={`${kind} enabled`} value={draft.enabled} onChange={(event) => change({ enabled: value(event) as TaskDraft["enabled"] })}>
              <option value="">on when scheduled</option>
              <option value="true">on</option>
              <option value="false">off</option>
            </select>
          </label>
          {(kind === "prune" || kind === "compact") && (
            <label className="check">
              <input type="checkbox" checked={draft.after} aria-label={`${kind} after each backup`} onChange={(event) => change({ after: (event.currentTarget as HTMLInputElement).checked })} />
              {" Also after each successful backup"}
            </label>
          )}
          {kind === "check" && (
            <label className="field">
              <span className="field-label">Checks</span>
              <select aria-label="What the check checks" value={draft.check} onChange={(event) => change({ check: value(event) })}>
                <option value="">default</option>
                {allowed.check_kinds.map((option) => <option key={option} value={option}>{option}</option>)}
              </select>
            </label>
          )}
        </div>
      </div>
    </div>
  );
}

// The schedule in words with its next runs, read from the server once typing pauses.
function SchedulePreviewLine({ id, text }: { id: string; text: string }) {
  const [preview, set_preview] = useState<{ text: string; bad: boolean }>({ text: "", bad: false });
  useEffect(() => {
    if (!text) {
      set_preview({ text: "No schedule: the default from its limits applies, or it runs only by hand.", bad: false });
      return;
    }
    let current = true;
    const timer = window.setTimeout(async () => {
      try {
        const answer = await api<SchedulePreview>(`/api/schedule${query({ text })}`);
        if (current) set_preview({ text: `${answer.description}; next ${answer.next.map(stamp).join(", ")} (${answer.time_zone})`, bad: false });
      } catch (error) {
        if (current) set_preview({ text: describe_error(error), bad: true });
      }
    }, 300);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [text]);
  return <p className={preview.bad ? "tone-bad small" : "muted small"} id={id} aria-live="polite">{preview.text}</p>;
}
