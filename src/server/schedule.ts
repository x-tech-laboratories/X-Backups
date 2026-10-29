// Reads a task's schedule: a duration counted from the start of the task's last run, a preset, a time of day on every
// day or one weekday, or a five-field cron line. Calendar forms are read in one time zone, X_BACKUPS_TIMEZONE or else the
// server's own; a time the clocks skip runs that much later, and a time they repeat runs once, at its first occurrence.

// ── Imports ──────────────────────────────────────────────────────────────────

import { parse_duration } from "./borg/durations.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

export interface IntervalSchedule {
  kind: "interval";
  seconds: number;
}

// The values each cron field allows, sorted; a day of week of 7 is read as Sunday, 0.
export interface CalendarSchedule {
  kind: "calendar";
  minutes: number[];
  hours: number[];
  days: number[];
  months: number[];
  weekdays: number[];
  // Whether the day of month or day of week field was "*"; when both are restricted, a day matching either is due.
  any_day: boolean;
  any_weekday: boolean;
}

export type Schedule = IntervalSchedule | CalendarSchedule;

// A schedule as the config writes it: a duration, a number of seconds, or a calendar expression.
export type ScheduleText = string | number;

// The shortest interval a task may repeat at.
const shortest_interval_in_seconds = 60;

// How far ahead a calendar expression is searched before it counts as never due, enough for 29 February on a weekday.
const search_days = 366 * 8;

const weekday_names = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const month_names = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

const presets: Record<string, string> = {
  hourly: "0 * * * *",
  daily: "0 0 * * *",
  weekly: "0 0 * * mon",
  monthly: "0 0 1 * *",
};

interface FieldSpec {
  name: string;
  min: number;
  max: number;
  names?: string[];
  // The value the first name stands for.
  names_from?: number;
}

const field_specs: FieldSpec[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: month_names, names_from: 1 },
  { name: "day of week", min: 0, max: 7, names: weekday_names, names_from: 0 },
];

// ── Time zone ────────────────────────────────────────────────────────────────

// The zone calendar schedules are read in: X_BACKUPS_TIMEZONE, or the server's own.
export function schedule_time_zone(): string {
  const zone = process.env.X_BACKUPS_TIMEZONE?.trim();
  if (!zone) return Intl.DateTimeFormat().resolvedOptions().timeZone;
  check_time_zone(zone);
  return zone;
}

export function check_time_zone(zone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
  } catch {
    throw new Error(`Unknown time zone '${zone}'; use an IANA name such as Europe/Berlin.`);
  }
}

// ── Parsing ──────────────────────────────────────────────────────────────────

export function parse_schedule(expression: ScheduleText): Schedule {
  if (typeof expression === "number") return interval(expression, String(expression));
  const text = expression.trim().toLowerCase().replace(/\s+/g, " ");
  if (text === "") throw new Error("A schedule cannot be empty.");
  if (/^\d+$/.test(text) || /^(\d+[wdhms])+$/.test(text)) return interval(parse_duration(text), expression);
  if (Object.hasOwn(presets, text)) return parse_cron(presets[text]);

  const daily = /^daily (\S+)$/.exec(text);
  if (daily !== null) {
    const [hour, minute] = time_of_day(daily[1], expression);
    return parse_cron(`${minute} ${hour} * * *`);
  }
  const weekly = /^weekly (\S+) (\S+)$/.exec(text);
  if (weekly !== null) {
    const weekday = weekday_of(weekly[1]);
    if (weekday === null) throw new Error(`'${weekly[1]}' in '${expression}' is not a weekday; use mon, tue, … sun.`);
    const [hour, minute] = time_of_day(weekly[2], expression);
    return parse_cron(`${minute} ${hour} * * ${weekday}`);
  }
  if (text.split(" ").length === 5) return parse_cron(text);
  throw new Error(
    `Unrecognised schedule '${expression}'. Use a duration such as "6h", hourly, daily, weekly, monthly, ` +
    `"daily 02:00", "weekly sun 03:00" or a five-field cron line such as "30 2 * * 1-5".`,
  );
}

// Whether the value is a schedule this file reads, for checking a config.
export function is_schedule(value: unknown): boolean {
  if (typeof value !== "string" && typeof value !== "number") return false;
  try {
    parse_schedule(value);
    return true;
  } catch {
    return false;
  }
}

function interval(seconds: number, expression: string): IntervalSchedule {
  if (!Number.isFinite(seconds) || seconds < shortest_interval_in_seconds) {
    throw new Error(`The schedule '${expression}' repeats too often; the shortest is one minute.`);
  }
  return { kind: "interval", seconds: Math.trunc(seconds) };
}

