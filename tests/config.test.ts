import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { load_config, parse_config } from "../src/server/config.ts";

const example_file = fileURLToPath(new URL("../config.example.json", import.meta.url));

function parse_repositories(repositories: unknown[]) {
  return parse_config(JSON.stringify({ repositories }), "test.json");
}

describe("config loading", () => {
  it("loads the example file", () => {
    const config = load_config(example_file);

    expect(config.repositories.map((repository) => repository.name)).toEqual(["local", "nightly:fileserver:offsite"]);
    expect(config.repositories[0]).toMatchObject({ host: null, ssh_user: null, borg: { max_age: "2d" } });
    expect(config.repositories[1]).toMatchObject({ host: "fileserver.example.org", ssh_user: "backup", interval_in_seconds: 3600 });
  });

  it("keeps borg settings apart from its own", () => {
    const [repository] = parse_repositories([{ name: "nas", host: "nas", interval: 600, repo: "/backups", keep_daily: 7 }]).repositories;

    expect(repository.interval_in_seconds).toBe(600);
    expect(repository.borg).toEqual({ repo: "/backups", keep_daily: 7 });
  });

  it("stops when the variable is not set", () => {
    expect(() => load_config("")).toThrow("X_BACKUPS_CONFIG is not set");
  });

  it("stops on a file without a repositories list", () => {
    expect(() => parse_config("{}", "test.json")).toThrow('"repositories" list');
    expect(() => parse_config("{", "test.json")).toThrow("not valid JSON");
    expect(() => parse_config('{ "repositories": [], "jobs": {} }', "test.json")).toThrow('"jobs" must be a list');
  });

  it("names the repository with a bad entry", () => {
    expect(() => parse_repositories([{ name: "nas", repo: "/b", max_age: "soon" }])).toThrow("Repository 'nas': max_age must be a duration");
    expect(() => parse_repositories([{ name: "nas", repo: "/b", alow_delete: true }])).toThrow("Repository 'nas': unknown field 'alow_delete'");
    expect(() => parse_repositories([{ name: "nas", repo: "/b", require_sudo: "yes" }])).toThrow("require_sudo must be true or false");
    expect(() => parse_repositories([{ name: "nas", repo: "/b", ssh_user: "backup" }])).toThrow("ssh_user is set without a host");
    expect(() => parse_repositories([{ name: "nas", repo: "/b", interval: 0 }])).toThrow("interval must be longer than zero");
    expect(() => parse_repositories([{ name: "nas" }])).toThrow("Repository 'nas': repo is required");
  });

  it("names the position when the name itself is bad", () => {
    expect(() => parse_repositories([{ name: "ok", repo: "/a" }, { name: "has space", repo: "/b" }])).toThrow("Repository 2: name must be");
  });

  it("fills unset fields from the file's defaults", () => {
    const config = parse_config(JSON.stringify({ defaults: { interval: "10m", max_age: "2d" }, repositories: [{ name: "a", repo: "/a" }, { name: "b", repo: "/b", max_age: "1h" }] }), "test.json");

    expect(config.repositories[0]).toMatchObject({ interval_in_seconds: 600, borg: { max_age: "2d" } });
    expect(config.repositories[1].borg.max_age).toBe("1h");
    expect(() => parse_config(JSON.stringify({ defaults: { repo: "/x" }, repositories: [] }), "test.json")).toThrow("unknown default 'repo'");
  });

  it("names the field at fault", () => {
    try {
      parse_repositories([{ name: "nas", repo: "/b", max_age: "soon" }]);
    } catch (error) {
      expect((error as { field: string }).field).toBe("max_age");
    }
    expect(() => parse_repositories([{ name: "nas", repo: "/b", prune_after_backup: true }])).toThrow("prune_after_backup needs a keep_* retention policy");
  });

  it("stops on two repositories with the same id", () => {
    expect(() => parse_repositories([{ name: "a", repo: "/a" }, { name: "b", id: "a", repo: "/b" }])).toThrow("Repository 'b': id 'a' is used twice");
  });
});
