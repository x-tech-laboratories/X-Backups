// One archive: its numbers against the one before it, what changed since then, and its files to browse and restore.

import { Badge, type Tone } from "@x-tech-laboratories/x-libs/web/preact/badges";
import { SearchBox, Select } from "@x-tech-laboratories/x-libs/web/preact/controls";
import { confirm_dialog } from "@x-tech-laboratories/x-libs/web/preact/dialog";
import { Crumbs, Facts, Section, Stepper, Tabs, Toolbar } from "@x-tech-laboratories/x-libs/web/preact/layout";
import { Empty, Failure, Loaded, Skeleton, use_resource } from "@x-tech-laboratories/x-libs/web/preact/states";
import { DataTable, Pager, type Sorting } from "@x-tech-laboratories/x-libs/web/preact/table";
import { toast } from "@x-tech-laboratories/x-libs/web/preact/toasts";
import { age, count_change, plural, size, size_change, stamp } from "@x-tech-laboratories/x-libs/web/format";
import { current_route, link, replace_query } from "@x-tech-laboratories/x-libs/web/router";
import { sorting_from } from "@x-tech-laboratories/x-libs/web/tables";
import { Fragment } from "preact";
import { useState } from "preact/hooks";
import { run_action, type ActionTarget } from "../actions.tsx";
import { api, query, repository_path, type Archive, type BrowserRow, type Diff, type DiffChange, type Listing, type RepositoryDetail } from "../api.ts";
import { can } from "../session.ts";
import { use_changes } from "../ui.tsx";
import { delete_archive } from "./repository.tsx";
import { touches } from "./shared.tsx";

const change_page_size = 200;

// ── Page ─────────────────────────────────────────────────────────────────────

export function ArchiveView({ id, name }: { id: string; name: string }) {
  const base = repository_path(id);
  const [tab] = useState(() => current_route().query.get("tab") === "files" ? "files" : "changes");
  const detail = use_resource(() => api<RepositoryDetail>(base), [base]);
  use_changes((changes) => { if (touches(changes, id, ["repository"])) detail.reload(true); });

  const repository = detail.data;
  const index = repository ? repository.archives.findIndex((archive) => archive.name === name) : -1;
  const archive = repository && index !== -1 ? repository.archives[index] : null;
  const older = repository && index !== -1 ? repository.archives[index + 1] ?? null : null;
  const target: ActionTarget = { target_id: id, repository_name: repository?.name ?? id, done: () => detail.reload(true) };

  // The tabs load once; a later change to the repository only refreshes the header's numbers.
  const body = () => {
    if (repository === null) return <Skeleton lines={6} />;
    if (archive === null) return null;
    // What is inside an archive is backed-up data, which the server shows only to operators.
    if (!can("operator")) return <Empty title="Reading what is inside an archive needs the operator role." hint="An admin can change your role on the Users page." />;
    if (tab === "files") return <FilesTab base={base} archive={archive.name} restore_dir={repository.restore_dir} target={target} />;
    return <ChangesTab base={base} archive={archive.name} older={older} />;
  };

  return (
    <div class="page">
      <Crumbs items={[["Repositories", link(["repositories"])], [id, link(["repositories", id])], ["Archives", link(["repositories", id, "archives"])], [name, null]]} />
      <div>
        <Loaded resource={detail} lines={3}>
          {(loaded) => index === -1
            ? <Empty title={`${name} is not in ${loaded.name}'s archive list.`} hint={<a href={link(["repositories", id, "archives"])}>Back to the archives</a>} />
            : <ArchiveHeader repository={loaded} index={index} tab={tab} target={target} />}
        </Loaded>
      </div>
      <Tabs active={tab} items={[
        { id: "changes", label: "Changes", href: link(["repositories", id, "archives", name], { tab: "changes" }) },
        { id: "files", label: "Files", href: link(["repositories", id, "archives", name], { tab: "files" }) },
      ]} />
      <div class="stack">{body()}</div>
    </div>
  );
}

// ── Header ───────────────────────────────────────────────────────────────────

