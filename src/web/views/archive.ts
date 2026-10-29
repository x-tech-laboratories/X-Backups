// One archive: its numbers against the one before it, what changed since then, and its files to browse and restore.

import { run_action, type ActionTarget } from "../actions.ts";
import { api, query, repository_path, type Archive, type Diff, type DiffChange, type Listing, type RepositoryDetail } from "../api.ts";
import { age, count_change, h, nodes, plural, size, size_change, stamp, type Child } from "../dom.ts";
import { current_route, link, replace_query } from "../router.ts";
import {
  attempt, confirm_dialog, crumbs, data_table, empty, facts, load, pager, search_box, section, select, skeleton, sorting_from, tabs,
  toast, toolbar, type Sorting,
} from "../ui.ts";
import { can } from "../session.ts";
import { delete_archive } from "./repository.ts";
import { touches, type View } from "./shared.ts";

const change_page_size = 200;

export function archive_view(id: string, name: string): View {
  const base = repository_path(id);
  const tab = current_route().query.get("tab") === "files" ? "files" : "changes";
  const header = h("div", {}, skeleton(3));
  const body = h("div", { class: "stack" }, skeleton(6));
  let started = false;

  const update = async (quiet: boolean): Promise<void> => {
    const repository = await attempt(header, quiet, () => api<RepositoryDetail>(base), () => void update(false));
    if (repository === null) return;
    const index = repository.archives.findIndex((archive) => archive.name === name);
    if (index === -1) {
      header.replaceChildren(empty(`${name} is not in ${repository.name}'s archive list.`, h("a", { href: link(["repositories", id, "archives"]) }, "Back to the archives")));
      body.replaceChildren();
      return;
    }
    const archive = repository.archives[index];
    const older = repository.archives[index + 1] ?? null;
    const newer = repository.archives[index - 1] ?? null;
    const target: ActionTarget = { target_id: id, repository_name: repository.name, done: () => void update(true) };
    header.replaceChildren(archive_header(repository, archive, older, newer, index, tab, target));
    // The tabs load once; a later change to the repository only refreshes the header's numbers.
    if (started) return;
    started = true;
    // What is inside an archive is backed-up data, which the server shows only to operators.
    if (!can("operator")) body.replaceChildren(empty("Reading what is inside an archive needs the operator role.", "An admin can change your role on the Users page."));
    else if (tab === "files") files_tab(body, base, archive.name, repository.restore_dir, target);
    else changes_tab(body, base, archive.name, older);
  };
  void update(false);

  return {
    title: name,
    root: h("div", { class: "page" },
      crumbs([["Repositories", link(["repositories"])], [id, link(["repositories", id])], ["Archives", link(["repositories", id, "archives"])], [name, null]]),
      header,
      tabs([
        { id: "changes", label: "Changes", href: link(["repositories", id, "archives", name], { tab: "changes" }) },
        { id: "files", label: "Files", href: link(["repositories", id, "archives", name], { tab: "files" }) },
      ], tab),
      body,
    ),
    update: async (changes) => {
      if (touches(changes, id, ["repository"])) await update(true);
    },
  };
}

// ── Header ───────────────────────────────────────────────────────────────────

function archive_header(repository: RepositoryDetail, archive: Archive, older: Archive | null, newer: Archive | null, index: number, tab: string, target: ActionTarget): HTMLElement {
  const step = (other: Archive | null, text: string) => other
    ? h("a", { class: "button", href: link(["repositories", repository.id, "archives", other.name], { tab }) }, text)
    : h("button", { disabled: true }, text);
  const delta = (now: number | undefined, before: number | undefined, format: (value: number) => string) =>
    now === undefined || before === undefined ? null : h("span", { class: "muted small" }, ` (${format(now - before)} since the one before)`);
  return h("header", { class: "page-head" },
    h("div", { class: "page-title" }, h("h1", {}, archive.name)),
    h("div", { class: "stepper", role: "group", "aria-label": "Step through archives" },
      step(older, "← Older"),
      h("span", { class: "muted" }, `${repository.archives.length - index} of ${repository.archives.length}`),
      step(newer, "Newer →"),
    ),
    facts([
      ["Created", h("span", { title: stamp(archive.epoch) }, `${stamp(archive.epoch)} (${age(archive.epoch)})`)],
      ["Original", [size(archive.original), delta(archive.original, older?.original, size_change)]],
      ["New data", h("span", { title: "Data no other archive shares, which deleting this archive would free" }, size(archive.deduplicated))],
      ["Files", [archive.nfiles?.toLocaleString() ?? "—", delta(archive.nfiles, older?.nfiles, count_change)]],
    ]),
    can("operator") && repository.allow_delete && h("div", { class: "head-actions" },
      h("button", { class: "danger", onclick: () => delete_archive(target, archive.name, () => { location.hash = link(["repositories", repository.id, "archives"]); }) }, "Delete archive")),
  );
}

