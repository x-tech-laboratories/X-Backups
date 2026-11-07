// The login page: a user name and password, then the code from an authenticator app when the account asks for one, or single sign-on.

import { current_route } from "@x-tech-laboratories/x-libs/web/router";
import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { api, ApiError } from "./api.ts";

// ── Login ────────────────────────────────────────────────────────────────────

export function Login({ on_login }: { on_login: () => Promise<void> }) {
  const [name, set_name] = useState("");
  const [password, set_password] = useState("");
  const [code, set_code] = useState("");
  const [asks_code, set_asks_code] = useState(false);
  // An error the single sign-on callback sent back in the URL.
  const [message, set_message] = useState(current_route().query.get("login_error") ?? "");
  const [busy, set_busy] = useState(false);
  const [info, set_info] = useState<{ oidc: { label: string } | null; admin_name: string } | null>(null);
  const name_input = useRef<HTMLInputElement>(null);
  const password_input = useRef<HTMLInputElement>(null);
  const code_input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    name_input.current?.focus();
    void api<{ oidc: { label: string } | null; admin_name: string }>("/api/auth/info").then(set_info).catch(() => {});
  }, []);

  useEffect(() => {
    if (asks_code) code_input.current?.focus();
  }, [asks_code]);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    set_busy(true);
    set_message("");
    try {
      await login(name, password, asks_code ? code : undefined);
      history.replaceState(null, "", location.pathname + "#/");
      await on_login();
    } catch (error) {
      // The server asks for the second factor only once the password is right.
      if (error instanceof ApiError && error.message.includes("authenticator")) {
        set_asks_code(true);
        code_input.current?.focus();
      } else {
        set_message(error instanceof Error ? error.message : String(error));
        (asks_code ? code_input : password_input).current?.select();
      }
      set_busy(false);
    }
  }

  const text = (event: ChangeEvent<HTMLInputElement>) => event.currentTarget.value;

  return (
    <form className="login" onSubmit={submit}>
      <h1>X-Backups</h1>
      <label className="field">
        <span className="field-label">User name</span>
        <input ref={name_input} type="text" name="username" autoComplete="username" aria-label="User name" autoCapitalize="none"
          placeholder={info?.admin_name} value={name} onChange={(event) => set_name(text(event))} />
      </label>
      <label className="field">
        <span className="field-label">Password</span>
        <input ref={password_input} type="password" name="password" autoComplete="current-password" required aria-label="Password"
          value={password} onChange={(event) => set_password(text(event))} />
      </label>
      <label className="field" hidden={!asks_code}>
        <span className="field-label">Code from your authenticator app, or a recovery code</span>
        <input ref={code_input} type="text" name="one-time-code" autoComplete="one-time-code" inputMode="numeric" aria-label="Code from your authenticator app"
          value={code} onChange={(event) => set_code(text(event))} />
      </label>
      <button type="submit" className="accent solid" disabled={busy}>Log in</button>
      <p className="tone-bad" role="alert">{message}</p>
      <div>
        {info?.oidc && <>
          <p className="muted small">or</p>
          <a className="button" href="/api/auth/oidc/start">{`Log in with ${info.oidc.label}`}</a>
        </>}
      </div>
    </form>
  );
}

// Logs in, telling a wrong password from a missing second factor, which the server answers with totp_required.
async function login(name: string, password: string, code: string | undefined): Promise<void> {
  const response = await fetch("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, password, code }),
  });
  if (response.ok) return;
  const answer = await response.json().catch(() => ({}));
  throw new ApiError(answer.totp_required && !code ? "Enter the code from your authenticator app." : answer.error ?? `${response.status} ${response.statusText}`, null);
}
