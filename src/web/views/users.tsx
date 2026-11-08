// Who may log in: an admin's list of users and API tokens, and each user's own password and second factor.

import { Chip } from "@x-tech-laboratories/x-libs/web/react/badges";
import { confirm_dialog, Dialog, open_dialog } from "@x-tech-laboratories/x-libs/web/react/dialog";
import { Facts, PageHeading, Section } from "@x-tech-laboratories/x-libs/web/react/layout";
import { Empty, Loaded, use_resource } from "@x-tech-laboratories/x-libs/web/react/states";
import { DataTable } from "@x-tech-laboratories/x-libs/web/react/table";
import { toast } from "@x-tech-laboratories/x-libs/web/react/toasts";
import { Age } from "@x-tech-laboratories/x-libs/web/react/time";
import { age, stamp } from "@x-tech-laboratories/x-libs/web/format";
import { useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { api, ApiError, send, type RepositorySummary } from "../api.ts";
import { can, load_me, me, type Grant, type Me, type Role } from "../session.ts";
import type { Refresh } from "./shared.tsx";

interface User {
  name: string;
  role: Role;
  grants: Grant[] | null;
  totp_enabled: boolean;
  has_password: boolean;
  source: "declared" | "page";
  created_epoch: number;
}

interface Token {
  id: number;
  name: string;
  created_by: string;
  created_epoch: number;
  last_used_epoch: number | null;
}

const role_text: Record<Role, string> = {
  viewer: "Sees the jobs it is granted; changes nothing.",
  operator: "Also runs actions, restores and downloads, and reads archive contents.",
  admin: "Also changes the config, users and API tokens.",
};

// What a user can be granted: each job with the repositories it writes to, and each repository no job writes to.
interface Grantable {
  jobs: { name: string; repositories: string[] }[];
  repositories: string[];
}

const tokens_path = "/api/tokens";

// ── Users ────────────────────────────────────────────────────────────────────

export function UsersView() {
  if (!can("admin")) {
    return (
      <div className="page">
        <PageHeading title="Users" />
        <Section title="Users"><div><Empty title="Only an admin manages users." /></div></Section>
        <Section title="API tokens">
          <div className="stack">
            <TokensNote />
            <div><button onClick={() => token_dialog(() => {})}>Create token</button></div>
            <div />
          </div>
        </Section>
      </div>
    );
  }
  return <AdminUsers />;
}

function TokensNote() {
  return <p className="muted small">A token reads what a viewer of everything reads, and the Prometheus metrics at /metrics; it changes nothing. Send it as Authorization: Bearer &lt;token&gt;.</p>;
}

function AdminUsers() {
  const grantable = use_resource(async () => grantable_of(await api<RepositorySummary[]>("/api/repositories").catch(() => [])), []);
  const users = use_resource(() => api<User[]>("/api/users"), []);
  const tokens = use_resource(() => api<Token[]>(tokens_path), []);
  const refresh = () => Promise.all([grantable.reload(true), users.reload(true), tokens.reload(true)]);
  const choices = grantable.data ?? { jobs: [], repositories: [] };

  return (
    <div className="page">
      <PageHeading title="Users" actions={<button className="accent solid" onClick={() => user_dialog(null, choices, refresh)}>Add user</button>} />
      <Section title="Users">
        <div><Loaded resource={users} lines={4}>{(rows) => <UsersTable users={rows} grantable={choices} refresh={refresh} />}</Loaded></div>
      </Section>
      <Section title="API tokens">
        <div className="stack">
          <TokensNote />
          <div><button onClick={() => token_dialog(refresh)}>Create token</button></div>
          <div><Loaded resource={tokens} lines={2}>{(rows) => <TokensTable tokens={rows} refresh={refresh} />}</Loaded></div>
        </div>
      </Section>
    </div>
  );
}

// The jobs and the repositories no job writes to, from the targets an admin sees.
function grantable_of(targets: RepositorySummary[]): Grantable {
  const jobs = new Map<string, Set<string>>();
  const repositories = new Set<string>();
  for (const target of targets) {
    if (target.job === null) repositories.add(target.repository);
    else jobs.set(target.job, (jobs.get(target.job) ?? new Set()).add(target.repository));
  }
  return {
    jobs: [...jobs].map(([name, written]) => ({ name, repositories: [...written].sort() })).sort((left, right) => left.name.localeCompare(right.name)),
    repositories: [...repositories].sort(),
  };
}

// What the grants show, in words.
function grants_text(grants: Grant[] | null): string {
  if (grants === null) return "everything";
  if (grants.length === 0) return "nothing";
  const jobs = grants.flatMap((grant) => "job" in grant ? [grant.job] : []);
  const repositories = grants.flatMap((grant) => "repository" in grant ? [grant.repository] : []);
  return [jobs.length > 0 && `jobs ${jobs.join(", ")}`, repositories.length > 0 && `repositories ${repositories.join(", ")}`].filter(Boolean).join("; ");
}

function UsersTable({ users, grantable, refresh }: { users: User[]; grantable: Grantable; refresh: Refresh }) {
  return (
    <DataTable<User> rows={users} row_key={(user) => user.name} caption="Users" columns={[
      { label: "Name", cell: (user) => <><strong>{user.name}</strong>{user.name === me()?.name && <span className="muted small"> (you)</span>}</> },
      { label: "Role", cell: (user) => <Chip title={role_text[user.role]}>{user.role}</Chip> },
      { label: "Access", cell: (user) => grants_text(user.grants) },
      { label: "Second factor", cell: (user) => user.totp_enabled ? "on" : <span className="muted">off</span> },
      {
        label: "Login", cell: (user) => user.source === "declared"
          ? <Chip title="Its password is the hash file X-Backups is deployed with">declared</Chip>
          : user.has_password ? "password" : <span className="muted">single sign-on only</span>,
      },
      {
        id: "actions", label: "", class: "actions-cell", cell: (user) => (
          <span className="row-actions">
            {user.source === "page" && <button onClick={() => user_dialog(user, grantable, refresh)}>Edit</button>}
            {user.totp_enabled && <button onClick={() => reset_totp(user, refresh)}>Reset second factor</button>}
            {user.source === "page" && user.name !== me()?.name && <button className="danger" onClick={() => remove_user(user, refresh)}>Remove</button>}
          </span>
        ),
      },
    ]} />
  );
}

// Adds a user, or edits one when given; a password left empty on an edit stays as it was.
function user_dialog(user: User | null, grantable: Grantable, refresh: () => void): void {
  open_dialog((close) => <UserDialog user={user} grantable={grantable} refresh={refresh} close={close} />);
}

interface UserDialogProps {
  user: User | null;
  grantable: Grantable;
  refresh: () => void;
  close: () => void;
}

function UserDialog({ user, grantable, refresh, close }: UserDialogProps) {
  const held = user?.grants ?? [];
  const held_jobs = held.flatMap((grant) => "job" in grant ? [grant.job] : []);
  const held_repositories = held.flatMap((grant) => "repository" in grant ? [grant.repository] : []);
  const [name, set_name] = useState(user?.name ?? "");
  const [role, set_role] = useState<Role>(user?.role ?? "viewer");
  const [all, set_all] = useState(user === null || user.grants === null);
  const [picked_jobs, set_picked_jobs] = useState(() => new Set(held_jobs));
  const [picked_repositories, set_picked_repositories] = useState(() => new Set(held_repositories));
  const [password, set_password] = useState("");
  const [message, set_message] = useState("");
  const [busy, set_busy] = useState(false);

  // A grant on something no longer configured stays listed, so saving keeps it unless it is unticked.
  const jobs = [
    ...grantable.jobs,
    ...held_jobs.filter((job_name) => !grantable.jobs.some((job) => job.name === job_name)).map((job_name) => ({ name: job_name, repositories: [] })),
  ];
  const repositories = [...grantable.repositories, ...held_repositories.filter((repository) => !grantable.repositories.includes(repository))];

  const toggle = (picks: Set<string>, set_picks: (picks: Set<string>) => void, value: string, on: boolean) => {
    const next = new Set(picks);
    if (on) next.add(value);
    else next.delete(value);
    set_picks(next);
  };
  const checked = (event: ChangeEvent<HTMLInputElement>) => event.currentTarget.checked;
  const typed = (event: ChangeEvent<HTMLInputElement>) => event.currentTarget.value;

  async function save(): Promise<void> {
    const body = {
      name: name.trim(), role,
      grants: all ? null : [
        ...jobs.filter((job) => picked_jobs.has(job.name)).map((job) => ({ job: job.name })),
        ...repositories.filter((repository) => picked_repositories.has(repository)).map((repository) => ({ repository })),
      ],
      password,
    };
    set_busy(true);
    try {
      if (user) await send("PUT", `/api/users/${encodeURIComponent(user.name)}`, body);
      else await api("/api/users", body);
      toast(user ? `${user.name} saved; their open sessions were ended.` : `${body.name} added.`, { tone: "good" });
      close();
      refresh();
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      set_message(error.message);
      set_busy(false);
    }
  }

  return (
    <Dialog title={user ? `Edit ${user.name}` : "Add a user"} on_close={close} buttons={<>
      <button onClick={close}>Cancel</button>
      <button className="accent solid" disabled={busy} onClick={() => void save()}>{user ? "Save" : "Add user"}</button>
    </>}>
      <div className="form-rows">
        <FormRow label="Name">
          <div>
            <input type="text" value={name} readOnly={user !== null} autoComplete="off" autoCapitalize="none" aria-label="User name" autoFocus={user === null} onChange={(event) => set_name(typed(event))} />
            <p className="muted small">Lowercase letters, digits, '.', '_' or '-'. Single sign-on matches it against the provider's user name.</p>
          </div>
        </FormRow>
        <FormRow label="Role">
          <div>
            <select aria-label="Role" value={role} autoFocus={user !== null} onChange={(event) => set_role((event.currentTarget as HTMLSelectElement).value as Role)}>
              {(["viewer", "operator", "admin"] as Role[]).map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
            <p className="muted small">{role_text[role]}</p>
          </div>
        </FormRow>
        <FormRow label="Access">
          <div>
            <label className="check"><input type="checkbox" checked={all} onChange={(event) => set_all(checked(event))} /> Everything, including jobs added later</label>
            <p className="muted small">A job shows its targets, runs and archives, and the sources, repositories and hosts it uses. Compacting, checking or deleting from a repository needs every job writing there.</p>
            <div className="check-list" hidden={all}>
              <fieldset className="check-group">
                <legend>Jobs</legend>
                {jobs.length === 0 ? <p className="muted small">No jobs are configured.</p> : jobs.map((job) => (
                  <label key={job.name} className="check">
                    <input type="checkbox" value={job.name} checked={picked_jobs.has(job.name)} onChange={(event) => toggle(picked_jobs, set_picked_jobs, job.name, checked(event))} />
                    {` ${job.name}`}
                    {job.repositories.length > 0 && <span className="muted small">{` to ${job.repositories.join(", ")}`}</span>}
                  </label>
                ))}
              </fieldset>
              {repositories.length > 0 && (
                <fieldset className="check-group">
                  <legend>Repositories no job writes to</legend>
                  {repositories.map((repository) => (
                    <label key={repository} className="check">
                      <input type="checkbox" value={repository} checked={picked_repositories.has(repository)} onChange={(event) => toggle(picked_repositories, set_picked_repositories, repository, checked(event))} />
                      {` ${repository}`}
                    </label>
                  ))}
                </fieldset>
              )}
            </div>
          </div>
        </FormRow>
        <FormRow label="Password">
          <input type="password" autoComplete="new-password" aria-label="Password" placeholder={user ? "leave empty to keep it" : "at least 12 characters, or empty for single sign-on only"} value={password} onChange={(event) => set_password(typed(event))} />
        </FormRow>
        <p className="tone-bad small" role="alert">{message}</p>
      </div>
    </Dialog>
  );
}

function remove_user(user: User, refresh: Refresh): void {
  confirm_dialog({
    title: `Remove ${user.name}?`,
    message: "They are logged out at once and can no longer log in. What they did stays in the events.",
    confirm_label: "Remove user",
    busy_label: "Removing…",
    danger: true,
    type_to_confirm: user.name,
    run: async () => {
      await send("DELETE", `/api/users/${encodeURIComponent(user.name)}`);
      toast(`${user.name} removed.`, { tone: "warn" });
      await refresh();
    },
  });
}

function reset_totp(user: User, refresh: Refresh): void {
  confirm_dialog({
    title: `Reset ${user.name}'s second factor?`,
    message: "Their authenticator app and recovery codes stop working, and they log in with the password alone until they set it up again. Do this when they have lost their phone.",
    confirm_label: "Reset second factor",
    danger: true,
    run: async () => {
      await api(`/api/users/${encodeURIComponent(user.name)}/totp/reset`, {});
      toast(`${user.name}'s second factor was reset.`, { tone: "warn" });
      await refresh();
    },
  });
}

// ── Tokens ───────────────────────────────────────────────────────────────────

function TokensTable({ tokens, refresh }: { tokens: Token[]; refresh: Refresh }) {
  if (tokens.length === 0) return <Empty title="No API tokens." hint="Create one for a Prometheus scraper or a script that only reads." />;
  return (
    <DataTable<Token> rows={tokens} row_key={(token) => token.id} caption="API tokens" columns={[
      { label: "Name", cell: (token) => token.name },
      { label: "Created", cell: (token) => <span title={stamp(token.created_epoch)}>{`${age(token.created_epoch)} by ${token.created_by}`}</span> },
      { label: "Last used", cell: (token) => token.last_used_epoch ? <Age epoch={token.last_used_epoch} /> : <span className="muted">never</span> },
      {
        id: "actions", label: "", class: "actions-cell", cell: (token) => (
          <button className="danger" onClick={() => confirm_dialog({
            title: `Revoke ${token.name}?`,
            message: "Whatever uses it is refused from now on.",
            confirm_label: "Revoke",
            danger: true,
            run: async () => {
              await send("DELETE", `${tokens_path}/${token.id}`);
              await refresh();
            },
          })}>Revoke</button>
        ),
      },
    ]} />
  );
}

function token_dialog(refresh: () => void): void {
  open_dialog((close) => <TokenDialog refresh={refresh} close={close} />);
}

function TokenDialog({ refresh, close }: { refresh: () => void; close: () => void }) {
  const [name, set_name] = useState("");
  const [message, set_message] = useState("");

  async function create(): Promise<void> {
    try {
      const { token } = await api<{ token: string }>(tokens_path, { name });
      close();
      refresh();
      show_once("Your new API token", "Copy it now: X-Backups keeps only a fingerprint of it and cannot show it again.", [token]);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      set_message(error.message);
    }
  }

  return (
    <Dialog title="Create an API token" on_close={close} buttons={<>
      <button onClick={close}>Cancel</button>
      <button className="accent solid" onClick={() => void create()}>Create</button>
    </>}>
      <div>
        <FormRow label="Name">
          <input type="text" placeholder="such as prometheus" aria-label="Token name" autoFocus value={name} onChange={(event) => set_name((event.currentTarget as HTMLInputElement).value)} />
        </FormRow>
        <p className="tone-bad small" role="alert">{message}</p>
      </div>
    </Dialog>
  );
}

// A secret the server hands out once, with a button to copy it.
function show_once(title: string, note: string, lines: string[]): void {
  const text = lines.join("\n");
  open_dialog((close) => (
    <Dialog title={title} on_close={close} buttons={<>
      <button onClick={() => void navigator.clipboard?.writeText(text).then(() => toast("Copied."))}>Copy</button>
      <button className="accent solid" onClick={close}>I have saved it</button>
    </>}>
      <div><p>{note}</p><pre className="output secret-once">{text}</pre></div>
    </Dialog>
  ));
}

// ── Own account ──────────────────────────────────────────────────────────────

export function AccountView() {
  const who = use_resource(load_me, []);
  return (
    <div className="page">
      <h1>Your account</h1>
      <div className="stack">
        <Loaded resource={who} lines={4}>{(account) => <AccountPanels who={account} refresh={() => who.reload(true)} />}</Loaded>
      </div>
    </div>
  );
}

function AccountPanels({ who, refresh }: { who: Me; refresh: () => void }) {
  return <>
    <Section title="You">
      <Facts rows={[
        ["Name", who.name],
        ["Role", `${who.role}: ${role_text[who.role]}`],
        ["Access", grants_text(who.grants)],
        ["Logged in through", who.via === "proxy" ? "the reverse proxy" : "this page"],
      ]} />
    </Section>
    <Section title="Password">
      {who.source === "declared"
        ? <p className="muted">Your password is the hash file X-Backups is deployed with; change it there with npm run hash-password.</p>
        : <PasswordForm />}
    </Section>
    <Section title="Second factor"><TotpPanel key={String(who.totp_enabled)} enabled={who.totp_enabled} refresh={refresh} /></Section>
  </>;
}

function PasswordForm() {
  const [current, set_current] = useState("");
  const [next, set_next] = useState("");
  const [repeat, set_repeat] = useState("");
  const [message, set_message] = useState<{ text: string; tone: "good" | "bad" } | null>(null);
  const typed = (event: ChangeEvent<HTMLInputElement>) => event.currentTarget.value;

  async function save(): Promise<void> {
    if (next !== repeat) {
      set_message({ text: "The two new passwords differ.", tone: "bad" });
      return;
    }
    try {
      await send("PUT", "/api/account/password", { current, next });
      set_current("");
      set_next("");
      set_repeat("");
      set_message({ text: "Changed. Your other sessions were logged out.", tone: "good" });
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      set_message({ text: error.message, tone: "bad" });
    }
  }

  return (
    <div className="form-rows">
      <FormRow label="Current password"><input type="password" autoComplete="current-password" aria-label="Current password" value={current} onChange={(event) => set_current(typed(event))} /></FormRow>
      <FormRow label="New password"><input type="password" autoComplete="new-password" aria-label="New password" value={next} onChange={(event) => set_next(typed(event))} /></FormRow>
      <FormRow label="New password again"><input type="password" autoComplete="new-password" aria-label="New password again" value={repeat} onChange={(event) => set_repeat(typed(event))} /></FormRow>
      <div>
        <button className="accent solid" onClick={() => void save()}>Change password</button>
        <p className={message ? `small tone-${message.tone}` : "small"} role="status">{message?.text ?? ""}</p>
      </div>
    </div>
  );
}

function TotpPanel({ enabled, refresh }: { enabled: boolean; refresh: () => void }) {
  const [code, set_code] = useState("");
  const [message, set_message] = useState("");
  const [setup, set_setup] = useState<{ secret: string; uri: string } | null>(null);
  const code_input = useRef<HTMLInputElement>(null);

  const code_field = (
    <input ref={code_input} type="text" inputMode="numeric" autoComplete="one-time-code" aria-label="Code from your authenticator app" value={code}
      onChange={(event) => set_code((event.currentTarget as HTMLInputElement).value)} />
  );
  const failed = (error: unknown) => {
    if (!(error instanceof ApiError)) throw error;
    set_message(error.message);
  };

  async function turn_off(): Promise<void> {
    try {
      await api("/api/account/totp/disable", { code });
      toast("Second factor turned off.", { tone: "warn" });
      refresh();
    } catch (error) {
      failed(error);
    }
  }

  async function start(): Promise<void> {
    set_setup(await api<{ secret: string; uri: string }>("/api/account/totp/start", {}));
    setTimeout(() => code_input.current?.focus());
  }

  async function confirm(): Promise<void> {
    try {
      const { recovery_codes } = await api<{ recovery_codes: string[] }>("/api/account/totp/confirm", { code });
      refresh();
      show_once("Your recovery codes", "Each logs you in once if you lose your phone. Keep them somewhere safe; they are not shown again.", recovery_codes);
    } catch (error) {
      failed(error);
    }
  }

  if (enabled) {
    return (
      <div className="stack">
        <p>On. Logging in asks for a code from your authenticator app, or one of your recovery codes.</p>
        <FormRow label="Code to turn it off">{code_field}</FormRow>
        <div><button className="danger" onClick={() => void turn_off()}>Turn off</button></div>
        <p className="tone-bad small" role="alert">{message}</p>
      </div>
    );
  }
  return (
    <div className="stack">
      <p className="muted">Off. A second factor asks for a code from your phone after the password.</p>
      <div><button className="accent solid" hidden={setup !== null} onClick={() => void start()}>Set up</button></div>
      <div className="stack">
        {setup && <>
          <p>Add this key to your authenticator app (such as Aegis, 2FAS or a password manager), or open the link on the phone that has it:</p>
          <pre className="output secret-once">{setup.secret.match(/.{1,4}/g)!.join(" ")}</pre>
          <p><a href={setup.uri}>Open in an authenticator app</a></p>
          <FormRow label="Code it shows now">{code_field}</FormRow>
          <div><button className="accent solid" onClick={() => void confirm()}>Confirm</button></div>
          <p className="tone-bad small" role="alert">{message}</p>
        </>}
      </div>
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function FormRow({ label, children }: { label: string; children: ReactNode }) {
  return <div className="form-row"><label>{label}</label><div>{children}</div></div>;
}
