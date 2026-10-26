// The page: the login, the shell around every view (header, sidebar, search, running jobs, theme), and the router between views.

import { api, LoginNeeded, query, type Change, type Job, type SearchResults } from "./api.ts";
import { h, stamp } from "./dom.ts";
import { connect, disconnect, on_changes, stream_up } from "./live.ts";
import { current_route, link } from "./router.ts";
import { apply, next_theme, theme_choice, type Theme } from "./theme.ts";
import { archive_view } from "./views/archive.ts";
import { job_view, jobs_view } from "./views/jobs.ts";
import { overview_view } from "./views/overview.ts";
import { events_view, schedules_view, settings_view } from "./views/pages.ts";
import { repositories_view } from "./views/repositories.ts";
import { repository_view } from "./views/repository.ts";
import type { View } from "./views/shared.ts";
import "./style.css";

const main = document.querySelector<HTMLElement>("main")!;
const sidebar = document.querySelector<HTMLElement>("#sidebar")!;
const scrim = document.querySelector<HTMLElement>("#scrim")!;
const menu = document.querySelector<HTMLButtonElement>("#menu")!;

let current: View | null = null;
let first_view = true;

// ── Routing ──────────────────────────────────────────────────────────────────

function view_for(parts: string[]): View {
  const [section, id, tab, archive] = parts;
  if (section === "repositories" && id && tab === "archives" && archive) return archive_view(id, archive);
  if (section === "repositories" && id) return repository_view(id, tab ?? "overview");
  if (section === "repositories") return repositories_view();
  if (section === "jobs" && id) return job_view(Number(id));
  if (section === "jobs") return jobs_view();
  if (section === "schedules") return schedules_view();
  if (section === "events") return events_view();
  if (section === "settings") return settings_view();
  return overview_view();
}

function show(): void {
  current?.dispose?.();
  const route = current_route();
  current = view_for(route.parts);
  main.replaceChildren(current.root);
  document.title = `${current.title} · X-Backups`;
  for (const item of sidebar.querySelectorAll<HTMLAnchorElement>("a[data-section]")) {
    const active = item.dataset.section === (route.parts[0] ?? "");
    item.classList.toggle("active", active);
    if (active) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  }
  close_menu();
  // Moving focus to the new page tells a screen reader the view changed, but not on the first load.
  if (!first_view) main.focus({ preventScroll: true });
  first_view = false;
  window.scrollTo(0, 0);
}

window.addEventListener("hashchange", () => {
  if (!document.body.classList.contains("logged-out")) show();
});

on_changes((changes: Change[] | null) => {
  void current?.update?.(changes);
  if (changes === null || changes.some((change) => change.kind === "job")) void update_running();
  update_stream_state();
});

// A login can lapse while any view is fetching, so a LoginNeeded from anywhere brings the login back.
window.addEventListener("unhandledrejection", (event) => {
  if (event.reason instanceof LoginNeeded) {
    event.preventDefault();
    show_login();
  }
});

// ── Login ────────────────────────────────────────────────────────────────────

function show_login(): void {
  disconnect();
  current?.dispose?.();
  current = null;
  document.body.classList.add("logged-out");
  document.title = "Log in · X-Backups";
  const password = h("input", { type: "password", name: "password", autocomplete: "current-password", required: true, "aria-label": "Password" });
  const message = h("p", { class: "tone-bad", role: "alert" });
  const submit = h("button", { type: "submit", class: "accent solid" }, "Log in");
  const form = h("form", { class: "login", onsubmit: async (event: Event) => {
    event.preventDefault();
    submit.disabled = true;
    message.textContent = "";
    try {
      await api("/api/login", { password: password.value });
      start();
    } catch (error) {
      message.textContent = error instanceof LoginNeeded ? "Wrong password." : `Could not log in: ${error instanceof Error ? error.message : String(error)}`;
      submit.disabled = false;
      password.select();
    }
  } }, h("h1", {}, "X-Backups"), h("label", { class: "field" }, h("span", { class: "field-label" }, "Password"), password), submit, message);
  main.replaceChildren(form);
  password.focus();
}

document.querySelector("#logout")!.addEventListener("click", async () => {
  await api("/api/logout", {}).catch(() => {});
  show_login();
});

function start(): void {
  document.body.classList.remove("logged-out");
  first_view = true;
  show();
  connect();
  void update_running();
  setTimeout(update_stream_state, 2000);
}

// ── Running jobs ─────────────────────────────────────────────────────────────

const running = document.querySelector<HTMLAnchorElement>("#running")!;

