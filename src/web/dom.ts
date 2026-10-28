// Builds elements without innerHTML, so names from archives and logs are always shown as text.

export type Child = Node | string | number | null | undefined | false | Child[];

type Attributes = Record<string, string | number | boolean | EventListener | null | undefined>;

export function h<Tag extends keyof HTMLElementTagNameMap>(tag: Tag, attributes: Attributes = {}, ...children: Child[]): HTMLElementTagNameMap[Tag] {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === null || value === undefined || value === false) continue;
    if (typeof value === "function") element.addEventListener(name.replace(/^on/, ""), value);
    else if (value === true) element.setAttribute(name, "");
    else element.setAttribute(name, String(value));
  }
  element.append(...nodes(children));
  return element;
}

// The nodes a child stands for, with lists flattened and the empty values dropped.
export function nodes(children: Child): (Node | string)[] {
  if (!Array.isArray(children)) children = [children];
  return children.flatMap((child): (Node | string)[] => {
    if (Array.isArray(child)) return nodes(child);
    if (child === null || child === undefined || child === false) return [];
    return [child instanceof Node ? child : String(child)];
  });
}

// ── Formatting ───────────────────────────────────────────────────────────────

export function size(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "—";
  const units = ["B", "kB", "MB", "GB", "TB", "PB"];
  let value = Math.abs(bytes);
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${bytes < 0 ? "−" : ""}${value.toFixed(value < 10 && unit > 0 ? 1 : 0)} ${units[unit]}`;
}

// A size change with its sign, such as +1.2 GB or −300 MB.
export function size_change(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "—";
  return bytes > 0 ? `+${size(bytes)}` : size(bytes);
}

export function count_change(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return value > 0 ? `+${value.toLocaleString()}` : value < 0 ? `−${Math.abs(value).toLocaleString()}` : "0";
}

export function age(epoch: number | null | undefined): string {
  if (!epoch) return "never";
  const seconds = Math.max(0, Date.now() / 1000 - epoch);
  if (seconds < 90) return `${Math.round(seconds)}s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 129600) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

// How long until the epoch, or how long ago when it has passed.
export function until(epoch: number | null): string {
  if (epoch === null) return "—";
  const seconds = epoch - Date.now() / 1000;
  return seconds < 0 ? age(epoch) : `in ${duration(seconds)}`;
}

export function duration(seconds: number | null): string {
  if (seconds === null) return "—";
  // Settings such as max_age are often whole days or hours, which read better without a decimal.
  if (seconds >= 86400 && seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds < 120) return `${Math.round(seconds)}s`;
  if (seconds < 7200) return `${Math.round(seconds / 60)}m`;
  if (seconds < 172800) return seconds % 3600 === 0 ? `${seconds / 3600}h` : `${(seconds / 3600).toFixed(1)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

export function stamp(epoch: number): string {
  return new Date(epoch * 1000).toLocaleString();
}

export function plural(count: number, word: string): string {
  return `${count.toLocaleString()} ${word}${count === 1 ? "" : "s"}`;
}

export function now_seconds(): number {
  return Date.now() / 1000;
}
