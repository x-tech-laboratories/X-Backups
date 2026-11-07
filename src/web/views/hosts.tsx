// Every host with its agent's state and health, and one host's page: its health, sources, repositories, the targets
// running there, its runs and timers, and for an admin, enrolling and revoking its agent.

import { age, now_seconds, plural, size, stamp } from "@x-tech-laboratories/x-libs/web/format";
import { Badge, Chip, type Tone } from "@x-tech-laboratories/x-libs/web/react/badges";
import { Select } from "@x-tech-laboratories/x-libs/web/react/controls";
import { confirm_dialog, Dialog, open_dialog } from "@x-tech-laboratories/x-libs/web/react/dialog";
import { Crumbs, Facts, Section, Toolbar, type Fact } from "@x-tech-laboratories/x-libs/web/react/layout";
import { Empty, Loaded, use_resource } from "@x-tech-laboratories/x-libs/web/react/states";
import { DataTable, type Sorting } from "@x-tech-laboratories/x-libs/web/react/table";
import { toast } from "@x-tech-laboratories/x-libs/web/react/toasts";
import { current_route, link, replace_query } from "@x-tech-laboratories/x-libs/web/router";
import { useState } from "react";
import { api, query, send, type HostRow, type HostSample, type RepositorySummary, type Run, type SourceRow, type TimerRow } from "../api.ts";
import { Sparkline } from "../charts.tsx";
import { can } from "../session.ts";
import { use_changes } from "../ui.tsx";
import { RepositoriesTable, RunsTable, TimersTable, touches, type Refresh } from "./shared.tsx";

const day_in_seconds = 86400;
// A reading turns amber and red at these shares, as the storage bars do.
const reading_warning_percent = 75;
const reading_danger_percent = 90;

// ── Agent state ──────────────────────────────────────────────────────────────

type AgentState = "built_in" | "connected" | "offline" | "never_enrolled" | "storage_only";

export function agent_state(host: HostRow): AgentState {
  if (host.kind === "storage-only") return "storage_only";
  if (host.built_in) return "built_in";
  if (host.connected) return "connected";
  return host.enrolled || host.agent_key !== null ? "offline" : "never_enrolled";
}

const agent_labels: Record<AgentState, [text: string, tone: Tone, title: string]> = {
  built_in: ["built in", "good", "This server's own host, run by the agent built into it"],
  connected: ["connected", "good", "Its agent is connected now"],
  offline: ["offline", "bad", "It has a token or a declared key, but its agent is not connected"],
  never_enrolled: ["never enrolled", "warn", "No token has been issued, so no agent can connect"],
  storage_only: ["no agent", "none", "A storage-only host holds repositories reached through borg serve, and runs no agent"],
};

export function AgentBadge({ host }: { host: HostRow }) {
  const [text, tone, title] = agent_labels[agent_state(host)];
  return <Badge tone={tone} title={title}>{text}</Badge>;
}

// Whether a managed host's agent is away, which holds its tasks and runs back.
export function agent_away(host: HostRow): boolean {
  const state = agent_state(host);
  return state === "offline" || state === "never_enrolled";
}

const state_filters: [value: string, text: string][] = [
  ["", "Any agent state"],
  ["away", "Offline or never enrolled"],
  ["connected", "Connected"],
  ["storage", "Storage-only"],
];

// The host readings of the last day.
const samples_path = () => `/api/hosts/samples${query({ since: Math.floor(now_seconds() - day_in_seconds) })}`;

// ── Hosts ────────────────────────────────────────────────────────────────────