// ── Changes ──────────────────────────────────────────────────────────────────

const change_tones: Record<DiffChange["kind"], string> = { added: "good", removed: "bad", modified: "info", metadata: "none", other: "none" };

function changes_tab(body: HTMLElement, base: string, archive: string, older: Archive | null): void {
  if (older === null) {
    body.replaceChildren(section("Changes", empty("This is the oldest listed archive.", "There is nothing before it to compare against.")));
    return;
  }
  const holder = h("div", {},
    h("p", { class: "muted", role: "status" }, `Comparing with ${older.name}… borg reads both archives' file lists, which can take a while.`),
    skeleton(6));
  body.replaceChildren(section(`Changes since ${older.name}`, holder));
  void load(holder, async () => {
    const diff = await api<Diff>(`${base}/diff${query({ archive })}`);
    if (!diff.success) return h("pre", { class: "output tone-bad" }, diff.content ?? "The diff failed.");
    return changes_view(diff);
  }, { quiet: true });
}

function changes_view(diff: Diff): HTMLElement {
  const route_query = current_route().query;
  let text = route_query.get("q") ?? "";
  let layout = route_query.get("view") === "tree" ? "tree" : "flat";
  let metadata = route_query.get("meta") === "1";
  let page = 1;
  let sorting = sorting_from(route_query, { key: "Path", descending: false });
  const list = h("div");
  const counts = (kind: DiffChange["kind"]) => diff.changes.filter((change) => change.kind === kind);
  const added = counts("added");
  const removed = counts("removed");
  const modified = counts("modified");
  const total = (changes: DiffChange[], field: "added_bytes" | "removed_bytes") => changes.reduce((sum, change) => sum + change[field], 0);

  const render = () => {
    const needle = text.trim().toLowerCase();
    const shown = diff.changes.filter((change) => (metadata || change.kind !== "metadata") && (!needle || change.path.toLowerCase().includes(needle)));
    if (diff.changes.length === 0) {
      list.replaceChildren(empty("Nothing changed between these two archives."));
      return;
    }
    if (shown.length === 0) {
      list.replaceChildren(empty("No change matches.", metadata ? null : "Changes to times, modes and owners alone are hidden; tick the box to show them."));
      return;
    }
    if (layout === "tree") {
      list.replaceChildren(change_tree(shown));
      return;
    }
    const pages = Math.ceil(shown.length / change_page_size);
    page = Math.min(page, pages);
    list.replaceChildren(...nodes([
      changes_table(shown, sorting, (next) => { sorting = next; replace_query({ sort: next.key, dir: next.descending ? "desc" : null }); render(); }, page),
      pager(page, page < pages, (next) => { page = next; render(); }),
    ]));
  };

  const box = h("input", { type: "checkbox", checked: metadata, onchange: (event: Event) => {
    metadata = (event.target as HTMLInputElement).checked;
    replace_query({ meta: metadata ? "1" : null });
    render();
  } });
  render();
  return h("div", {},
    h("div", { class: "change-summary" },
      h("span", { class: "badge tone-good" }, `${added.length.toLocaleString()} added · ${size_change(total(added, "added_bytes"))}`),
      h("span", { class: "badge tone-info" }, `${modified.length.toLocaleString()} modified · ${size_change(total(modified, "added_bytes") - total(modified, "removed_bytes"))}`),
      h("span", { class: "badge tone-bad" }, `${removed.length.toLocaleString()} removed · ${size_change(-total(removed, "removed_bytes"))}`),
      h("span", { class: "badge tone-none" }, `${counts("metadata").length.toLocaleString()} metadata only`),
    ),
    diff.more && h("p", { class: "muted small" }, "Only the first changes are shown; raise browse_limit in the repository's config for more."),
    toolbar(
      search_box("Filter by path", text, (value) => { text = value; page = 1; replace_query({ q: value }); render(); }),
      select("View", [["flat", "Flat list"], ["tree", "Folder tree"]], layout, (value) => { layout = value; replace_query({ view: value === "flat" ? null : value }); render(); }),
      h("label", { class: "check" }, box, " Show metadata-only changes"),
    ),
    list,
  );
}