function time_of_day(text: string, expression: string): [hour: number, minute: number] {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text);
  const hour = Number(match?.[1]);
  const minute = Number(match?.[2]);
  if (match === null || hour > 23 || minute > 59) throw new Error(`'${text}' in '${expression}' is not a time of day such as 02:00.`);
  return [hour, minute];
}

function weekday_of(text: string): number | null {
  const index = weekday_names.findIndex((name) => name === text || name.slice(0, 3) === text);
  return index === -1 ? null : index;
}

function parse_cron(text: string): CalendarSchedule {
  const fields = text.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`A cron line has five fields, not ${fields.length}: '${text}'.`);
  const [minutes, hours, days, months, weekdays] = fields.map((field, index) => parse_field(field, field_specs[index], text));
  return {
    kind: "calendar", minutes, hours, days, months,
    weekdays: [...new Set(weekdays.map((day) => day % 7))].sort((left, right) => left - right),
    any_day: fields[2] === "*", any_weekday: fields[4] === "*",
  };
}

// One cron field's values: "*", a value, a range, a list of them, each with an optional "/step".
function parse_field(field: string, spec: FieldSpec, text: string): number[] {
  const fail = (): never => {
    throw new Error(`'${field}' is not a valid ${spec.name} in '${text}'; it takes ${spec.min}-${spec.max}.`);
  };
  const value_of = (part: string): number => {
    if (/^\d+$/.test(part)) return Number(part);
    const named = spec.names?.findIndex((name) => name.slice(0, 3) === part.toLowerCase()) ?? -1;
    return named === -1 ? fail() : named + spec.names_from!;
  };
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const [range, step_text, ...rest] = part.split("/");
    if (rest.length > 0 || range === "") fail();
    const step = step_text === undefined ? 1 : /^\d+$/.test(step_text) && Number(step_text) > 0 ? Number(step_text) : fail();
    let low: number;
    let high: number;
    if (range === "*") {
      [low, high] = [spec.min, spec.max];
    } else if (range.includes("-")) {
      const [from, to, ...more] = range.split("-");
      if (more.length > 0) fail();
      [low, high] = [value_of(from), value_of(to)];
    } else {
      low = value_of(range);
      high = step_text === undefined ? low : spec.max;
    }
    if (low < spec.min || high > spec.max || low > high) fail();
    for (let value = low; value <= high; value += step) values.add(value);
  }
  return [...values].sort((left, right) => left - right);
}

// ── Next due ─────────────────────────────────────────────────────────────────

// When the schedule is next due after the epoch: an interval after it, or a calendar's first time strictly later.
export function next_due(expression: ScheduleText | Schedule, after_epoch: number, time_zone = schedule_time_zone()): number {
  const schedule = typeof expression === "object" ? expression : parse_schedule(expression);
  const after = Math.floor(after_epoch);
  if (schedule.kind === "interval") return after + schedule.seconds;
  return next_calendar(schedule, after, time_zone);
}

function next_calendar(schedule: CalendarSchedule, after: number, zone: string): number {
  const start = wall_parts(after * 1000, zone);
  for (let offset = 0; offset < search_days; offset++) {
    const date = new Date(Date.UTC(start.year, start.month - 1, start.day + offset));
    const [year, month, day] = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
    if (!schedule.months.includes(month) || !day_matches(schedule, day, date.getUTCDay())) continue;
    let best: number | null = null;
    for (const hour of schedule.hours) {
      for (const minute of schedule.minutes) {
        const wall = Date.UTC(year, month - 1, day, hour, minute) / 1000;
        // A zone is at most 14 hours ahead of UTC and 12 behind, which bounds the epoch a wall time can be.
        if (wall + 12 * 3600 <= after) continue;
        if (best !== null && wall - 14 * 3600 > best) break;
        const epoch = wall_to_epoch(year, month, day, hour, minute, zone);
        if (epoch > after && (best === null || epoch < best)) best = epoch;
      }
    }
    if (best !== null) return best;
  }
  throw new Error("That schedule is never due.");
}

// Cron's rule: with both day fields restricted, a day matching either is due.
function day_matches(schedule: CalendarSchedule, day: number, weekday: number): boolean {
  const by_day = schedule.days.includes(day);
  const by_weekday = schedule.weekdays.includes(weekday);
  if (schedule.any_day && schedule.any_weekday) return true;
  if (schedule.any_day) return by_weekday;
  if (schedule.any_weekday) return by_day;
  return by_day || by_weekday;
}

// ── Wall time ────────────────────────────────────────────────────────────────

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  let found = formatters.get(zone);
  if (found === undefined) {
    found = new Intl.DateTimeFormat("en-US", {
      timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
    });
    formatters.set(zone, found);
  }
  return found;
}

