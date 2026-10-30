// Every target, a job's backups from one host to one repository or a repository only watched, as cards or a table,
// searched, filtered and sorted, with the choices kept in the URL.

import { failing, overdue, repository_reasons } from "../attention.ts";
import { api, type ConfigInfo, type RepositorySummary } from "../api.ts";
import { h } from "../dom.ts";
import { current_route, link, replace_query } from "../router.ts";
import { attempt, empty, search_box, select, skeleton, sorting_from, toolbar, type Sorting } from "../ui.ts";
import { repositories_table, repository_card, status_rank, touches, type View } from "./shared.ts";

const status_filters: [value: string, text: string][] = [
  ["", "Any status"],
  ["failing", "Failing"],
  ["attention", "Needs attention"],
  ["overdue", "Overdue"],
  ["running", "Run in progress"],
  ["ok", "OK"],
];

const sorts: [value: string, text: string][] = [
  ["Status", "Worst first"],
  ["Name", "Name"],
  ["Last backup", "Oldest backup first"],
  ["Stored", "Largest first"],
];

export function repositories_view(): View {
  const query = current_route().query;
  let text = query.get("q") ?? "";
  let status = query.get("status") ?? "";
  let host = query.get("host") ?? "";
  let layout = query.get("view") === "table" ? "table" : "grid";
  let sorting = sorting_from(query, { key: "Status", descending: false });
  let repositories: RepositorySummary[] = [];

  const host_filter = h("span");
  const add_button = h("span");
  // Whether the page may add repositories, which the config mode decides.
  let adding = false;
  const body = h("div", {}, skeleton());

  const render = () => {
    const hosts = [...new Set(repositories.map((repository) => repository.host))].sort();
    host_filter.replaceChildren(select("Host", [["", "Any host"], ...hosts.map((name): [string, string] => [name, name])], host, (value) => {
      host = value;
      replace_query({ host: value });
      render();
    }));
    const shown = repositories.filter((repository) => matches(repository, text, status, host));
    if (repositories.length === 0) {
      body.replaceChildren(empty("No repositories yet.", adding
        ? h("a", { class: "button accent solid", href: link(["new-repository"]) }, "Add the first one")
        : "Hosts, repositories, sources and jobs are declared in the Nix configuration under services.x-backups, or added in Settings when the config mode allows it."));
      return;
    }
    if (shown.length === 0) {
      body.replaceChildren(empty("No repository matches these filters.", h("button", { class: "link", onclick: clear }, "Clear the filters")));
      return;
    }
    const on_sort = (next: Sorting) => {
      sorting = next;
      replace_query({ sort: next.key, dir: next.descending ? "desc" : null });
      render();
    };
    body.replaceChildren(
      h("p", { class: "muted small", role: "status" }, `${shown.length} of ${repositories.length} shown`),
      layout === "table" ? repositories_table(shown, sorting, on_sort) : h("div", { class: "grid" }, ...sort_cards(shown, sorting).map(repository_card)),
    );
  };

  // A fresh route draws the toolbar again with its fields empty.
  const clear = () => {
    location.hash = link(["repositories"], { view: layout === "table" ? "table" : null });
  };

  const update = async (quiet: boolean): Promise<void> => {
    const answer = await attempt(body, quiet, () => api<RepositorySummary[]>("/api/repositories"), () => void update(false));
    if (answer === null) return;
    repositories = answer;
    render();
  };
  void update(false);
  void api<ConfigInfo>("/api/config").then((info) => {
    adding = info.editable;
    if (adding) add_button.replaceChildren(h("a", { class: "button accent solid", href: link(["new-repository"]) }, "Add repository"));
    if (repositories.length === 0) render();
  }).catch(() => {});

  const layout_switch = h("div", { class: "segmented", role: "group", "aria-label": "Layout" },
    ...(["grid", "table"] as const).map((value) => h("button", {
      "aria-pressed": String(layout === value),
      onclick: (event: Event) => {
        layout = value;
        replace_query({ view: value === "grid" ? null : value });
        for (const button of (event.target as HTMLElement).parentElement!.children) button.setAttribute("aria-pressed", String(button.textContent === (value === "grid" ? "Cards" : "Table")));
        render();
      },
    }, value === "grid" ? "Cards" : "Table")));

  return {
    title: "Repositories",
    root: h("div", { class: "page" },
      h("div", { class: "page-title spread" }, h("h1", {}, "Repositories"), add_button),
      toolbar(
        search_box("Search by repository, job or host", text, (value) => { text = value; replace_query({ q: value }); render(); }),
        select("Status", status_filters, status, (value) => { status = value; replace_query({ status: value }); render(); }),
        host_filter,
        select("Sort", sorts, sorting.key, (value) => {
          sorting = { key: value, descending: value === "Stored" };
          replace_query({ sort: value, dir: sorting.descending ? "desc" : null });
          render();
        }),
        layout_switch,
      ),
      body,
    ),
    update: async (changes) => {
      if (touches(changes, null, ["repository", "run", "config"])) await update(true);
    },
  };
}

function matches(repository: RepositorySummary, text: string, status: string, host: string): boolean {
  const needle = text.trim().toLowerCase();
  if (needle && ![repository.name, repository.host, repository.repository, repository.job ?? ""].some((field) => field.toLowerCase().includes(needle))) return false;
  if (host && repository.host !== host) return false;
  if (status === "failing") return failing(repository);
  if (status === "attention") return repository_reasons(repository).length > 0;
  if (status === "overdue") return repository.last_poll_epoch !== null && overdue(repository);
  if (status === "running") return repository.running_run !== null;
  if (status === "ok") return repository_reasons(repository).length === 0;
  return true;
}

function sort_cards(repositories: RepositorySummary[], sorting: Sorting): RepositorySummary[] {
  const value = (repository: RepositorySummary): number | string => {
    if (sorting.key === "Name") return repository.name.toLowerCase();
    if (sorting.key === "Last backup") return repository.last_backup_epoch ?? 0;
    if (sorting.key === "Stored") return repository.stats?.deduplicated_size ?? 0;
    return status_rank(repository);
  };
  return [...repositories].sort((left, right) => {
    const [a, b] = [value(left), value(right)];
    const order = a === b ? left.name.localeCompare(right.name) : a < b ? -1 : 1;
    return sorting.descending ? -order : order;
  });
}
