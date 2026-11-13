---
title: Users and access
parent: User guide
nav_order: 8
---

# Users and access

The password hash file signs in as `admin` (`X_BACKUPS_ADMIN_NAME` renames it). That admin adds other users on the
Users page, each with a role and the jobs they are granted, or everything.

## Roles

| Role       | May                                                                 |
| :--------- | :------------------------------------------------------------------ |
| `viewer`   | see status, history, runs and events                                |
| `operator` | also run actions, restore, and read and download what is inside archives |
| `admin`    | also change the config, users and everyone's tokens                 |

## Grants

- A job's grant shows its targets with their runs, events and archives, the sources and repositories it uses, and the
  hosts those are on.
- A repository no job writes to, such as one a host's own borgmatic fills, is granted by itself.
- Where two jobs share a repository, a user granted one sees the repository and that job's targets and archives only,
  and sees the repository's own compact and check runs.
- Acting on the whole repository (compact, check, break lock, deleting or purging archives, and cancelling or
  rerunning those) needs an admin, or a user granted every job writing there.

## Signing in

Signing in, the Account page and the Users page are the X-Libs accounts every X-app shares.

- Unless **Keep me signed in** is ticked, a session ends when the browser closes; ticked, it lasts until it is signed
  out from the Account page or by an admin. Sessions survive a restart of the server.
- On the Account page anyone can change their password, turn on a second factor (an authenticator app, with recovery
  codes), see where they are signed in and sign those out, and make tokens.
- One name may be tried from one address five times in five minutes, right or wrong; then that pair waits.

## Tokens

A token acts as the user who made it, read-only unless they untick that. Send one as `Authorization: Bearer <token>`.
A read-only token can only make GET requests and run the MCP tools that read.

## Single sign-on

Two other ways in, both only for users an admin has added:

- **OIDC:** set `X_BACKUPS_OIDC_ISSUER`, `X_BACKUPS_OIDC_CLIENT_ID`, `X_BACKUPS_OIDC_CLIENT_SECRET_FILE` and
  `X_BACKUPS_OIDC_REDIRECT_URL` (the public URL of `/api/auth/oidc/callback`). The `preferred_username` claim names
  the user; `X_BACKUPS_OIDC_USERNAME_CLAIM` picks another.
- **A reverse proxy's header:** `X_BACKUPS_PROXY_USER_HEADER`, believed only from `X_BACKUPS_TRUSTED_PROXIES` (default
  `127.0.0.1,::1`). The proxy must strip that header from what clients send.

The NixOS module has the same as `adminName`, `oidc.*` and `proxyLogin.*`.
