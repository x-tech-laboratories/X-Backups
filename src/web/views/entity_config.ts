// Each host, repository, source and job as written: a list per kind in Settings, and one entry's page, a form in mixed
// and page modes with a job's sources and repositories picked from lists and its tasks edited with their schedules in
// words, or read-only with its source named.

import { api, ApiError, query, send, type EntityConfig, type EntityEntry, type EntityKind, type HostRow, type SchedulePreview, type SourceRow } from "../api.ts";
import { h, stamp, type Child } from "../dom.ts";
import { link } from "../router.ts";
import { chip, confirm_dialog, crumbs, empty, load, section, skeleton, toast } from "../ui.ts";
import { config_form, config_read_only, config_tools, type Choice } from "./config_form.ts";
import { touches, type View } from "./shared.ts";

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
export function entity_panels(): HTMLElement {
  const holder = h("div", { class: "stack" }, skeleton(4));
  void load(holder, async () => {
    const all = await Promise.all(kinds.map((kind) => api<EntityConfig>(`/api/config/${kind}`)));
    return all.map((info) => section(labels[info.kind][1], h("div", { class: "stack" },
      h("p", { class: "muted small" }, kind_text[info.kind]),
      info.entries.length === 0 ? h("p", { class: "muted" }, `No ${labels[info.kind][1].toLowerCase()} written yet.`) : h("ul", { class: "plain-list" }, ...info.entries.map((entry) => h("li", {},
        h("a", { href: entry_link(info.kind, entry) }, entry.name), " ", source_chip(entry))))),
    info.editable && h("a", { class: "button", href: link(["settings", "new", info.kind]) }, `Add ${labels[info.kind][0]}`)));
  });
  return holder;
}

function entry_link(kind: EntityKind, entry: EntityEntry): string {
  return entry.flat ? link(["repositories", String(entry.fields.id ?? entry.name), "config"]) : link(["settings", kind, entry.name]);
}

function source_chip(entry: EntityEntry): HTMLElement {
  if (entry.shadowed) return chip("hidden", "Added here, but a declared entry of the same name replaces it");
  if (entry.flat) return chip(entry.source === "declared" ? "declared, older shape" : "added here, older shape", "One entry that is a host, repository, source and job at once");
  return entry.source === "declared" ? chip("declared", "Set in the Nix configuration; change it there") : chip("added here", "Added from this page");
}

// ── One entry ────────────────────────────────────────────────────────────────

export function entity_view(kind_text_given: string, name: string | null): View {
  const kind = kinds.find((item) => item === kind_text_given);
  const title = kind === undefined ? "Not found" : name ?? `Add ${labels[kind][0]}`;
  const body = h("div", { class: "stack" }, skeleton(6));
  // A refresh while the form is open would throw away what was typed, so only a save or a reload redraws it.
  let editing = false;
  const reload = async (quiet: boolean) => {
    editing = false;
    await load(body, async () => {
      if (kind === undefined) return empty(`No kind ${kind_text_given}.`, h("a", { href: link(["settings"]) }, "Settings"));
      const [info, choices] = await Promise.all([api<EntityConfig>(`/api/config/${kind}`), choices_for(kind)]);
      const entry = name === null ? null : info.entries.find((item) => item.name === name && !item.shadowed) ?? info.entries.find((item) => item.name === name) ?? null;
      if (name !== null && entry === null) return empty(`No ${labels[kind][0]} named ${name} is written in the config.`, h("a", { href: link(["settings"]) }, "Settings"));
      if (entry?.flat) {
        return h("div", { class: "banner", role: "note" }, "This repository is an entry of the older shape, a host, repository, source and job in one, so it is changed on ",
          h("a", { href: entry_link(kind, entry) }, "its Config tab"), ".");
      }
      if (name === null && !info.editable) {
        return empty(`The config is declarative here, so ${labels[kind][1].toLowerCase()} are added in the Nix configuration.`,
          `Declare them under services.x-backups.${kind}, or set services.x-backups.configMode to mixed to add them here too.`);
      }
      if (entry !== null && (entry.source === "declared" || !info.editable)) return read_only(kind, entry);
      editing = true;
      return editor(kind, info, entry, choices, () => void reload(true));
    }, { quiet });
  };
  void reload(false);
  return {
    title,
    root: h("div", { class: "page" },
      crumbs([["Settings", link(["settings"])], [kind ? labels[kind][1] : kind_text_given, null], [title, null]]),
      h("h1", {}, title),
      body),
    update: async (changes) => {
      if (!editing && touches(changes, null, ["config"])) await reload(true);
    },
  };
}

