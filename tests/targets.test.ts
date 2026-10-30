import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { BorgRepository } from "../src/server/borg/repository.ts";
import {
  agent_keys, borg_fields, entity_field_list, entity_kinds, parse_config, target_key, type ConfigError, type RepositoryConfig,
} from "../src/server/config.ts";
import { make_key } from "./agents/test_keys.ts";

const hosts = [
  { name: "odin", address: "odin.technet", require_sudo: true },
  { name: "thor", address: "thor.technet" },
  { name: "storage", kind: "storage-only", address: "storage.technet" },
];

const key_folder = mkdtempSync(join(tmpdir(), "x-backups-target-keys-"));

function parse(document: Record<string, unknown>) {
  return parse_config(JSON.stringify({ hosts, repositories: [], ...document }), "test.json");
}

function built(target: RepositoryConfig): BorgRepository {
  return new BorgRepository(target.name, target.borg, target.scope);
}

// ── Jobs ─────────────────────────────────────────────────────────────────────

describe("job targets", () => {
  const config = parse({
    repositories: [
      { name: "offsite", host: "storage", repo: "ssh://borg@storage.technet/./shared", repo_by_host: { thor: "ssh://borg@storage.technet/./thor" }, poll_via: "thor" },
      { name: "disk", host: "odin", repo: "/srv/borg", repo_by_host: { thor: "ssh://borg@odin.technet//srv/borg" }, interval: "10m" },
    ],
    sources: [
      { name: "home", host: "odin", source_paths: ["/home"], exclude: ["*.tmp"] },
      { name: "etc", host: "odin", source_paths: "/etc", exclude: ["*.tmp", "*.bak"] },
      { name: "media", host: "thor", source_paths: ["/srv/media"] },
    ],
    jobs: [{ name: "nightly", sources: ["home", "etc", "media"], repositories: ["offsite", "disk"], keep_daily: 7 }],
  });

  it("builds one target per source host and repository", () => {
    expect(config.repositories.map((target) => target.name)).toEqual([
      "nightly:odin:offsite", "nightly:odin:disk", "nightly:thor:offsite", "nightly:thor:disk",
    ]);
    expect(config.repositories[0]).toMatchObject({
      host: "odin.technet", interval_in_seconds: 3600,
      target: { job: "nightly", host: "odin", repository: "offsite", sources: ["home", "etc"] },
    });
    expect(config.repositories[1].interval_in_seconds).toBe(600);
  });

  it("merges the sources on one host and takes each entity's fields", () => {
    const [odin_offsite] = config.repositories;
    expect(odin_offsite.borg).toMatchObject({
      id: "nightly:odin:offsite", repo: "ssh://borg@storage.technet/./shared", require_sudo: true, keep_daily: 7,
      source_paths: ["/home", "/etc"], exclude: ["*.tmp", "*.bak"],
    });
  });

  it("gives each client host its own URL where the repository names one", () => {
    expect(config.repositories[2].borg.repo).toBe("ssh://borg@storage.technet/./thor");
    expect(config.repositories[2].borg.require_sudo).toBeUndefined();
  });

  it("names archives by job and host, and prunes and lists only those", () => {
    const repository = built(config.repositories[0]);
    expect(repository.default_archive_name()).toMatch(/^nightly-odin-\d{4}-\d\d-\d\dT/);
    expect(repository.prune_match).toBe("nightly-odin-????-??-??T*");
    expect(repository.list_command()).toContain("--glob-archives 'nightly-odin-????-??-??T*'");

    const borg2 = parse({
      repositories: [{ name: "disk", host: "odin", repo: "/srv/borg", borg_version: 2 }],
      sources: [{ name: "home", host: "odin", source_paths: ["/home"] }],
      jobs: [{ name: "daily", archive_prefix: "laptop", sources: ["home"], repositories: ["disk"] }],
    });
    const target = built(borg2.repositories[0]);
    expect(target.default_archive_name()).toMatch(/^laptop-odin-/);
    expect(target.list_command()).toContain("-a 'sh:laptop-odin-????-??-??T*'");
  });

  it("offers compact and check once per repository, from the target polling from poll_via", () => {
    const offsite = config.entities!.repositories.find((repository) => repository.name === "offsite")!;
    expect(offsite.actions_target).toBe("nightly:thor:offsite");
    expect(offsite.targets).toEqual(["nightly:odin:offsite", "nightly:thor:offsite"]);

    const odin = built(config.repositories[0]);
    const thor = built(config.repositories[2]);
    expect(odin.get_actions().map((action) => action.action_id)).not.toContain("compact_repo");
    expect(thor.get_actions().map((action) => action.action_id)).toContain("compact_repo");
    expect(odin.compact_repo()).toMatchObject({ success: false, content: expect.stringContaining("nightly:thor:offsite") });
  });

  it("turns compact_after_backup into the repository's compact task, run once from the target offering its actions", () => {
    const compacting = parse({
      repositories: [{ name: "disk", host: "odin", repo: "/srv/borg", repo_by_host: { thor: "ssh://borg@odin.technet//srv/borg" } }],
      sources: [{ name: "home", host: "odin", source_paths: ["/home"] }, { name: "media", host: "thor", source_paths: ["/srv/media"] }],
      jobs: [{ name: "nightly", sources: ["home", "media"], repositories: ["disk"], compact_after_backup: true }],
    });
    const backup_command = (target: RepositoryConfig) => {
      const start = built(target).run_backup();
      return "command" in start ? start.command : "";
    };

    expect(backup_command(compacting.repositories[0])).not.toContain("compact --progress");
    expect(compacting.entities!.repositories[0]).toMatchObject({
      actions_target: "nightly:odin:disk", tasks: { compact: { after: "backup", enabled: true, origin: "translated" } },
    });
  });
});

