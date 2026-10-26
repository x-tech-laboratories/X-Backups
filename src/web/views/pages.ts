// The smaller pages: every host's timers, the event log, and the settings.

import { timer_problem } from "../attention.ts";
import { api, query, type EventRow, type RepositorySummary, type TimerRow } from "../api.ts";
import { h } from "../dom.ts";
import { current_route, link, replace_query } from "../router.ts";
import { theme_choice, type Theme } from "../theme.ts";
import { chip, empty, facts, load, pager, section, select, skeleton, toolbar } from "../ui.ts";
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

export function settings_view(): View {
  const repositories = h("div", {}, skeleton(3));
  void load(repositories, async () => {
    const list = await api<RepositorySummary[]>("/api/repositories");
    if (list.length === 0) return empty("No repositories are declared.");
    return h("ul", { class: "plain-list" }, ...list.map((repository) => h("li", {},
      h("a", { href: link(["repositories", repository.id, "config"]) }, repository.name), " ",
      chip(repository.source === "declared" ? "declared" : "page-managed"))));
  });

  return {
    title: "Settings",
    root: h("div", { class: "page" },
      h("h1", {}, "Settings"),
      section("Appearance", h("div", {},
        select("Theme", [["system", "Follow the system"], ["light", "Light"], ["dark", "Dark"]], theme_choice.get(), (value) => theme_choice.set(value as Theme)),
        h("p", { class: "muted small" }, "Kept in this browser only."),
      )),
      section("Configuration", h("div", {},
        facts([
          ["Mode", "Declarative"],
          ["Source", "The JSON file the NixOS module writes from services.x-backups"],
        ]),
        h("p", { class: "muted" }, "Repositories and their settings are read-only here. Change them in the Nix configuration and switch the system; X-Backups restarts with the new file."),
      )),
      section("Repositories", repositories),
    ),
  };
}
