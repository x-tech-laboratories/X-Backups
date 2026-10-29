// Who may log in: an admin's list of users and API tokens, and each user's own password and second factor.

import { api, ApiError, send, type RepositorySummary } from "../api.ts";
import { age, h, stamp, type Child } from "../dom.ts";
import { can, load_me, me, type Grant, type Role } from "../session.ts";
import { chip, confirm_dialog, data_table, empty, facts, load, open_dialog, section, skeleton, toast } from "../ui.ts";
import type { View } from "./shared.ts";

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

// ── Users ────────────────────────────────────────────────────────────────────

export function users_view(): View {
  const users = h("div", {}, skeleton(4));
  const tokens = h("div", {}, skeleton(2));
  let grantable: Grantable = { jobs: [], repositories: [] };

  const refresh = async (quiet: boolean) => {
    if (!can("admin")) {
      users.replaceChildren(empty("Only an admin manages users."));
      tokens.replaceChildren();
      return;
    }
    grantable = grantable_of(await api<RepositorySummary[]>("/api/repositories").catch(() => []));
    await load(users, async () => users_table(await api<User[]>("/api/users"), grantable, () => void refresh(true)), { quiet });
    await load(tokens, async () => tokens_table(await api<Token[]>("/api/tokens"), () => void refresh(true)), { quiet });
  };
  void refresh(false);

  return {
    title: "Users",
    root: h("div", { class: "page" },
      h("div", { class: "page-title spread" }, h("h1", {}, "Users"),
        can("admin") && h("button", { class: "accent solid", onclick: () => user_dialog(null, grantable, () => void refresh(true)) }, "Add user")),
      section("Users", users),
      section("API tokens", h("div", { class: "stack" },
        h("p", { class: "muted small" }, "A token reads what a viewer of everything reads, and the Prometheus metrics at /metrics; it changes nothing. Send it as Authorization: Bearer <token>."),
        h("div", {}, h("button", { onclick: () => token_dialog(() => void refresh(true)) }, "Create token")),
        tokens)),
    ),
  };
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

function users_table(users: User[], grantable: Grantable, refresh: () => void): HTMLElement {
  return data_table<User>([
    { label: "Name", cell: (user) => [h("strong", {}, user.name), user.name === me()?.name ? h("span", { class: "muted small" }, " (you)") : null] },
    { label: "Role", cell: (user) => chip(user.role, role_text[user.role]) },
    { label: "Access", cell: (user) => grants_text(user.grants) },
    { label: "Second factor", cell: (user) => user.totp_enabled ? "on" : h("span", { class: "muted" }, "off") },
    { label: "Login", cell: (user) => user.source === "declared" ? chip("declared", "Its password is the hash file X-Backups is deployed with") : user.has_password ? "password" : h("span", { class: "muted" }, "single sign-on only") },
    {
      label: "", class: "actions-cell", cell: (user) => h("span", { class: "row-actions" },
        user.source === "page" && h("button", { onclick: () => user_dialog(user, grantable, refresh) }, "Edit"),
        user.totp_enabled && h("button", { onclick: () => reset_totp(user, refresh) }, "Reset second factor"),
        user.source === "page" && user.name !== me()?.name && h("button", { class: "danger", onclick: () => remove_user(user, refresh) }, "Remove"),
      ),
    },
  ], users, { caption: "Users" });
}

// Adds a user, or edits one when given; a password left empty on an edit stays as it was.
function user_dialog(user: User | null, grantable: Grantable, refresh: () => void): void {
  const name = h("input", { type: "text", value: user?.name ?? "", readonly: user !== null, autocomplete: "off", autocapitalize: "none", "aria-label": "User name" });
  const role = h("select", { "aria-label": "Role" }, ...(["viewer", "operator", "admin"] as Role[]).map((value) =>
    h("option", { value, selected: (user?.role ?? "viewer") === value }, value)));
  const role_hint = h("p", { class: "muted small" }, role_text[(user?.role ?? "viewer")]);
  role.addEventListener("change", () => { role_hint.textContent = role_text[role.value as Role]; });
  const all = h("input", { type: "checkbox", checked: user === null || user.grants === null });
  const held = user?.grants ?? [];
  const held_jobs = held.flatMap((grant) => "job" in grant ? [grant.job] : []);
  const held_repositories = held.flatMap((grant) => "repository" in grant ? [grant.repository] : []);
  // A grant on something no longer configured stays listed, so saving keeps it unless it is unticked.
  const jobs = [
    ...grantable.jobs,
    ...held_jobs.filter((name) => !grantable.jobs.some((job) => job.name === name)).map((name) => ({ name, repositories: [] })),
  ];
  const repositories = [...grantable.repositories, ...held_repositories.filter((name) => !grantable.repositories.includes(name))];
  const job_picks = jobs.map((job) => h("input", { type: "checkbox", value: job.name, checked: held_jobs.includes(job.name) }));
  const repository_picks = repositories.map((name) => h("input", { type: "checkbox", value: name, checked: held_repositories.includes(name) }));
  const pick_list = h("div", { class: "check-list", hidden: all.checked },
    h("fieldset", { class: "check-group" }, h("legend", {}, "Jobs"),
      ...(jobs.length === 0 ? [h("p", { class: "muted small" }, "No jobs are configured.")] : jobs.map((job, index) => h("label", { class: "check" }, job_picks[index], ` ${job.name}`,
        job.repositories.length > 0 && h("span", { class: "muted small" }, ` to ${job.repositories.join(", ")}`))))),
    repositories.length > 0 && h("fieldset", { class: "check-group" }, h("legend", {}, "Repositories no job writes to"),
      ...repositories.map((name, index) => h("label", { class: "check" }, repository_picks[index], ` ${name}`))));
  all.addEventListener("change", () => { pick_list.hidden = all.checked; });
  const password = h("input", { type: "password", autocomplete: "new-password", "aria-label": "Password", placeholder: user ? "leave empty to keep it" : "at least 12 characters, or empty for single sign-on only" });
  const message = h("p", { class: "tone-bad small", role: "alert" });

  open_dialog(user ? `Edit ${user.name}` : "Add a user", h("div", { class: "form-rows" },
    form_row("Name", h("div", {}, name, h("p", { class: "muted small" }, "Lowercase letters, digits, '.', '_' or '-'. Single sign-on matches it against the provider's user name."))),
    form_row("Role", h("div", {}, role, role_hint)),
    form_row("Access", h("div", {},
      h("label", { class: "check" }, all, " Everything, including jobs added later"),
      h("p", { class: "muted small" }, "A job shows its targets, runs and archives, and the sources, repositories and hosts it uses. Compacting, checking or deleting from a repository needs every job writing there."),
      pick_list)),
    form_row("Password", password),
    message,
  ), (close) => {
    const save = h("button", { class: "accent solid" }, user ? "Save" : "Add user");
    save.addEventListener("click", async () => {
      const body = {
        name: name.value.trim(), role: role.value,
        grants: all.checked ? null : [
          ...job_picks.filter((pick) => pick.checked).map((pick) => ({ job: pick.value })),
          ...repository_picks.filter((pick) => pick.checked).map((pick) => ({ repository: pick.value })),
        ],
        password: password.value,
      };
      save.disabled = true;
      try {
        if (user) await send("PUT", `/api/users/${encodeURIComponent(user.name)}`, body);
        else await api("/api/users", body);
        toast(user ? `${user.name} saved; their open sessions were ended.` : `${body.name} added.`, { tone: "good" });
        close();
        refresh();
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        message.textContent = error.message;
        save.disabled = false;
      }
    });
    return [h("button", { onclick: close }, "Cancel"), save];
  });
  (user ? role : name).focus();
}

function remove_user(user: User, refresh: () => void): void {
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
      refresh();
    },
  });
}

