// The page: the login, the shell around every view (header, sidebar, search, runs in progress, theme), and the router between views.

import "@x-tech-laboratories/halon/halon-tokens.css";
import "@x-tech-laboratories/halon/halon.css";
import "./app.css";
import { stamp } from "@x-tech-laboratories/x-libs/web/format";
import { Shell, use_route, type ShellSection } from "@x-tech-laboratories/x-libs/web/preact/shell";
import { current_route, link, type Route } from "@x-tech-laboratories/x-libs/web/router";
import { Fragment, render, type ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { api, LoginNeeded, query, type Run, type SearchResults } from "./api.ts";
import { connect, disconnect, stream_up } from "./live.ts";
import { Login } from "./login.tsx";
import { can, forget_me, load_me, type Me } from "./session.ts";
import { theme, use_changes } from "./ui.tsx";
import { ArchiveView } from "./views/archive.tsx";
import { entity_title, EntityView } from "./views/entity_config.tsx";
import { HostsView, HostView } from "./views/hosts.tsx";
import { JobsView, JobView } from "./views/jobs.tsx";
import { NewRepositoryView } from "./views/new_repository.tsx";
import { OverviewView } from "./views/overview.tsx";
import { EventsView, SchedulesView, SettingsView } from "./views/pages.tsx";
import { RepositoriesView } from "./views/repositories.tsx";
import { RepositoryView } from "./views/repository.tsx";
import { RunsView, RunView } from "./views/runs.tsx";
import { SourcesView, SourceView } from "./views/sources.tsx";
import { AccountView, UsersView } from "./views/users.tsx";

const sections: ShellSection[] = [
  { id: "", label: "Overview", href: "#/" },
  { id: "hosts", label: "Hosts", href: "#/hosts" },
  { id: "repositories", label: "Repositories", href: "#/repositories" },
  { id: "sources", label: "Sources", href: "#/sources" },
  { id: "jobs", label: "Jobs", href: "#/jobs" },
  { id: "runs", label: "Runs", href: "#/runs" },
  { id: "schedules", label: "Schedules", href: "#/schedules" },
  { id: "events", label: "Events", href: "#/events" },
  { id: "settings", label: "Settings", href: "#/settings" },
  { id: "users", label: "Users", href: "#/users" },
  { id: "account", label: "Account", href: "#/account" },
];

// ── Routing ──────────────────────────────────────────────────────────────────

interface Page {
  title: string;
  view: ComponentChildren;
}

function page_for(parts: string[]): Page {
  const [section, id, tab, archive] = parts;
  if (section === "new-repository") return { title: "Add repository", view: <NewRepositoryView /> };
  if (section === "repositories" && id && tab === "archives" && archive) return { title: archive, view: <ArchiveView id={id} name={archive} /> };
  if (section === "repositories" && id) return { title: id, view: <RepositoryView id={id} tab={tab ?? "overview"} /> };
  if (section === "repositories") return { title: "Repositories", view: <RepositoriesView /> };
  if (section === "hosts" && id) return { title: id, view: <HostView name={id} /> };
  if (section === "hosts") return { title: "Hosts", view: <HostsView /> };
  if (section === "sources" && id) return { title: id, view: <SourceView name={id} /> };
  if (section === "sources") return { title: "Sources", view: <SourcesView /> };
  if (section === "jobs" && id) return { title: id, view: <JobView name={id} /> };
  if (section === "jobs") return { title: "Jobs", view: <JobsView /> };
  if (section === "runs" && id) return { title: `Run #${Number(id)}`, view: <RunView id={Number(id)} /> };
  if (section === "runs") return { title: "Runs", view: <RunsView /> };
  if (section === "schedules") return { title: "Schedules", view: <SchedulesView /> };
  if (section === "events") return { title: "Events", view: <EventsView /> };
  if (section === "settings" && id === "new" && tab) return { title: entity_title(tab, null), view: <EntityView kind={tab} name={null} /> };
  if (section === "settings" && id && tab) return { title: entity_title(id, tab), view: <EntityView kind={id} name={tab} /> };
  if (section === "settings") return { title: "Settings", view: <SettingsView /> };
  if (section === "users") return { title: "Users", view: <UsersView /> };
  if (section === "account") return { title: "Account", view: <AccountView /> };
  return { title: "Overview", view: <OverviewView /> };
}

// A link to a run on the old Jobs page opens it on the Runs page; Jobs now lists the job definitions.
function moved(route: Route): Route {
  const [first, second] = route.parts;
  if (first !== "jobs" || second === undefined || !/^\d+$/.test(second)) return route;
  history.replaceState(null, "", location.hash.replace(/^#\/?jobs/, "#/runs"));
  return current_route();
}

// ── App ──────────────────────────────────────────────────────────────────────

function App() {
  // Who is logged in, null on the login page, and undefined until the first request tells whether a session is open.
  const [who, set_who] = useState<Me | null | undefined>(undefined);
  const route = moved(use_route());

  function show_login(): void {
    disconnect();
    forget_me();
    set_who(null);
  }

  async function start(): Promise<void> {
    set_who(await load_me());
    connect();
  }

  useEffect(() => {
    // A login can lapse while any view is fetching, so a LoginNeeded from anywhere brings the login back.
    window.addEventListener("unhandledrejection", (event) => {
      if (!(event.reason instanceof LoginNeeded)) return;
      event.preventDefault();
      show_login();
    });
    void load_me().then(start, (error) => {
      if (error instanceof LoginNeeded) show_login();
      else void start();
    });
  }, []);

  const page = who ? page_for(route.parts) : null;
  const view_key = `${route.parts.join("/")}?${route.query.toString()}`;

  useEffect(() => {
    if (who === null) document.title = "Log in · X-Backups";
    else if (page) document.title = `${page.title} · X-Backups`;
  });

  async function log_out(): Promise<void> {
    await api("/api/logout", {}).catch(() => {});
    show_login();
  }

  return (
    <Shell
      brand="X-Backups"
      sections={sections.filter((section) => section.id !== "users" || can("admin"))}
      active={(route.parts[0] === "new-repository" ? "repositories" : route.parts[0]) ?? ""}
      theme={theme}
      user={who ? `${who.name} · ${who.role}` : null}
      user_href="#/account"
      on_logout={() => void log_out()}
      tools={who && <><Search /><RunningChip /></>}
      sidebar_foot={who && <StreamState />}
      view_key={who ? view_key : "login"}
    >
      {who === null && <Login on_login={async () => {
        window.dispatchEvent(new HashChangeEvent("hashchange"));
        await start();
      }} />}
      {page && <Fragment key={view_key}>{page.view}</Fragment>}
    </Shell>
  );
}

// ── Runs in progress ─────────────────────────────────────────────────────────

function RunningChip() {
  const [runs, set_runs] = useState<Run[]>([]);

  const update = () => void api<Run[]>(`/api/runs${query({ state: "running", limit: 100 })}`).then(set_runs, () => {});
  useEffect(update, []);
  use_changes((changes) => {
    if (changes === null || changes.some((change) => change.kind === "run")) update();
  });

  if (runs.length === 0) return null;
  const [first] = runs;
  return (
    <a class="chip chip-info running-chip" href={runs.length === 1 ? link(["runs", String(first.id)]) : link(["runs"], { state: "running" })}>
      {runs.length === 1 ? `${first.kind} running on ${first.target_id}` : `${runs.length} runs in progress`}
    </a>
  );
}

// ── Stream state ─────────────────────────────────────────────────────────────

const stream_text = () => stream_up() ? "Live" : "Reconnecting; refreshing every 15 s";

// Whether the change stream is up, written at the foot of the sidebar.
function StreamState() {
  const [text, set_text] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => set_text(stream_text()), 2000);
    return () => clearTimeout(timer);
  }, []);
  use_changes(() => set_text(stream_text()));
  return <p id="stream-state" class="stream-state muted small" role="status">{text}</p>;
}

