// The Overview's map of the backup flow in three columns: each host's folders on the left, the jobs that back them up in
// the middle, and the repositories they write to on the right, under the hosts that store them; every box opens its page.

import { age } from "@x-tech-laboratories/x-libs/web/format";
import { FlowMap, FlowMapZoom, use_flow_map, type FlowColumn, type FlowGroup, type FlowLink, type FlowTone } from "@x-tech-laboratories/x-libs/web/react/flow_map";
import { Section } from "@x-tech-laboratories/x-libs/web/react/layout";
import { Empty, Loaded, use_resource } from "@x-tech-laboratories/x-libs/web/react/states";
import { link } from "@x-tech-laboratories/x-libs/web/router";
import { api, type BackupMap, type MapTarget } from "../api.ts";
import { use_changes } from "../ui.tsx";
import { touches } from "./shared.tsx";

// ── Building ─────────────────────────────────────────────────────────────────

const node_id = { source: (id: string) => `source:${id}`, job: (id: string) => `job:${id}`, repository: (id: string) => `repository:${id}` };

const tone_rank: Record<FlowTone, number> = { unknown: 0, ok: 0, running: 1, warning: 2, critical: 3 };

function tone_of(target: MapTarget): FlowTone {
  return target.running_run ? "running" : target.level;
}

export function backup_flow(map: BackupMap): { columns: FlowColumn[]; links: FlowLink[] } {
  const host_name = new Map(map.hosts.map((host) => [host.id, host.name]));
  const host_of = (id: string) => host_name.get(id) ?? id;
  const by_name = (left: string, right: string) => host_of(left).localeCompare(host_of(right));
  const worst = (targets: MapTarget[]): FlowTone => targets.map(tone_of).sort((left, right) => tone_rank[right] - tone_rank[left])[0] ?? "ok";
  // Each host's box, linking to its page when it is a configured host.
  const group = (prefix: string, host: string): Omit<FlowGroup, "nodes"> => {
    const page = map.links?.hosts[host];
    return { id: `${prefix}:${host}`, label: host_of(host), href: page ? link(["hosts", page]) : null, title: page ? `${page}: open its page` : undefined };
  };

  const source_hosts = [...new Set(map.sources.map((source) => source.host))].sort(by_name);
  const sources: FlowGroup[] = source_hosts.map((host) => ({
    ...group("sources", host),
    nodes: map.sources.filter((source) => source.host === host).map((source) => {
      // A folder of a configured source opens the source's page.
      const page = map.links?.sources[source.id];
      return { id: node_id.source(source.id), label: source.path, mono: true, href: page ? link(["sources", page]) : null, title: page ? `${source.path}, in the source ${page}` : source.path };
    }),
  }));

  const jobs = map.jobs.map((job) => {
    const targets = map.targets.filter((target) => target.job === job.id);
    const folders = new Set(targets.flatMap((target) => target.sources)).size;
    const writes_to = new Set(targets.map((target) => target.repository)).size;
    const detail = `${folders} ${folders === 1 ? "folder" : "folders"} → ${writes_to} ${writes_to === 1 ? "repository" : "repositories"}`;
    return { id: node_id.job(job.id), label: job.id, tone: worst(targets), details: [{ text: detail }], href: map.links?.jobs.includes(job.id) ? link(["jobs", job.id]) : null };
  });

  const repository_hosts = [...new Set(map.repositories.map((repository) => repository.stored_on))].sort(by_name);
  const repositories: FlowGroup[] = repository_hosts.map((host) => ({
    ...group("repositories", host),
    nodes: map.repositories.filter((repository) => repository.stored_on === host).map((repository) => {
      const targets = map.targets.filter((target) => target.repository === repository.id);
      const last = Math.max(...targets.map((target) => target.last_backup_epoch ?? -Infinity));
      const when = `last backup ${age(Number.isFinite(last) ? last : null)}`;
      const detail = targets.some((target) => target.job !== null) ? when : `watched only · ${when}`;
      const reasons = new Set(targets.flatMap((target) => target.reasons.map((reason) => reason.text)));
      return {
        id: node_id.repository(repository.id),
        label: repository.id,
        tone: worst(targets),
        details: [{ text: repository.path, mono: true }, { text: detail }],
        href: link(["repositories", targets[0].id]),
        title: [repository.id, `${repository.path} on ${host_of(repository.stored_on)}`, detail, ...reasons].join("\n"),
      };
    }),
  }));

  // One line from each folder to each job that backs it up, and one from each job to each repository it writes to.
  const links: FlowLink[] = [];
  const path_of = new Map(map.sources.map((source) => [source.id, source]));
  for (const job of map.jobs) {
    const targets = map.targets.filter((target) => target.job === job.id);
    for (const source of new Set(targets.flatMap((target) => target.sources))) {
      const folder = path_of.get(source);
      links.push({
        from: node_id.source(source), to: node_id.job(job.id), tone: worst(targets.filter((target) => target.sources.includes(source))),
        title: `${folder ? `${host_of(folder.host)} ${folder.path}` : source} → ${job.id}`,
      });
    }
    for (const repository of new Set(targets.map((target) => target.repository))) {
      const writes = targets.filter((target) => target.repository === repository);
      const retention = [...new Set(writes.map((target) => keeps(target.retention)).filter(Boolean))];
      const stored_on = host_of(map.repositories.find((item) => item.id === repository)?.stored_on ?? "");
      links.push({
        from: node_id.job(job.id), to: node_id.repository(repository), tone: worst(writes),
        title: `${job.id} → ${repository} on ${stored_on}${retention.length > 0 ? `, keeps ${retention.join(" / ")}` : ""}`,
      });
    }
  }

  return {
    columns: [
      { title: "Sources", width: 300, groups: sources },
      { title: "Jobs", width: 240, nodes: jobs },
      { title: "Repositories", width: 300, groups: repositories },
    ],
    links,
  };
}

// Retention as borg's flags read, such as 24h 7d 4w 12m 3y.
function keeps(retention: Record<string, number | string>): string {
  const units: Record<string, string> = { keep_secondly: "s", keep_minutely: "min", keep_hourly: "h", keep_daily: "d", keep_weekly: "w", keep_monthly: "m", keep_yearly: "y" };
  return Object.entries(retention).map(([key, value]) => {
    if (key === "keep_within") return `within ${value}`;
    if (key === "keep_last") return `last ${value}`;
    return `${value}${units[key] ?? ` ${key}`}`;
  }).join(" ");
}

// ── Section ──────────────────────────────────────────────────────────────────

export function MapSection() {
  const map = use_resource(() => api<BackupMap>("/api/map"), []);
  use_changes((changes) => { if (touches(changes, null, ["repository", "run", "config"])) map.reload(true); });
  const handle = use_flow_map();

  return (
    <Section title="What is backed up where" tools={<FlowMapZoom handle={handle} />}>
      <div>
        <Loaded resource={map} lines={6}>
          {(answer) => {
            if (answer.targets.length === 0) return <Empty title="No repositories yet." hint="Repositories appear here once they are configured." />;
            const { columns, links } = backup_flow(answer);
            return <FlowMap label="Which folders each job backs up, and the repositories it writes them to" columns={columns} links={links} handle={handle} legend={["ok", "warning", "critical", "running"]} />;
          }}
        </Loaded>
      </div>
    </Section>
  );
}
