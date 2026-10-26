// Adds a repository from the page, when the config mode lets the page manage repositories.

import { api, ApiError, type ConfigInfo } from "../api.ts";
import { h } from "../dom.ts";
import { link } from "../router.ts";
import { crumbs, empty, load, skeleton, toast } from "../ui.ts";
import { config_form } from "./config_form.ts";
import type { View } from "./shared.ts";

export function new_repository_view(): View {
  const body = h("div", { class: "stack" }, skeleton(6));
  void load(body, async () => {
    const info = await api<ConfigInfo>("/api/config");
    if (!info.editable) {
      return empty("The config is declarative here, so repositories are added in the Nix configuration.",
        "Declare them under services.x-backups.repositories, or set services.x-backups.configMode to mixed to add them here too.");
    }
    const form = config_form(info.fields, {}, { adding: true });
    const add = h("button", { class: "accent solid" }, "Add repository");
    add.addEventListener("click", async () => {
      add.disabled = true;
      add.textContent = "Adding…";
      try {
        const { id } = await api<{ id: string }>("/api/repositories", form.read());
        toast(`${id} added. Its first poll has started.`, { tone: "good" });
        location.hash = link(["repositories", id]);
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        form.show_error(error.message, error.field);
      } finally {
        add.disabled = false;
        add.textContent = "Add repository";
      }
    });
    return [
      h("p", { class: "muted" }, "Only name and repo are required. Empty fields take their defaults, which Settings shows."),
      form.element,
      h("div", { class: "form-actions" }, add, h("a", { class: "button", href: link(["repositories"]) }, "Cancel")),
    ];
  });

  return {
    title: "Add repository",
    root: h("div", { class: "page" },
      crumbs([["Repositories", link(["repositories"])], ["Add", null]]),
      h("h1", {}, "Add a repository"),
      body,
    ),
  };
}