function net(change: DiffChange): number {
  return change.added_bytes - change.removed_bytes;
}

function change_size(change: DiffChange): string {
  if (change.kind === "modified") return `+${size(change.added_bytes)} −${size(change.removed_bytes)}`;
  if (change.kind === "added") return size_change(change.added_bytes);
  if (change.kind === "removed") return size_change(-change.removed_bytes);
  return "";
}

function changes_table(changes: DiffChange[], sorting: Sorting, on_sort: (sorting: Sorting) => void, page: number): HTMLElement {
  const order: Record<DiffChange["kind"], number> = { added: 0, modified: 1, removed: 2, metadata: 3, other: 4 };
  const sorted = [...changes].sort((left, right) => {
    const value = (change: DiffChange): string | number => sorting.key === "Change" ? order[change.kind] : sorting.key === "Size" ? net(change) : change.path;
    const [a, b] = [value(left), value(right)];
    const result = a === b ? left.path.localeCompare(right.path) : a < b ? -1 : 1;
    return sorting.descending ? -result : result;
  }).slice((page - 1) * change_page_size, page * change_page_size);
  return data_table<DiffChange>([
    { label: "Change", cell: (change) => h("span", { class: `badge tone-${change_tones[change.kind]}` }, change.kind), sort: () => 0 },
    { label: "Path", cell: (change) => h("code", { class: "path" }, change.path), sort: () => 0 },
    { label: "Size", class: "number", cell: (change) => change_size(change), sort: () => 0 },
    { label: "Also", cell: (change) => change.details.join(", ") },
  ], sorted, { sorting, on_sort, caption: "Changed paths" });
}

interface Folder {
  name: string;
  folders: Map<string, Folder>;
  files: DiffChange[];
  // The folder's own change, such as new times, shown on its line rather than as a file beside it.
  own: DiffChange | null;
  net: number;
  count: number;
}

function new_folder(name: string): Folder {
  return { name, folders: new Map(), files: [], own: null, net: 0, count: 0 };
}

// Folders as collapsible rows holding their changed files, each folder with how many changes it holds and its net size.
function change_tree(changes: DiffChange[]): HTMLElement {
  const root = new_folder("");
  for (const change of changes) {
    const parts = change.path.split("/");
    let folder = root;
    folder.net += net(change);
    folder.count += 1;
    for (const part of parts.slice(0, -1)) {
      let next = folder.folders.get(part);
      if (!next) {
        next = new_folder(part);
        folder.folders.set(part, next);
      }
      next.net += net(change);
      next.count += 1;
      folder = next;
    }
    folder.files.push(change);
  }
  // Borg lists a folder before what is inside it, so a folder's own change is found among its parent's files only now.
  const adopt = (folder: Folder) => {
    folder.files = folder.files.filter((change) => {
      const child = folder.folders.get(change.path.slice(change.path.lastIndexOf("/") + 1));
      if (child === undefined) return true;
      child.own = change;
      return false;
    });
    for (const child of folder.folders.values()) adopt(child);
  };
  adopt(root);
  const draw = (folder: Folder, depth: number): Child[] => [
    ...[...folder.folders.values()].sort((a, b) => a.name.localeCompare(b.name)).map((child) => h("details", { class: "tree-folder", open: depth < 2 },
      h("summary", {},
        h("span", { class: "tree-name" }, `${child.name}/`),
        h("span", { class: "muted small" }, ` ${plural(child.count, "change")} · ${size_change(child.net)}`),
        child.own && h("span", { class: "muted small" }, ` · folder ${child.own.kind === "metadata" ? child.own.details.join(", ") : child.own.kind}`)),
      h("div", { class: "tree-children" }, ...draw(child, depth + 1)),
    )),
    ...folder.files.sort((a, b) => a.path.localeCompare(b.path)).map((change) => h("div", { class: "tree-file" },
      h("span", { class: `badge tone-${change_tones[change.kind]}` }, change.kind),
      h("span", { class: "tree-name" }, change.path.slice(change.path.lastIndexOf("/") + 1)),
      h("span", { class: "muted small" }, ` ${change_size(change)}${change.details.length > 0 ? ` · ${change.details.join(", ")}` : ""}`),
    )),
  ];
  return h("div", { class: "tree" }, ...draw(root, 0));
}

