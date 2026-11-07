// Adds a repository from the page, when the config mode lets the page manage repositories.

import { Crumbs } from "@x-tech-laboratories/x-libs/web/react/layout";
import { Empty, Loaded, use_resource } from "@x-tech-laboratories/x-libs/web/react/states";
import { toast } from "@x-tech-laboratories/x-libs/web/react/toasts";
import { link } from "@x-tech-laboratories/x-libs/web/router";
import { useRef, useState } from "react";
import { api, ApiError, type ConfigInfo } from "../api.ts";
import { ConfigForm, type ConfigFormHandle } from "./config_form.tsx";

// ── Page ─────────────────────────────────────────────────────────────────────

export function NewRepositoryView() {
  const info = use_resource(() => api<ConfigInfo>("/api/config"), []);
  return (
    <div className="page">
      <Crumbs items={[["Repositories", link(["repositories"])], ["Add", null]]} />
      <h1>Add a repository</h1>
      <div className="stack">
        <Loaded resource={info} lines={6}>
          {(config) => config.editable
            ? <AddForm info={config} />
            : <Empty title="The config is declarative here, so repositories are added in the Nix configuration."
              hint="Declare them under services.x-backups.repositories, or set services.x-backups.configMode to mixed to add them here too." />}
        </Loaded>
      </div>
    </div>
  );
}

function AddForm({ info }: { info: ConfigInfo }) {
  const form = useRef<ConfigFormHandle>(null);
  const [busy, set_busy] = useState(false);

  async function add(): Promise<void> {
    set_busy(true);
    try {
      const { id } = await api<{ id: string }>("/api/repositories", form.current!.read());
      toast(`${id} added. Its first poll has started.`, { tone: "good" });
      location.hash = link(["repositories", id]);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      form.current!.show_error(error.message, error.field);
    } finally {
      set_busy(false);
    }
  }

  return <>
    <p className="muted">Only name and repo are required. Empty fields take their defaults, which Settings shows.</p>
    <ConfigForm fields={info.fields} values={{}} adding handle={form} />
    <div className="form-actions">
      <button className="accent solid" disabled={busy} onClick={add}>{busy ? "Adding…" : "Add repository"}</button>
      <a className="button" href={link(["repositories"])}>Cancel</a>
    </div>
  </>;
}
