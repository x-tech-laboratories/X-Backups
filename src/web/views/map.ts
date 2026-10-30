// The Overview's map of the backup flow in three columns: each host's folders on the left, the jobs that back them up in
// the middle, and the repositories they write to on the right, under the hosts that store them; every box opens its page.

import { api, type BackupMap, type Change, type MapTarget } from "../api.ts";
import { age, h } from "../dom.ts";
import { link } from "../router.ts";
import { attempt, empty, section, skeleton } from "../ui.ts";
import { touches } from "./shared.ts";

// ── Layout ───────────────────────────────────────────────────────────────────

const host_width = 300;
const job_width = 240;
// The room between columns that the lines cross.
const corridor = 150;
const padding = 12;
const heading_height = 30;
const host_head = 34;
const host_gap = 16;
const source_height = 28;
const job_height = 46;
const repository_height = 58;
const node_gap = 8;

type Tone = "running" | "ok" | "warning" | "critical";

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Node {
  id: string;
  box: Box;
  // The targets that pass through it, which hovering lights.
  targets: number[];
}

interface Placed {
  hosts: { name: string; id: string; box: Box }[];
  sources: Map<string, Node & { path: string }>;
  jobs: Map<string, Node>;
  repositories: Map<string, Node & { path: string; stored_on: string }>;
  columns: number[];
  width: number;
  height: number;
}

// Each column is ordered by where its boxes' lines come from, so the lines mostly run straight across.
function place(map: BackupMap): Placed {
  const host_name = new Map(map.hosts.map((host) => [host.id, host.name]));
  const by_name = (left: string, right: string) => (host_name.get(left) ?? left).localeCompare(host_name.get(right) ?? right);
  const mean = (values: number[]) => values.length === 0 ? Infinity : values.reduce((sum, value) => sum + value, 0) / values.length;
  const targets_where = (test: (target: MapTarget) => boolean) => map.targets.flatMap((target, index) => test(target) ? [index] : []);

  // Jobs first follow the folders in host order, then the hosts and their folders follow the jobs, and the jobs again.
  let source_hosts = [...new Set(map.sources.map((source) => source.host))].sort(by_name);
  let source_order = source_hosts.flatMap((host) => map.sources.filter((source) => source.host === host));
  const order_jobs = () => {
    const source_rank = new Map(source_order.map((source, index) => [source.id, index]));
    return [...map.jobs].sort((left, right) =>
      mean(left.sources.map((id) => source_rank.get(id)!)) - mean(right.sources.map((id) => source_rank.get(id)!)) || left.id.localeCompare(right.id));
  };
  let job_rank = new Map(order_jobs().map((job, index) => [job.id, index]));
  const source_feeds = new Map(map.sources.map((source) => [source.id,
    mean(map.jobs.filter((job) => job.sources.includes(source.id)).map((job) => job_rank.get(job.id)!))]));
  const host_feeds = (host: string) => mean(map.sources.filter((source) => source.host === host).map((source) => source_feeds.get(source.id)!).filter(Number.isFinite));
  source_hosts = source_hosts.sort((left, right) => host_feeds(left) - host_feeds(right) || by_name(left, right));
  source_order = source_hosts.flatMap((host) => map.sources.filter((source) => source.host === host)
    .sort((left, right) => source_feeds.get(left.id)! - source_feeds.get(right.id)! || left.path.localeCompare(right.path)));
  const jobs = order_jobs();
  job_rank = new Map(jobs.map((job, index) => [job.id, index]));
  // A repository only watched has no job and sinks to the bottom.
  const repository_rank = new Map(map.repositories.map((repository) => [repository.id,
    mean(map.targets.filter((target) => target.repository === repository.id && target.job !== null).map((target) => job_rank.get(target.job!)!))]));
  const repositories = [...map.repositories].sort((left, right) => repository_rank.get(left.id)! - repository_rank.get(right.id)! || left.id.localeCompare(right.id));
  const repository_hosts = [...new Set(repositories.map((repository) => repository.stored_on))]
    .sort((left, right) => mean(repositories.filter((item) => item.stored_on === left).map((item) => repository_rank.get(item.id)!).filter(Number.isFinite))
      - mean(repositories.filter((item) => item.stored_on === right).map((item) => repository_rank.get(item.id)!).filter(Number.isFinite)) || by_name(left, right));

  const columns = [padding, padding + host_width + corridor, padding + host_width + corridor + job_width + corridor];
  const top = padding + heading_height;
  const hosts: Placed["hosts"] = [];
  // Stacks host boxes down a column, each holding its own boxes.
  const stack = <T,>(x: number, host_ids: string[], items_of: (host: string) => T[], height: number, put: (item: T, box: Box) => void) => {
    let y = top;
    for (const host of host_ids) {
      const start = y;
      y += host_head;
      for (const item of items_of(host)) {
        put(item, { x: x + padding, y, width: host_width - 2 * padding, height });
        y += height + node_gap;
      }
      y += padding - node_gap;
      hosts.push({ id: host, name: host_name.get(host) ?? host, box: { x, y: start, width: host_width, height: y - start } });
      y += host_gap;
    }
    return y - host_gap;
  };

  const sources: Placed["sources"] = new Map();
  const left_bottom = stack(columns[0], source_hosts, (host) => source_order.filter((source) => source.host === host), source_height, (source, box) =>
    sources.set(source.id, { id: source.id, path: source.path, box, targets: targets_where((target) => target.sources.includes(source.id)) }));
  const repository_nodes: Placed["repositories"] = new Map();
  const right_bottom = stack(columns[2], repository_hosts, (host) => repositories.filter((repository) => repository.stored_on === host), repository_height, (repository, box) =>
    repository_nodes.set(repository.id, { ...repository, box, targets: targets_where((target) => target.repository === repository.id) }));

  // The jobs sit in the middle of the height the hosts take.
  const bottom = Math.max(left_bottom, right_bottom, top);
  const jobs_height = jobs.length * (job_height + node_gap) - node_gap;
  let y = top + Math.max(0, (bottom - top - jobs_height) / 2);
  const job_nodes: Placed["jobs"] = new Map();
  for (const job of jobs) {
    job_nodes.set(job.id, { id: job.id, box: { x: columns[1], y, width: job_width, height: job_height }, targets: targets_where((target) => target.job === job.id) });
    y += job_height + node_gap;
  }

  return {
    hosts,
    sources,
    jobs: job_nodes,
    repositories: repository_nodes,
    columns,
    width: columns[2] + host_width + padding,
    height: Math.max(bottom, y - node_gap) + padding,
  };
}

