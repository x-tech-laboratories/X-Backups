// Every host as a box holding the folders it backs up and the repositories it stores, with a line from each folder to each repository that takes it.

import { api, type BackupMap, type MapRepository } from "../api.ts";
import { age, h } from "../dom.ts";
import { link } from "../router.ts";
import { attempt, empty, section, skeleton } from "../ui.ts";
import { touches, type View } from "./shared.ts";

// ── Layout ───────────────────────────────────────────────────────────────────

const column_width = 300;
// The room between hosts that the lines cross.
const corridor = 110;
const padding = 12;
const host_head = 34;
const group_head = 22;
const source_height = 28;
const repository_height = 58;
const node_gap = 8;
// A line between two boxes in one host bows this far out past their right edges.
const loop_reach = 56;
// A line that passes a host runs in its own lane under the hosts, so it never seems to end at the host it passes.
const lane_gap = 8;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Placed {
  hosts: { id: string; name: string; box: Box }[];
  sources: Map<string, { path: string; box: Box; column: number }>;
  repositories: Map<string, { repository: MapRepository; box: Box; column: number }>;
  width: number;
  height: number;
}

// Hosts whose folders are backed up the most come first, so most lines run left to right.
function place(map: BackupMap): Placed {
  const sent = (host: string) => map.repositories.filter((repository) => repository.sources.some((source) => source.startsWith(`${host}:`))).length;
  const hosts = [...map.hosts].sort((left, right) => sent(right.id) - sent(left.id) || left.name.localeCompare(right.name));
  const column_of = new Map(hosts.map((host, index) => [host.id, index]));
  const source_column = (id: string) => column_of.get(map.sources.find((source) => source.id === id)?.host ?? "") ?? 0;

  const sources = new Map<string, { path: string; box: Box; column: number }>();
  const repositories = new Map<string, { repository: MapRepository; box: Box; column: number }>();
  const bottoms: number[] = [];
  hosts.forEach((host, column) => {
    const x = padding + column * (column_width + corridor);
    let y = padding + host_head;
    const own_sources = map.sources.filter((source) => source.host === host.id);
    if (own_sources.length > 0) y += group_head;
    for (const source of own_sources) {
      sources.set(source.id, { path: source.path, column, box: { x: x + padding, y, width: column_width - 2 * padding, height: source_height } });
      y += source_height + node_gap;
    }
    // Repositories fed from the left sit above those fed from the right, which keeps the lines from crossing.
    const stored = map.repositories
      .filter((repository) => repository.stored_on === host.id)
      .sort((left, right) => feed(left) - feed(right) || left.name.localeCompare(right.name));
    if (stored.length > 0) y += (own_sources.length > 0 ? node_gap : 0) + group_head;
    for (const repository of stored) {
      repositories.set(repository.id, { repository, column, box: { x: x + padding, y, width: column_width - 2 * padding, height: repository_height } });
      y += repository_height + node_gap;
    }
    bottoms.push(y + padding - node_gap);
  });
  function feed(repository: MapRepository): number {
    return repository.sources.length === 0 ? hosts.length : Math.min(...repository.sources.map(source_column));
  }

  const host_height = Math.max(...bottoms) - padding;
  return {
    hosts: hosts.map((host, column) => ({ ...host, box: { x: padding + column * (column_width + corridor), y: padding, width: column_width, height: host_height } })),
    sources,
    repositories,
    width: hosts.length * column_width + (hosts.length - 1) * corridor + 2 * padding,
    height: host_height + 2 * padding,
  };
}

// A curve leaving one box's side and entering another's, bowing out to the right when both are in one host and dipping
// into its lane when it passes another host.
function flow_path(from: Box, from_column: number, to: Box, to_column: number, from_y: number, to_y: number, lane_y: number | null): string {
  if (from_column === to_column) {
    const [x1, x2] = [from.x + from.width, to.x + to.width];
    const reach = Math.max(x1, x2) + padding + loop_reach;
    return `M${x1},${from_y}C${reach},${from_y} ${reach},${to_y} ${x2},${to_y}`;
  }
  const rightward = to_column > from_column;
  const x1 = rightward ? from.x + from.width : from.x;
  const x2 = rightward ? to.x : to.x + to.width;
  if (lane_y !== null) {
    const turn = (corridor / 2) * (rightward ? 1 : -1);
    return `M${x1},${from_y}C${x1 + turn},${from_y} ${x1 + turn * 0.4},${lane_y} ${x1 + turn},${lane_y}`
      + `L${x2 - turn},${lane_y}C${x2 - turn * 0.4},${lane_y} ${x2 - turn},${to_y} ${x2},${to_y}`;
  }
  const bend = Math.max(48, Math.abs(x2 - x1) / 2) * (rightward ? 1 : -1);
  return `M${x1},${from_y}C${x1 + bend},${from_y} ${x2 - bend},${to_y} ${x2},${to_y}`;
}

// ── Drawing ──────────────────────────────────────────────────────────────────