function reset_totp(user: User, refresh: () => void): void {
  confirm_dialog({
    title: `Reset ${user.name}'s second factor?`,
    message: "Their authenticator app and recovery codes stop working, and they log in with the password alone until they set it up again. Do this when they have lost their phone.",
    confirm_label: "Reset second factor",
    danger: true,
    run: async () => {
      await api(`/api/users/${encodeURIComponent(user.name)}/totp/reset`, {});
      toast(`${user.name}'s second factor was reset.`, { tone: "warn" });
      refresh();
    },
  });
}

// ── Tokens ───────────────────────────────────────────────────────────────────

function tokens_table(tokens: Token[], refresh: () => void): HTMLElement {
  if (tokens.length === 0) return empty("No API tokens.", "Create one for a Prometheus scraper or a script that only reads.");
  return data_table<Token>([
    { label: "Name", cell: (token) => token.name },
    { label: "Created", cell: (token) => h("span", { title: stamp(token.created_epoch) }, `${age(token.created_epoch)} by ${token.created_by}`) },
    { label: "Last used", cell: (token) => token.last_used_epoch ? h("span", { title: stamp(token.last_used_epoch) }, age(token.last_used_epoch)) : h("span", { class: "muted" }, "never") },
    {
      label: "", class: "actions-cell", cell: (token) => h("button", {
        class: "danger",
        onclick: () => confirm_dialog({
          title: `Revoke ${token.name}?`,
          message: "Whatever uses it is refused from now on.",
          confirm_label: "Revoke",
          danger: true,
          run: async () => {
            await send("DELETE", `/api/tokens/${token.id}`);
            refresh();
          },
        }),
      }, "Revoke"),
    },
  ], tokens, { caption: "API tokens" });
}

function token_dialog(refresh: () => void): void {
  const name = h("input", { type: "text", placeholder: "such as prometheus", "aria-label": "Token name" });
  const message = h("p", { class: "tone-bad small", role: "alert" });
  open_dialog("Create an API token", h("div", {}, form_row("Name", name), message), (close) => {
    const create = h("button", { class: "accent solid" }, "Create");
    create.addEventListener("click", async () => {
      try {
        const { token } = await api<{ token: string }>("/api/tokens", { name: name.value });
        close();
        refresh();
        show_once("Your new API token", "Copy it now: X-Backups keeps only a fingerprint of it and cannot show it again.", [token]);
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        message.textContent = error.message;
      }
    });
    return [h("button", { onclick: close }, "Cancel"), create];
  });
  name.focus();
}