export function HostsView() {
  const [state, set_state] = useState(current_route().query.get("state") ?? "");
  const answer = use_resource(() => Promise.all([api<HostRow[]>("/api/hosts"), api<HostSample[]>(samples_path())]), []);
  use_changes((changes) => { if (touches(changes, null, ["hosts", "config"])) answer.reload(true); });

  return (
    <div className="page">
      <div className="page-title spread"><h1>Hosts</h1>{can("admin") && <a className="button" href={link(["settings", "new", "hosts"])}>Add host</a>}</div>
      <Toolbar>
        <Select label="Agent" options={state_filters} value={state} on_change={(value) => { set_state(value); replace_query({ state: value }); }} />
      </Toolbar>
      <div>
        <Loaded resource={answer} lines={5}>
          {([hosts, samples]) => {
            if (hosts.length === 0) {
              return <Empty title="No hosts yet." hint={can("admin") ? <a href={link(["settings", "new", "hosts"])}>Add a host in Settings</a> : "Hosts are declared in the Nix configuration under services.x-backups.hosts."} />;
            }
            const shown = hosts.filter((host) => state === "" || (state === "away" ? agent_away(host) : state === "connected" ? host.connected : host.kind === "storage-only"));
            if (shown.length === 0) return <Empty title="No host matches this filter." />;
            return <HostsTable hosts={shown} samples={samples} />;
          }}
        </Loaded>
      </div>
    </div>
  );
}

function HostsTable({ hosts, samples }: { hosts: HostRow[]; samples: HostSample[] }) {
  return (
    <DataTable<HostRow> rows={hosts} row_key={(host) => host.name} caption="Hosts" columns={[
      { label: "Host", cell: (host) => <a href={link(["hosts", host.name])}>{host.name}</a>, sort: (host) => host.name },
      { label: "Kind", cell: (host) => host.kind === "storage-only" ? "storage-only" : host.own ? "managed, this server" : "managed", sort: (host) => host.kind },
      { label: "Agent", cell: (host) => <AgentBadge host={host} />, sort: (host) => agent_state(host) },
      { label: "Version", cell: (host) => host.agent_version ?? <span className="muted">—</span> },
      { label: "Last seen", cell: (host) => <LastSeen host={host} />, sort: (host) => host.last_seen_epoch },
      { label: "Load, memory, disk", cell: (host) => <HealthSparklines samples={samples.filter((sample) => sample.host === host.name)} /> },
      { label: "Sources", class: "number", cell: (host) => host.sources.length, sort: (host) => host.sources.length },
      { label: "Repositories", class: "number", cell: (host) => host.repositories.length, sort: (host) => host.repositories.length },
    ]} />
  );
}

function LastSeen({ host }: { host: HostRow }) {
  if (host.built_in) return <>now</>;
  if (host.last_seen_epoch === null) return <span className="muted">never</span>;
  return <span title={stamp(host.last_seen_epoch)}>{host.connected ? "now" : age(host.last_seen_epoch)}</span>;
}

// The newest load against the CPUs, memory in use and root disk full, with one small line of the last day for each once there are two readings to draw.
function HealthSparklines({ samples }: { samples: HostSample[] }) {
  if (samples.length === 0) return <span className="muted">no readings</span>;
  const latest = samples.at(-1)!;
  const load = samples.map((sample): [number, number] => [sample.epoch, sample.load1 / sample.cpus * 100]);
  const memory = samples.map((sample): [number, number] => [sample.epoch, (1 - sample.memory_available / sample.memory_total) * 100]);
  const disk = samples.map((sample): [number, number] => [sample.epoch, (1 - sample.disk_available / sample.disk_size) * 100]);
  const texts = [`load ${latest.load1.toFixed(2)} on ${latest.cpus} CPUs`, `memory ${Math.round(memory.at(-1)![1])}% used`, `disk ${Math.round(disk.at(-1)![1])}% full`];
  return (
    <div>
      {samples.length > 1 && (
        <div className="row-actions">
          <Sparkline label={texts[0]} points={load} top={100} color="var(--series-1)" />
          <Sparkline label={texts[1]} points={memory} top={100} color="var(--series-2)" />
          <Sparkline label={texts[2]} points={disk} top={100} color="var(--series-3)" />
        </div>
      )}
      <div className="muted small">{texts.join(" · ")}</div>
    </div>
  );
}

// ── Health ───────────────────────────────────────────────────────────────────

const reading_tone = (percent: number) => percent >= reading_danger_percent ? "var(--status-danger)" : percent >= reading_warning_percent ? "var(--status-warning)" : "var(--series-1)";

function Reading({ name, points, text }: { name: string; points: [number, number][]; text: string }) {
  return (
    <div className="host-reading">
      <span className="reading-label">{name}</span>
      <Sparkline label={`${name}: ${text}`} points={points} top={100} color={reading_tone(points.at(-1)![1])} />
      <span className="meter-value">{text}</span>
    </div>
  );
}