function draw(map: BackupMap, view_box: { current: Box | null }): { figure: HTMLElement; fit: () => void; zoom: (factor: number) => void } {
  const placed = place(map);
  const passing = [...placed.repositories.values()].flatMap(({ repository, column }) =>
    repository.sources.filter((source) => Math.abs((placed.sources.get(source)?.column ?? column) - column) > 1).map((source) => `${source}>${repository.id}`));
  const lane_top = placed.height - padding + lane_gap * 2;
  const whole: Box = { x: 0, y: 0, width: placed.width, height: placed.height + (passing.length > 0 ? lane_gap * (passing.length + 2) : 0) };
  const drawing = svg("svg", { class: "flow-map", role: "img", "aria-label": "Which folders each repository backs up, and the host that stores it" });
  const lines = svg("g", { class: "flows" });
  const boxes = svg("g", {});

  for (const host of placed.hosts) {
    boxes.append(
      svg("rect", { class: "map-host", x: host.box.x, y: host.box.y, width: host.box.width, height: host.box.height, rx: 10 }),
      text("map-host-name", host.box.x + padding, host.box.y + 22, host.name),
    );
    const group_label = (y: number, label: string) => boxes.append(text("map-group", host.box.x + padding, y - 7, label));
    const first_source = [...placed.sources.values()].find((source) => placed.hosts[source.column] === host);
    if (first_source) group_label(first_source.box.y, "Backs up");
    const first_repository = [...placed.repositories.values()].find((entry) => placed.hosts[entry.column] === host);
    if (first_repository) group_label(first_repository.box.y, "Stores");
  }

  for (const [id, source] of placed.sources) {
    const { box } = source;
    boxes.append(svg("g", { class: "map-node map-source", "data-source": id, tabindex: 0 },
      svg("rect", { x: box.x, y: box.y, width: box.width, height: box.height, rx: 6 }),
      text("map-path", box.x + 10, box.y + 18, clip(source.path, box.width - 20, 7.4)),
      svg("title", {}, source.path)));
  }

  const lane = (flow: string) => passing.includes(flow) ? lane_top + passing.indexOf(flow) * lane_gap : null;
  for (const { repository, box, column } of placed.repositories.values()) {
    const tone = tone_of(repository);
    const retention = keeps(repository.retention);
    const detail = `${retention ? `keeps ${retention} · ` : ""}last backup ${age(repository.last_backup_epoch)}`;
    const node = svg("a", { class: `map-node map-repository map-tone-${tone}`, href: link(["repositories", repository.id]), "data-repository": repository.id },
      svg("rect", { x: box.x, y: box.y, width: box.width, height: box.height, rx: 6 }),
      svg("circle", { class: "map-dot", cx: box.x + 14, cy: box.y + 17, r: 4 }),
      text("map-name", box.x + 24, box.y + 21, clip(repository.name, box.width - 34, 7.8)),
      text("map-path", box.x + 10, box.y + 37, clip(repository.path, box.width - 20, 7.4)),
      text("map-detail", box.x + 10, box.y + 51, clip(detail, box.width - 20)),
      svg("title", {}, [repository.name, repository.path, repository.sources.length === 0 ? "Watched only: no source paths are configured" : null, detail, ...repository.reasons.map((reason) => reason.text)].filter(Boolean).join("\n")));
    boxes.append(node);

    // A repository's lines enter spread along its side, one per source.
    repository.sources.forEach((source_id, index) => {
      const source = placed.sources.get(source_id);
      if (!source) return;
      const to_y = box.y + box.height * (index + 1) / (repository.sources.length + 1);
      const from_y = source.box.y + source.box.height / 2;
      lines.append(svg("path", {
        class: `flow map-tone-${tone}`,
        d: flow_path(source.box, source.column, box, column, from_y, to_y, lane(`${source_id}>${repository.id}`)),
        "data-source": source_id,
        "data-repository": repository.id,
      }, svg("title", {}, `${placed.hosts[source.column].name} ${source.path} → ${repository.name} on ${placed.hosts[column].name}`)));
    });
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

// Lights the lines and boxes joined to whatever the pointer or focus is on, dimming the rest.
function highlight_on_hover(drawing: SVGElement): void {
  const light = (target: Element | null) => {
    for (const lit of drawing.querySelectorAll(".lit")) lit.classList.remove("lit");
    const node = target?.closest<SVGElement>("[data-source], [data-repository]");
    drawing.classList.toggle("focused", node !== null && node !== undefined);
    if (!node) return;
    const source = node.dataset.source;
    const repository = node.dataset.repository;
    const flows = [...drawing.querySelectorAll<SVGElement>(".flow")].filter((flow) =>
      (source !== undefined && flow.dataset.source === source) || (repository !== undefined && flow.dataset.repository === repository));
    const joined = new Set<string>();
    for (const flow of flows) {
      flow.classList.add("lit");
      joined.add(`s:${flow.dataset.source}`);
      joined.add(`r:${flow.dataset.repository}`);
    }
    for (const box of drawing.querySelectorAll<SVGElement>(".map-node")) {
      const key = box.dataset.source !== undefined ? `s:${box.dataset.source}` : `r:${box.dataset.repository}`;
      if (box === node || joined.has(key)) box.classList.add("lit");
    }
  };
  drawing.addEventListener("pointerover", (event) => light(event.target as Element));
  drawing.addEventListener("pointerleave", () => light(null));
  drawing.addEventListener("focusin", (event) => light(event.target as Element));
  drawing.addEventListener("focusout", () => light(null));
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

function tone_of(repository: MapRepository): "running" | "ok" | "warning" | "critical" {
  return repository.running_job ? "running" : repository.level;
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

// ── View ─────────────────────────────────────────────────────────────────────

export function map_view(): View {
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
    if (map.repositories.length === 0) {
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
    title: "Map",
    root: h("div", { class: "page" },
      h("div", { class: "page-title" }, h("h1", {}, "Map")),
      section("What is backed up where", body, tools),
    ),
    update: async (changes) => {
      if (touches(changes, null, ["repository", "job", "config"])) await update(true);
    },
  };
}
