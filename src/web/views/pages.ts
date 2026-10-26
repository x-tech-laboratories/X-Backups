// The smaller pages: every host's timers, the event log, and the settings.

import { timer_problem } from "../attention.ts";
import { api, ApiError, query, send, type ConfigInfo, type EventRow, type RepositorySummary, type Setting, type TimerRow } from "../api.ts";
import { h, type Child } from "../dom.ts";
import { current_route, link, replace_query } from "../router.ts";
import { theme_choice, type Theme } from "../theme.ts";
import { chip, empty, facts, load, pager, section, select, skeleton, toast, toolbar } from "../ui.ts";
import { event_levels } from "./repository.ts";
import { events_list, timers_table, touches, type View } from "./shared.ts";

const page_size = 50;

// ── Schedules ────────────────────────────────────────────────────────────────

export function schedules_view(): View {
  const route_query = current_route().query;
  let host = route_query.get("host") ?? "";
  let state = route_query.get("state") ?? "";
  let timers: TimerRow[] = [];
  const host_filter = h("span");
  const list = h("div", {}, skeleton(5));

  const render = () => {
    const hosts = [...new Set(timers.map((timer) => timer.host))].sort();
    host_filter.replaceChildren(select("Host", [["", "Any host"], ...hosts.map((name): [string, string] => [name, name])], host, (value) => {
      host = value;
      replace_query({ host: value });
      render();
    }));
    const shown = timers
      .filter((timer) => (!host || timer.host === host) && (state !== "problem" || timer_problem(timer) !== null))
      .sort((a, b) => (a.next_epoch ?? Infinity) - (b.next_epoch ?? Infinity));
    list.replaceChildren(shown.length === 0 && timers.length > 0 ? empty("No timer matches these filters.") : timers_table(shown, true));
  };
  const refresh = async (quiet: boolean) => {
    await load(list, async () => {
      timers = await api<TimerRow[]>("/api/timers");
      render();
      return [...list.childNodes];
    }, { quiet });
  };
  void refresh(false);

  return {
    title: "Schedules",
    root: h("div", { class: "page" },
      h("h1", {}, "Schedules"),
      h("p", { class: "muted" }, "Each host's own systemd timers run its backups; X-Backups reads them on each poll and flags missed and failed runs."),
      toolbar(host_filter, select("State", [["", "Any state"], ["problem", "Needs attention"]], state, (value) => { state = value; replace_query({ state: value }); render(); })),
      list,
    ),
    update: async (changes) => {
      if (touches(changes, null, ["timers"])) await refresh(true);
    },
  };
}

// ── Events ───────────────────────────────────────────────────────────────────

export function events_view(): View {
  const route_query = current_route().query;
  let repository = route_query.get("repository") ?? "";
  let level = route_query.get("level") ?? "";
  let page = Number(route_query.get("page") ?? 1);
  const repository_filter = h("span");
  const list = h("div", {}, skeleton(8));

  const refresh = async (quiet: boolean) => {
    await load(list, async () => {
      const events = await api<EventRow[]>(`/api/events${query({ repository, level, limit: page_size + 1, offset: (page - 1) * page_size })}`);
      return [
        events_list(events.slice(0, page_size), true),
        pager(page, events.length > page_size, (next) => { page = next; replace_query({ page: next === 1 ? null : next }); void refresh(false); }),
      ];
    }, { quiet });
  };
  const refilter = () => {
    page = 1;
    replace_query({ repository, level, page: null });
    void refresh(false);
  };

  void api<RepositorySummary[]>("/api/repositories").then((repositories) => {
    repository_filter.replaceChildren(select("Repository", [["", "Any repository"], ...repositories.map((item): [string, string] => [item.id, item.name])], repository,
      (value) => { repository = value; refilter(); }));
  }).catch(() => {});
  void refresh(false);

  return {
    title: "Events",
    root: h("div", { class: "page" },
      h("h1", {}, "Events"),
      toolbar(repository_filter, select("Level", event_levels, level, (value) => { level = value; refilter(); })),
      list,
    ),
    update: async (changes) => {
      if (page === 1 && touches(changes, null, ["repository", "job"])) await refresh(true);
    },
  };
}

// ── Settings ─────────────────────────────────────────────────────────────────

const mode_text: Record<ConfigInfo["mode"], [title: string, text: string]> = {
  declarative: ["Declarative", "Everything comes from the Nix configuration and the page shows it read-only. Set services.x-backups.configMode to mixed to add repositories and defaults here too."],
  mixed: ["Mixed", "What the Nix configuration declares is locked. The page may add repositories and set the defaults it leaves open; a declared repository of the same name replaces a page one."],
  page: ["Page", "The page manages repositories and defaults; anything the Nix configuration declares is still locked."],
};

