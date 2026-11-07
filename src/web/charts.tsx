// Small SVG charts: lines over time, bars, meters, a donut, a timeline, sparklines and a pass/fail strip, colored from the page's CSS tokens.

import type { CSSProperties, ReactNode } from "react";

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

type Legend = [label: string, color: string][];

const width = 600;
const height = 160;
const margin = { left: 64, right: 8, top: 8, bottom: 20 };

// ── Line chart ───────────────────────────────────────────────────────────────

interface LineChartProps {
  title: string;
  series: Series[];
  format: (value: number) => string;
  limits?: Limit[];
}

export function LineChart({ title, series, format, limits = [] }: LineChartProps) {
  const points = series.flatMap((line) => line.points).filter(([, value]) => value !== null) as [number, number][];
  // A line needs two readings at different times, which one day of polls summed per day does not give.
  const drawable = series.some((line) => new Set(line.points.filter(([, value]) => value !== null).map(([epoch]) => epoch)).size >= 2);
  if (!drawable) return <EmptyChart title={title} message="Not enough history yet to draw a trend." />;

  const epochs = points.map(([epoch]) => epoch);
  const values = points.map(([, value]) => value);
  const [first, last] = [Math.min(...epochs), Math.max(...epochs)];
  const highest = Math.max(...values, ...limits.map((limit) => limit.value));
  const top = highest * 1.05 || 1;
  const x = (epoch: number) => margin.left + (epoch - first) / Math.max(1, last - first) * (width - margin.left - margin.right);
  const y = (value: number) => height - margin.bottom - value / top * (height - margin.top - margin.bottom);

  return (
    <Figure title={title} legend={[...series, ...limits].map((item): [string, string] => [item.label, item.color])}>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={title}>
        <AxisLines />
        <Tick x={margin.left - 6} y={y(highest)} text={format(highest)} anchor="end" />
        <Tick x={margin.left - 6} y={height - margin.bottom} text={format(0)} anchor="end" />
        <Tick x={margin.left} y={height - 4} text={new Date(first * 1000).toLocaleDateString()} anchor="start" />
        <Tick x={width - margin.right} y={height - 4} text={new Date(last * 1000).toLocaleDateString()} anchor="end" />
        {limits.map((limit) => (
          <line key={limit.label} x1={margin.left} y1={y(limit.value).toFixed(1)} x2={width - margin.right} y2={y(limit.value).toFixed(1)} stroke={limit.color} strokeWidth={2} strokeDasharray="6 4">
            <title>{`${limit.label}: ${format(limit.value)}`}</title>
          </line>
        ))}
        {series.map((line) => {
          const drawn = line.points.filter(([, value]) => value !== null) as [number, number][];
          const path = drawn.map(([epoch, value], index) => `${index === 0 ? "M" : "L"}${x(epoch).toFixed(1)},${y(value).toFixed(1)}`).join("");
          return <path key={line.label} d={path} fill="none" stroke={line.color} strokeWidth={2}><title>{line.label}</title></path>;
        })}
      </svg>
    </Figure>
  );
}

// ── Bar chart ────────────────────────────────────────────────────────────────

export function BarChart({ title, bars, format }: { title: string; bars: Bar[]; format: (value: number) => string }) {
  if (bars.length === 0) return <EmptyChart title={title} message="Nothing to show yet." />;
  const top = Math.max(...bars.map((bar) => bar.value)) || 1;
  const slot = (width - margin.left - margin.right) / bars.length;
  const y = (value: number) => height - margin.bottom - value / top * (height - margin.top - margin.bottom);

  return (
    <Figure title={title} legend={[]}>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={title}>
        <AxisLines />
        <Tick x={margin.left - 6} y={y(top)} text={format(top)} anchor="end" />
        <Tick x={margin.left - 6} y={height - margin.bottom} text={format(0)} anchor="end" />
        {bars.map((bar, index) => (
          <rect
            key={index}
            x={(margin.left + index * slot + slot * 0.15).toFixed(1)}
            y={y(bar.value).toFixed(1)}
            width={Math.max(1, slot * 0.7).toFixed(1)}
            height={Math.max(1, height - margin.bottom - y(bar.value)).toFixed(1)}
            fill={bar.color}
          >
            <title>{`${bar.label}: ${format(bar.value)}`}</title>
          </rect>
        ))}
      </svg>
    </Figure>
  );
}