// ── Search ───────────────────────────────────────────────────────────────────

function Search() {
  const [text, set_text] = useState("");
  const [found, set_found] = useState<SearchResults | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const open = found !== null;

  useEffect(() => {
    const outside = (event: MouseEvent) => { if (!box.current?.contains(event.target as Node)) set_found(null); };
    document.addEventListener("click", outside);
    return () => document.removeEventListener("click", outside);
  }, []);

  function typed(value: string): void {
    set_text(value);
    clearTimeout(timer.current);
    const wanted = value.trim();
    if (!wanted) return set_found(null);
    timer.current = window.setTimeout(async () => {
      const answer = await api<SearchResults>(`/api/search${query({ q: wanted })}`).catch(() => null);
      if (answer === null || input.current?.value.trim() !== wanted) return;
      set_found(answer);
    }, 200);
  }

  const items = () => [...(results.current?.querySelectorAll<HTMLAnchorElement>("a") ?? [])];

  function input_key(event: KeyboardEvent): void {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      items()[0]?.focus();
    } else if (event.key === "Escape") {
      set_found(null);
    } else if (event.key === "Enter") {
      items()[0]?.click();
    }
  }

  function results_key(event: KeyboardEvent): void {
    const list = items();
    const at = list.indexOf(document.activeElement as HTMLAnchorElement);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      list[Math.min(list.length - 1, at + 1)]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (at <= 0) input.current?.focus();
      else list[at - 1].focus();
    } else if (event.key === "Escape") {
      set_found(null);
      input.current?.focus();
    }
  }

  function picked(event: MouseEvent): void {
    if (!(event.target as HTMLElement).closest("a")) return;
    set_found(null);
    set_text("");
  }

  const count = found ? found.repositories.length + found.archives.length : 0;
  return (
    <div ref={box} class="search" role="search">
      <input ref={input} id="search" type="search" placeholder="Search repositories and archives" aria-label="Search repositories and archives"
        autocomplete="off" aria-controls="search-results" aria-expanded={open} value={text}
        onInput={(event) => typed((event.currentTarget as HTMLInputElement).value)} onKeyDown={input_key} />
      <div ref={results} id="search-results" class="search-results" hidden={!open} onKeyDown={results_key} onClick={picked}>
        {found?.repositories.map((repository) => (
          <a key={`repository-${repository.id}`} href={link(["repositories", repository.id])} class="search-item">
            <span class="chip">repository</span> {repository.name}
          </a>
        ))}
        {found?.archives.map((archive) => (
          <a key={`archive-${archive.target_id}-${archive.name}`} href={link(["repositories", archive.target_id, "archives", archive.name], { tab: "changes" })} class="search-item">
            <span class="chip">archive</span> {archive.name}<span class="muted small">{` in ${archive.target_id}, ${stamp(archive.epoch)}`}</span>
          </a>
        ))}
        {open && count === 0 && <p class="muted search-none">Nothing matches.</p>}
      </div>
    </div>
  );
}

// ── Start ────────────────────────────────────────────────────────────────────

render(<App />, document.querySelector("#app")!);
