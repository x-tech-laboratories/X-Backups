// Every run across the targets, filtered by target, host, job, task, kind, outcome and period and paged, and one run's
// page with its outcome and live output.

import { FollowingOutput } from "@x-tech-laboratories/x-libs/web/react/following";
import { Crumbs, Facts, PageHeading, Section, Toolbar } from "@x-tech-laboratories/x-libs/web/react/layout";
import { Select } from "@x-tech-laboratories/x-libs/web/react/controls";
import { Loaded, use_resource } from "@x-tech-laboratories/x-libs/web/react/states";
import { Pager } from "@x-tech-laboratories/x-libs/web/react/table";
import { age, duration, now_seconds, stamp } from "@x-tech-laboratories/x-libs/web/format";
import { current_route, link, replace_query } from "@x-tech-laboratories/x-libs/web/router";
import { useEffect, useRef, useState } from "react";
import { api, query, type HostRow, type JobRow, type Run, type RepositorySummary, type TaskView } from "../api.ts";
import { RunStateBadge, use_changes } from "../ui.tsx";
import { medians, run_kinds, run_states, RunButtons, RunsTable, touches } from "./shared.tsx";
import { task_label } from "./tasks.tsx";

const page_size = 50;

// How many finished runs of each kind set the usual duration the bars are drawn against.
const median_sample = 500;

const periods: [value: string, text: string][] = [["", "Any time"], ["1", "Last 24 hours"], ["7", "Last 7 days"], ["30", "Last 30 days"]];

type Filter = "repository" | "host" | "job" | "task" | "kind" | "state" | "days";

const filter_names: Filter[] = ["repository", "host", "job", "task", "kind", "state", "days"];

// ── Runs ─────────────────────────────────────────────────────────────────────