// ── Files ────────────────────────────────────────────────────────────────────

function files_tab(body: HTMLElement, base: string, archive: string, restore_dir: string, target: ActionTarget): void {
  // Each picked path, and whether it is a folder, which decides how it downloads.
  const picked = new Map<string, boolean>();
  const holder = h("div");
  const restore = h("button", { class: "accent solid", disabled: true, onclick: () => restore_picked(target, archive, [...picked.keys()], restore_dir) }, "Restore picked");
  const download = h("a", { class: "button", download: true, "aria-disabled": "true" }, "Download picked");
  const status = h("span", { class: "muted small", role: "status" }, "Nothing picked.");
  const on_pick = () => {
    restore.disabled = picked.size === 0;
    download.setAttribute("aria-disabled", String(picked.size === 0));
    // One file downloads as itself; anything else comes as one tar.gz.
    const [only_folder] = picked.values();
    if (picked.size === 0) download.removeAttribute("href");
    else download.href = download_link(base, archive, [...picked.keys()], picked.size === 1 && !only_folder ? "file" : "tar");
    status.textContent = picked.size === 0 ? "Nothing picked." : `${plural(picked.size, "item")} picked.`;
  };

  const open = (path: string) => {
    replace_query({ path: path || null });
    void load(holder, async () => folder_view(await api<Listing>(`${base}/browse${query({ archive, path })}`), base, archive, path, picked, open, on_pick));
  };

  const files = h("div", {},
    h("div", { class: "toolbar" }, restore, download, status),
    h("p", { class: "muted small" }, "Restoring extracts on the repository's host into a folder you choose; it never writes over files already there."),
    h("p", { class: "muted small" },
      "Downloads stream straight from borg to your browser; a folder or several picks come as one tar.gz. ",
      "While one runs it holds the repository's lock, so a backup that starts meanwhile waits for it, and fails if it waits past its lock wait. ",
      "Running downloads show on the repository's Overview tab, where they can be stopped."),
    holder,
  );
  // A download is refused while a run is going, and the browser would save that refusal as a file, so it is checked first.
  files.addEventListener("click", async (event) => {
    const anchor = (event.target as HTMLElement).closest<HTMLAnchorElement>("a[download]");
    if (!anchor?.href || anchor.dataset.checked === "yes") return;
    event.preventDefault();
    const repository = await api<RepositoryDetail>(base).catch(() => null);
    if (repository?.running_run) {
      toast(`A ${repository.running_run.kind} is running on ${repository.name}; download once it ends.`, { tone: "warn" });
      return;
    }
    anchor.dataset.checked = "yes";
    anchor.click();
    delete anchor.dataset.checked;
  });
  body.replaceChildren(section("Files", files));
  open(current_route().query.get("path") ?? "");
}

// A plain link the browser saves to disk as borg sends it, never held in the page's memory.
function download_link(base: string, archive: string, paths: string[], kind: "file" | "tar"): string {
  const params = new URLSearchParams({ archive, kind });
  for (const path of paths) params.append("path", path);
  return `${base}/download?${params}`;
}

