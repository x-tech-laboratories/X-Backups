// The agents the server can reach, by host name, through X-Libs' hub: those that have dialled in over /api/agent with
// their host's token or declared key, and the one built into the server for its own machine. A host with a declared key
// logs in only with that key, so a leaked token cannot stand in for it. This adds the hosts' tokens and health samples.

// ── Imports ──────────────────────────────────────────────────────────────────

import { AgentHub as XLibsAgentHub, type HubOptions as XLibsHubOptions } from "@x-tech-laboratories/x-libs/server/agents/hub";

import { x_backups_app, type HealthSample } from "../../shared/agent_protocol.ts";
import type { AgentEnrolment, AgentTokens } from "./tokens.ts";

export { close_codes, type Admission, type AgentLogin, type AgentStatus } from "@x-tech-laboratories/x-libs/server/agents/hub";

export type HubOptions = Omit<XLibsHubOptions<string>, "app" | "tokens">;

// ── Hub ──────────────────────────────────────────────────────────────────────

export class AgentHub extends XLibsAgentHub<string> {
  private readonly token_store: AgentTokens;

  constructor(tokens: AgentTokens, options: HubOptions = {}) {
    super({ ...options, app: x_backups_app, tokens });
    this.token_store = tokens;
  }

  // A new token for the host, shown this once; an agent still using the old one is hung up on.
  issue_token(host: string): string {
    const token = this.token_store.issue(host);
    this.disconnect_token_login(host, "The host's token was replaced.");
    return token;
  }

  revoke(host: string): void {
    this.token_store.revoke(host);
    this.disconnect_token_login(host, "The host's token was revoked.");
  }

  // Each host issued a token, with when its agent was last in touch.
  enrolments(): AgentEnrolment[] {
    return this.token_store.enrolments();
  }

  // How loaded the host is, sampled by its agent.
  async health(host: string): Promise<HealthSample> {
    return (await this.request(host, "health")) as HealthSample;
  }
}