// ── Watched repositories ─────────────────────────────────────────────────────

describe("repositories no job writes to", () => {
  it("are still watched, from their own managed host", () => {
    const config = parse({ repositories: [{ name: "borgmatic", host: "odin", id: "odin-borgmatic", repo: "/srv/borgmatic", max_age: "2d" }] });

    expect(config.repositories).toHaveLength(1);
    expect(config.repositories[0]).toMatchObject({
      name: "borgmatic", host: "odin.technet", borg: { id: "odin-borgmatic", max_age: "2d" }, target: { job: null, host: "odin", sources: [] },
    });
    expect(built(config.repositories[0]).get_actions().map((action) => action.action_id)).not.toContain("run_backup");
  });

  it("on a storage host are polled via the host poll_via names", () => {
    expect(() => parse({ repositories: [{ name: "offsite", host: "storage", repo: "ssh://storage.technet/./x" }] })).toThrow("poll_via must name");
    const config = parse({ repositories: [{ name: "offsite", host: "storage", repo: "ssh://storage.technet/./x", poll_via: "thor" }] });
    expect(config.repositories[0]).toMatchObject({ host: "thor.technet", target: { host: "thor" } });
  });

  it("refuse a folder path from a host other than their own, unless repo_by_host gives that host a URL", () => {
    const disk = { name: "disk", host: "odin", repo: "/srv/borg" };
    const home = { name: "home", host: "thor", source_paths: ["/home"] };
    const job = { name: "web", sources: ["home"], repositories: ["disk"] };

    expect(() => parse({ repositories: [disk], sources: [home], jobs: [job] })).toThrow("/srv/borg is a folder on 'odin', which 'thor' cannot reach");
    expect(() => parse({ repositories: [{ ...disk, poll_via: "thor" }] })).toThrow("which 'thor' cannot reach");
    const config = parse({ repositories: [{ ...disk, repo_by_host: { thor: "ssh://borg@odin.technet//srv/borg" } }], sources: [home], jobs: [job] });
    expect(config.repositories.find((target) => target.target?.job === "web")!.borg.repo).toBe("ssh://borg@odin.technet//srv/borg");
  });

  it("use the job's freshness, not their own, once a job writes to them", () => {
    const config = parse({
      repositories: [{ name: "disk", host: "odin", repo: "/srv/borg", max_age: "9d" }],
      sources: [{ name: "home", host: "odin", source_paths: ["/home"] }],
      jobs: [{ name: "daily", sources: ["home"], repositories: ["disk"], max_age: "2d" }],
    });
    expect(config.repositories.map((target) => [target.name, target.borg.max_age])).toEqual([["daily:odin:disk", "2d"]]);
  });
});