function ArchiveHeader({ repository, index, tab, target }: { repository: RepositoryDetail; index: number; tab: string; target: ActionTarget }) {
  const archive = repository.archives[index];
  const older = repository.archives[index + 1] ?? null;
  const newer = repository.archives[index - 1] ?? null;
  const step = (other: Archive | null, text: string) => ({ text, href: other ? link(["repositories", repository.id, "archives", other.name], { tab }) : null });
  const delta = (now: number | undefined, before: number | undefined, format: (value: number) => string) =>
    now === undefined || before === undefined ? null : <span class="muted small">{` (${format(now - before)} since the one before)`}</span>;
  return (
    <header class="page-head">
      <div class="page-title"><h1>{archive.name}</h1></div>
      <Stepper label="Step through archives" previous={step(older, "← Older")} position={`${repository.archives.length - index} of ${repository.archives.length}`} next={step(newer, "Newer →")} />
      <Facts rows={[
        ["Created", <span title={stamp(archive.epoch)}>{`${stamp(archive.epoch)} (${age(archive.epoch)})`}</span>],
        ["Original", <>{size(archive.original)}{delta(archive.original, older?.original, size_change)}</>],
        ["New data", <span title="Data no other archive shares, which deleting this archive would free">{size(archive.deduplicated)}</span>],
        ["Files", <>{archive.nfiles?.toLocaleString() ?? "—"}{delta(archive.nfiles, older?.nfiles, count_change)}</>],
      ]} />
      {can("operator") && repository.allow_delete && (
        <div class="head-actions">
          <button class="danger" onClick={() => delete_archive(target, archive.name, () => { location.hash = link(["repositories", repository.id, "archives"]); })}>Delete archive</button>
        </div>
      )}
    </header>
  );
}

// ── Changes ──────────────────────────────────────────────────────────────────

const change_tones: Record<DiffChange["kind"], Tone> = { added: "good", removed: "bad", modified: "info", metadata: "none", other: "none" };

function ChangesTab({ base, archive, older }: { base: string; archive: string; older: Archive | null }) {
  const diff = use_resource(async () => older === null ? null : api<Diff>(`${base}/diff${query({ archive })}`), [base, archive, older?.name]);
  if (older === null) {
    return <Section title="Changes"><Empty title="This is the oldest listed archive." hint="There is nothing before it to compare against." /></Section>;
  }
  return (
    <Section title={`Changes since ${older.name}`}>
      <div>
        {diff.data
          ? diff.data.success ? <ChangesView diff={diff.data} /> : <pre class="output tone-bad">{diff.data.content ?? "The diff failed."}</pre>
          : diff.error !== null
            ? <Failure error={diff.error} retry={() => diff.reload()} />
            : <>
              <p class="muted" role="status">{`Comparing with ${older.name}… borg reads both archives' file lists, which can take a while.`}</p>
              <Skeleton lines={6} />
            </>}
      </div>
    </Section>
  );
}

