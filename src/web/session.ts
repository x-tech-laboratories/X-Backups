// Who is logged in, so views show only what that role may do; the server checks every request again regardless.

import { api } from "./api.ts";

export type Role = "viewer" | "operator" | "admin";

// A grant on a job, or on a repository no job writes to.
export type Grant = { job: string } | { repository: string };

export interface Me {
  name: string;
  role: Role;
  // null sees everything.
  grants: Grant[] | null;
  via: "session" | "token" | "proxy";
  totp_enabled: boolean;
  source: "declared" | "page" | null;
  has_password: boolean;
}

const roles: Role[] = ["viewer", "operator", "admin"];

let current: Me | null = null;

export async function load_me(): Promise<Me> {
  current = await api<Me>("/api/me");
  return current;
}

export function me(): Me | null {
  return current;
}

export function forget_me(): void {
  current = null;
}

// Whether the logged-in user has the role or a higher one.
export function can(role: Role): boolean {
  return current !== null && roles.indexOf(current.role) >= roles.indexOf(role);
}
