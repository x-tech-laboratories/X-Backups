// Every run across the repositories, filtered and paged, and one run's page with its outcome and live output.

import { api, query, type Run, type RepositorySummary } from "../api.ts";
import { age, duration, h, now_seconds, stamp } from "../dom.ts";
import { current_route, link, replace_query } from "../router.ts";
import { attempt, crumbs, facts, run_badge, load, pager, section, select, skeleton, toolbar } from "../ui.ts";
import { run_kinds, run_states } from "./repository.ts";
import { run_buttons, runs_table, medians, touches, type View } from "./shared.ts";

const page_size = 50;

// How many finished runs of each kind set the usual duration the bars are drawn against.
const median_sample = 500;

const periods: [value: string, text: string][] = [["", "Any time"], ["1", "Last 24 hours"], ["7", "Last 7 days"], ["30", "Last 30 days"]];

export function runs_view(): View {
  const route_query = current_route().query;
  let repository = route_query.get("repository") ?? "";
  let kind = route_query.get("kind") ?? "";
  let state = route_query.get("state") ?? "";
  let days = route_query.get("days") ?? "";
  let page = Number(route_query.get("page") ?? 1);
  const repository_filter = h("span");
  const list = h("div", {}, skeleton(8));
  let usual = new Map<string, number>();

  const refresh = async (quiet: boolean) => {
    await load(list, async () => {
      const since = days ? Math.floor(now_seconds() - Number(days) * 86400) : null;
      const [runs, sample] = await Promise.all([
        api<Run[]>(`/api/runs${query({ target: repository, kind, state, since, limit: page_size + 1, offset: (page - 1) * page_size })}`),
        usual.size === 0 ? api<Run[]>(`/api/runs${query({ state: "succeeded", limit: median_sample })}`) : Promise.resolve(null),
      ]);
      if (sample !== null) usual = medians(sample);
      return [
        runs_table(runs.slice(0, page_size), { with_repository: true, refresh: () => void refresh(true), usual }),
        pager(page, runs.length > page_size, (next) => { page = next; replace_query({ page: next === 1 ? null : next }); void refresh(false); }),
      ];
    }, { quiet });
  };
  const refilter = () => {
    page = 1;
    replace_query({ repository, kind, state, days, page: null });
    void refresh(false);
  };

  void api<RepositorySummary[]>("/api/repositories").then((repositories) => {
    repository_filter.replaceChildren(select("Repository", [["", "Any repository"], ...repositories.map((item): [string, string] => [item.id, item.name])], repository,
      (value) => { repository = value; refilter(); }));
  }).catch(() => {});
  void refresh(false);

  return {
    title: "Runs",
    root: h("div", { class: "page" },
      h("h1", {}, "Runs"),
      toolbar(
        repository_filter,
        select("Kind", run_kinds, kind, (value) => { kind = value; refilter(); }),
        select("Outcome", run_states, state, (value) => { state = value; refilter(); }),
        select("Started", periods, days, (value) => { days = value; refilter(); }),
      ),
      list,
    ),
    update: async (changes) => {
      if (touches(changes, null, ["run"])) await refresh(true);
    },
  };
}

// ── One run ──────────────────────────────────────────────────────────────────

const result_text: Record<Run["state"], string> = {
  running: "Running",
  succeeded: "Finished",
  warning: "Finished with warnings",
  failed: "Failed",
  cancelled: "Cancelled",
};

const result_tones: Record<Run["state"], string> = { running: "info", succeeded: "good", warning: "warn", failed: "bad", cancelled: "none" };

export function run_view(run_id: number): View {
  const head = h("div", {}, skeleton(3));
  const text = h("pre", { class: "output run-output", tabindex: "0", "aria-label": "Run output" });
  const output_note = h("p", { class: "muted small" });
  let lines = 0;
  let following = true;

  const update = async (quiet: boolean): Promise<void> => {
    const run = await attempt(head, quiet, () => api<Run>(`/api/runs/${run_id}${query({ skip: lines })}`), () => void update(false));
    if (run === null) return;
    head.replaceChildren(run_head(run, () => void update(true)));
    const fresh = (run.output ?? []).map(readable_line).filter((line): line is string => line !== null);
    lines += run.output?.length ?? 0;
    if (fresh.length > 0) {
      // Only a reader already at the bottom is carried along, so scrolling up to read is not undone.
      following = text.scrollTop + text.clientHeight >= text.scrollHeight - 8;
      text.textContent += (text.textContent ? "\n" : "") + fresh.join("\n");
      if (following) text.scrollTop = text.scrollHeight;
    }
    output_note.textContent = lines === 0
      ? run.state === "running" ? "No output yet; it arrives with each poll of the run." : "This run wrote no output."
      : run.state === "running" ? "Updates as the run writes." : "";
  };
  void update(false);

  return {
    title: `Run #${run_id}`,
    root: h("div", { class: "page" },
      crumbs([["Runs", link(["runs"])], [`#${run_id}`, null]]),
      head,
      section("Output", h("div", {}, output_note, text),
        h("button", { onclick: () => void navigator.clipboard?.writeText(text.textContent ?? "") }, "Copy")),
    ),
    update: async (changes) => {
      if (changes === null || changes.some((change) => change.kind === "run" && change.run_id === run_id)) await update(true);
    },
  };
}

function run_head(run: Run, refresh: () => void): HTMLElement {
  const took = (run.ended_epoch ?? now_seconds()) - run.started_epoch;
  return h("header", { class: "page-head" },
    h("div", { class: "page-title" },
      h("h1", {}, `${run.kind} #${run.id}`),
      run_badge(run.state),
      h("a", { href: link(["repositories", run.target_id]) }, `on ${run.target_id}`),
    ),
    h("div", { class: `result-bar tone-fill-${result_tones[run.state]}`, role: "status", "aria-live": "polite" },
      `${result_text[run.state]}${run.state === "running" ? ` for ${duration(took)}` : ` after ${duration(took)}`}`,
      run.progress && run.state === "running" ? ` · ${run.progress}` : "",
      run.error ? ` · ${run.error}` : "",
    ),
    facts([
      ["Started", h("span", { title: stamp(run.started_epoch) }, `${stamp(run.started_epoch)} (${age(run.started_epoch)})`)],
      ["Ended", run.ended_epoch ? stamp(run.ended_epoch) : "still running"],
      ["Exit code", run.exit_code ?? "—"],
    ]),
    h("details", { class: "command" }, h("summary", {}, "Command"), h("pre", { class: "output" }, run.command)),
    h("div", { class: "head-actions" }, run_buttons(run, refresh)),
  );
}

// Shows a borg JSON log line as its message, leaves other lines as they are, and drops progress lines.
function readable_line(line: string): string | null {
  if (!line.startsWith("{")) return line;
  try {
    const entry = JSON.parse(line);
    if (entry.type === "log_message") return entry.message;
    if (entry.type === "file_status") return `${entry.status} ${entry.path}`;
    return null;
  } catch {
    return line;
  }
}
