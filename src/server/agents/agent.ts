// What the server can ask of one host's agent, whether it is connected over a WebSocket or built into the server: X-Libs'
// agent, whose tasks are shell command lines.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { Agent as XLibsAgent } from "@x-tech-laboratories/x-libs/server/agents/agent";

export {
  AgentError, ended_stream, type AgentRunOptions, type AgentStreamOptions, type CommandStream, type LongRun, type LongRunPoll, type LongRunState,
} from "@x-tech-laboratories/x-libs/server/agents/agent";

// ── Agent ────────────────────────────────────────────────────────────────────

export type Agent = XLibsAgent<string>;
