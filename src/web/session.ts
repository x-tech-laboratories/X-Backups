// Who is signed in, so views show only what that role may do; the server checks every request again regardless.

import { create_accounts_client, type Me as AccountMe } from "@x-tech-laboratories/x-libs/web/accounts";

export type Role = "viewer" | "operator" | "admin";

// A grant on a job, or on a repository no job writes to.
export type Grant = { job: string } | { repository: string };

export interface Me extends AccountMe {
  role: Role;
  // null sees everything.
  access: Grant[] | null;
}

const roles: Role[] = ["viewer", "operator", "admin"];

export const accounts = create_accounts_client();

let current: Me | null = null;

export async function load_me(): Promise<Me> {
  current = await accounts.me() as Me;
  return current;
}

export function me(): Me | null {
  return current;
}

export function forget_me(): void {
  current = null;
}

// Whether the signed-in user has the role or a higher one.
export function can(role: Role): boolean {
  return current !== null && roles.indexOf(current.role) >= roles.indexOf(role);
}
