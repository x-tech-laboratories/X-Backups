// The page's building blocks: badges, dialogs, toasts, tabs, tables, filters, and the loading, empty and error states.

import { LoginNeeded, type EventLevel, type Level, type Run, type RunState, type Status } from "./api.ts";
import { h, nodes, type Child } from "./dom.ts";

// ── Badges ───────────────────────────────────────────────────────────────────

const status_labels: Record<Status, string> = {
  online: "OK",
  info: "OK",
  warning: "Warning",
  unavailable: "Unreachable",
  failed: "Failed",
};

export function status_badge(status: Status | null): HTMLElement {
  return h("span", { class: `badge tone-${status_tone(status)}` }, status === null ? "Not polled" : status_labels[status]);
}

export function status_tone(status: Status | null): "good" | "warn" | "bad" | "none" {
  if (status === "online" || status === "info") return "good";
  if (status === "warning" || status === "unavailable") return "warn";
  if (status === "failed") return "bad";
  return "none";
}

const run_tones: Record<RunState, string> = { running: "info", succeeded: "good", warning: "warn", failed: "bad", cancelled: "none" };

export function run_badge(state: RunState): HTMLElement {
  return h("span", { class: `badge tone-${run_tones[state]}` }, state);
}

// A run's state, or what keeps it from going: waiting for its host's agent, or lost when the agent no longer knew it.
export function run_state_badge(run: Pick<Run, "state" | "condition">): HTMLElement {
  if (run.condition === "waiting_for_agent") return h("span", { class: "badge tone-warn", title: "Its host's agent is away; the run carries on there and is followed again when it connects" }, "waiting for agent");
  if (run.condition === "lost") return h("span", { class: "badge tone-bad", title: "The agent no longer knew this run, so its outcome is unknown" }, "lost");
  return run_badge(run.state);
}

const health_labels: Record<Level, [text: string, tone: string]> = { ok: ["OK", "good"], warning: ["Warning", "warn"], critical: ["Failing", "bad"] };

// How healthy a job or a target is, as the server judges it.
export function health_badge(level: Level | null): HTMLElement {
  if (level === null) return h("span", { class: "badge tone-none" }, "No targets");
  const [text, tone] = health_labels[level];
  return h("span", { class: `badge tone-${tone}` }, text);
}

const level_tones: Record<EventLevel, string> = { INFO: "none", WARNING: "warn", ERROR: "bad" };

export function level_badge(level: EventLevel): HTMLElement {
  return h("span", { class: `badge tone-${level_tones[level]}` }, level.toLowerCase());
}

export function chip(text: string, title = ""): HTMLElement {
  return h("span", { class: "chip", title: title || null }, text);
}

// A pass, fail or not-yet verdict, written out so it never rests on color alone.
export function verdict(ok: boolean | null | undefined, label: string): HTMLElement {
  const text = ok === null || ok === undefined ? "no verdict" : ok ? "pass" : "fail";
  const tone = ok === null || ok === undefined ? "none" : ok ? "good" : "bad";
  return h("span", { class: `verdict tone-${tone}` }, `${label}: ${text}`);
}

// ── States ───────────────────────────────────────────────────────────────────

export function skeleton(lines = 3): HTMLElement {
  return h("div", { class: "skeleton", "aria-busy": "true", "aria-label": "Loading" },
    ...Array.from({ length: lines }, (_, index) => h("div", { class: "skeleton-line", style: `width: ${90 - index * 15}%` })));
}

export function empty(title: string, hint: Child = null): HTMLElement {
  return h("div", { class: "empty" }, h("p", { class: "empty-title" }, title), hint && h("p", { class: "muted" }, hint));
}

export function failure(error: unknown, retry: () => void): HTMLElement {
  return h("div", { class: "failure", role: "alert" },
    h("p", {}, `Could not load this: ${error instanceof Error ? error.message : String(error)}`),
    h("button", { onclick: retry }, "Retry"));
}

// Fills the target with what the work builds, showing a skeleton first and an error with Retry if it fails.
export async function load(target: HTMLElement, work: () => Promise<Child>, options: { quiet?: boolean } = {}): Promise<boolean> {
  if (!options.quiet) target.replaceChildren(skeleton());
  try {
    target.replaceChildren(...nodes(await work()));
    return true;
  } catch (error) {
    // A login is the router's to ask for; a quiet refresh keeps what is already shown.
    if (error instanceof LoginNeeded) throw error;
    if (options.quiet) return false;
    target.replaceChildren(failure(error, () => void load(target, work)));
    return false;
  }
}