const setting_hints: Record<string, string> = {
  interval: "How often each repository is polled, such as 1h.",
  max_age: "The newest archive older than this fails a repository, such as 1d.",
  check_max_age: "A check older than this fails a repository, such as 8d.",
  browse_limit: "How many entries a folder, diff or listing shows at most.",
};

const source_text: Record<Setting["source"], [label: string, title: string]> = {
  declared: ["declared", "Set in the Nix configuration; change it there"],
  saved: ["saved", "Saved from this page"],
  default: ["default", "Built in; nothing sets it"],
};

export function settings_view(): View {
  const configuration = h("div", {}, skeleton(4));
  const repositories = h("div", {}, skeleton(3));

  const refresh = async (quiet: boolean) => {
    await load(configuration, async () => configuration_panel(await api<ConfigInfo>("/api/config"), () => void refresh(true)), { quiet });
    await load(repositories, async () => {
      const list = await api<RepositorySummary[]>("/api/repositories");
      if (list.length === 0) return empty("No repositories yet.");
      return h("ul", { class: "plain-list" }, ...list.map((repository) => h("li", {},
        h("a", { href: link(["repositories", repository.id, "config"]) }, repository.name), " ",
        chip(repository.source === "declared" ? "declared" : "added here"))));
    }, { quiet });
  };
  void refresh(false);

  return {
    title: "Settings",
    root: h("div", { class: "page" },
      h("h1", {}, "Settings"),
      section("Appearance", h("div", {},
        select("Theme", [["system", "Follow the system"], ["light", "Light"], ["dark", "Dark"]], theme_choice.get(), (value) => theme_choice.set(value as Theme)),
        h("p", { class: "muted small" }, "Kept in this browser only."),
      )),
      configuration,
      section("Repositories", repositories),
    ),
    update: async (changes) => {
      if (touches(changes, null, ["config"])) await refresh(true);
    },
  };
}

function configuration_panel(info: ConfigInfo, saved: () => void): Child[] {
  const [title, text] = mode_text[info.mode];
  const inputs = new Map<string, HTMLInputElement>();
  const message = h("p", { class: "tone-bad small", role: "alert" });
  const rows = info.settings.map((setting) => {
    const [label, label_title] = source_text[setting.source];
    const locked = !info.editable || setting.source === "declared";
    const input = h("input", { id: `setting-${setting.name}`, type: "text", readonly: locked, placeholder: setting.source === "default" ? String(setting.value) : null });
    if (setting.source !== "default") input.value = String(setting.value);
    inputs.set(setting.name, input);
    return h("div", { class: "form-row" },
      h("label", { for: `setting-${setting.name}` }, h("code", {}, setting.name)),
      h("div", {}, h("div", { class: "setting-value" }, input, h("span", { class: `chip source-${setting.source}`, title: label_title }, label)),
        h("p", { class: "muted small" }, setting_hints[setting.name] ?? "")),
    );
  });

  const save = h("button", { class: "accent solid" }, "Save defaults");
  save.addEventListener("click", async () => {
    const values: Record<string, unknown> = {};
    for (const setting of info.settings) {
      if (setting.source === "declared") continue;
      const text = inputs.get(setting.name)!.value.trim();
      values[setting.name] = text === "" ? null : /^\d+$/.test(text) ? Number(text) : text;
    }
    save.disabled = true;
    message.textContent = "";
    try {
      await send("PUT", "/api/config/defaults", values);
      toast("Defaults saved. Repositories that use them are polled again.", { tone: "good" });
      saved();
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      message.textContent = error.message;
      if (error.field) inputs.get(error.field)?.focus();
    } finally {
      save.disabled = false;
    }
  });

  return [
    section("Configuration", h("div", { class: "stack" },
      facts([["Mode", title]]),
      h("p", { class: "muted" }, text),
      info.shadowed.length > 0 && h("div", { class: "banner", role: "note" },
        h("strong", {}, "Hidden by the Nix configuration: "), info.shadowed.join(", "),
        ". These were added here, but a declared repository of the same name replaces each one; remove them from the page or rename the declared one."),
      info.editable && h("p", {}, h("a", { class: "button accent solid", href: link(["new-repository"]) }, "Add a repository")),
    )),
    section("Defaults for every repository", h("div", { class: "stack" },
      h("p", { class: "muted small" }, "A repository's own setting wins over these. An empty field goes back to the built-in value."),
      h("div", { class: "form-rows" }, ...rows),
      info.editable && h("div", {}, save, message),
    )),
  ];
}