// A row per host: its load against its CPUs, its memory in use and how full its root disk is, each as a sparkline and the latest reading.
export function HostHealth({ samples }: { samples: HostSample[] }) {
  if (samples.length === 0) return <Empty title="No host readings yet." hint="Each host is read beside its timers, every five minutes." />;
  const by_host = new Map<string, HostSample[]>();
  for (const sample of samples) by_host.set(sample.host, [...(by_host.get(sample.host) ?? []), sample]);
  return (
    <div className="hosts">
      {[...by_host].sort(([first], [second]) => first.localeCompare(second)).map(([host, readings]) => {
        const latest = readings.at(-1)!;
        const load = readings.map((sample): [number, number] => [sample.epoch, sample.load1 / sample.cpus * 100]);
        const memory = readings.map((sample): [number, number] => [sample.epoch, (1 - sample.memory_available / sample.memory_total) * 100]);
        const disk = readings.map((sample): [number, number] => [sample.epoch, (1 - sample.disk_available / sample.disk_size) * 100]);
        return [
          <strong key={`${host}-name`} title={`read ${age(latest.epoch)}`}>{host}</strong>,
          <Reading key={`${host}-load`} name="load" points={load} text={`${latest.load1.toFixed(2)} / ${latest.cpus} CPUs`} />,
          <Reading key={`${host}-memory`} name="memory" points={memory} text={`${Math.round(memory.at(-1)![1])}% used`} />,
          <Reading key={`${host}-disk`} name="disk /" points={disk} text={`${size(latest.disk_available)} free`} />,
        ];
      })}
    </div>
  );
}

// ── One host ─────────────────────────────────────────────────────────────────

export function HostView({ name }: { name: string }) {
  const [sorting, set_sorting] = useState<Sorting>({ key: "Status", descending: false });
  const answer = use_resource(() => Promise.all([
    api<HostRow[]>("/api/hosts"),
    api<SourceRow[]>("/api/sources"),
    api<RepositorySummary[]>("/api/repositories"),
  ]), [name]);
  const samples = use_resource(() => api<HostSample[]>(samples_path()), [name]);
  const runs = use_resource(() => api<Run[]>(`/api/runs${query({ host: name, limit: 20 })}`), [name]);
  const timers = use_resource(() => api<TimerRow[]>("/api/timers"), [name]);
  const refresh = () => Promise.all([answer, samples, runs, timers].map((resource) => resource.reload(true)));
  use_changes((changes) => { if (touches(changes, null, ["hosts", "config", "run", "timers", "repository"])) refresh(); });

  const host = answer.data?.[0].find((item) => item.name === name);
  // A host that is not there leaves the panels below empty.
  const found = answer.data === null || host !== undefined;

  return (
    <div className="page">
      <Crumbs items={[["Hosts", link(["hosts"])], [name, null]]} />
      <div>
        <Loaded resource={answer} lines={2}>
          {() => host === undefined
            ? <Empty title={`No host named ${name}.`} hint={<a href={link(["hosts"])}>All hosts</a>} />
            : <HostHeader host={host} refresh={refresh} />}
        </Loaded>
      </div>
      <Section title="Health" tools={<span className="muted small">last 24 hours</span>}>
        <div>
          {found && (
            <Loaded resource={samples} lines={2}>
              {(all) => {
                const own = all.filter((sample) => sample.host === name);
                if (own.length === 0 && host !== undefined && agent_away(host)) return <Empty title="No health readings." hint="Readings arrive every five minutes once this host's agent connects." />;
                return <HostHealth samples={own} />;
              }}
            </Loaded>
          )}
        </div>
      </Section>
      <div className="columns">
        <Section title="Sources">
          <div>
            {found && <Loaded resource={answer} lines={2}>{([, all_sources]) => <SourcesList sources={all_sources.filter((source) => source.host === name)} />}</Loaded>}
          </div>
        </Section>
        <Section title="Repositories stored here">
          <div>
            {found && <Loaded resource={answer} lines={2}>{([, , all_targets]) => host && <StoredList host={host} targets={all_targets} />}</Loaded>}
          </div>
        </Section>
      </div>
      <Section title="Targets running here">
        <div>
          {found && (
            <Loaded resource={answer} lines={3}>
              {([, , all_targets]) => {
                const running_here = all_targets.filter((target) => target.host === name);
                return running_here.length === 0
                  ? <Empty title="No targets run here." hint="A job whose source is on this host runs its backups here; a storage-only host's repositories are backed up from other hosts." />
                  : <RepositoriesTable repositories={running_here} sorting={sorting} on_sort={set_sorting} />;
              }}
            </Loaded>
          )}
        </div>
      </Section>
      <Section title="Runs" tools={<a href={link(["runs"], { host: name })}>All runs on this host</a>}>
        <div>
          {found && <Loaded resource={runs} lines={3}>{(rows) => <RunsTable runs={rows} with_repository refresh={refresh} />}</Loaded>}
        </div>
      </Section>
      <Section title="Host timers" tools={<span className="muted small">read where systemd has them</span>}>
        <div>
          {found && <Loaded resource={timers} lines={2}>{(all) => <TimersTable timers={all.filter((timer) => timer.host === name)} with_host={false} />}</Loaded>}
        </div>
      </Section>
    </div>
  );
}