// Fetches what a view needs, putting an error with Retry in the target when a first load fails; null when it failed.
export async function attempt<Answer>(target: HTMLElement, quiet: boolean, work: () => Promise<Answer>, retry: () => void): Promise<Answer | null> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof LoginNeeded) throw error;
    if (!quiet) target.replaceChildren(failure(error, retry));
    return null;
  }
}

// ── Layout pieces ────────────────────────────────────────────────────────────

export function section(title: Child, body: Child, tools: Child = null): HTMLElement {
  return h("section", { class: "panel" },
    h("div", { class: "panel-head" }, h("h2", {}, title), tools && h("div", { class: "panel-tools" }, tools)),
    body);
}

// Labelled values in a grid of tiles, or as rows of label and value for long values such as paths.
export function facts(rows: [label: string, value: Child, class_name?: string][], layout: "grid" | "rows" = "grid"): HTMLElement {
  return h("dl", { class: layout === "rows" ? "facts facts-rows" : "facts" }, ...rows.map(([label, value, class_name]) => h("div", {},
    h("dt", {}, label), h("dd", { class: class_name ?? null }, value ?? "—"),
  )));
}

export function tabs(items: { id: string; label: string; href: string }[], active: string): HTMLElement {
  return h("nav", { class: "tabs", "aria-label": "Sections" }, ...items.map((item) =>
    h("a", { href: item.href, class: item.id === active ? "tab active" : "tab", "aria-current": item.id === active ? "page" : null }, item.label)));
}

export function crumbs(items: [label: string, href: string | null][]): HTMLElement {
  return h("nav", { class: "crumbs", "aria-label": "Breadcrumb" }, ...items.flatMap(([label, href], index) => [
    index > 0 ? h("span", { class: "muted", "aria-hidden": "true" }, " / ") : null,
    href ? h("a", { href }, label) : h("span", { "aria-current": "page" }, label),
  ]));
}

// ── Filters ──────────────────────────────────────────────────────────────────

export function search_box(label: string, value: string, on_input: (value: string) => void): HTMLElement {
  let timer: number | undefined;
  return h("input", {
    type: "search", class: "filter", placeholder: label, "aria-label": label, value,
    oninput: (event: Event) => {
      clearTimeout(timer);
      const text = (event.target as HTMLInputElement).value;
      timer = window.setTimeout(() => on_input(text), 200);
    },
  });
}

export function select(label: string, options: [value: string, text: string][], value: string, on_change: (value: string) => void): HTMLElement {
  return h("label", { class: "field" }, h("span", { class: "field-label" }, label),
    h("select", { onchange: (event: Event) => on_change((event.target as HTMLSelectElement).value) },
      ...options.map(([option, text]) => h("option", { value: option, selected: option === value }, text))));
}

export function toolbar(...children: Child[]): HTMLElement {
  return h("div", { class: "toolbar" }, ...children);
}

// ── Tables ───────────────────────────────────────────────────────────────────

export interface Column<Row> {
  label: string;
  cell: (row: Row) => Child;
  // A value to sort by; a column without one does not sort.
  sort?: (row: Row) => string | number | null;
  class?: string;
}

export interface Sorting {
  key: string;
  descending: boolean;
}

// A table whose cells carry their column's label, so phones can show each row as a card.
export function data_table<Row>(columns: Column<Row>[], rows: Row[], options: {
  sorting?: Sorting;
  on_sort?: (sorting: Sorting) => void;
  caption?: string;
} = {}): HTMLElement {
  const sorting = options.sorting;
  const sort_column = sorting ? columns.find((column) => column.label === sorting.key && column.sort) : undefined;
  const sorted = sort_column ? [...rows].sort((left, right) => {
    const [a, b] = [sort_column.sort!(left), sort_column.sort!(right)];
    const order = a === b ? 0 : a === null ? 1 : b === null ? -1 : a < b ? -1 : 1;
    return sorting!.descending ? -order : order;
  }) : rows;

  const header = (column: Column<Row>) => {
    if (!column.sort || !options.on_sort) return h("th", { class: column.class ?? null, scope: "col" }, column.label);
    const active = sort_column === column;
    const aria_sort = active ? (sorting!.descending ? "descending" : "ascending") : "none";
    return h("th", { class: column.class ?? null, scope: "col", "aria-sort": aria_sort },
      h("button", {
        class: "sort",
        onclick: () => options.on_sort!({ key: column.label, descending: active ? !sorting!.descending : false }),
      }, column.label, active ? (sorting!.descending ? " ↓" : " ↑") : ""));
  };

  return h("div", { class: "table-wrap" },
    h("table", { class: "responsive" },
      options.caption ? h("caption", { class: "visually-hidden" }, options.caption) : null,
      h("thead", {}, h("tr", {}, ...columns.map(header))),
      h("tbody", {}, ...sorted.map((row) => h("tr", {}, ...columns.map((column) =>
        h("td", { class: column.class ?? null, "data-label": column.label }, column.cell(row)))))),
    ),
  );
}