// ── Flat entries ─────────────────────────────────────────────────────────────

describe("flat entries", () => {
  it("expand into a host, a repository, a source and a job, keeping the entry as the target", () => {
    const entry = { name: "laptop", host: "odin.technet", ssh_user: "backup", repo: "ssh://borg@heimdall.technet/./laptop", source_paths: ["/home"], keep_daily: 7 };
    const config = parse_config(JSON.stringify({ repositories: [entry, { name: "local", repo: "/srv/local" }] }), "test.json");

    expect(config.repositories.map((target) => [target.name, target.borg.archive_prefix ?? null])).toEqual([["laptop", null], ["local", null]]);
    expect(config.repositories[0].borg).toEqual({ repo: entry.repo, source_paths: ["/home"], keep_daily: 7 });
    expect(config.entities!.hosts.map((host) => [host.name, host.kind, host.address])).toEqual([
      ["odin.technet", "managed", "odin.technet"], ["heimdall.technet", "storage-only", "heimdall.technet"], ["local", "managed", null],
    ]);
    expect(config.entities!.repositories[0]).toMatchObject({ name: "laptop", host: "heimdall.technet", poll_via: "odin.technet" });
    expect(config.entities!.sources.map((source) => source.name)).toEqual(["laptop"]);
    expect(config.entities!.jobs.map((job) => [job.name, job.sources])).toEqual([["laptop", ["laptop"]], ["local", []]]);
  });

  it("reads a repository on a written host as flat when it holds another entity's fields", () => {
    const config = parse({ repositories: [{ name: "old", host: "odin", repo: "/srv/old", source_paths: ["/etc"] }] });
    expect(config.repositories[0]).toMatchObject({ name: "old", host: "odin", borg: { source_paths: ["/etc"] } });
    expect(config.entities!.hosts.find((host) => host.name === "odin")!.address).toBe("odin.technet");
  });

  it("run on the written host their host names, keeping its key and kind, and stay flat", () => {
    const keys = { heimdall: make_key(key_folder, "heimdall").public_line, odin: make_key(key_folder, "odin").public_line };
    const shared = {
      ssh_user: "x-monitor-access", require_sudo: true, cache_dir: "/var/cache/x-monitor-borg", job_lock: "/run/x-monitor-borg.lock",
      archive_prefix: "backup", prune_after_backup: true, compact_after_backup: true, keep_daily: 7,
    };
    const repositories = [
      { ...shared, name: "heimdall-on-disk", host: "heimdall.technet", source_paths: ["/Storage/Services"], repo: "/Storage/Files/Backups/Server/Borgmatic" },
      { ...shared, name: "heimdall-ragnarok", host: "heimdall.technet", source_paths: ["/Storage/Services"], repo: "ssh://borg@ragnarok.technet/Storage/Backups/Server" },
      {
        ...shared, name: "odin-vorta-heimdall", host: "odin.technet", source_paths: ["/Storage"], archive_prefix: "odin", prune_match: "Odin-*",
        repo: "ssh://borg@heimdall.technet/Storage/Files/Backups/Laptop/Vorta",
      },
    ];
    const declared_hosts = [
      { name: "heimdall.technet", address: "heimdall.technet", agent_public_key: keys.heimdall },
      { name: "odin.technet", address: "odin.technet", agent_public_key: keys.odin },
    ];

    const flat_only = parse_config(JSON.stringify({ repositories }), "test.json");
    const with_hosts = parse_config(JSON.stringify({ hosts: declared_hosts, repositories }), "test.json");

    expect(with_hosts.repositories).toEqual(flat_only.repositories);
    expect(with_hosts.repositories.map((target) => [target_key(target), built(target).default_archive_name().replace(/\d.*$/, "")])).toEqual([
      [{ target_id: "heimdall-on-disk", host: "heimdall.technet", job: "heimdall-on-disk", repository: "heimdall-on-disk" }, "backup-"],
      [{ target_id: "heimdall-ragnarok", host: "heimdall.technet", job: "heimdall-ragnarok", repository: "heimdall-ragnarok" }, "backup-"],
      [{ target_id: "odin-vorta-heimdall", host: "odin.technet", job: "odin-vorta-heimdall", repository: "odin-vorta-heimdall" }, "odin-"],
    ]);
    expect(with_hosts.repositories[2].borg.prune_match).toBe("Odin-*");
    expect(with_hosts.repositories.every((target) => target.scope === undefined || target.scope.list_match === undefined)).toBe(true);
    expect(with_hosts.entities!.hosts.map((host) => [host.name, host.kind, host.address, host.agent_public_key, host.expanded_from])).toEqual([
      ["heimdall.technet", "managed", "heimdall.technet", keys.heimdall, null],
      ["odin.technet", "managed", "odin.technet", keys.odin, null],
      ["ragnarok.technet", "storage-only", "ragnarok.technet", null, "heimdall-ragnarok"],
    ]);
    expect(with_hosts.entities!.repositories.map((repository) => [repository.name, repository.expanded_from, repository.host, repository.poll_via])).toEqual([
      ["heimdall-on-disk", "heimdall-on-disk", "heimdall.technet", "heimdall.technet"],
      ["heimdall-ragnarok", "heimdall-ragnarok", "ragnarok.technet", "heimdall.technet"],
      ["odin-vorta-heimdall", "odin-vorta-heimdall", "heimdall.technet", "odin.technet"],
    ]);
    expect(agent_keys(with_hosts.entities)).toEqual(new Map([["heimdall.technet", keys.heimdall], ["odin.technet", keys.odin]]));
  });
});