function HostHeader({ host, refresh }: { host: HostRow; refresh: Refresh }) {
  const state = agent_state(host);
  const rows: Fact[] = [
    ["Kind", host.kind],
    ["Address", host.address ?? "none, this server"],
    ["Agent", agent_labels[state][2]],
    ...host.kind === "managed" && !host.own ? [["Login", login_text(host)] as Fact] : [],
    ["Sources", plural(host.sources.length, "source")],
    ["Repositories", `${host.repositories.length} ${host.repositories.length === 1 ? "repository" : "repositories"}`],
  ];
  return (
    <header className="page-head">
      <div className="page-title"><h1>{host.name}</h1><AgentBadge host={host} />{host.own && <Chip>this server</Chip>}</div>
      <p className="muted" role="status" aria-live="polite">
        {host.kind === "storage-only" ? "Storage-only: holds repositories reached through borg serve." : host.address ?? "This server's own machine."}
        {host.agent_version ? ` · agent ${host.agent_version}` : ""}
        {host.connected_epoch ? ` · connected ${age(host.connected_epoch)}` : ""}
        {state === "offline" && host.last_seen_epoch ? ` · last seen ${age(host.last_seen_epoch)}` : ""}
      </p>
      <Facts rows={rows} />
      {state === "never_enrolled" && (
        <div className="banner" role="note">
          <strong>Enrol this host's agent.</strong> Until it connects, backups and tasks on this host wait.
          {can("admin") ? "" : " An admin issues its token."}
        </div>
      )}
      {can("admin") && host.kind === "managed" && !host.own && (
        <div className="head-actions">
          {host.agent_key === null && <button className={host.enrolled ? undefined : "accent solid"} onClick={() => enrol(host, refresh)}>{host.enrolled ? "Issue a new token" : "Enrol agent"}</button>}
          {host.enrolled && <button className="danger" onClick={() => revoke(host, refresh)}>Revoke token</button>}
          <a className="button" href={link(["settings", "hosts", host.name])}>Config</a>
        </div>
      )}
    </header>
  );
}

// How the host's agent logs in: its declared key, which shuts out tokens, or a token issued here.
function login_text(host: HostRow): string {
  if (host.agent_key !== null) return `declared key ${host.agent_key}; tokens are refused`;
  return host.enrolled ? "token issued here" : "none yet";
}

function SourcesList({ sources }: { sources: SourceRow[] }) {
  if (sources.length === 0) return <Empty title="No sources on this host." />;
  return (
    <ul className="plain-list">
      {sources.map((source) => (
        <li key={source.name}>
          <a href={link(["sources", source.name])}>{source.name}</a>
          <span className="muted">{` · ${source.paths.join(", ")}`}</span>
        </li>
      ))}
    </ul>
  );
}

