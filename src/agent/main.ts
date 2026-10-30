// Starts the X-Backups agent from its environment: the server's URL, the file holding this host's private key or its
// token, the host it logs in as, and the folder long runs keep their output in.

// ── Imports ──────────────────────────────────────────────────────────────────

import { readFileSync } from "node:fs";
import { hostname } from "node:os";

import { AgentConfigError, start_agent } from "./agent.ts";

// ── Settings ─────────────────────────────────────────────────────────────────

// Ended runs are kept this long for the server to read, then removed.
const ended_run_retention_in_seconds = 30 * 86400;

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} must be set.`);
    process.exit(2);
  }
  return value;
}

// Exactly one of the key file and the token file says how the agent logs in.
function login_files(): { key_file?: string; token_file?: string } {
  const key_file = process.env.X_BACKUPS_AGENT_KEY_FILE || undefined;
  const token_file = process.env.X_BACKUPS_AGENT_TOKEN_FILE || undefined;
  if ((key_file === undefined) === (token_file === undefined)) {
    console.error("Set exactly one of X_BACKUPS_AGENT_KEY_FILE and X_BACKUPS_AGENT_TOKEN_FILE.");
    process.exit(2);
  }
  return { key_file, token_file };
}

function agent_version(): string {
  try {
    return String(JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version);
  } catch {
    return "unknown";
  }
}

// ── Start ────────────────────────────────────────────────────────────────────

try {
  const agent = start_agent({
    url: required("X_BACKUPS_AGENT_URL"),
    ...login_files(),
    state_directory: process.env.X_BACKUPS_AGENT_STATE_DIR || "state",
    host: process.env.X_BACKUPS_AGENT_HOST || hostname(),
    agent_version: agent_version(),
  });
  agent.runs.prune(ended_run_retention_in_seconds);

  // Long runs are in their own process groups, so they keep going after the agent exits.
  const stop = () => void agent.stop().then(() => process.exit(0));
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
} catch (error) {
  if (!(error instanceof AgentConfigError)) throw error;
  console.error(error.message);
  process.exit(2);
}
