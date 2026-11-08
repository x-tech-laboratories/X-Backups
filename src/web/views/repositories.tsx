// Every target, a job's backups from one host to one repository or a repository only watched, as cards or a table,
// searched, filtered and sorted, with the choices kept in the URL.

import { Segmented, SearchBox, Select } from "@x-tech-laboratories/x-libs/web/react/controls";
import { PageHeading, Toolbar } from "@x-tech-laboratories/x-libs/web/react/layout";
import { Empty, Loaded, use_resource } from "@x-tech-laboratories/x-libs/web/react/states";
import { current_route, link, replace_query } from "@x-tech-laboratories/x-libs/web/router";
import { sorting_from, type Sorting } from "@x-tech-laboratories/x-libs/web/tables";
import { useState } from "react";
import { failing, overdue, repository_reasons } from "../attention.ts";
import { api, type ConfigInfo, type RepositorySummary } from "../api.ts";
import { use_changes } from "../ui.tsx";
import { RepositoriesTable, RepositoryCard, status_rank, touches } from "./shared.tsx";

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

type Layout = "grid" | "table";

const layouts: { value: Layout; label: string }[] = [{ value: "grid", label: "Cards" }, { value: "table", label: "Table" }];

// ── Page ─────────────────────────────────────────────────────────────────────

export function RepositoriesView() {
  const [query] = useState(() => current_route().query);
  const [text, set_text] = useState(query.get("q") ?? "");
  const [status, set_status] = useState(query.get("status") ?? "");
  const [host, set_host] = useState(query.get("host") ?? "");
  const [layout, set_layout] = useState<Layout>(query.get("view") === "table" ? "table" : "grid");
  const [sorting, set_sorting] = useState<Sorting>(() => sorting_from(query, { key: "Status", descending: false }));

  const repositories = use_resource(() => api<RepositorySummary[]>("/api/repositories"), []);
  // Whether the page may add repositories, which the config mode decides.
  const config = use_resource(() => api<ConfigInfo>("/api/config"), []);
  const adding = config.data?.editable ?? false;
  use_changes((changes) => { if (touches(changes, null, ["repository", "run", "config"])) repositories.reload(true); });

  const sort = (next: Sorting) => {
    set_sorting(next);
    replace_query({ sort: next.key, dir: next.descending ? "desc" : null });
  };

  // A fresh route draws the toolbar again with its fields empty.
  const clear = () => {
    location.hash = link(["repositories"], { view: layout === "table" ? "table" : null });
  };

  const hosts = [...new Set((repositories.data ?? []).map((repository) => repository.host))].sort();

  return (
    <div className="page">
      <PageHeading title="Repositories" actions={adding && <a className="button accent solid" href={link(["new-repository"])}>Add repository</a>} />
      <Toolbar>
        <SearchBox label="Search by repository, job or host" value={text} on_input={(value) => { set_text(value); replace_query({ q: value }); }} />
        <Select label="Status" options={status_filters} value={status} on_change={(value) => { set_status(value); replace_query({ status: value }); }} />
        <span>
          {repositories.data !== null && <Select label="Host" options={[["", "Any host"], ...hosts.map((name): [string, string] => [name, name])]} value={host}
            on_change={(value) => { set_host(value); replace_query({ host: value }); }} />}
        </span>
        <Select label="Sort" options={sorts} value={sorting.key} on_change={(value) => sort({ key: value, descending: value === "Stored" })} />
        <Segmented label="Layout" choices={layouts} value={layout} on_change={(value) => { set_layout(value); replace_query({ view: value === "grid" ? null : value }); }} />
      </Toolbar>
      <div>
        <Loaded resource={repositories}>
          {(all) => {
            if (all.length === 0) {
              return <Empty title="No repositories yet." hint={adding
                ? <a className="button accent solid" href={link(["new-repository"])}>Add the first one</a>
                : "Hosts, repositories, sources and jobs are declared in the Nix configuration under services.x-backups, or added in Settings when the config mode allows it."} />;
            }
            const shown = all.filter((repository) => matches(repository, text, status, host));
            if (shown.length === 0) return <Empty title="No repository matches these filters." hint={<button className="link" onClick={clear}>Clear the filters</button>} />;
            return <>
              <p className="muted small" role="status">{`${shown.length} of ${all.length} shown`}</p>
              {layout === "table"
                ? <RepositoriesTable repositories={shown} sorting={sorting} on_sort={sort} />
                : <div className="grid">{sort_cards(shown, sorting).map((repository) => <RepositoryCard key={repository.id} repository={repository} />)}</div>}
            </>;
          }}
        </Loaded>
      </div>
    </div>
  );
}

// ── Filtering ────────────────────────────────────────────────────────────────

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
    const [first, second] = [value(left), value(right)];
    const order = first === second ? left.name.localeCompare(right.name) : first < second ? -1 : 1;
    return sorting.descending ? -order : order;
  });
}