// The repositories whose disk is on this host, each linking to its first target the viewer sees.
function StoredList({ host, targets }: { host: HostRow; targets: RepositorySummary[] }) {
  if (host.repositories.length === 0) return <Empty title="No repositories stored here." />;
  return (
    <ul className="plain-list">
      {host.repositories.map((repository) => {
        const target = targets.find((item) => item.repository === repository);
        return (
          <li key={repository}>
            {target ? <a href={link(["repositories", target.id])}>{repository}</a> : repository}
            {target && <span className="muted">{` · last backup ${age(target.last_backup_epoch)}`}</span>}
          </li>
        );
      })}
    </ul>
  );
}

// ── Enrolment ────────────────────────────────────────────────────────────────

function enrol(host: HostRow, refresh: Refresh): void {
  const issue = async () => {
    try {
      const { token } = await api<{ token: string }>(`/api/hosts/${encodeURIComponent(host.name)}/token`, {});
      show_token(host.name, token);
    } catch (error) {
      toast(`Could not issue a token: ${error instanceof Error ? error.message : String(error)}`, { tone: "bad" });
    }
    await refresh();
  };
  if (!host.enrolled) {
    void issue();
    return;
  }
  confirm_dialog({
    title: `Issue ${host.name} a new token?`,
    message: "The agent using the old token is hung up on, and connects again only once it has the new one.",
    confirm_label: "Issue new token",
    busy_label: "Issuing…",
    danger: true,
    run: issue,
  });
}

// The token once, with what to put on the host: the NixOS module's options, or the variables for a host without it.
function show_token(host: string, token: string): void {
  open_dialog((close) => <TokenDialog host={host} token={token} close={close} />);
}

function TokenDialog({ host, token, close }: { host: string; token: string; close: () => void }) {
  const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/agent`;
  const nix = [
    "services.x-backups-agent = {",
    "  enable = true;",
    `  url = "${url}";`,
    '  tokenFile = "/run/secrets/x-backups-agent-token";',
    "};",
  ].join("\n");
  const environment = [
    `X_BACKUPS_AGENT_URL=${url}`,
    "X_BACKUPS_AGENT_TOKEN_FILE=/etc/x-backups-agent/token",
    "X_BACKUPS_AGENT_STATE_DIR=/var/lib/x-backups-agent",
  ].join("\n");
  const copy = (text: string, what: string, label: string) => (
    <div><button onClick={() => void navigator.clipboard?.writeText(text).then(() => toast(`${what} copied.`))}>{label}</button></div>
  );
  return (
    <Dialog title={`${host}'s agent token`} on_close={close} wide buttons={<button className="accent solid" onClick={close}>I have saved it</button>}>
      <div className="stack">
        <p>Shown this once. Put it in a file on the host, readable only by root.</p>
        <pre className="output secret-once">{token}</pre>
        {copy(token, "Token", "Copy token")}
        <p>On NixOS, enable the flake's agent module:</p>
        <pre className="output">{nix}</pre>
        {copy(nix, "Nix", "Copy the Nix")}
        <p>Elsewhere, run the agent package with:</p>
        <pre className="output">{environment}</pre>
        {copy(environment, "Variables", "Copy the variables")}
        {location.protocol !== "https:" && <p className="tone-warn small">The agent needs wss:// to reach a server on another machine; serve this page over HTTPS for the URL above to work.</p>}
      </div>
    </Dialog>
  );
}

function revoke(host: HostRow, refresh: Refresh): void {
  confirm_dialog({
    title: `Revoke ${host.name}'s token?`,
    message: <div>
      <p>{`Its agent is hung up on and cannot connect again. Backups and tasks on ${host.name} wait until it is enrolled again.`}</p>
      <p className="muted">Runs it has going carry on there and are followed again once it reconnects with a new token.</p>
    </div>,
    confirm_label: "Revoke token",
    busy_label: "Revoking…",
    danger: true,
    type_to_confirm: host.name,
    run: async () => {
      try {
        await send("DELETE", `/api/hosts/${encodeURIComponent(host.name)}/token`);
        toast(`${host.name}'s token is revoked.`, { tone: "warn" });
      } catch (error) {
        toast(`Could not revoke it: ${error instanceof Error ? error.message : String(error)}`, { tone: "bad" });
      }
      await refresh();
    },
  });
}