describe("agent keys on hosts", () => {
  function field_of(run: () => unknown): string | null {
    try {
      run();
    } catch (error) {
      return (error as ConfigError).field;
    }
    return null;
  }

  it("takes an ssh-ed25519 line on a managed host", () => {
    const line = make_key(key_folder, "thor").public_line;

    const config = parse({ hosts: [{ name: "thor", address: "thor.technet", agent_public_key: line }] });

    expect(config.entities!.hosts[0].agent_public_key).toBe(line);
    expect(entity_field_list("hosts").map((field) => field.name)).toContain("agent_public_key");
  });

  it("refuses a bad line, another key type, and a host that runs no agent of its own", () => {
    const blob = make_key(key_folder, "refused").public_line.split(" ")[1];
    const host = (fields: Record<string, unknown>) => () => parse({ hosts: [{ name: "thor", address: "thor.technet", ...fields }] });

    expect(host({ agent_public_key: "not a key" })).toThrow("Host 'thor': agent_public_key must be an ssh-ed25519 key, not not");
    expect(host({ agent_public_key: `ssh-rsa ${blob}` })).toThrow("agent_public_key must be an ssh-ed25519 key, not ssh-rsa");
    expect(host({ agent_public_key: "ssh-ed25519 AAAA" })).toThrow("Host 'thor': agent_public_key is cut short");
    expect(host({ agent_public_key: 42 })).toThrow("agent_public_key must be a string");
    expect(field_of(host({ agent_public_key: "ssh-ed25519" }))).toBe("agent_public_key");
    expect(host({ kind: "storage-only", agent_public_key: `ssh-ed25519 ${blob}` })).toThrow("storage-only host runs none");
    expect(() => parse({ hosts: [{ name: "server", agent_public_key: `ssh-ed25519 ${blob}` }] })).toThrow("runs the one built in");
  });
});

// ── Checks ───────────────────────────────────────────────────────────────────