function folder_view(listing: Listing, base: string, archive: string, path: string, picked: Map<string, boolean>, open: (path: string) => void, on_pick: () => void): HTMLElement {
  let text = "";
  const parts = path.split("/").filter(Boolean);
  const rows_holder = h("div");
  const render = () => {
    const needle = text.trim().toLowerCase();
    const rows = listing.rows.filter((row) => !needle || row.name.toLowerCase().includes(needle));
    if (listing.rows.length === 0) {
      rows_holder.replaceChildren(empty("This folder is empty."));
      return;
    }
    rows_holder.replaceChildren(data_table([
      {
        label: "Pick", cell: (row) => h("input", {
          type: "checkbox", checked: picked.has(row.path), "aria-label": `Pick ${row.name}`,
          onchange: (event: Event) => {
            if ((event.target as HTMLInputElement).checked) picked.set(row.path, row.dir);
            else picked.delete(row.path);
            on_pick();
          },
        }),
      },
      { label: "Name", cell: (row) => row.dir ? h("button", { class: "link", onclick: () => open(row.path) }, `${row.name}/`) : row.name },
      { label: "Size", class: "number", cell: (row) => row.size },
      { label: "Modified", cell: (row) => row.mtime },
      {
        label: "Download", cell: (row) => h("a", {
          href: download_link(base, archive, [row.path], row.dir ? "tar" : "file"), download: true, "aria-label": `Download ${row.name}`,
        }, row.dir ? "tar.gz" : "Download"),
      },
    ], rows, { caption: `Contents of ${path || "the archive"}` }));
  };
  render();
  return h("div", {},
    h("nav", { class: "crumbs", "aria-label": "Folder" },
      h("button", { class: "link", onclick: () => open("") }, archive),
      ...parts.map((part, index) => [h("span", { class: "muted" }, " / "), h("button", { class: "link", onclick: () => open(parts.slice(0, index + 1).join("/")) }, part)]),
    ),
    listing.success ? null : h("pre", { class: "output tone-bad" }, listing.content ?? ""),
    toolbar(search_box("Filter this folder", "", (value) => { text = value; render(); })),
    rows_holder,
    listing.more ? h("p", { class: "muted small" }, "Only the first entries are shown; raise browse_limit in the repository's config for more.") : null,
  );
}

// Asks where on the host to restore: a new dated folder inside the chosen one, or the chosen one itself if it is empty.
function restore_picked(target: ActionTarget, archive: string, paths: string[], restore_dir: string): void {
  const folder = h("input", { type: "text", value: restore_dir, "aria-label": "Folder on the host", autocomplete: "off" });
  const fresh = h("input", { type: "radio", name: "restore-into", checked: true });
  const direct = h("input", { type: "radio", name: "restore-into" });
  const where = h("p", { class: "muted small", role: "status" });
  const describe = () => {
    const base = folder.value.trim().replace(/\/+$/, "") || restore_dir;
    where.textContent = fresh.checked
      ? `Into ${base}/${archive}-<date and time>, a new folder.`
      : `Into ${base} itself, which must be empty or not exist yet; the restore stops before writing if it holds anything.`;
  };
  folder.addEventListener("input", describe);
  fresh.addEventListener("change", describe);
  direct.addEventListener("change", describe);
  describe();
  confirm_dialog({
    title: `Restore ${plural(paths.length, "item")}?`,
    message: h("div", {},
      h("p", {}, `This extracts from ${archive} on ${target.repository_name}'s host. It never writes over files already there.`),
      h("ul", { class: "paths" }, ...paths.slice(0, 10).map((path) => h("li", {}, h("code", {}, path)))),
      paths.length > 10 && h("p", { class: "muted" }, `and ${paths.length - 10} more`),
      h("label", { class: "field restore-folder" }, h("span", { class: "field-label" }, "Folder on the host"), folder),
      h("div", { class: "choice-stack", role: "radiogroup", "aria-label": "Restore into" },
        h("label", { class: "check" }, fresh, " A new dated folder inside it"),
        h("label", { class: "check" }, direct, " This folder itself")),
      where),
    confirm_label: "Restore",
    busy_label: "Starting…",
    run: () => run_action(target, "restore_archive", "Restore", { archive, paths, target: folder.value.trim(), fresh: fresh.checked }),
  });
}