export function sorting_from(query: URLSearchParams, fallback: Sorting): Sorting {
  const key = query.get("sort");
  return key ? { key, descending: query.get("dir") === "desc" } : fallback;
}

export function pager(page: number, has_more: boolean, go: (page: number) => void): HTMLElement | null {
  if (page === 1 && !has_more) return null;
  return h("nav", { class: "pager", "aria-label": "Pages" },
    h("button", { disabled: page <= 1, onclick: () => go(page - 1) }, "← Newer"),
    h("span", { class: "muted" }, `Page ${page}`),
    h("button", { disabled: !has_more, onclick: () => go(page + 1) }, "Older →"));
}

// ── Toasts ───────────────────────────────────────────────────────────────────

export interface ToastOptions {
  tone?: "good" | "bad" | "warn" | "info";
  link?: { href: string; text: string };
  // An error stays until closed; anything else fades after a few seconds.
  sticky?: boolean;
}

export function toast(message: string, options: ToastOptions = {}): void {
  const region = document.querySelector<HTMLElement>("#toasts")!;
  const tone = options.tone ?? "info";
  const close = () => item.remove();
  const item = h("div", { class: `toast tone-${tone}`, role: tone === "bad" ? "alert" : "status" },
    h("span", {}, message),
    options.link && h("a", { href: options.link.href, onclick: close }, options.link.text),
    h("button", { class: "icon", "aria-label": "Dismiss", onclick: close }, "×"));
  region.append(item);
  if (!(options.sticky ?? tone === "bad")) setTimeout(close, 6000);
}

// ── Dialogs ──────────────────────────────────────────────────────────────────

// A modal dialog: the page behind it is inert, focus stays inside, and Escape closes it.
export function open_dialog(title: string, body: Child, buttons: (close: () => void) => Child, options: { wide?: boolean } = {}): () => void {
  const dialog = h("dialog", { class: options.wide ? "dialog wide" : "dialog", "aria-labelledby": "dialog-title" });
  const close = () => {
    dialog.close();
    dialog.remove();
  };
  dialog.addEventListener("close", () => dialog.remove());
  dialog.append(
    h("h2", { id: "dialog-title" }, title),
    h("div", { class: "dialog-body" }, body),
    h("div", { class: "dialog-buttons" }, buttons(close)),
  );
  document.body.append(dialog);
  dialog.showModal();
  return close;
}

export interface ConfirmOptions {
  title: string;
  message: Child;
  confirm_label: string;
  busy_label?: string;
  danger?: boolean;
  // Text the user must type before the confirm button wakes, for what cannot be undone.
  type_to_confirm?: string;
  // Runs while the dialog stays open with a busy label, closing it when done.
  run: () => Promise<void>;
}

export function confirm_dialog(options: ConfirmOptions): void {
  const confirm = h("button", { class: options.danger ? "danger solid" : "accent solid", disabled: options.type_to_confirm !== undefined }, options.confirm_label);
  const typed = options.type_to_confirm === undefined ? null : h("input", {
    type: "text", class: "filter", autocomplete: "off", "aria-label": `Type ${options.type_to_confirm} to confirm`,
    oninput: (event: Event) => { confirm.disabled = (event.target as HTMLInputElement).value !== options.type_to_confirm; },
  });
  const body = h("div", {},
    typeof options.message === "string" ? h("p", {}, options.message) : options.message,
    typed && h("label", { class: "type-confirm" }, h("span", {}, "Type ", h("strong", {}, options.type_to_confirm!), " to confirm:"), typed),
  );
  open_dialog(options.title, body, (close) => {
    const cancel = h("button", { onclick: close }, "Cancel");
    confirm.addEventListener("click", async () => {
      confirm.disabled = true;
      cancel.disabled = true;
      confirm.textContent = options.busy_label ?? "Working…";
      try {
        await options.run();
      } finally {
        close();
      }
    });
    return [cancel, confirm];
  });
  (typed ?? confirm).focus();
}

// Shows a long text result, such as a preview, with a button to copy it.
export function text_dialog(title: string, text: string): void {
  open_dialog(title, h("pre", { class: "output" }, text), (close) => [
    h("button", { onclick: () => void navigator.clipboard?.writeText(text).then(() => toast("Copied.")) }, "Copy"),
    h("button", { class: "accent solid", onclick: close }, "Close"),
  ], { wide: true });
}