function ChangesView({ diff }: { diff: Diff }) {
  const [text, set_text] = useState(() => current_route().query.get("q") ?? "");
  const [layout, set_layout] = useState<"flat" | "tree">(() => current_route().query.get("view") === "tree" ? "tree" : "flat");
  const [metadata, set_metadata] = useState(() => current_route().query.get("meta") === "1");
  const [page, set_page] = useState(1);
  const [sorting, set_sorting] = useState(() => sorting_from(current_route().query, { key: "Path", descending: false }));
  const counts = (kind: DiffChange["kind"]) => diff.changes.filter((change) => change.kind === kind);
  const added = counts("added");
  const removed = counts("removed");
  const modified = counts("modified");
  const total = (changes: DiffChange[], field: "added_bytes" | "removed_bytes") => changes.reduce((sum, change) => sum + change[field], 0);

  const list = () => {
    const needle = text.trim().toLowerCase();
    const shown = diff.changes.filter((change) => (metadata || change.kind !== "metadata") && (!needle || change.path.toLowerCase().includes(needle)));
    if (diff.changes.length === 0) return <Empty title="Nothing changed between these two archives." />;
    if (shown.length === 0) return <Empty title="No change matches." hint={metadata ? undefined : "Changes to times, modes and owners alone are hidden; tick the box to show them."} />;
    if (layout === "tree") return <ChangeTree changes={shown} />;
    const pages = Math.ceil(shown.length / change_page_size);
    const at = Math.min(page, pages);
    return <>
      <ChangesTable changes={shown} sorting={sorting} page={at} on_sort={(next) => {
        set_sorting(next);
        replace_query({ sort: next.key, dir: next.descending ? "desc" : null });
      }} />
      <Pager page={at} has_more={at < pages} go={set_page} />
    </>;
  };

  return (
    <div>
      <div class="change-summary">
        <Badge tone="good">{`${added.length.toLocaleString()} added · ${size_change(total(added, "added_bytes"))}`}</Badge>
        <Badge tone="info">{`${modified.length.toLocaleString()} modified · ${size_change(total(modified, "added_bytes") - total(modified, "removed_bytes"))}`}</Badge>
        <Badge tone="bad">{`${removed.length.toLocaleString()} removed · ${size_change(-total(removed, "removed_bytes"))}`}</Badge>
        <Badge tone="none">{`${counts("metadata").length.toLocaleString()} metadata only`}</Badge>
      </div>
      {diff.more && <p class="muted small">Only the first changes are shown; raise browse_limit in the repository's config for more.</p>}
      <Toolbar>
        <SearchBox label="Filter by path" value={text} on_input={(value) => { set_text(value); set_page(1); replace_query({ q: value }); }} />
        <Select<"flat" | "tree"> label="View" options={[["flat", "Flat list"], ["tree", "Folder tree"]]} value={layout} on_change={(value) => { set_layout(value); replace_query({ view: value === "flat" ? null : value }); }} />
        <label class="check">
          <input type="checkbox" checked={metadata} onChange={(event) => {
            const on = (event.currentTarget as HTMLInputElement).checked;
            set_metadata(on);
            replace_query({ meta: on ? "1" : null });
          }} />
          {" Show metadata-only changes"}
        </label>
      </Toolbar>
      <div>{list()}</div>
    </div>
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

function ChangesTable({ changes, sorting, on_sort, page }: { changes: DiffChange[]; sorting: Sorting; on_sort: (sorting: Sorting) => void; page: number }) {
  const order: Record<DiffChange["kind"], number> = { added: 0, modified: 1, removed: 2, metadata: 3, other: 4 };
  const sorted = [...changes].sort((left, right) => {
    const value = (change: DiffChange): string | number => sorting.key === "Change" ? order[change.kind] : sorting.key === "Size" ? net(change) : change.path;
    const [first, second] = [value(left), value(right)];
    const result = first === second ? left.path.localeCompare(right.path) : first < second ? -1 : 1;
    return sorting.descending ? -result : result;
  }).slice((page - 1) * change_page_size, page * change_page_size);
  return (
    <DataTable<DiffChange> rows={sorted} row_key={(change) => change.path} sorting={sorting} on_sort={on_sort} caption="Changed paths" columns={[
      { label: "Change", cell: (change) => <Badge tone={change_tones[change.kind]}>{change.kind}</Badge>, sort: () => 0 },
      { label: "Path", cell: (change) => <code class="path">{change.path}</code>, sort: () => 0 },
      { label: "Size", class: "number", cell: (change) => change_size(change), sort: () => 0 },
      { label: "Also", cell: (change) => change.details.join(", ") },
    ]} />
  );
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

// The changes as nested folders, each folder with how many changes it holds and its net size.
function folder_tree(changes: DiffChange[]): Folder {
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
  return root;
}

// Folders as collapsible rows holding their changed files.
function ChangeTree({ changes }: { changes: DiffChange[] }) {
  return <div class="tree"><FolderContents folder={folder_tree(changes)} depth={0} /></div>;
}

function FolderContents({ folder, depth }: { folder: Folder; depth: number }) {
  return <>
    {[...folder.folders.values()].sort((first, second) => first.name.localeCompare(second.name)).map((child) => (
      <details key={`folder-${child.name}`} class="tree-folder" open={depth < 2}>
        <summary>
          <span class="tree-name">{`${child.name}/`}</span>
          <span class="muted small">{` ${plural(child.count, "change")} · ${size_change(child.net)}`}</span>
          {child.own && <span class="muted small">{` · folder ${child.own.kind === "metadata" ? child.own.details.join(", ") : child.own.kind}`}</span>}
        </summary>
        <div class="tree-children"><FolderContents folder={child} depth={depth + 1} /></div>
      </details>
    ))}
    {folder.files.sort((first, second) => first.path.localeCompare(second.path)).map((change) => (
      <div key={`file-${change.path}`} class="tree-file">
        <Badge tone={change_tones[change.kind]}>{change.kind}</Badge>
        <span class="tree-name">{change.path.slice(change.path.lastIndexOf("/") + 1)}</span>
        <span class="muted small">{` ${change_size(change)}${change.details.length > 0 ? ` · ${change.details.join(", ")}` : ""}`}</span>
      </div>
    ))}
  </>;
}

// ── Files ────────────────────────────────────────────────────────────────────

interface FilesTabProps {
  base: string;
  archive: string;
  restore_dir: string;
  target: ActionTarget;
}

function FilesTab({ base, archive, restore_dir, target }: FilesTabProps) {
  // Each picked path, and whether it is a folder, which decides how it downloads.
  const [picked, set_picked] = useState<Map<string, boolean>>(() => new Map());
  const [path, set_path] = useState(() => current_route().query.get("path") ?? "");
  const listing = use_resource(() => api<Listing>(`${base}/browse${query({ archive, path })}`), [base, archive, path]);

  const open = (next: string) => {
    replace_query({ path: next || null });
    set_path(next);
  };
  const pick = (row: BrowserRow, on: boolean) => {
    const next = new Map(picked);
    if (on) next.set(row.path, row.dir);
    else next.delete(row.path);
    set_picked(next);
  };

  // One file downloads as itself; anything else comes as one tar.gz.
  const [only_folder] = picked.values();
  const download_href = picked.size === 0 ? undefined : download_link(base, archive, [...picked.keys()], picked.size === 1 && !only_folder ? "file" : "tar");

  // A download is refused while a run is going, and the browser would save that refusal as a file, so it is checked first.
  async function check_download(event: MouseEvent): Promise<void> {
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
  }

  return (
    <Section title="Files">
      <div onClick={(event) => void check_download(event)}>
        <div class="toolbar">
          <button class="accent solid" disabled={picked.size === 0} onClick={() => restore_picked(target, archive, [...picked.keys()], restore_dir)}>Restore picked</button>
          <a class="button" download href={download_href} aria-disabled={picked.size === 0 ? "true" : "false"}>Download picked</a>
          <span class="muted small" role="status">{picked.size === 0 ? "Nothing picked." : `${plural(picked.size, "item")} picked.`}</span>
        </div>
        <p class="muted small">Restoring extracts on the repository's host into a folder you choose; it never writes over files already there.</p>
        <p class="muted small">
          {"Downloads stream straight from borg to your browser; a folder or several picks come as one tar.gz. "}
          {"While one runs it holds the repository's lock, so a backup that starts meanwhile waits for it, and fails if it waits past its lock wait. "}
          {"Running downloads show on the repository's Overview tab, where they can be stopped."}
        </p>
        <div>
          <Loaded resource={listing}>
            {(folder) => <FolderView key={path} listing={folder} base={base} archive={archive} path={path} picked={picked} open={open} pick={pick} />}
          </Loaded>
        </div>
      </div>
    </Section>
  );
}

// A plain link the browser saves to disk as borg sends it, never held in the page's memory.
function download_link(base: string, archive: string, paths: string[], kind: "file" | "tar"): string {
  const params = new URLSearchParams({ archive, kind });
  for (const path of paths) params.append("path", path);
  return `${base}/download?${params}`;
}

interface FolderViewProps {
  listing: Listing;
  base: string;
  archive: string;
  path: string;
  picked: Map<string, boolean>;
  open: (path: string) => void;
  pick: (row: BrowserRow, on: boolean) => void;
}

function FolderView({ listing, base, archive, path, picked, open, pick }: FolderViewProps) {
  const [text, set_text] = useState("");
  const parts = path.split("/").filter(Boolean);
  const needle = text.trim().toLowerCase();
  const rows = listing.rows.filter((row) => !needle || row.name.toLowerCase().includes(needle));
  return (
    <div>
      <nav class="crumbs" aria-label="Folder">
        <button class="link" onClick={() => open("")}>{archive}</button>
        {parts.map((part, index) => (
          <Fragment key={index}>
            <span class="muted"> / </span>
            <button class="link" onClick={() => open(parts.slice(0, index + 1).join("/"))}>{part}</button>
          </Fragment>
        ))}
      </nav>
      {!listing.success && <pre class="output tone-bad">{listing.content ?? ""}</pre>}
      <Toolbar><SearchBox label="Filter this folder" value={text} on_input={set_text} /></Toolbar>
      <div>
        {listing.rows.length === 0 ? <Empty title="This folder is empty." /> : (
          <DataTable<BrowserRow> rows={rows} row_key={(row) => row.path} caption={`Contents of ${path || "the archive"}`} columns={[
            {
              label: "Pick", cell: (row) => <input type="checkbox" checked={picked.has(row.path)} aria-label={`Pick ${row.name}`}
                onChange={(event) => pick(row, (event.currentTarget as HTMLInputElement).checked)} />,
            },
            { label: "Name", cell: (row) => row.dir ? <button class="link" onClick={() => open(row.path)}>{`${row.name}/`}</button> : row.name },
            { label: "Size", class: "number", cell: (row) => row.size },
            { label: "Modified", cell: (row) => row.mtime },
            {
              label: "Download", cell: (row) => (
                <a href={download_link(base, archive, [row.path], row.dir ? "tar" : "file")} download aria-label={`Download ${row.name}`}>{row.dir ? "tar.gz" : "Download"}</a>
              ),
            },
          ]} />
        )}
      </div>
      {listing.more && <p class="muted small">Only the first entries are shown; raise browse_limit in the repository's config for more.</p>}
    </div>
  );
}

// ── Restore ──────────────────────────────────────────────────────────────────

interface RestoreChoice {
  folder: string;
  fresh: boolean;
}

// Asks where on the host to restore: a new dated folder inside the chosen one, or the chosen one itself if it is empty.
function restore_picked(target: ActionTarget, archive: string, paths: string[], restore_dir: string): void {
  const choice: RestoreChoice = { folder: restore_dir, fresh: true };
  confirm_dialog({
    title: `Restore ${plural(paths.length, "item")}?`,
    message: <div>
      <p>{`This extracts from ${archive} on ${target.repository_name}'s host. It never writes over files already there.`}</p>
      <ul class="paths">{paths.slice(0, 10).map((path) => <li key={path}><code>{path}</code></li>)}</ul>
      {paths.length > 10 && <p class="muted">{`and ${paths.length - 10} more`}</p>}
      <RestoreWhere choice={choice} archive={archive} restore_dir={restore_dir} />
    </div>,
    confirm_label: "Restore",
    busy_label: "Starting…",
    run: () => run_action(target, "restore_archive", "Restore", { archive, paths, target: choice.folder.trim(), fresh: choice.fresh }),
  });
}

// The folder and how to restore into it, kept in the choice the dialog's Restore reads.
function RestoreWhere({ choice, archive, restore_dir }: { choice: RestoreChoice; archive: string; restore_dir: string }) {
  const [folder, set_folder] = useState(choice.folder);
  const [fresh, set_fresh] = useState(choice.fresh);
  const base = folder.trim().replace(/\/+$/, "") || restore_dir;
  return <>
    <label class="field restore-folder">
      <span class="field-label">Folder on the host</span>
      <input type="text" value={folder} aria-label="Folder on the host" autocomplete="off" onInput={(event) => {
        choice.folder = (event.currentTarget as HTMLInputElement).value;
        set_folder(choice.folder);
      }} />
    </label>
    <div class="choice-stack" role="radiogroup" aria-label="Restore into">
      <label class="check"><input type="radio" name="restore-into" checked={fresh} onChange={() => { choice.fresh = true; set_fresh(true); }} /> A new dated folder inside it</label>
      <label class="check"><input type="radio" name="restore-into" checked={!fresh} onChange={() => { choice.fresh = false; set_fresh(false); }} /> This folder itself</label>
    </div>
    <p class="muted small" role="status">
      {fresh
        ? `Into ${base}/${archive}-<date and time>, a new folder.`
        : `Into ${base} itself, which must be empty or not exist yet; the restore stops before writing if it holds anything.`}
    </p>
  </>;
}
