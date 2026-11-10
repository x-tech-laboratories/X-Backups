// The page: the sign-in, the shell around every view (header, sidebar, search, runs in progress, theme), and the router between views.

import "@x-tech-laboratories/halon/halon-tokens.css";
import "@x-tech-laboratories/halon/halon.css";
import "./app.css";
import { stamp } from "@x-tech-laboratories/x-libs/web/format";
import { StatusPill } from "@x-tech-laboratories/x-libs/web/react/badges";
import { Shell, use_route, type ShellSection } from "@x-tech-laboratories/x-libs/web/react/shell";
import { SignInForm } from "@x-tech-laboratories/x-libs/web/react/sign_in";
import { Suggestions } from "@x-tech-laboratories/x-libs/web/react/suggestions";
import { current_route, link, type Route } from "@x-tech-laboratories/x-libs/web/router";
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { api, LoginNeeded, query, type Run, type SearchResults } from "./api.ts";
import { connect, disconnect, stream_up } from "./live.ts";
import { accounts, can, forget_me, load_me, type Me } from "./session.ts";
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
  view: ReactNode;
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
  // Who is signed in, null on the sign-in page, and undefined until the first request tells whether a session is open.
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
    // A session can lapse while any view is fetching, so a LoginNeeded from anywhere brings the sign-in back.
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
    if (who === null) document.title = "Sign in · X-Backups";
    else if (page) document.title = `${page.title} · X-Backups`;
  });

  async function sign_out(): Promise<void> {
    await accounts.sign_out().catch(() => {});
    show_login();
  }

  return (
    <Shell
      brand="X-Backups"
      brand_icon="/icon.svg"
      sections={sections.filter((section) => section.id !== "users" || can("admin"))}
      active={(route.parts[0] === "new-repository" ? "repositories" : route.parts[0]) ?? ""}
      theme={theme}
      user={who ? `${who.name} · ${who.role}` : null}
      user_href="#/account"
      on_logout={() => void sign_out()}
      tools={who && <><Search /><RunningChip /></>}
      sidebar_foot={who && <StreamState />}
      view_key={who ? view_key : "login"}
    >
      {who === null && <SignInForm client={accounts} title="X-Backups" on_signed_in={async () => {
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
    <a className="chip chip-info running-chip" href={runs.length === 1 ? link(["runs", String(first.id)]) : link(["runs"], { state: "running" })}>
      {runs.length === 1 ? `${first.kind} running on ${first.target_id}` : `${runs.length} runs in progress`}
    </a>
  );
}

// ── Stream state ─────────────────────────────────────────────────────────────

// Whether the change stream is up, at the foot of the sidebar.
function StreamState() {
  const [up, set_up] = useState<boolean | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => set_up(stream_up()), 2000);
    return () => clearTimeout(timer);
  }, []);
  use_changes(() => set_up(stream_up()));
  if (up === null) return null;
  return (
    <div className="stream-state" role="status">
      <StatusPill tone={up ? "good" : "warn"} busy={!up} label={up ? "Live" : "Reconnecting; refreshing every 15 s"} />
    </div>
  );
}

// ── Search ───────────────────────────────────────────────────────────────────

interface Found {
  kind: "repository" | "archive";
  key: string;
  text: string;
  detail: string | null;
  href: string;
}

// The repositories and archives whose names hold the text.
async function find(text: string): Promise<Found[]> {
  if (!text) return [];
  const answer = await api<SearchResults>(`/api/search${query({ q: text })}`).catch(() => null);
  if (answer === null) return [];
  return [
    ...answer.repositories.map((repository): Found => ({
      kind: "repository", key: `repository-${repository.id}`, text: repository.name, detail: null, href: link(["repositories", repository.id]),
    })),
    ...answer.archives.map((archive): Found => ({
      kind: "archive", key: `archive-${archive.target_id}-${archive.name}`, text: archive.name, detail: `in ${archive.target_id}, ${stamp(archive.epoch)}`,
      href: link(["repositories", archive.target_id, "archives", archive.name], { tab: "changes" }),
    })),
  ];
}

function Search() {
  const [text, set_text] = useState("");
  const [wanted, set_wanted] = useState("");
  const timer = useRef<number | undefined>(undefined);

  // The server is asked once typing pauses.
  function typed(value: string): void {
    set_text(value);
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => set_wanted(value.trim()), 200);
  }

  function picked(item: Found): void {
    set_text("");
    set_wanted("");
    location.hash = item.href;
  }

  return (
    <div className="search" role="search">
      <Suggestions value={wanted} source={find} key_of={(item) => item.key} label="Search results" on_take={picked}
        render={(item) => <><span className="chip">{item.kind}</span> {item.text}</>} detail={(item) => item.detail}>
        {(field) => (
          <input {...field} id="search" type="search" placeholder="Search repositories and archives" aria-label="Search repositories and archives"
            autoComplete="off" value={text} onChange={(event) => typed(event.currentTarget.value)} />
        )}
      </Suggestions>
    </div>
  );
}

// ── Start ────────────────────────────────────────────────────────────────────

createRoot(document.querySelector("#app")!).render(<App />);