function read_only(kind: EntityKind, entry: EntityEntry): Child[] {
  const why = entry.source === "declared"
    ? [h("strong", {}, "Declared in the Nix configuration."), ` Change it under services.x-backups.${kind}.${entry.name} and switch the system to apply it.`]
    : [h("strong", {}, "Added from this page,"), " but the config is declarative now, so the page shows it read-only."];
  return [h("div", { class: "banner", role: "note" }, ...why), config_tools(entry.fields, kind), ...config_read_only(entry.fields)];
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

function editor(kind: EntityKind, info: EntityConfig, entry: EntityEntry | null, choices: Record<string, Choice>, reload: () => void): Child[] {
  const adding = entry === null;
  const values = entry?.fields ?? (kind === "hosts" ? { kind: "managed" } : {});
  const form = config_form(info.fields, values, { adding, choices, hints: entity_hints });
  const tasks = info.tasks.kinds.length > 0 ? tasks_editor(info.tasks, (values.tasks ?? {}) as Record<string, unknown>) : null;
  const label = labels[kind][0];
  const save = h("button", { class: "accent solid" }, adding ? `Add ${label}` : "Save");
  save.addEventListener("click", async () => {
    const body: Record<string, unknown> = { ...form.read(), ...(tasks ? { tasks: tasks.read() } : {}) };
    save.disabled = true;
    save.textContent = "Saving…";
    try {
      const saved_name = String(body.name ?? "");
      if (adding) await api(`/api/config/${kind}`, body);
      else await send("PUT", `/api/config/${kind}/${encodeURIComponent(entry.name)}`, body);
      toast(adding ? `${saved_name} added.` : "Saved. It applies at once.", { tone: "good" });
      location.hash = entity_page(kind, saved_name);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      if (error.field === "tasks" && tasks) tasks.show_error(error.message);
      else form.show_error(error.message, error.field);
    } finally {
      save.disabled = false;
      save.textContent = adding ? `Add ${label}` : "Save";
    }
  });
  const remove = !adding && h("button", {
    class: "danger",
    onclick: () => confirm_dialog({
      title: `Remove the ${label} ${entry.name}?`,
      message: h("div", {},
        h("p", {}, `X-Backups forgets this ${label}. Nothing on disk is touched: borg repositories and their archives stay.`),
        h("p", { class: "muted" }, "Anything still naming it must be changed first; the history it made stays in X-Backups' state.")),
      confirm_label: `Remove ${label}`,
      busy_label: "Removing…",
      danger: true,
      type_to_confirm: entry.name,
      run: async () => {
        try {
          await send("DELETE", `/api/config/${kind}/${encodeURIComponent(entry.name)}`);
          toast(`${entry.name} removed.`, { tone: "warn" });
          location.hash = kind === "repositories" ? link(["settings"]) : link([kind]);
        } catch (error) {
          toast(`Could not remove it: ${error instanceof Error ? error.message : String(error)}`, { tone: "bad" });
        }
      },
    }),
  }, `Remove ${label}`);
  return [
    entry?.shadowed && h("div", { class: "banner", role: "note" }, h("strong", {}, "Hidden."), " A declared entry of the same name replaces this one; remove it here or rename the declared one."),
    h("p", { class: "muted" }, kind_text[kind], adding ? " Empty fields take their defaults." : " Saving applies the change at once; nothing restarts."),
    entry && config_tools(entry.fields, kind),
    form.element,
    tasks?.element,
    h("div", { class: "form-actions" }, save, h("button", { onclick: reload }, "Discard changes"), remove),
  ];
}

// ── Tasks editor ─────────────────────────────────────────────────────────────

interface TasksEditor {
  element: HTMLElement;
  read: () => Record<string, unknown> | undefined;
  show_error: (message: string) => void;
}

// A row per task the kind takes: its schedule with presets and its meaning in words as it is typed, whether it is
// switched on, whether it runs after each backup, and what a check checks.
function tasks_editor(allowed: EntityConfig["tasks"], written: Record<string, unknown>): TasksEditor {
  const note = h("p", { class: "field-error tone-bad small", role: "alert", hidden: true });
  const presets = h("datalist", { id: "schedule-presets" }, ...schedule_presets.map((preset) => h("option", { value: preset })));
  const readers: [kind: string, read: () => Record<string, unknown> | undefined][] = [];
  const rows = allowed.kinds.map((kind) => {
    const given = written[kind];
    const task = (typeof given === "string" || typeof given === "number" ? { schedule: given } : given ?? {}) as Record<string, unknown>;
    const id = `task-${kind}`;
    const schedule = h("input", { id, type: "text", list: "schedule-presets", autocomplete: "off", placeholder: "such as daily 02:00, 6h or a cron line" });
    schedule.value = task.schedule === undefined ? "" : String(task.schedule);
    const preview = h("p", { class: "muted small", id: `${id}-preview`, "aria-live": "polite" });
    schedule.setAttribute("aria-describedby", `${id}-preview`);
    let timer: number | undefined;
    const describe = () => {
      clearTimeout(timer);
      const text = schedule.value.trim();
      if (!text) {
        preview.textContent = "No schedule: the default from its limits applies, or it runs only by hand.";
        preview.className = "muted small";
        return;
      }
      timer = window.setTimeout(async () => {
        try {
          const answer = await api<SchedulePreview>(`/api/schedule${query({ text })}`);
          if (schedule.value.trim() !== text) return;
          preview.textContent = `${answer.description}; next ${answer.next.map(stamp).join(", ")} (${answer.time_zone})`;
          preview.className = "muted small";
        } catch (error) {
          preview.textContent = error instanceof Error ? error.message : String(error);
          preview.className = "tone-bad small";
        }
      }, 300);
    };
    schedule.addEventListener("input", describe);
    describe();
    const enabled = h("select", { "aria-label": `${kind} enabled` },
      h("option", { value: "", selected: task.enabled === undefined }, "on when scheduled"),
      h("option", { value: "true", selected: task.enabled === true }, "on"),
      h("option", { value: "false", selected: task.enabled === false }, "off"));
    const after = kind === "prune" || kind === "compact"
      ? h("input", { type: "checkbox", checked: task.after === "backup", "aria-label": `${kind} after each backup` }) : null;
    const check = kind === "check"
      ? h("select", { "aria-label": "What the check checks" },
        h("option", { value: "", selected: task.kind === undefined }, "default"),
        ...allowed.check_kinds.map((option) => h("option", { value: option, selected: task.kind === option }, option)))
      : null;
    readers.push([kind, () => {
      const result: Record<string, unknown> = {};
      const text = schedule.value.trim();
      if (text) result.schedule = /^\d+$/.test(text) ? Number(text) : text;
      if (enabled.value) result.enabled = enabled.value === "true";
      if (after?.checked) result.after = "backup";
      if (check?.value) result.kind = check.value;
      return Object.keys(result).length === 0 ? undefined : result;
    }]);
    return h("div", { class: "form-row" },
      h("label", { for: id }, h("code", {}, kind)),
      h("div", { class: "stack" }, schedule, preview,
        h("div", { class: "toolbar" },
          h("label", { class: "field" }, h("span", { class: "field-label" }, "Switched"), enabled),
          after && h("label", { class: "check" }, after, " Also after each successful backup"),
          check && h("label", { class: "field" }, h("span", { class: "field-label" }, "Checks"), check))),
    );
  });
  return {
    element: h("section", { class: "panel" },
      h("div", { class: "panel-head" }, h("h2", {}, "Tasks")),
      h("p", { class: "muted small" }, "Each takes a duration from its last run, hourly, daily, weekly, monthly, daily HH:MM, weekly <day> HH:MM or a cron line."),
      note, presets, h("div", { class: "form-rows" }, ...rows)),
    read: () => {
      const tasks = Object.fromEntries(readers.map(([kind, read]) => [kind, read()]).filter(([, value]) => value !== undefined));
      return Object.keys(tasks).length === 0 ? undefined : tasks;
    },
    show_error: (message) => {
      note.textContent = message;
      note.hidden = false;
      note.scrollIntoView({ block: "center" });
    },
  };
}