describe("cross-references", () => {
  const sources = [{ name: "home", host: "odin", source_paths: ["/home"] }];
  const repositories = [{ name: "disk", host: "odin", repo: "/srv/borg" }];

  it("names what an entity refers to that is not there", () => {
    expect(() => parse({ repositories: [{ name: "disk", host: "ghost", repo: "/x", poll_via: "odin" }] })).toThrow("Repository 'disk': no host named 'ghost'");
    expect(() => parse({ sources: [{ name: "home", host: "ghost", source_paths: ["/home"] }] })).toThrow("Source 'home': no host named 'ghost'");
    expect(() => parse({ repositories, sources, jobs: [{ name: "daily", sources: ["away"], repositories: ["disk"] }] })).toThrow("no source named 'away'");
    expect(() => parse({ repositories, sources, jobs: [{ name: "daily", sources: ["home"], repositories: ["away"] }] })).toThrow("no repository named 'away'");
  });

  it("refuses a source on a storage host and a job missing either side", () => {
    expect(() => parse({ sources: [{ name: "home", host: "storage", source_paths: ["/home"] }] })).toThrow("storage-only");
    expect(() => parse({ repositories, sources, jobs: [{ name: "daily", sources: [], repositories: ["disk"] }] })).toThrow("Job 'daily': needs at least one source");
    expect(() => parse({ repositories, sources, jobs: [{ name: "daily", sources: ["home"] }] })).toThrow("needs at least one repository");
  });

  it("refuses two entities of a kind with one name, and two repositories with one id", () => {
    expect(() => parse({ sources: [...sources, ...sources] })).toThrow("Source 'home' is defined twice");
    expect(() => parse({ repositories: [...repositories, { name: "other", host: "odin", repo: "/y", id: "disk" }] })).toThrow("Repository 'other': id 'disk' is used twice");
  });

  it("refuses sources on one host that disagree on a single setting", () => {
    expect(() => parse({
      repositories,
      sources: [...sources, { name: "etc", host: "odin", source_paths: ["/etc"], one_file_system: false }, { name: "var", host: "odin", source_paths: ["/var"], one_file_system: true }],
      jobs: [{ name: "daily", sources: ["etc", "var"], repositories: ["disk"] }],
    })).toThrow("give different one_file_system");
  });

  it("names the entity and field a bad value sits on", () => {
    let field: string | null = null;
    try {
      parse({ hosts: [{ name: "odin", kind: "cloud" }] });
    } catch (error) {
      field = (error as { field: string }).field;
    }
    expect(field).toBe("kind");
    expect(() => parse({ repositories, sources, jobs: [{ name: "daily", sources: ["home"], repositories: ["disk"], repo: "/x" }] })).toThrow("Job 'daily': unknown field 'repo'");
  });
});

describe("field homes", () => {
  it("gives every borg field but id an entity", () => {
    const homed = new Set(entity_kinds.flatMap((kind) => entity_field_list(kind).map((field) => field.name)));
    expect(Object.keys(borg_fields).filter((field) => !homed.has(field))).toEqual([]);
  });
});

// ── Tasks ────────────────────────────────────────────────────────────────────