export function RunsView() {
  const [filters, set_filters] = useState<Record<Filter, string>>(() => {
    const route_query = current_route().query;
    return Object.fromEntries(filter_names.map((name) => [name, route_query.get(name) ?? ""])) as Record<Filter, string>;
  });
  const [page, set_page] = useState(() => Number(current_route().query.get("page") ?? 1));
  const usual = useRef(new Map<string, number>());

  const runs = use_resource(async () => {
    const { repository, host, job, task, kind, state, days } = filters;
    const since = days ? Math.floor(now_seconds() - Number(days) * 86400) : null;
    const [rows, sample] = await Promise.all([
      api<Run[]>(`/api/runs${query({ target: repository, host, job, task, kind, state, since, limit: page_size + 1, offset: (page - 1) * page_size })}`),
      usual.current.size === 0 ? api<Run[]>(`/api/runs${query({ state: "succeeded", limit: median_sample })}`) : Promise.resolve(null),
    ]);
    if (sample !== null) usual.current = medians(sample);
    return rows;
  }, [filters, page]);
  use_changes((changes) => { if (touches(changes, null, ["run"])) runs.reload(true); });

  const repositories = use_resource(() => api<RepositorySummary[]>("/api/repositories"), []);
  const hosts = use_resource(() => api<HostRow[]>("/api/hosts"), []);
  const jobs = use_resource(() => api<JobRow[]>("/api/jobs"), []);
  const tasks = use_resource(() => api<TaskView[]>("/api/tasks"), []);

  const refilter = (name: Filter) => (value: string) => {
    const next = { ...filters, [name]: value };
    set_filters(next);
    set_page(1);
    replace_query({ ...next, page: null });
  };

  const task_options = (tasks.data ?? []).map((item): [string, string] => [item.id, `${task_label(item)} of ${item.owner}`]);
  if (filters.task && !task_options.some(([id]) => id === filters.task)) task_options.push([filters.task, filters.task]);

  return (
    <div className="page">
      <h1>Runs</h1>
      <Toolbar>
        <span>{repositories.data && <Select label="Target" options={[["", "Any target"], ...repositories.data.map((item): [string, string] => [item.id, item.name])]} value={filters.repository} on_change={refilter("repository")} />}</span>
        <span>{hosts.data && <Select label="Host" options={[["", "Any host"], ...hosts.data.map((item): [string, string] => [item.name, item.name])]} value={filters.host} on_change={refilter("host")} />}</span>
        <span>{jobs.data && <Select label="Job" options={[["", "Any job"], ...jobs.data.map((item): [string, string] => [item.name, item.name])]} value={filters.job} on_change={refilter("job")} />}</span>
        <span>{tasks.data && <Select label="Task" options={[["", "Any task"], ...task_options]} value={filters.task} on_change={refilter("task")} />}</span>
        <Select label="Kind" options={run_kinds} value={filters.kind} on_change={refilter("kind")} />
        <Select label="Outcome" options={run_states} value={filters.state} on_change={refilter("state")} />
        <Select label="Started" options={periods} value={filters.days} on_change={refilter("days")} />
      </Toolbar>
      <div>
        <Loaded resource={runs} lines={8}>
          {(rows) => <>
            <RunsTable runs={rows.slice(0, page_size)} with_repository refresh={() => runs.reload(true)} usual={usual.current} />
            <Pager page={page} has_more={rows.length > page_size} go={(next) => { set_page(next); replace_query({ page: next === 1 ? null : next }); }} />
          </>}
        </Loaded>
      </div>
    </div>
  );
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

export function RunView({ id }: { id: number }) {
  // How many output lines have arrived, so each poll asks only for the ones after.
  const lines = useRef(0);
  const [output, set_output] = useState("");
  const run = use_resource(() => api<Run>(`/api/runs/${id}${query({ skip: lines.current })}`), [id]);
  use_changes((changes) => {
    if (changes === null || changes.some((change) => change.kind === "run" && change.run_id === id)) run.reload(true);
  });

  useEffect(() => {
    if (run.data === null) return;
    const fresh = (run.data.output ?? []).map(readable_line).filter((line): line is string => line !== null);
    lines.current += run.data.output?.length ?? 0;
    if (fresh.length === 0) return;
    set_output((before) => before + (before ? "\n" : "") + fresh.join("\n"));
  }, [run.data]);

  const state = run.data;
  const note = state === null ? "" : lines.current === 0
    ? state.state === "running" ? "No output yet; it arrives with each poll of the run." : "This run wrote no output."
    : state.state === "running" ? "Updates as the run writes." : "";

  return (
    <div className="page">
      <Crumbs items={[["Runs", link(["runs"])], [`#${id}`, null]]} />
      <div><Loaded resource={run} lines={3}>{(row) => <RunHead run={row} refresh={() => run.reload(true)} />}</Loaded></div>
      <Section title="Output" tools={<button onClick={() => void navigator.clipboard?.writeText(output)}>Copy</button>}>
        <div>
          <p className="muted small">{note}</p>
          <FollowingOutput text={output} class_name="run-output" />
        </div>
      </Section>
    </div>
  );
}

function RunHead({ run, refresh }: { run: Run; refresh: () => void }) {
  const took = (run.ended_epoch ?? now_seconds()) - run.started_epoch;
  return (
    <PageHeading title={`${run.kind} #${run.id}`} subtitle={<span className="chips"><RunStateBadge run={run} /><a href={link(["repositories", run.target_id])}>{`on ${run.target_id}`}</a></span>}
      actions={<RunButtons run={run} refresh={refresh} />}>
      <div className={`result-bar tone-fill-${run.condition === "waiting_for_agent" ? "warn" : result_tones[run.state]}`} role="status" aria-live="polite">
        {run.condition === "waiting_for_agent" ? `Waiting for ${run.host ?? "its host"}'s agent; the run carries on there, started ${duration(took)} ago`
          : run.condition === "lost" ? `Lost after ${duration(took)}: its agent no longer knew it, so its outcome is unknown`
            : `${result_text[run.state]}${run.state === "running" ? ` for ${duration(took)}` : ` after ${duration(took)}`}`}
        {run.progress && run.state === "running" && run.condition === null ? ` · ${run.progress}` : ""}
        {run.error && run.condition === null ? ` · ${run.error}` : ""}
      </div>
      <Facts rows={[
        ["Task", run.task === null ? "started by hand" : <a href={link(["runs"], { task: run.task })}>{run.task}</a>],
        ["Job", run.job === null ? "—" : <a href={link(["jobs", run.job])}>{run.job}</a>],
        ["Host", run.host === null ? "—" : <a href={link(["hosts", run.host])}>{run.host}</a>],
        ["Started", <span title={stamp(run.started_epoch)}>{`${stamp(run.started_epoch)} (${age(run.started_epoch)})`}</span>],
        ["Ended", run.ended_epoch ? stamp(run.ended_epoch) : "still running"],
        ["Exit code", run.exit_code ?? "—"],
      ]} />
      <details className="command"><summary>Command</summary><pre className="output">{run.command}</pre></details>
    </PageHeading>
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