interface WallParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function wall_parts(epoch_ms: number, zone: string): WallParts {
  const parts = Object.fromEntries(formatter(zone).formatToParts(new Date(epoch_ms)).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour) % 24, minute: Number(parts.minute), second: Number(parts.second),
  };
}

// The zone's offset from UTC at the instant, in seconds.
function offset_at(epoch: number, zone: string): number {
  const parts = wall_parts(epoch * 1000, zone);
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) / 1000 - epoch;
}

// The instant a wall time happens in the zone: its first occurrence when the clocks repeat it, and when they skip it,
// the instant it would be by the offset before the jump, which lands as far past the jump as the time was into the gap.
export function wall_to_epoch(year: number, month: number, day: number, hour: number, minute: number, zone: string): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute) / 1000;
  const before = offset_at(wall - 86400, zone);
  const after = offset_at(wall + 86400, zone);
  const valid = [...new Set([before, after])].map((offset) => wall - offset).filter((epoch) => wall - offset_at(epoch, zone) === epoch);
  return valid.length > 0 ? Math.min(...valid) : wall - before;
}

// ── Describing ───────────────────────────────────────────────────────────────

// The schedule in words, such as "Every day at 02:00" or "Every 6 hours".
export function describe(expression: ScheduleText | Schedule): string {
  const schedule = typeof expression === "object" ? expression : parse_schedule(expression);
  if (schedule.kind === "interval") return describe_interval(schedule.seconds);
  return describe_calendar(schedule, typeof expression === "object" ? null : String(expression));
}

const interval_units: [seconds: number, name: string][] = [[7 * 86400, "week"], [86400, "day"], [3600, "hour"], [60, "minute"], [1, "second"]];

function describe_interval(seconds: number): string {
  const parts: [count: number, name: string][] = [];
  let remaining = seconds;
  for (const [unit, name] of interval_units) {
    // Weeks only read better when they are whole.
    if (name === "week" && remaining % unit !== 0) continue;
    if (remaining >= unit) {
      parts.push([Math.floor(remaining / unit), name]);
      remaining %= unit;
    }
  }
  if (parts.length === 1 && parts[0][0] === 1) return `Every ${parts[0][1]}`;
  return `Every ${parts.map(([count, name]) => `${count} ${name}${count === 1 ? "" : "s"}`).join(" ")}`;
}

function describe_calendar(schedule: CalendarSchedule, text: string | null): string {
  const every_hour = schedule.hours.length === 24;
  const every_day = schedule.any_day && schedule.any_weekday && schedule.months.length === 12;
  const step = even_step(schedule.minutes, 60);
  if (every_hour && every_day && step !== null && schedule.minutes.length > 1) return step === 1 ? "Every minute" : `Every ${step} minutes`;

  let time: string;
  if (schedule.hours.length === 1 && schedule.minutes.length === 1) time = `at ${pad(schedule.hours[0])}:${pad(schedule.minutes[0])}`;
  else if (every_hour && schedule.minutes.length === 1) time = schedule.minutes[0] === 0 ? "every hour" : `every hour at minute ${schedule.minutes[0]}`;
  else return `On the cron schedule "${text ?? "(custom)"}"`;

  const months = schedule.months.length === 12 ? "" : ` in ${join_words(schedule.months.map((month) => capitalize(month_names[month - 1])))}`;
  const weekdays = join_words(schedule.weekdays.map((day) => capitalize(weekday_names[day])));
  const days = join_words(schedule.days.map(ordinal));
  let when: string;
  if (schedule.any_day && schedule.any_weekday) when = "every day";
  else if (schedule.any_day) when = `every ${weekdays}`;
  else if (schedule.any_weekday) when = schedule.months.length === 12 ? `on the ${days} of every month` : `on the ${days}`;
  else when = `on the ${days} of the month and every ${weekdays}`;

  if (time.startsWith("every hour")) {
    const on = when === "every day" ? "" : ` ${when.startsWith("every ") ? `on ${when.slice("every ".length)}` : when}`;
    return capitalize(`${time}${on}${months}`);
  }
  return capitalize(`${when}${months} ${time}`);
}

// The step between evenly spaced values starting at zero that fill the range, or null when they do not.
function even_step(values: number[], range: number): number | null {
  if (values[0] !== 0) return null;
  const step = values.length > 1 ? values[1] - values[0] : range;
  if (range % step !== 0 || values.length !== range / step) return null;
  return values.every((value, index) => value === index * step) ? step : null;
}

function join_words(words: string[]): string {
  if (words.length <= 2) return words.join(" and ");
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

function ordinal(day: number): string {
  const tens = day % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[day % 10] ?? "th";
  return `${day}${suffix}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
