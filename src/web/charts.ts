// Small SVG charts: lines over time, bars, meters, a donut, a timeline and a pass/fail strip, colored from the page's CSS tokens.

import { h } from "./dom.ts";

export interface Series {
  label: string;
  // A CSS color, normally one of the --series-* tokens.
  color: string;
  points: [epoch: number, value: number | null][];
}

export interface Bar {
  label: string;
  value: number;
  color: string;
}

// A level the readings should stay under, drawn as a dashed line across the chart.
export interface Limit {
  label: string;
  value: number;
  color: string;
}

export interface Meter {
  label: string;
  href: string | null;
  value_text: string;
  // How full the meter is, 0 to 100.
  percent: number;
  color: string;
  // Ticks along the meter, as percentages, such as where it starts warning.
  marks: number[];
  title: string | null;
  // A second, lighter fill drawn under the first, such as a repository's original size beneath what it stores.
  behind?: { percent: number; color: string };
}

// One row of a timeline: spans that ran from start to end, and instants drawn as ticks where end is null.
export interface TimelineRow {
  label: string;
  href: string | null;
  marks: { start: number; end: number | null; color: string; title: string }[];
}

export interface Cell {
  label: string;
  ok: boolean | null;
}

const width = 600;
const height = 160;
const margin = { left: 64, right: 8, top: 8, bottom: 20 };

// ── Line chart ───────────────────────────────────────────────────────────────

