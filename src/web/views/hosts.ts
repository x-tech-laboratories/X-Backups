// Every host with its agent's state and health, and one host's page: its health, sources, repositories, the targets
// running there, its runs and timers, and for an admin, enrolling and revoking its agent.

import { api, query, send, type HostRow, type HostSample, type RepositorySummary, type Run, type SourceRow, type TimerRow } from "../api.ts";
import { sparkline } from "../charts.ts";
import { age, h, now_seconds, plural, size, stamp, type Child } from "../dom.ts";
import { current_route, link, replace_query } from "../router.ts";
import { can } from "../session.ts";
import { attempt, chip, confirm_dialog, crumbs, data_table, empty, facts, load, open_dialog, section, select, skeleton, toast, toolbar, type Sorting } from "../ui.ts";
import { repositories_table, runs_table, timers_table, touches, type View } from "./shared.ts";

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
  return host.enrolled ? "offline" : "never_enrolled";
}

const agent_labels: Record<AgentState, [text: string, tone: string, title: string]> = {
  built_in: ["built in", "good", "This server's own host, run by the agent built into it"],
  connected: ["connected", "good", "Its agent is connected now"],
  offline: ["offline", "bad", "It has a token, but its agent is not connected"],
  never_enrolled: ["never enrolled", "warn", "No token has been issued, so no agent can connect"],
  storage_only: ["no agent", "none", "A storage-only host holds repositories reached through borg serve, and runs no agent"],
};

