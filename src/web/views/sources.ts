// Every source: the paths and excludes on one managed host, and the jobs backing them up; and one source's page.

import { api, type SourceRow } from "../api.ts";
import { h, nodes, type Child } from "../dom.ts";
import { link } from "../router.ts";
import { can } from "../session.ts";
import { attempt, chip, crumbs, data_table, empty, facts, section, skeleton } from "../ui.ts";
import { touches, type View } from "./shared.ts";

export function sources_view(): View {
  const body = h("div", {}, skeleton(5));
  const update = async (quiet: boolean) => {
    const sources = await attempt(body, quiet, () => api<SourceRow[]>("/api/sources"), () => void update(false));
    if (sources === null) return;
    body.replaceChildren(sources.length === 0
      ? empty("No sources yet.", can("admin") ? h("a", { href: link(["settings", "new", "sources"]) }, "Add a source in Settings") : "A source names the paths a job backs up on one host; they are declared under services.x-backups.sources.")
      : data_table<SourceRow>([
        { label: "Source", cell: (source) => h("a", { href: link(["sources", source.name]) }, source.name), sort: (source) => source.name },
        { label: "Host", cell: (source) => h("a", { href: link(["hosts", source.host]) }, source.host), sort: (source) => source.host },
        { label: "Paths", cell: (source) => paths_inline(source.paths) },
        { label: "Excludes", class: "number", cell: (source) => source.exclude.length },
        { label: "Jobs", cell: (source) => job_links(source.jobs) },
        { label: "From", cell: (source) => origin_chip(source) },
      ], sources, { caption: "Sources" }));
  };
  void update(false);
  return {
    title: "Sources",
    root: h("div", { class: "page" },
      h("div", { class: "page-title spread" }, h("h1", {}, "Sources"), can("admin") && h("a", { class: "button", href: link(["settings", "new", "sources"]) }, "Add source")),
      body),
    update: async (changes) => {
      if (touches(changes, null, ["config"])) await update(true);
    },
  };
}

export function source_view(name: string): View {
  const body = h("div", { class: "stack" }, skeleton(5));
  const update = async (quiet: boolean) => {
    const source = await attempt(body, quiet, () => api<SourceRow>(`/api/sources/${encodeURIComponent(name)}`), () => void update(false));
    if (source === null) return;
    const settings = Object.entries(source.settings).filter(([field]) => field !== "source_paths" && field !== "exclude");
    body.replaceChildren(...nodes([
      h("header", { class: "page-head" },
        h("div", { class: "page-title" }, h("h1", {}, source.name), origin_chip(source)),
        h("p", { class: "muted" }, "On ", h("a", { href: link(["hosts", source.host]) }, source.host)),
        can("admin") && h("div", { class: "head-actions" }, h("a", { class: "button", href: config_link(source) }, "Config"))),
      section("Backed up", path_list(source.paths, "No paths.")),
      section("Excluded", path_list(source.exclude, "Nothing is excluded.")),
      settings.length > 0 && section("Other settings", facts(settings.map(([field, value]): [string, Child] => [field, h("code", {}, JSON.stringify(value))]), "rows")),
      section("Jobs backing it up", source.jobs.length === 0
        ? empty("No job uses this source yet.", "Add it to a job's sources to back it up.")
        : h("ul", { class: "plain-list" }, ...source.jobs.map((job) => h("li", {}, h("a", { href: link(["jobs", job]) }, job))))),
    ]));
  };
  void update(false);
  return {
    title: name,
    root: h("div", { class: "page" }, crumbs([["Sources", link(["sources"])], [name, null]]), body),
    update: async (changes) => {
      if (touches(changes, null, ["config"])) await update(true);
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// Where an entity's config lives: its own entry, or the flat repository entry it was expanded from.
export function config_link(entity: { name: string; expanded_from: string | null }, kind = "sources"): string {
  return entity.expanded_from === null ? link(["settings", kind, entity.name]) : link(["settings", "repositories", entity.expanded_from]);
}

export function origin_chip(entity: { source: "declared" | "page"; expanded_from: string | null }): HTMLElement {
  if (entity.expanded_from !== null) return chip(entity.source === "declared" ? "declared, older shape" : "added here, older shape", `Expanded from the repository entry ${entity.expanded_from}`);
  return entity.source === "declared" ? chip("declared", "Set in the Nix configuration; change it there") : chip("added here", "Added from this page; change it in Settings");
}

export function job_links(jobs: string[]): Child {
  if (jobs.length === 0) return h("span", { class: "muted" }, "none");
  return jobs.flatMap((job, index) => [index > 0 ? ", " : null, h("a", { href: link(["jobs", job]) }, job)]);
}

function paths_inline(paths: string[]): Child {
  const shown = paths.slice(0, 3).join(", ");
  return h("code", { title: paths.join("\n") }, paths.length > 3 ? `${shown} and ${paths.length - 3} more` : shown);
}

function path_list(items: string[], none: string): HTMLElement {
  return items.length > 0 ? h("ul", { class: "paths" }, ...items.map((item) => h("li", {}, h("code", {}, item)))) : h("p", { class: "muted" }, none);
}
