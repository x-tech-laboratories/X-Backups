import { describe, expect, it } from "vitest";

import { BorgRepository } from "../src/server/borg/repository.ts";
import { borg_fields, entity_field_list, entity_kinds, parse_config, type RepositoryConfig } from "../src/server/config.ts";

const hosts = [
  { name: "odin", address: "odin.technet", require_sudo: true },
  { name: "thor", address: "thor.technet" },
  { name: "storage", kind: "storage-only", address: "storage.technet" },
];

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
      { name: "disk", host: "odin", repo: "/srv/borg", interval: "10m" },
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
      repositories: [{ name: "disk", host: "odin", repo: "/srv/borg" }],
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

  it("defaults a repository's check from check_kinds, checking everything where no job writes", () => {
    const config = parse({ repositories: [disk] });
    expect(config.entities!.repositories[0].tasks.check).toEqual({ schedule: "4d", after: null, enabled: true, check: "all", origin: "default" });
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