describe("tasks", () => {
  const disk = { name: "disk", host: "odin", repo: "/srv/borg", check_kinds: { repository: "14d", archives: "8d" } };
  const home = { name: "home", host: "odin", source_paths: ["/home"] };

  it("takes a schedule or an object, and fills what it leaves out", () => {
    const config = parse({
      repositories: [{ ...disk, tasks: { compact: { schedule: "weekly sun 03:00" }, check: { kind: "data", enabled: false } } }],
      sources: [home],
      jobs: [{ name: "web", sources: ["home"], repositories: ["disk"], keep_daily: 7, tasks: { backup: "daily 02:00", prune: { after: "backup" } } }],
    });
    const [repository] = config.entities!.repositories;
    const [job] = config.entities!.jobs;

    expect(job.tasks).toEqual({
      backup: { schedule: "daily 02:00", after: null, enabled: true, check: null, origin: "written" },
      prune: { schedule: null, after: "backup", enabled: true, check: null, origin: "written" },
      // Half the archives check's limit of 8 days.
      check: { schedule: "4d", after: null, enabled: true, check: "archives", origin: "default" },
    });
    expect(repository.tasks).toEqual({
      compact: { schedule: "weekly sun 03:00", after: null, enabled: true, check: null, origin: "written" },
      check: { schedule: null, after: null, enabled: false, check: "data", origin: "manual" },
    });
  });

  it("leaves a watched repository's check to be started by hand, checking everything where no job writes", () => {
    const config = parse({ repositories: [disk] });
    expect(config.entities!.repositories[0].tasks.check).toEqual({ schedule: null, after: null, enabled: false, check: "all", origin: "manual" });
  });

  it("defaults checks from check_kinds only where a job's backup is scheduled", () => {
    const scheduled = parse({ repositories: [disk], sources: [home], jobs: [{ name: "web", sources: ["home"], repositories: ["disk"], tasks: { backup: "daily 02:00" } }] });
    const by_hand = parse({ repositories: [disk], sources: [home], jobs: [{ name: "web", sources: ["home"], repositories: ["disk"] }] });

    // Half the repository check's limit of 14 days.
    expect(scheduled.entities!.repositories[0].tasks.check).toMatchObject({ schedule: "7d", check: "repository", origin: "default" });
    expect(by_hand.entities!.repositories[0].tasks.check).toMatchObject({ schedule: null, enabled: false, origin: "manual" });
    expect(by_hand.entities!.jobs[0].tasks.check).toMatchObject({ schedule: null, enabled: false, origin: "manual" });
  });

  it("translates prune_after_backup and compact_after_backup into tasks run after a backup", () => {
    const config = parse({ repositories: [{ name: "flat", repo: "/srv/flat", source_paths: ["/etc"], keep_daily: 7, prune_after_backup: true, compact_after_backup: true }] });
    const job = config.entities!.jobs.find((item) => item.name === "flat")!;
    const repository = config.entities!.repositories.find((item) => item.name === "flat")!;

    expect(job.tasks.prune).toMatchObject({ after: "backup", enabled: true, origin: "translated" });
    expect(repository.tasks.compact).toMatchObject({ after: "backup", enabled: true, origin: "translated" });
  });

  it("splits a flat entry's tasks between its job and its repository", () => {
    const config = parse({ repositories: [{ name: "flat", repo: "/srv/flat", source_paths: ["/etc"], tasks: { backup: "6h", check: "monthly", compact: "1w" } }] });
    const job = config.entities!.jobs.find((item) => item.name === "flat")!;
    const repository = config.entities!.repositories.find((item) => item.name === "flat")!;

    expect(job.tasks.backup).toMatchObject({ schedule: "6h" });
    expect(job.tasks.check).toMatchObject({ origin: "manual" });
    expect(repository.tasks).toMatchObject({ check: { schedule: "monthly", check: "repository" }, compact: { schedule: "1w" } });
  });

  it("runs a job's canary as a task, which its polls then leave out", () => {
    const config = parse({ repositories: [disk], sources: [home], jobs: [{ name: "web", sources: ["home"], repositories: ["disk"], canary_path: "/home/canary" }] });

    expect(config.entities!.jobs[0].tasks.canary).toMatchObject({ schedule: "1d", origin: "default" });
    expect(config.repositories[0].scope).toMatchObject({ canary_by_task: true });
    const repository = built(config.repositories[0]);
    repository.state = { ...repository.state, archives: [{ name: "web-odin-2026-10-01T10:00:00" } as never] };
    expect(repository.poll_plan().map(([name]) => name)).not.toContain("canary");
  });

  it.each([
    [{ backup: "whenever" }, "tasks.backup.schedule: Unrecognised schedule"],
    [{ restore: "1d" }, "unknown task 'restore'"],
    [{ backup: { after: "backup" } }, "only prune and compact run after a backup"],
    [{ prune: "1d" }, "prune needs a keep_* retention policy"],
    [{ check: { kind: "data" } }, "tasks.check.kind must be archives, extract"],
    [{ backup: { enabled: true } }, "tasks.backup has no schedule, so it cannot be enabled"],
  ])("refuses the job tasks %j", (tasks, message) => {
    expect(() => parse({ repositories: [disk], sources: [home], jobs: [{ name: "web", sources: ["home"], repositories: ["disk"], tasks }] })).toThrow(message);
  });
});
