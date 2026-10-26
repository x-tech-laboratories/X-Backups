// Small SVG charts: lines over time, bars, and a pass/fail strip, colored from the page's CSS tokens.

import { h } from "./dom.ts";

export interface Series {
  label: string;
  // A CSS color, normally one of the --chart-* tokens.
  color: string;
  points: [epoch: number, value: number | null][];
}

export interface Bar {
  label: string;
  value: number;
  color: string;
}

export interface Cell {
  label: string;
  ok: boolean | null;
}

const width = 600;
const height = 160;
const margin = { left: 64, right: 8, top: 8, bottom: 20 };

// ── Line chart ───────────────────────────────────────────────────────────────

export function line_chart(title: string, series: Series[], format: (value: number) => string): HTMLElement {
  const points = series.flatMap((line) => line.points).filter(([, value]) => value !== null) as [number, number][];
  if (points.length < 2) return empty(title, "Not enough polls yet to draw a trend.");

  const epochs = points.map(([epoch]) => epoch);
  const values = points.map(([, value]) => value);
  const [first, last] = [Math.min(...epochs), Math.max(...epochs)];
  const top = Math.max(...values) * 1.05 || 1;
  const x = (epoch: number) => margin.left + (epoch - first) / Math.max(1, last - first) * (width - margin.left - margin.right);
  const y = (value: number) => height - margin.bottom - value / top * (height - margin.top - margin.bottom);

  const lines = series.map((line) => {
    const drawn = line.points.filter(([, value]) => value !== null) as [number, number][];
    const path = drawn.map(([epoch, value], index) => `${index === 0 ? "M" : "L"}${x(epoch).toFixed(1)},${y(value).toFixed(1)}`).join("");
    return svg("path", { d: path, fill: "none", stroke: line.color, "stroke-width": 2 }, svg("title", {}, line.label));
  });

  return figure(title, series.map((line) => [line.label, line.color]),
    svg("svg", { viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": title },
      ...axis_lines(),
      label(margin.left - 6, y(top / 1.05), format(top / 1.05), "end"),
      label(margin.left - 6, height - margin.bottom, format(0), "end"),
      label(margin.left, height - 4, new Date(first * 1000).toLocaleDateString(), "start"),
      label(width - margin.right, height - 4, new Date(last * 1000).toLocaleDateString(), "end"),
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
