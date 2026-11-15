---
title: User guide
sidebar:
  order: 0
  label: Overview
---

This part of the documentation is for people **running and using** X-Backups: setting it up, describing what to back
up, and watching and restoring backups from the page. If you want to change X-Backups itself, see the
[architecture](/architecture/) and the README in the repository.

Start with [Getting started](/user/getting-started/) to install the server and its agents, then read
[Concepts](/user/concepts/): the rest makes most sense once you know what hosts, repositories, sources, jobs and targets
are.

| Page                                          | Covers                                                          |
| :-------------------------------------------- | :-------------------------------------------------------------- |
| [Getting started](/user/getting-started/)       | Installing on NixOS or by hand, the first sign-in               |
| [Concepts](/user/concepts/)                     | Hosts, repositories, sources, jobs, targets, tasks and runs     |
| [Configuration](/user/configuration/)           | The config file, its fields, defaults and health ages           |
| [Scheduling](/user/scheduling/)                 | When backups, prunes, checks and compacts run                   |
| [Agents](/user/agents/)                         | Enrolling a host, keys and tokens, sudo rules                   |
| [Using the page](/user/using-the-page/)         | Each page, the actions, browsing and restoring archives         |
| [Editing from the page](/user/editing-from-the-page/) | Config modes and adding entities from Settings             |
| [Users and access](/user/users-and-access/)     | Roles, job grants, second factor, tokens, single sign-on         |
| [Monitoring and integrations](/user/monitoring/) | `/api/health`, Prometheus, MCP and the database's own backups  |
| [Borg 2](/user/borg2/)                          | Driving borg 2 repositories                                     |
