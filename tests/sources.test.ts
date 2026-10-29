import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { ConfigError } from "../src/server/config.ts";
import { ConfigSources, SECRET_MASK, type ConfigMode } from "../src/server/sources.ts";

let directory: string;
let declared_path: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "x-backups-sources-"));
  declared_path = join(directory, "declared.json");
  writeFileSync(declared_path, JSON.stringify({ defaults: { max_age: "2d" }, repositories: [{ name: "nas", repo: "/srv/nas" }] }));
});

function sources(mode: ConfigMode, declared: string | null = declared_path): ConfigSources {
  return new ConfigSources({ mode, declared_path: declared, state_dir: join(directory, "state") });
}

function page_file(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(directory, "state", "config.json"), "utf8"));
}

// ── Modes ────────────────────────────────────────────────────────────────────

describe("modes", () => {
  it("lets the page edit nothing when declarative", () => {
    const declarative = sources("declarative");

    expect(declarative.editable).toBe(false);
    expect(() => declarative.save_repository({ name: "laptop", repo: "/srv/laptop" }, null)).toThrow(ConfigError);
  });

  it("adds page repositories beside the declared ones when mixed", () => {
    const mixed = sources("mixed");

    const config = mixed.save_repository({ name: "laptop", repo: "/srv/laptop" }, null);

    expect(config.repositories.map((repository) => [repository.name, repository.source])).toEqual([["nas", "declared"], ["laptop", "page"]]);
    expect(sources("mixed").config().repositories).toHaveLength(2);
    // A declarative start ignores what the page saved.
    expect(sources("declarative").config().repositories).toHaveLength(1);
  });

  it("needs a declared file unless the page manages everything", () => {
    expect(() => sources("mixed", null)).toThrow("X_BACKUPS_CONFIG is not set");
    expect(sources("page", null).config().repositories).toEqual([]);
  });
});

// ── Repositories ─────────────────────────────────────────────────────────────

describe("page repositories", () => {
  it("refuses to change or shadow a declared repository", () => {
    const mixed = sources("mixed");

    expect(() => mixed.save_repository({ name: "nas", repo: "/elsewhere" }, null)).toThrow("declared in the Nix configuration");
    expect(() => mixed.delete_repository("nas")).toThrow("declared in the Nix configuration");
  });

  it("names the field a bad entry fails on, and writes nothing", () => {
    const mixed = sources("mixed");

    let error: ConfigError | null = null;
    try {
      mixed.save_repository({ name: "laptop", repo: "/srv/laptop", max_age: "soon" }, null);
    } catch (caught) {
      error = caught as ConfigError;
    }

    expect(error?.field).toBe("max_age");
    expect(mixed.config().repositories).toHaveLength(1);
  });

  it("refuses a duplicate, a rename, and an edit of what is not there", () => {
    const mixed = sources("mixed");
    mixed.save_repository({ name: "laptop", repo: "/srv/laptop" }, null);

    expect(() => mixed.save_repository({ name: "laptop", repo: "/srv/laptop" }, null)).toThrow("already exists");
    expect(() => mixed.save_repository({ name: "other", repo: "/srv/laptop" }, "laptop")).toThrow("cannot be renamed");
    expect(() => mixed.save_repository({ name: "ghost", repo: "/x" }, "ghost")).toThrow("No page repository");
  });

  it("keeps a typed passphrase in its own private file, never in the JSON", () => {
    const mixed = sources("mixed");

    mixed.save_repository({ name: "laptop", repo: "/srv/laptop", passphrase: "correct horse" }, null);

    const passphrase_file = join(directory, "state", "passphrases", "laptop");
    expect(JSON.stringify(page_file())).not.toContain("correct horse");
    expect(readFileSync(passphrase_file, "utf8")).toBe("correct horse");
    expect(statSync(passphrase_file).mode & 0o777).toBe(0o600);
    expect(mixed.entry("laptop")).toMatchObject({ passphrase_file });
  });

  it("keeps a masked secret as it was and drops a cleared one", () => {
    const mixed = sources("mixed");
    mixed.save_repository({ name: "laptop", repo: "/srv/laptop", passphrase_command: "pass show borg" }, null);
    expect(mixed.entry("laptop")!.passphrase_command).toBe(SECRET_MASK);

    mixed.save_repository({ name: "laptop", repo: "/srv/laptop", passphrase_command: SECRET_MASK, max_age: "3d" }, "laptop");
    expect((page_file().repositories as Record<string, unknown>[])[0]).toMatchObject({ passphrase_command: "pass show borg", max_age: "3d" });

    mixed.save_repository({ name: "laptop", repo: "/srv/laptop", passphrase_command: "" }, "laptop");
    expect((page_file().repositories as Record<string, unknown>[])[0].passphrase_command).toBeUndefined();
  });

  it("flags a page repository a declared one shadows", () => {
    const mixed = sources("mixed");
    mixed.save_repository({ name: "laptop", repo: "/srv/laptop" }, null);
    writeFileSync(declared_path, JSON.stringify({ repositories: [{ name: "nas", repo: "/srv/nas" }, { name: "laptop", repo: "/srv/declared" }] }));

    const reread = sources("mixed");

    expect(reread.shadowed()).toEqual(["laptop"]);
    expect(reread.config().repositories.map((repository) => [repository.name, repository.source])).toEqual([["nas", "declared"], ["laptop", "declared"]]);
  });
});