export function line_chart(title: string, series: Series[], format: (value: number) => string, limits: Limit[] = []): HTMLElement {
  const points = series.flatMap((line) => line.points).filter(([, value]) => value !== null) as [number, number][];
  // A line needs two readings at different times, which one day of polls summed per day does not give.
  const drawable = series.some((line) => new Set(line.points.filter(([, value]) => value !== null).map(([epoch]) => epoch)).size >= 2);
  if (!drawable) return empty(title, "Not enough history yet to draw a trend.");

  const epochs = points.map(([epoch]) => epoch);
  const values = points.map(([, value]) => value);
  const [first, last] = [Math.min(...epochs), Math.max(...epochs)];
  const highest = Math.max(...values, ...limits.map((limit) => limit.value));
  const top = highest * 1.05 || 1;
  const x = (epoch: number) => margin.left + (epoch - first) / Math.max(1, last - first) * (width - margin.left - margin.right);
  const y = (value: number) => height - margin.bottom - value / top * (height - margin.top - margin.bottom);

  const lines = series.map((line) => {
    const drawn = line.points.filter(([, value]) => value !== null) as [number, number][];
    const path = drawn.map(([epoch, value], index) => `${index === 0 ? "M" : "L"}${x(epoch).toFixed(1)},${y(value).toFixed(1)}`).join("");
    return svg("path", { d: path, fill: "none", stroke: line.color, "stroke-width": 2 }, svg("title", {}, line.label));
  });

  const limit_lines = limits.map((limit) => svg("line", {
    x1: margin.left, y1: y(limit.value).toFixed(1), x2: width - margin.right, y2: y(limit.value).toFixed(1),
    stroke: limit.color, "stroke-width": 2, "stroke-dasharray": "6 4",
  }, svg("title", {}, `${limit.label}: ${format(limit.value)}`)));

  return figure(title, [...series, ...limits].map((item): [string, string] => [item.label, item.color]),
    svg("svg", { viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": title },
      ...axis_lines(),
      label(margin.left - 6, y(highest), format(highest), "end"),
      label(margin.left - 6, height - margin.bottom, format(0), "end"),
      label(margin.left, height - 4, new Date(first * 1000).toLocaleDateString(), "start"),
      label(width - margin.right, height - 4, new Date(last * 1000).toLocaleDateString(), "end"),
      ...limit_lines,
      ...lines,
    ),
  );
}

// ── Bar chart ────────────────────────────────────────────────────────────────

export function bar_chart(title: string, bars: Bar[], format: (value: number) => string): HTMLElement {
  if (bars.length === 0) return empty(title, "Nothing to show yet.");
  const top = Math.max(...bars.map((bar) => bar.value)) || 1;
  const slot = (width - margin.left - margin.right) / bars.length;
  const y = (value: number) => height - margin.bottom - value / top * (height - margin.top - margin.bottom);

  return figure(title, [],
    svg("svg", { viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": title },
      ...axis_lines(),
      label(margin.left - 6, y(top), format(top), "end"),
      label(margin.left - 6, height - margin.bottom, format(0), "end"),
      ...bars.map((bar, index) => svg("rect", {
        x: (margin.left + index * slot + slot * 0.15).toFixed(1),
        y: y(bar.value).toFixed(1),
        width: Math.max(1, slot * 0.7).toFixed(1),
        height: Math.max(1, height - margin.bottom - y(bar.value)).toFixed(1),
        fill: bar.color,
      }, svg("title", {}, `${bar.label}: ${format(bar.value)}`))),
    ),
  );
}

// ── Stacked bar chart ────────────────────────────────────────────────────────

export interface Stack {
  label: string;
  parts: Bar[];
}

// One bar per bucket, its parts stacked in order, such as the jobs of each hour by outcome.
export function stacked_bar_chart(title: string, stacks: Stack[], legend: [label: string, color: string][], format: (value: number) => string): HTMLElement {
  const totals = stacks.map((stack) => stack.parts.reduce((sum, part) => sum + part.value, 0));
  if (totals.every((total) => total === 0)) return empty(title, "Nothing ran in this period.");
  const top = Math.max(...totals);
  const slot = (width - margin.left - margin.right) / stacks.length;
  const scale = (value: number) => value / top * (height - margin.top - margin.bottom);

  const rects = stacks.flatMap((stack, index) => {
    let base = height - margin.bottom;
    return stack.parts.filter((part) => part.value > 0).map((part) => {
      const tall = scale(part.value);
      base -= tall;
      return svg("rect", {
        x: (margin.left + index * slot + slot * 0.15).toFixed(1),
        y: base.toFixed(1),
        width: Math.max(1, slot * 0.7).toFixed(1),
        height: Math.max(1, tall).toFixed(1),
        fill: part.color,
      }, svg("title", {}, `${stack.label}: ${format(part.value)} ${part.label}`));
    });
  });

  return figure(title, legend,
    svg("svg", { viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": `${title}, ${format(totals.reduce((a, b) => a + b, 0))} in all` },
      ...axis_lines(),
      label(margin.left - 6, height - margin.bottom - scale(top), format(top), "end"),
      label(margin.left - 6, height - margin.bottom, format(0), "end"),
      label(margin.left, height - 4, stacks[0].label, "start"),
      label(width - margin.right, height - 4, stacks[stacks.length - 1].label, "end"),
      ...rects,
    ),
  );
}

// ── Meters ───────────────────────────────────────────────────────────────────

// One labeled bar per row with its value beside the label, such as the time since each repository's last backup.
export function meters(rows: Meter[], message: string): HTMLElement {
  if (rows.length === 0) return h("p", { class: "muted" }, message);
  return h("ul", { class: "meters" }, ...rows.map((row) => h("li", { title: row.title },
    h("div", { class: "meter-head" },
      row.href ? h("a", { href: row.href }, row.label) : h("span", {}, row.label),
      h("span", { class: "meter-value" }, row.value_text),
    ),
    h("div", { class: "meter", role: "meter", "aria-label": row.label, "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": Math.round(row.percent), "aria-valuetext": row.value_text },
      row.behind && h("span", { class: "meter-fill meter-behind", style: `width: ${row.behind.percent.toFixed(1)}%; background-color: ${row.behind.color}` }),
      h("span", { class: "meter-fill", style: `width: ${row.percent.toFixed(1)}%; background-color: ${row.color}` }),
      ...row.marks.map((mark) => h("span", { class: "meter-mark", style: `left: ${mark.toFixed(1)}%` })),
    ),
  )));
}

// ── Donut ────────────────────────────────────────────────────────────────────

const donut_size = 120;
const donut_radius = 46;
const donut_stroke = 16;

// Parts of one whole as a ring, its headline figure in the middle and each part's count in the legend.
export function donut(title: string, parts: Bar[], center: string, center_label: string, message: string): HTMLElement {
  const total = parts.reduce((sum, part) => sum + part.value, 0);
  if (total === 0) return empty(title, message);
  const circumference = 2 * Math.PI * donut_radius;
  let offset = 0;
  const arcs = parts.filter((part) => part.value > 0).map((part) => {
    const length = part.value / total * circumference;
    const arc = svg("circle", {
      cx: donut_size / 2, cy: donut_size / 2, r: donut_radius, fill: "none", stroke: part.color, "stroke-width": donut_stroke,
      // A hair short of its share leaves a gap between neighbours; the ring is turned so the first part starts at the top.
      "stroke-dasharray": `${Math.max(0.5, length - 1.5).toFixed(2)} ${circumference.toFixed(2)}`,
      "stroke-dashoffset": (-offset).toFixed(2),
    }, svg("title", {}, `${part.label}: ${part.value}`));
    offset += length;
    return arc;
  });
  return h("figure", { class: "chart donut" },
    h("figcaption", {}, title),
    h("div", { class: "donut-body" },
      svg("svg", { viewBox: `0 0 ${donut_size} ${donut_size}`, role: "img", "aria-label": `${title}: ${center} ${center_label}` },
        svg("circle", { cx: donut_size / 2, cy: donut_size / 2, r: donut_radius, fill: "none", class: "donut-track", "stroke-width": donut_stroke }),
        svg("g", { transform: `rotate(-90 ${donut_size / 2} ${donut_size / 2})` }, ...arcs),
        svg("text", { x: donut_size / 2, y: donut_size / 2 - 4, "text-anchor": "middle", class: "donut-value" }, center),
        svg("text", { x: donut_size / 2, y: donut_size / 2 + 14, "text-anchor": "middle", class: "tick" }, center_label),
      ) as unknown as HTMLElement,
      h("ul", { class: "donut-legend" }, ...parts.map((part) => h("li", {},
        h("span", { class: "legend", style: `--swatch: ${part.color}` }, part.label),
        h("span", { class: "meter-value" }, `${part.value} · ${Math.round(part.value / total * 100)}%`),
      ))),
    ),
  );
}

// ── Timeline ─────────────────────────────────────────────────────────────────

// Wider than the other charts, since it spans a whole panel and its text should stay at their size.
const timeline_width = 1100;
const timeline_label_width = 150;
const timeline_row_height = 22;

// One lane per row between two instants, with the spans and ticks of each and the day boundaries marked.
export function timeline(title: string, rows: TimelineRow[], from: number, to: number, legend: [label: string, color: string][], message: string): HTMLElement {
  if (rows.every((row) => row.marks.length === 0)) return empty(title, message);
  const lanes_top = margin.top;
  const chart_height = lanes_top + rows.length * timeline_row_height + margin.bottom;
  const x = (epoch: number) => timeline_label_width + Math.min(1, Math.max(0, (epoch - from) / (to - from))) * (timeline_width - timeline_label_width - margin.right);

  const days: SVGElement[] = [];
  const first_day = new Date(from * 1000);
  first_day.setHours(24, 0, 0, 0);
  for (let day = first_day.getTime() / 1000; day < to; day += 86400) {
    days.push(svg("line", { x1: x(day).toFixed(1), y1: lanes_top, x2: x(day).toFixed(1), y2: chart_height - margin.bottom, class: "axis" }));
  }

  const lanes = rows.flatMap((row, index) => {
    const middle = lanes_top + index * timeline_row_height + timeline_row_height / 2;
    const name = row.label.length > 22 ? `${row.label.slice(0, 21)}…` : row.label;
    const text = svg("text", { x: timeline_label_width - 8, y: middle.toFixed(1), "text-anchor": "end", "dominant-baseline": "middle", class: "lane-label" }, name);
    return [
      row.href ? svg("a", { href: row.href }, text, svg("title", {}, row.label)) : text,
      svg("line", { x1: timeline_label_width, y1: middle.toFixed(1), x2: timeline_width - margin.right, y2: middle.toFixed(1), class: "lane" }),
      ...row.marks.map((mark) => {
        const left = x(mark.start);
        const span = mark.end === null ? 2 : Math.max(3, x(mark.end) - left);
        const tall = mark.end === null ? 14 : 10;
        return svg("rect", {
          x: (left - (mark.end === null ? 1 : 0)).toFixed(1), y: (middle - tall / 2).toFixed(1), width: span.toFixed(1), height: tall, rx: 1, fill: mark.color,
        }, svg("title", {}, mark.title));
      }),
    ];
  });

  return figure(title, legend,
    svg("svg", { viewBox: `0 0 ${timeline_width} ${chart_height}`, role: "img", "aria-label": title },
      ...days,
      ...lanes,
      label(timeline_label_width, chart_height - 4, new Date(from * 1000).toLocaleDateString(), "start"),
      label(timeline_width - margin.right, chart_height - 4, "now", "end"),
    ),
  );
}

// ── Strip ────────────────────────────────────────────────────────────────────

// One cell per reading, green for a pass, red for a failure and grey for no verdict.
export function strip(title: string, cells: Cell[]): HTMLElement {
  if (cells.length === 0) return empty(title, "No readings yet.");
  return h("figure", { class: "chart" },
    h("figcaption", {}, title),
    h("div", { class: "strip" }, ...cells.map((cell) => h("span", {
      class: `cell cell-${cell.ok === null ? "none" : cell.ok ? "pass" : "fail"}`,
      title: `${cell.label}: ${cell.ok === null ? "no verdict" : cell.ok ? "pass" : "fail"}`,
    }))),
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function figure(title: string, legend: [label: string, color: string][], chart: SVGElement): HTMLElement {
  return h("figure", { class: "chart" },
    h("figcaption", {}, title, ...legend.map(([text, color]) => h("span", { class: "legend", style: `--swatch: ${color}` }, text))),
    chart as unknown as HTMLElement,
  );
}

function empty(title: string, message: string): HTMLElement {
  return h("figure", { class: "chart" }, h("figcaption", {}, title), h("p", { class: "muted" }, message));
}

function axis_lines(): SVGElement[] {
  return [
    svg("line", { x1: margin.left, y1: margin.top, x2: margin.left, y2: height - margin.bottom, class: "axis" }),
    svg("line", { x1: margin.left, y1: height - margin.bottom, x2: width - margin.right, y2: height - margin.bottom, class: "axis" }),
  ];
}

function label(x: number, y: number, text: string, anchor: "start" | "end"): SVGElement {
  return svg("text", { x: x.toFixed(1), y: y.toFixed(1), "text-anchor": anchor, "dominant-baseline": "middle", class: "tick" }, text);
}

function svg(tag: string, attributes: Record<string, string | number>, ...children: (SVGElement | string)[]): SVGElement {
  const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
  element.append(...children);
  return element;
}