export function agent_badge(host: HostRow): HTMLElement {
  const [text, tone, title] = agent_labels[agent_state(host)];
  return h("span", { class: `badge tone-${tone}`, title }, text);
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

// ── Hosts ────────────────────────────────────────────────────────────────────

export function hosts_view(): View {
  let state = current_route().query.get("state") ?? "";
  const body = h("div", {}, skeleton(5));
  let hosts: HostRow[] = [];
  let samples: HostSample[] = [];

  const render = () => {
    if (hosts.length === 0) {
      body.replaceChildren(empty("No hosts yet.", can("admin") ? h("a", { href: link(["settings", "new", "hosts"]) }, "Add a host in Settings") : "Hosts are declared in the Nix configuration under services.x-backups.hosts."));
      return;
    }
    const shown = hosts.filter((host) => state === "" || (state === "away" ? agent_away(host) : state === "connected" ? host.connected : host.kind === "storage-only"));
    if (shown.length === 0) {
      body.replaceChildren(empty("No host matches this filter."));
      return;
    }
    body.replaceChildren(hosts_table(shown, samples));
  };

  const update = async (quiet: boolean) => {
    const answer = await attempt(body, quiet, () => Promise.all([
      api<HostRow[]>("/api/hosts"),
      api<HostSample[]>(`/api/hosts/samples${query({ since: Math.floor(now_seconds() - day_in_seconds) })}`),
    ]), () => void update(false));
    if (answer === null) return;
    [hosts, samples] = answer;
    render();
  };
  void update(false);

  return {
    title: "Hosts",
    root: h("div", { class: "page" },
      h("div", { class: "page-title spread" }, h("h1", {}, "Hosts"), can("admin") && h("a", { class: "button", href: link(["settings", "new", "hosts"]) }, "Add host")),
      toolbar(select("Agent", state_filters, state, (value) => { state = value; replace_query({ state: value }); render(); })),
      body,
    ),
    update: async (changes) => {
      if (touches(changes, null, ["hosts", "config"])) await update(true);
    },
  };
}

function hosts_table(hosts: HostRow[], samples: HostSample[]): HTMLElement {
  return data_table<HostRow>([
    { label: "Host", cell: (host) => h("a", { href: link(["hosts", host.name]) }, host.name), sort: (host) => host.name },
    { label: "Kind", cell: (host) => host.kind === "storage-only" ? "storage-only" : host.own ? "managed, this server" : "managed", sort: (host) => host.kind },
    { label: "Agent", cell: (host) => agent_badge(host), sort: (host) => agent_state(host) },
    { label: "Version", cell: (host) => host.agent_version ?? h("span", { class: "muted" }, "—") },
    { label: "Last seen", cell: (host) => last_seen(host), sort: (host) => host.last_seen_epoch },
    { label: "Load, memory, disk", cell: (host) => health_sparklines(samples.filter((sample) => sample.host === host.name)) },
    { label: "Sources", class: "number", cell: (host) => host.sources.length, sort: (host) => host.sources.length },
    { label: "Repositories", class: "number", cell: (host) => host.repositories.length, sort: (host) => host.repositories.length },
  ], hosts, { caption: "Hosts" });
}

function last_seen(host: HostRow): Child {
  if (host.built_in) return "now";
  if (host.last_seen_epoch === null) return h("span", { class: "muted" }, "never");
  return h("span", { title: stamp(host.last_seen_epoch) }, host.connected ? "now" : age(host.last_seen_epoch));
}

// The newest load against the CPUs, memory in use and root disk full, with one small line of the last day for each once
// there are two readings to draw.
function health_sparklines(samples: HostSample[]): Child {
  if (samples.length === 0) return h("span", { class: "muted" }, "no readings");
  const latest = samples.at(-1)!;
  const load = samples.map((sample): [number, number] => [sample.epoch, sample.load1 / sample.cpus * 100]);
  const memory = samples.map((sample): [number, number] => [sample.epoch, (1 - sample.memory_available / sample.memory_total) * 100]);
  const disk = samples.map((sample): [number, number] => [sample.epoch, (1 - sample.disk_available / sample.disk_size) * 100]);
  const texts = [`load ${latest.load1.toFixed(2)} on ${latest.cpus} CPUs`, `memory ${Math.round(memory.at(-1)![1])}% used`, `disk ${Math.round(disk.at(-1)![1])}% full`];
  return h("div", {},
    samples.length > 1 && h("div", { class: "row-actions" },
      sparkline(texts[0], load, 100, "var(--series-1)"), sparkline(texts[1], memory, 100, "var(--series-2)"), sparkline(texts[2], disk, 100, "var(--series-3)")),
    h("div", { class: "muted small" }, texts.join(" · ")));
}

// ── Health ───────────────────────────────────────────────────────────────────

// A row per host: its load against its CPUs, its memory in use and how full its root disk is, each as a sparkline and the latest reading.
export function host_health(samples: HostSample[]): HTMLElement {
  if (samples.length === 0) return empty("No host readings yet.", "Each host is read beside its timers, every five minutes.");
  const by_host = new Map<string, HostSample[]>();
  for (const sample of samples) by_host.set(sample.host, [...(by_host.get(sample.host) ?? []), sample]);
  const tone = (percent: number) => percent >= reading_danger_percent ? "var(--status-danger)" : percent >= reading_warning_percent ? "var(--status-warning)" : "var(--series-1)";
  const reading = (name: string, points: [number, number][], top: number, color: string, text: string) => h("div", { class: "host-reading" },
    h("span", { class: "reading-label" }, name),
    sparkline(`${name}: ${text}`, points, top, color),
    h("span", { class: "meter-value" }, text));
  return h("div", { class: "hosts" }, ...[...by_host].sort(([a], [b]) => a.localeCompare(b)).flatMap(([host, readings]) => {
    const latest = readings.at(-1)!;
    const load = readings.map((sample): [number, number] => [sample.epoch, sample.load1 / sample.cpus * 100]);
    const memory = readings.map((sample): [number, number] => [sample.epoch, (1 - sample.memory_available / sample.memory_total) * 100]);
    const disk = readings.map((sample): [number, number] => [sample.epoch, (1 - sample.disk_available / sample.disk_size) * 100]);
    return [
      h("strong", { title: `read ${age(latest.epoch)}` }, host),
      reading("load", load, 100, tone(load.at(-1)![1]), `${latest.load1.toFixed(2)} / ${latest.cpus} CPUs`),
      reading("memory", memory, 100, tone(memory.at(-1)![1]), `${Math.round(memory.at(-1)![1])}% used`),
      reading("disk /", disk, 100, tone(disk.at(-1)![1]), `${size(latest.disk_available)} free`),
    ];
  }));
}

// ── One host ─────────────────────────────────────────────────────────────────

export function host_view(name: string): View {
  const header = h("div", {}, skeleton(2));
  const health = h("div", {}, skeleton(2));
  const sources = h("div", {}, skeleton(2));
  const stored = h("div", {}, skeleton(2));
  const targets = h("div", {}, skeleton(3));
  const runs = h("div", {}, skeleton(3));
  const timers = h("div", {}, skeleton(2));
  let sorting: Sorting = { key: "Status", descending: false };
  let running_here: RepositorySummary[] = [];

  const render_targets = () => {
    targets.replaceChildren(running_here.length === 0
      ? empty("No targets run here.", "A job whose source is on this host runs its backups here; a storage-only host's repositories are backed up from other hosts.")
      : repositories_table(running_here, sorting, (next) => { sorting = next; render_targets(); }));
  };

  const update = async (quiet: boolean) => {
    const answer = await attempt(header, quiet, () => Promise.all([
      api<HostRow[]>("/api/hosts"),
      api<SourceRow[]>("/api/sources"),
      api<RepositorySummary[]>("/api/repositories"),
    ]), () => void update(false));
    if (answer === null) return;
    const [hosts, all_sources, all_targets] = answer;
    const host = hosts.find((item) => item.name === name);
    if (host === undefined) {
      header.replaceChildren(empty(`No host named ${name}.`, h("a", { href: link(["hosts"]) }, "All hosts")));
      for (const box of [health, sources, stored, targets, runs, timers]) box.replaceChildren();
      return;
    }
    header.replaceChildren(host_header(host, () => void update(true)));
    sources.replaceChildren(sources_list(all_sources.filter((source) => source.host === name)));
    stored.replaceChildren(stored_list(host, all_targets));
    running_here = all_targets.filter((target) => target.host === name);
    render_targets();
    await Promise.all([
      load(health, async () => {
        const samples = await api<HostSample[]>(`/api/hosts/samples${query({ since: Math.floor(now_seconds() - day_in_seconds) })}`);
        const own = samples.filter((sample) => sample.host === name);
        if (own.length === 0 && agent_away(host)) return empty("No health readings.", "Readings arrive every five minutes once this host's agent connects.");
        return host_health(own);
      }, { quiet }),
      load(runs, async () => runs_table(await api<Run[]>(`/api/runs${query({ host: name, limit: 20 })}`), { with_repository: true, refresh: () => void update(true) }), { quiet }),
      load(timers, async () => {
        const all = await api<TimerRow[]>("/api/timers");
        return timers_table(all.filter((timer) => timer.host === name), false);
      }, { quiet }),
    ]);
  };
  void update(false);

  return {
    title: name,
    root: h("div", { class: "page" },
      crumbs([["Hosts", link(["hosts"])], [name, null]]),
      header,
      section("Health", health, h("span", { class: "muted small" }, "last 24 hours")),
      h("div", { class: "columns" }, section("Sources", sources), section("Repositories stored here", stored)),
      section("Targets running here", targets),
      section("Runs", runs, h("a", { href: link(["runs"], { host: name }) }, "All runs on this host")),
      section("Host timers", timers, h("span", { class: "muted small" }, "read where systemd has them")),
    ),
    update: async (changes) => {
      if (touches(changes, null, ["hosts", "config", "run", "timers", "repository"])) await update(true);
    },
  };
}

function host_header(host: HostRow, refresh: () => void): HTMLElement {
  const state = agent_state(host);
  return h("header", { class: "page-head" },
    h("div", { class: "page-title" }, h("h1", {}, host.name), agent_badge(host), host.own && chip("this server")),
    h("p", { class: "muted", role: "status", "aria-live": "polite" },
      host.kind === "storage-only" ? "Storage-only: holds repositories reached through borg serve." : host.address ?? "This server's own machine.",
      host.agent_version ? ` · agent ${host.agent_version}` : "",
      host.connected_epoch ? ` · connected ${age(host.connected_epoch)}` : "",
      state === "offline" && host.last_seen_epoch ? ` · last seen ${age(host.last_seen_epoch)}` : ""),
    facts([
      ["Kind", host.kind],
      ["Address", host.address ?? "none, this server"],
      ["Agent", agent_labels[state][2]],
      ["Sources", plural(host.sources.length, "source")],
      ["Repositories", `${host.repositories.length} ${host.repositories.length === 1 ? "repository" : "repositories"}`],
    ]),
    state === "never_enrolled" && h("div", { class: "banner", role: "note" },
      h("strong", {}, "Enrol this host's agent."), " Until it connects, backups and tasks on this host wait.",
      can("admin") ? "" : " An admin issues its token."),
    can("admin") && host.kind === "managed" && !host.own && h("div", { class: "head-actions" },
      h("button", { class: host.enrolled ? null : "accent solid", onclick: () => enrol(host, refresh) }, host.enrolled ? "Issue a new token" : "Enrol agent"),
      host.enrolled && h("button", { class: "danger", onclick: () => revoke(host, refresh) }, "Revoke token"),
      h("a", { class: "button", href: link(["settings", "hosts", host.name]) }, "Config"),
    ),
  );
}

function sources_list(sources: SourceRow[]): HTMLElement {
  if (sources.length === 0) return empty("No sources on this host.");
  return h("ul", { class: "plain-list" }, ...sources.map((source) => h("li", {},
    h("a", { href: link(["sources", source.name]) }, source.name),
    h("span", { class: "muted" }, ` · ${source.paths.join(", ")}`))));
}

// The repositories whose disk is on this host, each linking to its first target the viewer sees.
function stored_list(host: HostRow, targets: RepositorySummary[]): HTMLElement {
  if (host.repositories.length === 0) return empty("No repositories stored here.");
  return h("ul", { class: "plain-list" }, ...host.repositories.map((repository) => {
    const target = targets.find((item) => item.repository === repository);
    return h("li", {}, target ? h("a", { href: link(["repositories", target.id]) }, repository) : repository,
      target && h("span", { class: "muted" }, ` · last backup ${age(target.last_backup_epoch)}`));
  }));
}

// ── Enrolment ────────────────────────────────────────────────────────────────

function enrol(host: HostRow, refresh: () => void): void {
  const issue = async () => {
    try {
      const { token } = await api<{ token: string }>(`/api/hosts/${encodeURIComponent(host.name)}/token`, {});
      show_token(host.name, token);
    } catch (error) {
      toast(`Could not issue a token: ${error instanceof Error ? error.message : String(error)}`, { tone: "bad" });
    }
    refresh();
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
  const copy = (text: string, what: string, label: string) => h("div", {}, h("button", { onclick: () => void navigator.clipboard?.writeText(text).then(() => toast(`${what} copied.`)) }, label));
  open_dialog(`${host}'s agent token`, h("div", { class: "stack" },
    h("p", {}, "Shown this once. Put it in a file on the host, readable only by root."),
    h("pre", { class: "output secret-once" }, token),
    copy(token, "Token", "Copy token"),
    h("p", {}, "On NixOS, enable the flake's agent module:"),
    h("pre", { class: "output" }, nix),
    copy(nix, "Nix", "Copy the Nix"),
    h("p", {}, "Elsewhere, run the agent package with:"),
    h("pre", { class: "output" }, environment),
    copy(environment, "Variables", "Copy the variables"),
    location.protocol !== "https:" && h("p", { class: "tone-warn small" }, "The agent needs wss:// to reach a server on another machine; serve this page over HTTPS for the URL above to work."),
  ), (close) => [h("button", { class: "accent solid", onclick: close }, "I have saved it")], { wide: true });
}

function revoke(host: HostRow, refresh: () => void): void {
  confirm_dialog({
    title: `Revoke ${host.name}'s token?`,
    message: h("div", {},
      h("p", {}, `Its agent is hung up on and cannot connect again. Backups and tasks on ${host.name} wait until it is enrolled again.`),
      h("p", { class: "muted" }, "Runs it has going carry on there and are followed again once it reconnects with a new token.")),
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
      refresh();
    },
  });
}
