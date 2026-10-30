import { describe, expect, it } from "vitest";
import { parse_config } from "../src/server/config.ts";
import { backup_map, map_entry, repo_location } from "../src/server/map.ts";

describe("repo_location", () => {
  it("reads the host and path of an ssh URL", () => {
    expect(repo_location("ssh://borg@heimdall.technet/Storage/Files/Backups/Laptop/Borgmatic")).toEqual({ host: "heimdall.technet", path: "/Storage/Files/Backups/Laptop/Borgmatic" });
    expect(repo_location("ssh://ragnarok.technet:2222/./repo")).toEqual({ host: "ragnarok.technet", path: "/./repo" });
    expect(repo_location("ssh://borg@[fd00::1]:22/repo")).toEqual({ host: "fd00::1", path: "/repo" });
  });

  it("reads borg's scp-like form", () => {
    expect(repo_location("borg@heimdall.technet:/srv/repo")).toEqual({ host: "heimdall.technet", path: "/srv/repo" });
  });

  it("leaves a plain path on the host borg runs on", () => {
    expect(repo_location("/Storage/Files/Backups/Laptop/Borgmatic")).toEqual({ host: null, path: "/Storage/Files/Backups/Laptop/Borgmatic" });
  });
});

describe("backup_map", () => {
  it("joins a host's names and runs each job from its folders to the repositories it writes to", () => {
    const map = backup_map([
      { id: "on-disk", job: "laptop", repository: "on-disk", host: "odin.technet", repo: "/Storage/Files/Backups/Laptop/Borgmatic", source_paths: ["/Storage"] },
      { id: "to-heimdall", job: "laptop", repository: "to-heimdall", host: "odin.technet", repo: "ssh://borg@heimdall.technet/Storage/Files/Backups/Laptop/Borgmatic", source_paths: ["/Storage"] },
      { id: "server", job: "server", repository: "server", host: null, repo: "/Storage/Backups/Server", source_paths: ["/Storage/Services", "/Storage/Apps"] },
      { id: "watched", job: null, repository: "watched", host: "10.100.100.6", repo: "/srv/repo", source_paths: [] },
    ], "Heimdall");

    expect(map.hosts).toEqual([
      { id: "odin", name: "Odin" },
      { id: "heimdall", name: "Heimdall" },
      { id: "10.100.100.6", name: "10.100.100.6" },
    ]);
    expect(map.sources.map((source) => source.id)).toEqual(["odin:/Storage", "heimdall:/Storage/Apps", "heimdall:/Storage/Services"]);
    expect(map.jobs).toEqual([
      { id: "laptop", sources: ["odin:/Storage"] },
      { id: "server", sources: ["heimdall:/Storage/Services", "heimdall:/Storage/Apps"] },
    ]);
    expect(map.repositories).toEqual([
      { id: "on-disk", stored_on: "odin", path: "/Storage/Files/Backups/Laptop/Borgmatic" },
      { id: "to-heimdall", stored_on: "heimdall", path: "/Storage/Files/Backups/Laptop/Borgmatic" },
      { id: "server", stored_on: "heimdall", path: "/Storage/Backups/Server" },
      { id: "watched", stored_on: "10.100.100.6", path: "/srv/repo" },
    ]);
    expect(map.targets).toEqual([
      { id: "on-disk", job: "laptop", repository: "on-disk", sources: ["odin:/Storage"] },
      { id: "to-heimdall", job: "laptop", repository: "to-heimdall", sources: ["odin:/Storage"] },
      { id: "server", job: "server", repository: "server", sources: ["heimdall:/Storage/Services", "heimdall:/Storage/Apps"] },
      { id: "watched", job: null, repository: "watched", sources: [] },
    ]);
  });
});

describe("map_entry", () => {
  it("places targets by the configured hosts rather than their URLs", () => {
    const config = parse_config(JSON.stringify({
      hosts: [{ name: "odin", address: "10.0.0.5" }, { name: "heimdall" }, { name: "vault", kind: "storage-only" }],
      repositories: [
        { name: "offsite", host: "vault", repo: "ssh://borg@10.0.0.9/./offsite" },
        { name: "server", host: "heimdall", repo: "/Storage/Backups/Server", repo_by_host: { odin: "ssh://borg@heimdall.technet/Storage/Backups/Server" } },
      ],
      sources: [{ name: "home", host: "odin", source_paths: ["/home"] }],
      jobs: [{ name: "daily", sources: ["home"], repositories: ["offsite", "server"] }],
    }), "test.json");

    const map = backup_map(config.repositories.map((target) => map_entry(target, config.entities!)), "Heimdall");

    expect(map.hosts).toEqual([{ id: "odin", name: "Odin" }, { id: "vault", name: "Vault" }, { id: "heimdall", name: "Heimdall" }]);
    expect(map.jobs).toEqual([{ id: "daily", sources: ["odin:/home"] }]);
    expect(map.repositories).toEqual([
      { id: "offsite", stored_on: "vault", path: "/./offsite" },
      { id: "server", stored_on: "heimdall", path: "/Storage/Backups/Server" },
    ]);
    expect(map.targets).toEqual([
      { id: "daily:odin:offsite", job: "daily", repository: "offsite", sources: ["odin:/home"] },
      { id: "daily:odin:server", job: "daily", repository: "server", sources: ["odin:/home"] },
    ]);
  });

  it("draws a flat config as it reads its URLs, as its own job", () => {
    const config = parse_config(JSON.stringify({ repositories: [{ name: "to-heimdall", host: "odin.technet", repo: "ssh://borg@heimdall.technet/srv/repo", source_paths: ["/home"] }] }), "test.json");

    const map = backup_map(config.repositories.map((target) => map_entry(target, config.entities!)), "Heimdall");

    expect(map.repositories).toEqual([{ id: "to-heimdall", stored_on: "heimdall", path: "/srv/repo" }]);
    expect(map.targets).toEqual([{ id: "to-heimdall", job: "to-heimdall", repository: "to-heimdall", sources: ["odin:/home"] }]);
  });
});
