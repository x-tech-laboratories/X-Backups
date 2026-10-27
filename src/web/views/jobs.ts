// Every job across the repositories, filtered and paged, and one job's page with its outcome and live output.

import { api, query, type Job, type RepositorySummary } from "../api.ts";
import { age, duration, h, now_seconds, stamp } from "../dom.ts";
import { current_route, link, replace_query } from "../router.ts";
import { attempt, crumbs, facts, job_badge, load, pager, section, select, skeleton, toolbar } from "../ui.ts";
import { job_kinds, job_states } from "./repository.ts";
import { job_buttons, jobs_table, medians, touches, type View } from "./shared.ts";

const page_size = 50;

// How many finished jobs of each kind set the usual duration the bars are drawn against.
const median_sample = 500;

const periods: [value: string, text: string][] = [["", "Any time"], ["1", "Last 24 hours"], ["7", "Last 7 days"], ["30", "Last 30 days"]];

export function jobs_view(): View {
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
      const [jobs, sample] = await Promise.all([
        api<Job[]>(`/api/jobs${query({ repository, kind, state, since, limit: page_size + 1, offset: (page - 1) * page_size })}`),
        usual.size === 0 ? api<Job[]>(`/api/jobs${query({ state: "succeeded", limit: median_sample })}`) : Promise.resolve(null),
      ]);
      if (sample !== null) usual = medians(sample);
      return [
        jobs_table(jobs.slice(0, page_size), { with_repository: true, refresh: () => void refresh(true), usual }),
        pager(page, jobs.length > page_size, (next) => { page = next; replace_query({ page: next === 1 ? null : next }); void refresh(false); }),
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
    title: "Jobs",
    root: h("div", { class: "page" },
      h("h1", {}, "Jobs"),
      toolbar(
        repository_filter,
        select("Kind", job_kinds, kind, (value) => { kind = value; refilter(); }),
        select("Outcome", job_states, state, (value) => { state = value; refilter(); }),
        select("Started", periods, days, (value) => { days = value; refilter(); }),
      ),
      list,
    ),
    update: async (changes) => {
      if (touches(changes, null, ["job"])) await refresh(true);
    },
  };
}

// ── One job ──────────────────────────────────────────────────────────────────

const result_text: Record<Job["state"], string> = {
  running: "Running",
  succeeded: "Finished",
  warning: "Finished with warnings",
  failed: "Failed",
  cancelled: "Cancelled",
};

const result_tones: Record<Job["state"], string> = { running: "info", succeeded: "good", warning: "warn", failed: "bad", cancelled: "none" };

export function job_view(job_id: number): View {
  const head = h("div", {}, skeleton(3));
  const text = h("pre", { class: "output job-output", tabindex: "0", "aria-label": "Job output" });
  const output_note = h("p", { class: "muted small" });
  let lines = 0;
  let following = true;

  const update = async (quiet: boolean): Promise<void> => {
    const job = await attempt(head, quiet, () => api<Job>(`/api/jobs/${job_id}${query({ skip: lines })}`), () => void update(false));
    if (job === null) return;
    head.replaceChildren(job_head(job, () => void update(true)));
    const fresh = (job.output ?? []).map(readable_line).filter((line): line is string => line !== null);
    lines += job.output?.length ?? 0;
    if (fresh.length > 0) {
      // Only a reader already at the bottom is carried along, so scrolling up to read is not undone.
      following = text.scrollTop + text.clientHeight >= text.scrollHeight - 8;
      text.textContent += (text.textContent ? "\n" : "") + fresh.join("\n");
      if (following) text.scrollTop = text.scrollHeight;
    }
    output_note.textContent = lines === 0
      ? job.state === "running" ? "No output yet; it arrives with each poll of the job." : "This job wrote no output."
      : job.state === "running" ? "Updates as the job writes." : "";
  };
  void update(false);

  return {
    title: `Job #${job_id}`,
    root: h("div", { class: "page" },
      crumbs([["Jobs", link(["jobs"])], [`#${job_id}`, null]]),
      head,
      section("Output", h("div", {}, output_note, text),
        h("button", { onclick: () => void navigator.clipboard?.writeText(text.textContent ?? "") }, "Copy")),
    ),
    update: async (changes) => {
      if (changes === null || changes.some((change) => change.kind === "job" && change.job_id === job_id)) await update(true);
    },
  };
}

function job_head(job: Job, refresh: () => void): HTMLElement {
  const took = (job.ended_epoch ?? now_seconds()) - job.started_epoch;
  return h("header", { class: "page-head" },
    h("div", { class: "page-title" },
      h("h1", {}, `${job.kind} #${job.id}`),
      job_badge(job.state),
      h("a", { href: link(["repositories", job.repository_id]) }, `on ${job.repository_id}`),
    ),
    h("div", { class: `result-bar tone-fill-${result_tones[job.state]}`, role: "status", "aria-live": "polite" },
      `${result_text[job.state]}${job.state === "running" ? ` for ${duration(took)}` : ` after ${duration(took)}`}`,
      job.progress && job.state === "running" ? ` · ${job.progress}` : "",
      job.error ? ` · ${job.error}` : "",
    ),
    facts([
      ["Started", h("span", { title: stamp(job.started_epoch) }, `${stamp(job.started_epoch)} (${age(job.started_epoch)})`)],
      ["Ended", job.ended_epoch ? stamp(job.ended_epoch) : "still running"],
      ["Exit code", job.exit_code ?? "—"],
    ]),
    h("details", { class: "command" }, h("summary", {}, "Command"), h("pre", { class: "output" }, job.command)),
    h("div", { class: "head-actions" }, job_buttons(job, refresh)),
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