// A curve from one box's right side to the next column's box's left side.
function flow_path(from: Box, from_y: number, to: Box, to_y: number): string {
  const [x1, x2] = [from.x + from.width, to.x];
  const bend = (x2 - x1) / 2;
  return `M${x1},${from_y}C${x1 + bend},${from_y} ${x2 - bend},${to_y} ${x2},${to_y}`;
}

// Where each line meets a box's side, spread along it in the order of the boxes at their other ends so they never cross there.
function ports(lines: { key: string; at: string; other_y: number }[], box_of: (id: string) => Box): Map<string, number> {
  const out = new Map<string, number>();
  const by_box = new Map<string, typeof lines>();
  for (const line of lines) by_box.set(line.at, [...by_box.get(line.at) ?? [], line]);
  for (const [at, group] of by_box) {
    const box = box_of(at);
    group.sort((left, right) => left.other_y - right.other_y)
      .forEach((line, index) => out.set(line.key, box.y + box.height * (index + 1) / (group.length + 1)));
  }
  return out;
}

// ── Drawing ──────────────────────────────────────────────────────────────────

function draw(map: BackupMap, view_box: { current: Box | null }): { figure: HTMLElement; fit: () => void; zoom: (factor: number) => void } {
  const placed = place(map);
  const whole: Box = { x: 0, y: 0, width: placed.width, height: placed.height };
  const drawing = svg("svg", { class: "flow-map", role: "img", "aria-label": "Which folders each job backs up, and the repositories it writes them to" });
  const lines = svg("g", { class: "flows" });
  const boxes = svg("g", {});
  const tones = map.targets.map(tone_of);
  const worst = (indexes: number[]): Tone => indexes.map((index) => tones[index]).sort((left, right) => tone_rank[right] - tone_rank[left])[0] ?? "ok";
  const lit_by = (indexes: number[]) => ({ "data-targets": indexes.join(" ") });
  const host_of = (id: string) => placed.hosts.find((host) => host.id === id)?.name ?? id;

  for (const [index, title] of ["Sources", "Jobs", "Repositories"].entries()) {
    boxes.append(text("map-group", placed.columns[index], padding + 14, title));
  }

  for (const host of placed.hosts) {
    boxes.append(svg("rect", { class: "map-host", x: host.box.x, y: host.box.y, width: host.box.width, height: host.box.height, rx: 10 }));
    // A configured host's name opens its page.
    const host_page = map.links?.hosts[host.id];
    const name = text("map-host-name", host.box.x + padding, host.box.y + 22, host.name);
    boxes.append(host_page ? svg("a", { href: link(["hosts", host_page]) }, name, svg("title", {}, `${host_page}: open its page`)) : name);
  }

  for (const [id, source] of placed.sources) {
    const { box } = source;
    // A folder of a configured source opens the source's page.
    const source_page = map.links?.sources[id];
    boxes.append(svg(source_page ? "a" : "g", { class: "map-node map-source", ...lit_by(source.targets), ...(source_page ? { href: link(["sources", source_page]) } : { tabindex: 0 }) },
      svg("rect", { x: box.x, y: box.y, width: box.width, height: box.height, rx: 6 }),
      text("map-path", box.x + 10, box.y + 18, clip(source.path, box.width - 20, 7.4)),
      svg("title", {}, source_page ? `${source.path}, in the source ${source_page}` : source.path)));
  }

  for (const [id, job] of placed.jobs) {
    const { box } = job;
    const folders = new Set(job.targets.flatMap((index) => map.targets[index].sources)).size;
    const writes_to = new Set(job.targets.map((index) => map.targets[index].repository)).size;
    const detail = `${folders} ${folders === 1 ? "folder" : "folders"} → ${writes_to} ${writes_to === 1 ? "repository" : "repositories"}`;
    const page = map.links?.jobs.includes(id);
    boxes.append(svg(page ? "a" : "g", { class: `map-node map-job map-tone-${worst(job.targets)}`, ...lit_by(job.targets), ...(page ? { href: link(["jobs", id]) } : { tabindex: 0 }) },
      svg("rect", { x: box.x, y: box.y, width: box.width, height: box.height, rx: 6 }),
      svg("circle", { class: "map-dot", cx: box.x + 14, cy: box.y + 17, r: 4 }),
      text("map-name", box.x + 24, box.y + 21, clip(id, box.width - 34, 7.8)),
      text("map-detail", box.x + 10, box.y + 37, clip(detail, box.width - 20)),
      svg("title", {}, `${id}\n${detail}`)));
  }

  for (const [id, repository] of placed.repositories) {
    const { box } = repository;
    const written = repository.targets.filter((index) => map.targets[index].job !== null);
    const last = Math.max(...repository.targets.map((index) => map.targets[index].last_backup_epoch ?? -Infinity));
    const detail = written.length === 0 ? `watched only · last backup ${age(Number.isFinite(last) ? last : null)}` : `last backup ${age(Number.isFinite(last) ? last : null)}`;
    const reasons = repository.targets.flatMap((index) => map.targets[index].reasons.map((reason) => reason.text));
    boxes.append(svg("a", { class: `map-node map-repository map-tone-${worst(repository.targets)}`, href: link(["repositories", map.targets[repository.targets[0]].id]), ...lit_by(repository.targets) },
      svg("rect", { x: box.x, y: box.y, width: box.width, height: box.height, rx: 6 }),
      svg("circle", { class: "map-dot", cx: box.x + 14, cy: box.y + 17, r: 4 }),
      text("map-name", box.x + 24, box.y + 21, clip(id, box.width - 34, 7.8)),
      text("map-path", box.x + 10, box.y + 37, clip(repository.path, box.width - 20, 7.4)),
      text("map-detail", box.x + 10, box.y + 51, clip(detail, box.width - 20)),
      svg("title", {}, [id, `${repository.path} on ${host_of(repository.stored_on)}`, detail, ...new Set(reasons)].join("\n"))));
  }

  // One line from each folder to each job that backs it up, and one from each job to each repository it writes to.
  const centre = (box: Box) => box.y + box.height / 2;
  const feeds = [...placed.jobs.values()].flatMap((job) => [...new Set(job.targets.flatMap((index) => map.targets[index].sources))]
    .map((source) => ({ source, job: job.id, targets: job.targets.filter((index) => map.targets[index].sources.includes(source)) })));
  const writes = [...placed.jobs.values()].flatMap((job) => [...new Set(job.targets.map((index) => map.targets[index].repository))]
    .map((repository) => ({ job: job.id, repository, targets: job.targets.filter((index) => map.targets[index].repository === repository) })));
  const source_box = (id: string) => placed.sources.get(id)!.box;
  const job_box = (id: string) => placed.jobs.get(id)!.box;
  const repository_box = (id: string) => placed.repositories.get(id)!.box;
  const feed_out = ports(feeds.map((feed) => ({ key: `${feed.source}>${feed.job}`, at: feed.source, other_y: centre(job_box(feed.job)) })), source_box);
  const feed_in = ports(feeds.map((feed) => ({ key: `${feed.source}>${feed.job}`, at: feed.job, other_y: centre(source_box(feed.source)) })), job_box);
  const write_out = ports(writes.map((write) => ({ key: `${write.job}>${write.repository}`, at: write.job, other_y: centre(repository_box(write.repository)) })), job_box);
  const write_in = ports(writes.map((write) => ({ key: `${write.job}>${write.repository}`, at: write.repository, other_y: centre(job_box(write.job)) })), repository_box);

  for (const feed of feeds) {
    const key = `${feed.source}>${feed.job}`;
    const source = placed.sources.get(feed.source)!;
    lines.append(svg("path", { class: `flow map-tone-${worst(feed.targets)}`, d: flow_path(source.box, feed_out.get(key)!, job_box(feed.job), feed_in.get(key)!), ...lit_by(feed.targets) },
      svg("title", {}, `${host_of(feed.source.split(":")[0])} ${source.path} → ${feed.job}`)));
  }
  for (const write of writes) {
    const key = `${write.job}>${write.repository}`;
    const retention = [...new Set(write.targets.map((index) => keeps(map.targets[index].retention)).filter(Boolean))];
    const stored_on = host_of(placed.repositories.get(write.repository)!.stored_on);
    lines.append(svg("path", { class: `flow map-tone-${worst(write.targets)}`, d: flow_path(job_box(write.job), write_out.get(key)!, repository_box(write.repository), write_in.get(key)!), ...lit_by(write.targets) },
      svg("title", {}, `${write.job} → ${write.repository} on ${stored_on}${retention.length > 0 ? `, keeps ${retention.join(" / ")}` : ""}`)));
  }

  drawing.append(lines, boxes);
  highlight_on_hover(drawing);
  const set_view = (box: Box) => {
    view_box.current = box;
    drawing.setAttribute("viewBox", `${box.x} ${box.y} ${box.width} ${box.height}`);
  };
  // A redraw after a change keeps the reader's zoom.
  set_view(view_box.current ?? whole);
  const zoom = (factor: number, centre?: { x: number; y: number }) => {
    const box = view_box.current!;
    const width = Math.min(whole.width * 2, Math.max(whole.width / 8, box.width * factor));
    const height = width * box.height / box.width;
    const point = centre ?? { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    set_view({ x: point.x - (point.x - box.x) * width / box.width, y: point.y - (point.y - box.y) * height / box.height, width, height });
  };
  pan_and_zoom(drawing, () => view_box.current!, set_view, zoom);

  const figure = h("figure", { class: "chart flow-map-frame" }, drawing);
  return { figure, fit: () => set_view(whole), zoom };
}

// Lights every line and box that shares a target with whatever the pointer or focus is on, which follows a folder through
// its jobs to the repositories it lands in, and back; the rest dims.
function highlight_on_hover(drawing: SVGElement): void {
  const light = (target: Element | null) => {
    for (const lit of drawing.querySelectorAll(".lit")) lit.classList.remove("lit");
    const node = target?.closest<SVGElement>(".map-node");
    drawing.classList.toggle("focused", node !== null && node !== undefined);
    if (!node) return;
    const targets = new Set(targets_of(node));
    for (const item of drawing.querySelectorAll<SVGElement>("[data-targets]")) {
      if (item === node || targets_of(item).some((index) => targets.has(index))) item.classList.add("lit");
    }
  };
  drawing.addEventListener("pointerover", (event) => light(event.target as Element));
  drawing.addEventListener("pointerleave", () => light(null));
  drawing.addEventListener("focusin", (event) => light(event.target as Element));
  drawing.addEventListener("focusout", () => light(null));
}

function targets_of(element: SVGElement): string[] {
  return (element.dataset.targets ?? "").split(" ").filter(Boolean);
}

// Dragging pans and Ctrl or ⌘ with the wheel zooms about the pointer; a drag never counts as a click on a repository.
function pan_and_zoom(drawing: SVGElement, view: () => Box, set_view: (box: Box) => void, zoom: (factor: number, centre: { x: number; y: number }) => void): void {
  const to_map = (event: { clientX: number; clientY: number }) => {
    const bounds = drawing.getBoundingClientRect();
    const box = view();
    return { x: box.x + (event.clientX - bounds.left) / bounds.width * box.width, y: box.y + (event.clientY - bounds.top) / bounds.height * box.height };
  };
  drawing.addEventListener("wheel", (event) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    zoom(Math.exp(event.deltaY * 0.002), to_map(event));
  }, { passive: false });

  let start: { x: number; y: number; box: Box } | null = null;
  let dragged = false;
  drawing.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    start = { x: event.clientX, y: event.clientY, box: view() };
    dragged = false;
  });
  drawing.addEventListener("pointermove", (event) => {
    if (!start) return;
    const [dx, dy] = [event.clientX - start.x, event.clientY - start.y];
    if (!dragged && Math.hypot(dx, dy) < 4) return;
    if (!dragged) drawing.setPointerCapture(event.pointerId);
    dragged = true;
    drawing.classList.add("panning");
    const bounds = drawing.getBoundingClientRect();
    set_view({ ...start.box, x: start.box.x - dx / bounds.width * start.box.width, y: start.box.y - dy / bounds.height * start.box.height });
  });
  const stop = () => {
    start = null;
    drawing.classList.remove("panning");
  };
  drawing.addEventListener("pointerup", stop);
  drawing.addEventListener("pointercancel", stop);
  drawing.addEventListener("click", (event) => {
    if (!dragged) return;
    event.preventDefault();
    dragged = false;
  }, true);
}