async function update_running(): Promise<void> {
  const jobs = await api<Job[]>(`/api/jobs${query({ state: "running", limit: 100 })}`).catch(() => null);
  if (jobs === null) return;
  running.hidden = jobs.length === 0;
  running.textContent = jobs.length === 1 ? `${jobs[0].kind} running on ${jobs[0].repository_id}` : `${jobs.length} jobs running`;
  running.href = jobs.length === 1 ? link(["jobs", String(jobs[0].id)]) : link(["jobs"], { state: "running" });
}

function update_stream_state(): void {
  document.querySelector("#stream-state")!.textContent = stream_up() ? "Live" : "Reconnecting; refreshing every 15 s";
}

// ── Menu ─────────────────────────────────────────────────────────────────────

function close_menu(): void {
  document.body.classList.remove("menu-open");
  menu.setAttribute("aria-expanded", "false");
  scrim.hidden = true;
}

menu.addEventListener("click", () => {
  const open = !document.body.classList.contains("menu-open");
  document.body.classList.toggle("menu-open", open);
  menu.setAttribute("aria-expanded", String(open));
  scrim.hidden = !open;
  if (open) sidebar.querySelector<HTMLElement>("a")?.focus();
});
scrim.addEventListener("click", close_menu);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && document.body.classList.contains("menu-open")) {
    close_menu();
    menu.focus();
  }
});

// ── Theme ────────────────────────────────────────────────────────────────────

const theme_button = document.querySelector<HTMLButtonElement>("#theme")!;
const theme_labels: Record<Theme, [icon: string, text: string]> = { system: ["◐", "Theme: system"], light: ["☀", "Theme: light"], dark: ["☾", "Theme: dark"] };

function show_theme(theme: Theme): void {
  const [icon, text] = theme_labels[theme];
  theme_button.textContent = icon;
  theme_button.title = `${text} (click to change)`;
  theme_button.setAttribute("aria-label", `${text}, click to change`);
}

theme_choice.on_change(show_theme);
theme_button.addEventListener("click", () => theme_choice.set(next_theme(theme_choice.get())));
apply();

// ── Search ───────────────────────────────────────────────────────────────────

const search = document.querySelector<HTMLInputElement>("#search")!;
const results = document.querySelector<HTMLElement>("#search-results")!;
let search_timer: number | undefined;

function close_search(): void {
  results.hidden = true;
  search.setAttribute("aria-expanded", "false");
}

search.addEventListener("input", () => {
  clearTimeout(search_timer);
  const text = search.value.trim();
  if (!text) return close_search();
  search_timer = window.setTimeout(async () => {
    const found = await api<SearchResults>(`/api/search${query({ q: text })}`).catch(() => null);
    if (found === null || search.value.trim() !== text) return;
    const items = [
      ...found.repositories.map((repository) => h("a", { href: link(["repositories", repository.id]), class: "search-item" },
        h("span", { class: "chip" }, "repository"), " ", repository.name)),
      ...found.archives.map((archive) => h("a", { href: link(["repositories", archive.repository_id, "archives", archive.name], { tab: "changes" }), class: "search-item" },
        h("span", { class: "chip" }, "archive"), " ", archive.name, h("span", { class: "muted small" }, ` in ${archive.repository_id}, ${stamp(archive.epoch)}`))),
    ];
    results.replaceChildren(...(items.length > 0 ? items : [h("p", { class: "muted search-none" }, "Nothing matches.")]));
    results.hidden = false;
    search.setAttribute("aria-expanded", "true");
  }, 200);
});

search.addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    results.querySelector<HTMLElement>("a")?.focus();
  } else if (event.key === "Escape") {
    close_search();
  } else if (event.key === "Enter") {
    results.querySelector<HTMLAnchorElement>("a")?.click();
  }
});

results.addEventListener("keydown", (event) => {
  const items = [...results.querySelectorAll<HTMLElement>("a")];
  const at = items.indexOf(document.activeElement as HTMLElement);
  if (event.key === "ArrowDown") {
    event.preventDefault();
    items[Math.min(items.length - 1, at + 1)]?.focus();
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    if (at <= 0) search.focus();
    else items[at - 1].focus();
  } else if (event.key === "Escape") {
    close_search();
    search.focus();
  }
});

results.addEventListener("click", (event) => {
  if ((event.target as HTMLElement).closest("a")) {
    close_search();
    search.value = "";
  }
});

document.addEventListener("click", (event) => {
  if (!(event.target as HTMLElement).closest(".search")) close_search();
});

// ── Start ────────────────────────────────────────────────────────────────────

// The first request tells whether a session is still open.
void api("/api/repositories").then(start, (error) => {
  if (error instanceof LoginNeeded) show_login();
  else start();
});
