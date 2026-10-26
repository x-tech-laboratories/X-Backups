// Builds elements without innerHTML, so names from archives and logs are always shown as text.

type Child = Node | string | number | null | undefined | false;

type Attributes = Record<string, string | number | boolean | EventListener | null | undefined>;

export function h<Tag extends keyof HTMLElementTagNameMap>(tag: Tag, attributes: Attributes = {}, ...children: Child[]): HTMLElementTagNameMap[Tag] {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === null || value === undefined || value === false) continue;
    if (typeof value === "function") element.addEventListener(name.replace(/^on/, ""), value);
    else if (value === true) element.setAttribute(name, "");
    else element.setAttribute(name, String(value));
  }
  element.append(...children.filter((child) => child !== null && child !== undefined && child !== false).map(string_or_node));
  return element;
}

function string_or_node(child: Child): Node | string {
  return child instanceof Node ? child : String(child);
}

// ── Formatting ───────────────────────────────────────────────────────────────

export function size(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "—";
  const units = ["B", "kB", "MB", "GB", "TB", "PB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value.toFixed(value < 10 && unit > 0 ? 1 : 0)} ${units[unit]}`;
}

export function age(epoch: number | null | undefined): string {
  if (!epoch) return "never";
  const seconds = Math.max(0, Date.now() / 1000 - epoch);
  if (seconds < 90) return `${Math.round(seconds)}s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 129600) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

export function duration(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 120) return `${Math.round(seconds)}s`;
  if (seconds < 7200) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

export function stamp(epoch: number): string {
  return new Date(epoch * 1000).toLocaleString();
}
