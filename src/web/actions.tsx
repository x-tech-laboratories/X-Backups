// Runs a repository's actions from any page: what each does, how it is confirmed, and how its outcome is shown.

import { describe_error } from "@x-tech-laboratories/x-libs/web/errors";
import { confirm_dialog, Dialog, open_dialog, text_dialog } from "@x-tech-laboratories/x-libs/web/react/dialog";
import { toast } from "@x-tech-laboratories/x-libs/web/react/toasts";
import { link } from "@x-tech-laboratories/x-libs/web/router";
import { useState } from "react";
import { api, query, repository_path, type Action, type Run, type Outcome } from "./api.ts";

// One sentence per action on what it does, shown beside its button.
export const action_descriptions: Record<string, string> = {
  run_backup: "Back up the source paths now, as the host's own job would.",
  dry_run_backup: "List what a backup would store, without writing anything.",
  verify_restore: "Restore the canary file from the newest archive and compare it with the live copy.",
  check_repo: "Verify the repository's segments and archive metadata; a data check also reads every chunk.",
  compact_repo: "Free the space that pruned and deleted archives left behind.",
  prune_preview: "List which archives the retention policy would keep and drop, changing nothing.",
  prune_repo: "Delete the archives the retention policy drops. Run Prune Preview first.",
  purge_preview: "List the files the exclude patterns now drop from older archives, changing nothing.",
  purge_excluded: "Rewrite every archive without the files the excludes now drop, then compact.",
  break_lock: "Remove a lock left by a borg process that died. Only when nothing is running.",
};

// Actions that change the repository for good ask for its name to be typed before they run.
const typed_actions = new Set(["purge_excluded", "break_lock"]);

const check_kinds: [kind: string, text: string][] = [
  ["all", "Repository and archives"],
  ["repository", "Repository only"],
  ["archives", "Archives only"],
  ["data", "Verify all data (slow)"],
  ["extract", "Extract the newest archive to nowhere"],
];

export interface ActionTarget {
  target_id: string;
  repository_name: string;
  // Called once the action has answered, so the page can refresh what it shows.
  done?: () => Promise<unknown> | void;
}

// Starts the action the button stands for, asking first when the action says it needs asking.
export function start_action(target: ActionTarget, action: Action): void {
  if (action.action_id === "check_repo") return choose_check(target);
  if (action.confirm) {
    confirm_dialog({
      title: `${action.name}?`,
      message: action.confirm,
      confirm_label: action.name,
      busy_label: "Starting…",
      danger: true,
      type_to_confirm: typed_actions.has(action.action_id) ? target.repository_name : undefined,
      run: () => run_action(target, action.action_id, action.name),
    });
    return;
  }
  void run_action(target, action.action_id, action.name);
}

function choose_check(target: ActionTarget): void {
  open_dialog((close) => <CheckDialog target={target} close={close} />);
}

function CheckDialog({ target, close }: { target: ActionTarget; close: () => void }) {
  const [kind, set_kind] = useState(check_kinds[0][0]);
  return (
    <Dialog title="Check the repository" on_close={close} buttons={<>
      <button onClick={close}>Cancel</button>
      <button className="accent solid" onClick={() => { close(); void run_action(target, "check_repo", "Check", { kind }); }}>Start check</button>
    </>}>
      <p>{action_descriptions.check_repo}</p>
      <label className="field">
        <span className="field-label">What to check</span>
        <select aria-label="What to check" value={kind} onChange={(event) => set_kind((event.currentTarget as HTMLSelectElement).value)}>
          {check_kinds.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
        </select>
      </label>
    </Dialog>
  );
}

export async function run_action(target: ActionTarget, action_id: string, name: string, body: object = {}): Promise<void> {
  try {
    const outcome = await api<Outcome>(`${repository_path(target.target_id)}/actions/${action_id}`, body);
    await show_outcome(target.target_id, name, outcome);
  } catch (error) {
    toast(`${name} failed: ${describe_error(error)}`, { tone: "bad" });
  }
  await target.done?.();
}

// A short answer becomes a toast, linking to the run it started; a long one, such as a preview, opens in a dialog.
export async function show_outcome(target_id: string, name: string, outcome: Outcome): Promise<void> {
  const text = outcome.content ?? outcome.logs.map(([message]) => message).join("\n");
  if (text.includes("\n")) {
    text_dialog(name, text);
    return;
  }
  let run_link: { href: string; text: string } | undefined;
  if (outcome.success && / started\b/.test(text)) {
    const [run] = await api<Run[]>(`/api/runs${query({ target: target_id, limit: 1 })}`).catch(() => []);
    if (run?.state === "running") run_link = { href: link(["runs", String(run.id)]), text: "Follow it" };
  }
  toast(text || `${name} done.`, { tone: outcome.success ? "good" : "bad", link: run_link });
}
