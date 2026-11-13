---
title: User guide
nav_order: 2
has_children: true
permalink: /user/
---

# User guide

This part of the documentation is for people **running and using** X-Backups: setting it up, describing what to back
up, and watching and restoring backups from the page. If you want to change X-Backups itself, see the
[architecture](../architecture.html) and the README in the repository.

Start with [Getting started](getting-started.html) to install the server and its agents, then read
[Concepts](concepts.html): the rest makes most sense once you know what hosts, repositories, sources, jobs and targets
are.

| Page                                          | Covers                                                          |
| :-------------------------------------------- | :-------------------------------------------------------------- |
| [Getting started](getting-started.html)       | Installing on NixOS or by hand, the first sign-in               |
| [Concepts](concepts.html)                     | Hosts, repositories, sources, jobs, targets, tasks and runs     |
| [Configuration](configuration.html)           | The config file, its fields, defaults and health ages           |
| [Scheduling](scheduling.html)                 | When backups, prunes, checks and compacts run                   |
| [Agents](agents.html)                         | Enrolling a host, keys and tokens, sudo rules                   |
| [Using the page](using-the-page.html)         | Each page, the actions, browsing and restoring archives         |
| [Editing from the page](editing-from-the-page.html) | Config modes and adding entities from Settings             |
| [Users and access](users-and-access.html)     | Roles, job grants, second factor, tokens, single sign-on         |
| [Monitoring and integrations](monitoring.html) | `/api/health`, Prometheus, MCP and the database's own backups  |
| [Borg 2](borg2.html)                          | Driving borg 2 repositories                                     |