// ── Defaults ─────────────────────────────────────────────────────────────────

describe("defaults", () => {
  it("tags each default with where it came from", () => {
    const mixed = sources("mixed");
    mixed.save_defaults({ interval: "30m" });

    expect(mixed.settings()).toEqual([
      { name: "interval", value: "30m", source: "saved" },
      { name: "max_age", value: "2d", source: "declared" },
      { name: "warn_age", value: 0, source: "default" },
      { name: "check_max_age", value: "8d", source: "default" },
      { name: "check_warn_age", value: 0, source: "default" },
      { name: "canary_max_age", value: 0, source: "default" },
      { name: "canary_warn_age", value: 0, source: "default" },
      { name: "browse_limit", value: 2000, source: "default" },
    ]);
    expect(mixed.config().repositories[0]).toMatchObject({ interval_in_seconds: 1800, borg: { max_age: "2d" } });
  });

  it("refuses to override a declared default, and clears a saved one", () => {
    const mixed = sources("mixed");
    mixed.save_defaults({ browse_limit: 50 });

    expect(() => mixed.save_defaults({ max_age: "1d" })).toThrow("declared in the Nix configuration");
    mixed.save_defaults({ browse_limit: "" });
    expect(mixed.settings().find((setting) => setting.name === "browse_limit")!.source).toBe("default");
  });
});

// ── Entities ─────────────────────────────────────────────────────────────────

describe("page entities", () => {
  it("adds hosts, repositories, sources and jobs that build targets", () => {
    const mixed = sources("mixed");
    mixed.save_entity("hosts", { name: "odin", address: "odin.technet" }, null);
    mixed.save_entity("repositories", { name: "disk", host: "odin", repo: "/srv/borg" }, null);
    mixed.save_entity("sources", { name: "home", host: "odin", source_paths: ["/home"] }, null);
    const config = mixed.save_entity("jobs", { name: "daily", sources: ["home"], repositories: ["disk"] }, null);

    expect(config.repositories.map((target) => [target.name, target.source])).toEqual([["nas", "declared"], ["daily:odin:disk", "page"]]);
    expect(page_file()).toMatchObject({ hosts: [{ name: "odin" }], sources: [{ name: "home" }], jobs: [{ name: "daily" }] });
    expect(sources("mixed").config().repositories).toHaveLength(2);
  });

  it("refuses a job naming what is not there, and writes nothing", () => {
    const mixed = sources("mixed");

    expect(() => mixed.save_entity("jobs", { name: "daily", sources: ["home"], repositories: ["nas"] }, null)).toThrow("no source named 'home'");
    expect(page_file).toThrow();
  });

  it("refuses deleting an entity another names, until that one goes", () => {
    const mixed = sources("mixed");
    mixed.save_entity("hosts", { name: "odin" }, null);
    mixed.save_entity("sources", { name: "home", host: "odin", source_paths: ["/home"] }, null);
    mixed.save_entity("jobs", { name: "daily", sources: ["home"], repositories: ["nas"] }, null);

    expect(() => mixed.delete_entity("hosts", "odin")).toThrow("The host 'odin' is used by source 'home'");
    expect(() => mixed.delete_entity("sources", "home")).toThrow("used by job 'daily'");
    expect(() => mixed.delete_entity("repositories", "nas")).toThrow("declared in the Nix configuration");
    mixed.delete_entity("jobs", "daily");
    mixed.delete_entity("sources", "home");
    mixed.delete_entity("hosts", "odin");
    expect(page_file()).toMatchObject({ hosts: [], sources: [], jobs: [] });
  });

  it("lets a declared entity shadow a page one per kind", () => {
    const mixed = sources("mixed");
    mixed.save_entity("hosts", { name: "odin", address: "page.technet" }, null);
    writeFileSync(declared_path, JSON.stringify({ hosts: [{ name: "odin", address: "declared.technet" }], repositories: [{ name: "nas", host: "odin", repo: "/srv/nas" }] }));

    const reread = sources("mixed");

    expect(reread.shadowed("hosts")).toEqual(["odin"]);
    expect(reread.shadowed()).toEqual([]);
    expect(reread.config().repositories[0]).toMatchObject({ name: "nas", host: "declared.technet" });
  });

  it("keeps a passphrase file only for a repository", () => {
    const mixed = sources("mixed");
    mixed.save_entity("hosts", { name: "odin" }, null);
    mixed.save_entity("repositories", { name: "disk", host: "odin", repo: "/srv/borg", passphrase: "correct horse" }, null);

    expect(JSON.stringify(page_file())).not.toContain("correct horse");
    expect(mixed.entry("disk")).toMatchObject({ passphrase_file: join(directory, "state", "passphrases", "disk") });
  });
});