// ── Stacked bar chart ────────────────────────────────────────────────────────

export interface Stack {
  label: string;
  parts: Bar[];
}

interface StackedBarChartProps {
  title: string;
  stacks: Stack[];
  legend: Legend;
  format: (value: number) => string;
}

// One bar per bucket, its parts stacked in order, such as the runs of each hour by outcome.
export function StackedBarChart({ title, stacks, legend, format }: StackedBarChartProps) {
  const totals = stacks.map((stack) => stack.parts.reduce((sum, part) => sum + part.value, 0));
  if (totals.every((total) => total === 0)) return <EmptyChart title={title} message="Nothing ran in this period." />;
  const top = Math.max(...totals);
  const slot = (width - margin.left - margin.right) / stacks.length;
  const scale = (value: number) => value / top * (height - margin.top - margin.bottom);

  const rects = stacks.flatMap((stack, index) => {
    let base = height - margin.bottom;
    return stack.parts.filter((part) => part.value > 0).map((part) => {
      const tall = scale(part.value);
      base -= tall;
      return (
        <rect
          key={`${index}-${part.label}`}
          x={(margin.left + index * slot + slot * 0.15).toFixed(1)}
          y={base.toFixed(1)}
          width={Math.max(1, slot * 0.7).toFixed(1)}
          height={Math.max(1, tall).toFixed(1)}
          fill={part.color}
        >
          <title>{`${stack.label}: ${format(part.value)} ${part.label}`}</title>
        </rect>
      );
    });
  });

  return (
    <Figure title={title} legend={legend}>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${title}, ${format(totals.reduce((sum, total) => sum + total, 0))} in all`}>
        <AxisLines />
        <Tick x={margin.left - 6} y={height - margin.bottom - scale(top)} text={format(top)} anchor="end" />
        <Tick x={margin.left - 6} y={height - margin.bottom} text={format(0)} anchor="end" />
        <Tick x={margin.left} y={height - 4} text={stacks[0].label} anchor="start" />
        <Tick x={width - margin.right} y={height - 4} text={stacks[stacks.length - 1].label} anchor="end" />
        {rects}
      </svg>
    </Figure>
  );
}

// ── Meters ───────────────────────────────────────────────────────────────────

// One labeled bar per row with its value beside the label, such as the time since each repository's last backup.
export function Meters({ rows, message }: { rows: Meter[]; message: string }) {
  if (rows.length === 0) return <p className="muted">{message}</p>;
  return (
    <ul className="meters">
      {rows.map((row, index) => (
        <li key={index} title={row.title ?? undefined}>
          <div className="meter-head">
            {row.href ? <a href={row.href}>{row.label}</a> : <span>{row.label}</span>}
            <span className="meter-value">{row.value_text}</span>
          </div>
          <div className="meter" role="meter" aria-label={row.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(row.percent)} aria-valuetext={row.value_text}>
            {row.behind && <span className="meter-fill meter-behind" style={{ width: `${row.behind.percent.toFixed(1)}%`, backgroundColor: row.behind.color }} />}
            <span className="meter-fill" style={{ width: `${row.percent.toFixed(1)}%`, backgroundColor: row.color }} />
            {row.marks.map((mark) => <span key={mark} className="meter-mark" style={{ left: `${mark.toFixed(1)}%` }} />)}
          </div>
        </li>
      ))}
    </ul>
  );
}

// ── Donut ────────────────────────────────────────────────────────────────────

const donut_size = 120;
const donut_radius = 46;
const donut_stroke = 16;

interface DonutProps {
  title: string;
  parts: Bar[];
  center: string;
  center_label: string;
  message: string;
}

// Parts of one whole as a ring, its headline figure in the middle and each part's count in the legend.
export function Donut({ title, parts, center, center_label, message }: DonutProps) {
  const total = parts.reduce((sum, part) => sum + part.value, 0);
  if (total === 0) return <EmptyChart title={title} message={message} />;
  const circumference = 2 * Math.PI * donut_radius;
  const middle = donut_size / 2;
  let offset = 0;
  const arcs = parts.filter((part) => part.value > 0).map((part) => {
    const length = part.value / total * circumference;
    const start = offset;
    offset += length;
    // A hair short of its share leaves a gap between neighbours; the ring is turned so the first part starts at the top.
    return (
      <circle
        key={part.label}
        cx={middle}
        cy={middle}
        r={donut_radius}
        fill="none"
        stroke={part.color}
        strokeWidth={donut_stroke}
        strokeDasharray={`${Math.max(0.5, length - 1.5).toFixed(2)} ${circumference.toFixed(2)}`}
        strokeDashoffset={(-start).toFixed(2)}
      >
        <title>{`${part.label}: ${part.value}`}</title>
      </circle>
    );
  });

  return (
    <figure className="chart donut">
      <figcaption>{title}</figcaption>
      <div className="donut-body">
        <svg viewBox={`0 0 ${donut_size} ${donut_size}`} role="img" aria-label={`${title}: ${center} ${center_label}`}>
          <circle cx={middle} cy={middle} r={donut_radius} fill="none" className="donut-track" strokeWidth={donut_stroke} />
          <g transform={`rotate(-90 ${middle} ${middle})`}>{arcs}</g>
          <text x={middle} y={middle - 4} textAnchor="middle" className="donut-value">{center}</text>
          <text x={middle} y={middle + 14} textAnchor="middle" className="tick">{center_label}</text>
        </svg>
        <ul className="donut-legend">
          {parts.map((part) => (
            <li key={part.label}>
              <span className="legend" style={swatch(part.color)}>{part.label}</span>
              <span className="meter-value">{`${part.value} · ${Math.round(part.value / total * 100)}%`}</span>
            </li>
          ))}
        </ul>
      </div>
    </figure>
  );
}

// ── Timeline ─────────────────────────────────────────────────────────────────

// Wider than the other charts, since it spans a whole panel and its text should stay at their size.
const timeline_width = 1100;
const timeline_label_width = 150;
const timeline_row_height = 22;

interface TimelineProps {
  title: string;
  rows: TimelineRow[];
  from: number;
  to: number;
  legend: Legend;
  message: string;
}

// One lane per row between two instants, with the spans and ticks of each and the day boundaries marked.
export function Timeline({ title, rows, from, to, legend, message }: TimelineProps) {
  if (rows.every((row) => row.marks.length === 0)) return <EmptyChart title={title} message={message} />;
  const lanes_top = margin.top;
  const chart_height = lanes_top + rows.length * timeline_row_height + margin.bottom;
  const x = (epoch: number) => timeline_label_width + Math.min(1, Math.max(0, (epoch - from) / (to - from))) * (timeline_width - timeline_label_width - margin.right);

  const days: number[] = [];
  const first_day = new Date(from * 1000);
  first_day.setHours(24, 0, 0, 0);
  for (let day = first_day.getTime() / 1000; day < to; day += 86400) days.push(day);

  return (
    <Figure title={title} legend={legend}>
      <svg viewBox={`0 0 ${timeline_width} ${chart_height}`} role="img" aria-label={title}>
        {days.map((day) => <line key={day} x1={x(day).toFixed(1)} y1={lanes_top} x2={x(day).toFixed(1)} y2={chart_height - margin.bottom} className="axis" />)}
        {rows.map((row, index) => {
          const middle = lanes_top + index * timeline_row_height + timeline_row_height / 2;
          const name = row.label.length > 22 ? `${row.label.slice(0, 21)}…` : row.label;
          const text = <text x={timeline_label_width - 8} y={middle.toFixed(1)} textAnchor="end" dominantBaseline="middle" className="lane-label">{name}</text>;
          return (
            <g key={index}>
              {row.href ? <a href={row.href}>{text}<title>{row.label}</title></a> : text}
              <line x1={timeline_label_width} y1={middle.toFixed(1)} x2={timeline_width - margin.right} y2={middle.toFixed(1)} className="lane" />
              {row.marks.map((mark, mark_index) => {
                const left = x(mark.start);
                const span = mark.end === null ? 2 : Math.max(3, x(mark.end) - left);
                const tall = mark.end === null ? 14 : 10;
                return (
                  <rect key={mark_index} x={(left - (mark.end === null ? 1 : 0)).toFixed(1)} y={(middle - tall / 2).toFixed(1)} width={span.toFixed(1)} height={tall} rx={1} fill={mark.color}>
                    <title>{mark.title}</title>
                  </rect>
                );
              })}
            </g>
          );
        })}
        <Tick x={timeline_label_width} y={chart_height - 4} text={new Date(from * 1000).toLocaleDateString()} anchor="start" />
        <Tick x={timeline_width - margin.right} y={chart_height - 4} text="now" anchor="end" />
      </svg>
    </Figure>
  );
}

// ── Sparkline ────────────────────────────────────────────────────────────────

const sparkline_width = 120;
const sparkline_height = 28;

interface SparklineProps {
  label: string;
  points: [epoch: number, value: number][];
  top: number;
  color: string;
}

// A small line of readings over time with no axes, scaled from zero to top or the highest reading if that is higher.
export function Sparkline({ label, points, top, color }: SparklineProps) {
  const frame = { viewBox: `0 0 ${sparkline_width} ${sparkline_height}`, className: "sparkline", role: "img" as const, "aria-label": label };
  if (points.length < 2) return <svg {...frame} />;
  const [first, last] = [points[0][0], points.at(-1)![0]];
  const highest = Math.max(top, ...points.map(([, value]) => value)) || 1;
  const x = (epoch: number) => (epoch - first) / Math.max(1, last - first) * sparkline_width;
  const y = (value: number) => sparkline_height - 2 - value / highest * (sparkline_height - 4);
  const path = points.map(([epoch, value], index) => `${index === 0 ? "M" : "L"}${x(epoch).toFixed(1)},${y(value).toFixed(1)}`).join("");
  return (
    <svg {...frame}>
      <path d={`${path}L${sparkline_width},${sparkline_height}L0,${sparkline_height}Z`} fill={color} opacity={0.15} />
      <path d={path} fill="none" stroke={color} strokeWidth={1.5} />
      <title>{label}</title>
    </svg>
  );
}

// ── Strip ────────────────────────────────────────────────────────────────────

// One cell per reading, green for a pass, red for a failure and grey for no verdict.
export function Strip({ title, cells }: { title: string; cells: Cell[] }) {
  if (cells.length === 0) return <EmptyChart title={title} message="No readings yet." />;
  return (
    <figure className="chart">
      <figcaption>{title}</figcaption>
      <div className="strip">
        {cells.map((cell, index) => (
          <span key={index} className={`cell cell-${cell.ok === null ? "none" : cell.ok ? "pass" : "fail"}`} title={`${cell.label}: ${cell.ok === null ? "no verdict" : cell.ok ? "pass" : "fail"}`} />
        ))}
      </div>
    </figure>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function Figure({ title, legend, children }: { title: string; legend: Legend; children: ReactNode }) {
  return (
    <figure className="chart">
      <figcaption>
        {title}
        {legend.map(([text, color]) => <span key={text} className="legend" style={swatch(color)}>{text}</span>)}
      </figcaption>
      {children}
    </figure>
  );
}

function EmptyChart({ title, message }: { title: string; message: string }) {
  return <figure className="chart"><figcaption>{title}</figcaption><p className="muted">{message}</p></figure>;
}

function AxisLines() {
  return (
    <>
      <line x1={margin.left} y1={margin.top} x2={margin.left} y2={height - margin.bottom} className="axis" />
      <line x1={margin.left} y1={height - margin.bottom} x2={width - margin.right} y2={height - margin.bottom} className="axis" />
    </>
  );
}

function Tick({ x, y, text, anchor }: { x: number; y: number; text: string; anchor: "start" | "end" }) {
  return <text x={x.toFixed(1)} y={y.toFixed(1)} textAnchor={anchor} dominantBaseline="middle" className="tick">{text}</text>;
}

// A legend swatch takes its color from the --swatch property the stylesheet reads.
function swatch(color: string): CSSProperties {
  return { "--swatch": color } as CSSProperties;
}
