// The Connections section of Settings in the desktop and Android apps, which show a daemon on another host: which
// daemons this device knows, the one in use, and adding one by its address. A browser shows none.

import { ConnectionSettings } from "@x-tech-laboratories/x-libs/web/react/connections";
import { Section } from "@x-tech-laboratories/x-libs/web/react/layout";
import { certificates, connections } from "../daemon.ts";

export function ConnectionsSection() {
  if (connections === null) return null;
  return (
    <Section title="Connections">
      <div className="stack">
        <p className="muted small">This app shows the X-Backups daemon, the server that runs your backups, on another host. Add it by its address and your sign-in; this device gets a token of its own, which removing the daemon gives back.</p>
        <ConnectionSettings client={connections} certificates={certificates} placeholder="https://backups.example.org" />
      </div>
    </Section>
  );
}

// Settings with only the Connections section, while no daemon is chosen or the chosen one turned this device away.
export function ConnectionsPage({ refused }: { refused: boolean }) {
  return (
    <div className="page">
      <h1>Settings</h1>
      {refused && <p className="banner" role="alert">The daemon turned this device's sign-in away. Remove it and add it again to sign in anew, or connect to another.</p>}
      {!refused && <p className="muted">Choose the X-Backups daemon to connect to.</p>}
      <ConnectionsSection />
    </div>
  );
}