// ── Pieces ───────────────────────────────────────────────────────────────────

const tone_rank: Record<Tone, number> = { ok: 0, running: 1, warning: 2, critical: 3 };

function tone_of(target: MapTarget): Tone {
  return target.running_run ? "running" : target.level;
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

// Shortens a label to about the width it has, since SVG text never wraps or ellipsises.
function clip(label: string, width: number, char_width = 6.2): string {
  const room = Math.floor(width / char_width);
  return label.length <= room ? label : `${label.slice(0, Math.max(1, room - 1))}…`;
}

function text(class_name: string, x: number, y: number, content: string): SVGElement {
  return svg("text", { class: class_name, x, y }, content);
}

function svg(tag: string, attributes: Record<string, string | number>, ...children: (SVGElement | string)[]): SVGElement {
  const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
  element.append(...children);
  return element;
}

// ── Section ──────────────────────────────────────────────────────────────────

export function map_section(): { root: HTMLElement; update: (changes: Change[] | null) => Promise<void> } {
  const body = h("div", {}, skeleton(6));
  const view_box: { current: Box | null } = { current: null };
  let controls: ReturnType<typeof draw> | null = null;
  let drawn = "";

  const tools = h("div", { class: "segmented", role: "group", "aria-label": "Zoom" },
    h("button", { type: "button", "aria-label": "Zoom out", onclick: () => controls?.zoom(1.25) }, "−"),
    h("button", { type: "button", "aria-label": "Zoom in", onclick: () => controls?.zoom(0.8) }, "+"),
    h("button", { type: "button", onclick: () => controls?.fit() }, "Fit"));

  const update = async (quiet: boolean): Promise<void> => {
    const map = await attempt(body, quiet, () => api<BackupMap>("/api/map"), () => void update(false));
    if (map === null) return;
    // A refresh that changes nothing leaves the drawing, and whatever is lit, alone.
    const snapshot = JSON.stringify(map);
    if (snapshot === drawn) return;
    drawn = snapshot;
    if (map.targets.length === 0) {
      controls = null;
      body.replaceChildren(empty("No repositories yet.", "Repositories appear here once they are configured."));
      return;
    }
    controls = draw(map, view_box);
    body.replaceChildren(
      controls.figure,
      h("p", { class: "muted small flow-map-legend" },
        ...(["ok", "warning", "critical", "running"] as const).map((tone) => h("span", { class: `legend map-swatch-${tone}` }, tone === "ok" ? "OK" : tone.charAt(0).toUpperCase() + tone.slice(1))),
        h("span", {}, "Drag to pan, Ctrl or ⌘ and scroll to zoom. Hover a box to follow its lines."),
      ),
    );
  };
  void update(false);

  return {
    root: section("What is backed up where", body, tools),
    update: async (changes) => {
      if (touches(changes, null, ["repository", "run", "config"])) await update(true);
    },
  };
}
