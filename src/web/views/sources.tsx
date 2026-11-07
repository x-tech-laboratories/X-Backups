// Every source: the paths and excludes on one managed host, and the jobs backing them up; and one source's page.

import { Chip } from "@x-tech-laboratories/x-libs/web/react/badges";
import { Crumbs, Facts, Section, type Fact } from "@x-tech-laboratories/x-libs/web/react/layout";
import { Empty, Loaded, use_resource } from "@x-tech-laboratories/x-libs/web/react/states";
import { DataTable } from "@x-tech-laboratories/x-libs/web/react/table";
import { link } from "@x-tech-laboratories/x-libs/web/router";
import { Fragment } from "react";
import { api, type SourceRow } from "../api.ts";
import { can } from "../session.ts";
import { use_changes } from "../ui.tsx";
import { touches } from "./shared.tsx";

// ── Pages ────────────────────────────────────────────────────────────────────

export function SourcesView() {
  const sources = use_resource(() => api<SourceRow[]>("/api/sources"), []);
  use_changes((changes) => { if (touches(changes, null, ["config"])) sources.reload(true); });
  return (
    <div className="page">
      <div className="page-title spread"><h1>Sources</h1>{can("admin") && <a className="button" href={link(["settings", "new", "sources"])}>Add source</a>}</div>
      <div>
        <Loaded resource={sources} lines={5}>
          {(rows) => rows.length === 0
            ? <Empty title="No sources yet." hint={can("admin") ? <a href={link(["settings", "new", "sources"])}>Add a source in Settings</a> : "A source names the paths a job backs up on one host; they are declared under services.x-backups.sources."} />
            : <DataTable<SourceRow> rows={rows} row_key={(source) => source.name} caption="Sources" columns={[
              { label: "Source", cell: (source) => <a href={link(["sources", source.name])}>{source.name}</a>, sort: (source) => source.name },
              { label: "Host", cell: (source) => <a href={link(["hosts", source.host])}>{source.host}</a>, sort: (source) => source.host },
              { label: "Paths", cell: (source) => <PathsInline paths={source.paths} /> },
              { label: "Excludes", class: "number", cell: (source) => source.exclude.length },
              { label: "Jobs", cell: (source) => <JobLinks jobs={source.jobs} /> },
              { label: "From", cell: (source) => <OriginChip entity={source} /> },
            ]} />}
        </Loaded>
      </div>
    </div>
  );
}

export function SourceView({ name }: { name: string }) {
  const source = use_resource(() => api<SourceRow>(`/api/sources/${encodeURIComponent(name)}`), [name]);
  use_changes((changes) => { if (touches(changes, null, ["config"])) source.reload(true); });
  return (
    <div className="page">
      <Crumbs items={[["Sources", link(["sources"])], [name, null]]} />
      <div className="stack">
        <Loaded resource={source} lines={5}>
          {(row) => {
            const settings = Object.entries(row.settings).filter(([field]) => field !== "source_paths" && field !== "exclude");
            return <>
              <header className="page-head">
                <div className="page-title"><h1>{row.name}</h1><OriginChip entity={row} /></div>
                <p className="muted">On <a href={link(["hosts", row.host])}>{row.host}</a></p>
                {can("admin") && <div className="head-actions"><a className="button" href={config_link(row)}>Config</a></div>}
              </header>
              <Section title="Backed up"><PathList items={row.paths} none="No paths." /></Section>
              <Section title="Excluded"><PathList items={row.exclude} none="Nothing is excluded." /></Section>
              {settings.length > 0 && (
                <Section title="Other settings">
                  <Facts layout="rows" rows={settings.map(([field, value]): Fact => [field, <code>{JSON.stringify(value)}</code>])} />
                </Section>
              )}
              <Section title="Jobs backing it up">
                {row.jobs.length === 0
                  ? <Empty title="No job uses this source yet." hint="Add it to a job's sources to back it up." />
                  : <ul className="plain-list">{row.jobs.map((job) => <li key={job}><a href={link(["jobs", job])}>{job}</a></li>)}</ul>}
              </Section>
            </>;
          }}
        </Loaded>
      </div>
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// Where an entity's config lives: its own entry, or the flat repository entry it was expanded from.
export function config_link(entity: { name: string; expanded_from: string | null }, kind = "sources"): string {
  return entity.expanded_from === null ? link(["settings", kind, entity.name]) : link(["settings", "repositories", entity.expanded_from]);
}

export function OriginChip({ entity }: { entity: { source: "declared" | "page"; expanded_from: string | null } }) {
  if (entity.expanded_from !== null) {
    return <Chip title={`Expanded from the repository entry ${entity.expanded_from}`}>{entity.source === "declared" ? "declared, older shape" : "added here, older shape"}</Chip>;
  }
  return entity.source === "declared"
    ? <Chip title="Set in the Nix configuration; change it there">declared</Chip>
    : <Chip title="Added from this page; change it in Settings">added here</Chip>;
}

export function JobLinks({ jobs }: { jobs: string[] }) {
  if (jobs.length === 0) return <span className="muted">none</span>;
  return <>{jobs.map((job, index) => <Fragment key={job}>{index > 0 && ", "}<a href={link(["jobs", job])}>{job}</a></Fragment>)}</>;
}

function PathsInline({ paths }: { paths: string[] }) {
  const shown = paths.slice(0, 3).join(", ");
  return <code title={paths.join("\n")}>{paths.length > 3 ? `${shown} and ${paths.length - 3} more` : shown}</code>;
}

function PathList({ items, none }: { items: string[]; none: string }) {
  return items.length > 0
    ? <ul className="paths">{items.map((item) => <li key={item}><code>{item}</code></li>)}</ul>
    : <p className="muted">{none}</p>;
}
