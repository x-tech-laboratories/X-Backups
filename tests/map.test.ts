import { describe, expect, it } from "vitest";
import { backup_map, repo_location } from "../src/server/map.ts";

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
  it("joins a host's names and draws each repository from its sources to where it is stored", () => {
    const map = backup_map([
      { id: "on-disk", name: "on-disk", host: "odin.technet", repo: "/Storage/Files/Backups/Laptop/Borgmatic", source_paths: ["/Storage"] },
      { id: "to-heimdall", name: "to-heimdall", host: "odin.technet", repo: "ssh://borg@heimdall.technet/Storage/Files/Backups/Laptop/Borgmatic", source_paths: ["/Storage"] },
      { id: "server", name: "server", host: null, repo: "/Storage/Backups/Server", source_paths: ["/Storage/Services", "/Storage/Apps"] },
      { id: "watched", name: "watched", host: "10.100.100.6", repo: "/srv/repo", source_paths: [] },
    ], "Heimdall");

    expect(map.hosts).toEqual([
      { id: "odin", name: "Odin" },
      { id: "heimdall", name: "Heimdall" },
      { id: "10.100.100.6", name: "10.100.100.6" },
    ]);
    expect(map.sources.map((source) => source.id)).toEqual(["odin:/Storage", "heimdall:/Storage/Apps", "heimdall:/Storage/Services"]);
    expect(map.repositories).toEqual([
      { id: "on-disk", stored_on: "odin", path: "/Storage/Files/Backups/Laptop/Borgmatic", sources: ["odin:/Storage"] },
      { id: "to-heimdall", stored_on: "heimdall", path: "/Storage/Files/Backups/Laptop/Borgmatic", sources: ["odin:/Storage"] },
      { id: "server", stored_on: "heimdall", path: "/Storage/Backups/Server", sources: ["heimdall:/Storage/Services", "heimdall:/Storage/Apps"] },
      { id: "watched", stored_on: "10.100.100.6", path: "/srv/repo", sources: [] },
    ]);
  });
});