// A secret the server hands out once, with a button to copy it.
function show_once(title: string, note: string, lines: string[]): void {
  const text = lines.join("\n");
  open_dialog(title, h("div", {}, h("p", {}, note), h("pre", { class: "output secret-once" }, text)), (close) => [
    h("button", { onclick: () => void navigator.clipboard?.writeText(text).then(() => toast("Copied.")) }, "Copy"),
    h("button", { class: "accent solid", onclick: close }, "I have saved it"),
  ]);
}

// ── Own account ──────────────────────────────────────────────────────────────

export function account_view(): View {
  const body = h("div", { class: "stack" }, skeleton(4));
  const refresh = () => void load(body, async () => account_panels(await load_me(), refresh), { quiet: true });
  refresh();
  return { title: "Account", root: h("div", { class: "page" }, h("h1", {}, "Your account"), body) };
}

function account_panels(who: NonNullable<ReturnType<typeof me>>, refresh: () => void): Child[] {
  return [
    section("You", facts([
      ["Name", who.name],
      ["Role", `${who.role}: ${role_text[who.role]}`],
      ["Access", grants_text(who.grants)],
      ["Logged in through", who.via === "proxy" ? "the reverse proxy" : "this page"],
    ])),
    section("Password", who.source === "declared"
      ? h("p", { class: "muted" }, "Your password is the hash file X-Backups is deployed with; change it there with npm run hash-password.")
      : password_form()),
    section("Second factor", totp_panel(who.totp_enabled, refresh)),
  ];
}

function password_form(): HTMLElement {
  const current = h("input", { type: "password", autocomplete: "current-password", "aria-label": "Current password" });
  const next = h("input", { type: "password", autocomplete: "new-password", "aria-label": "New password" });
  const repeat = h("input", { type: "password", autocomplete: "new-password", "aria-label": "New password again" });
  const message = h("p", { class: "small", role: "status" });
  const save = h("button", { class: "accent solid" }, "Change password");
  save.addEventListener("click", async () => {
    message.className = "small tone-bad";
    if (next.value !== repeat.value) {
      message.textContent = "The two new passwords differ.";
      return;
    }
    try {
      await send("PUT", "/api/account/password", { current: current.value, next: next.value });
      for (const input of [current, next, repeat]) input.value = "";
      message.className = "small tone-good";
      message.textContent = "Changed. Your other sessions were logged out.";
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      message.textContent = error.message;
    }
  });
  return h("div", { class: "form-rows" },
    form_row("Current password", current), form_row("New password", next), form_row("New password again", repeat),
    h("div", {}, save, message));
}

function totp_panel(enabled: boolean, refresh: () => void): HTMLElement {
  const code = h("input", { type: "text", inputmode: "numeric", autocomplete: "one-time-code", "aria-label": "Code from your authenticator app" });
  const message = h("p", { class: "tone-bad small", role: "alert" });
  if (enabled) {
    const off = h("button", { class: "danger" }, "Turn off");
    off.addEventListener("click", async () => {
      try {
        await api("/api/account/totp/disable", { code: code.value });
        toast("Second factor turned off.", { tone: "warn" });
        refresh();
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        message.textContent = error.message;
      }
    });
    return h("div", { class: "stack" },
      h("p", {}, "On. Logging in asks for a code from your authenticator app, or one of your recovery codes."),
      form_row("Code to turn it off", code), h("div", {}, off), message);
  }
  const start = h("button", { class: "accent solid" }, "Set up");
  const steps = h("div", { class: "stack" });
  start.addEventListener("click", async () => {
    const { secret, uri } = await api<{ secret: string; uri: string }>("/api/account/totp/start", {});
    const confirm = h("button", { class: "accent solid" }, "Confirm");
    confirm.addEventListener("click", async () => {
      try {
        const { recovery_codes } = await api<{ recovery_codes: string[] }>("/api/account/totp/confirm", { code: code.value });
        refresh();
        show_once("Your recovery codes", "Each logs you in once if you lose your phone. Keep them somewhere safe; they are not shown again.", recovery_codes);
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        message.textContent = error.message;
      }
    });
    start.hidden = true;
    steps.replaceChildren(
      h("p", {}, "Add this key to your authenticator app (such as Aegis, 2FAS or a password manager), or open the link on the phone that has it:"),
      h("pre", { class: "output secret-once" }, secret.match(/.{1,4}/g)!.join(" ")),
      h("p", {}, h("a", { href: uri }, "Open in an authenticator app")),
      form_row("Code it shows now", code),
      h("div", {}, confirm), message,
    );
    code.focus();
  });
  return h("div", { class: "stack" },
    h("p", { class: "muted" }, "Off. A second factor asks for a code from your phone after the password."),
    h("div", {}, start), steps);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function form_row(label: string, control: Child): HTMLElement {
  return h("div", { class: "form-row" }, h("label", {}, label), h("div", {}, control));
}
