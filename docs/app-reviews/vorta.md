# Vorta review (docs only)

## Summary
Vorta is a Qt (PyQt) desktop GUI/tray app for macOS and Linux wrapping BorgBackup, with a local SQLite settings store (settings.db) and a scheduler. GPL-3.0. Actively maintained: v0.11.6 (7 Sep, year not shown on the releases page, probably 2025), 0.11.x series through the year, 1007 commits, ~2.5k stars, 174 open issues. Supports Borg 1.x and has Borg 2.x timestamp fixes. Runs on the machine being backed up (client-side, not a server dashboard).

## Features
- Views: tabs Repository, Sources, Archives, Schedule, Misc; profile selector; tray menu. Sources tab shows size/file count (0.11.4). Archives tab = central list of point-in-time archives.
- Jobs: Start Backup, create/add repo, prune (manual or "prune after each backup"), mount/unmount, extract; pre/post-backup shell commands (async since 0.11.0; per release notes).
- Scheduling: Schedule tab, in-app scheduler (src/vorta/scheduler); 0.11.6 fixes timer limits and adds groundwork for persistent scheduler jobs. WiFi network list with Select All/None, wait for network before remote backups (0.11.4). Details of missed-run handling NOT in the fetched docs (no schedule docs page exists; usage page says only "auto-pilot").
- Notifications: desktop notifications (src/vorta/notifications.py exists); no docs page fetched. Docs mention only BorgBase.com alerts for backups stale more than X days.
- Restore/browse/diff/mount: Extract (file tree dialog by full path, choose folder, extraction target, completion message); Mount (choose empty dir, browse in file manager, Unmount; FUSE errors documented). Diff: the docs do NOT describe it (the app has an archive diff feature per my background knowledge, unverified here).
- Repo management: create or add existing repo, passphrase change in UI (0.11.0), BorgBase integration.
- Security: passphrase stored in OS keyring (src/vorta/keyring; KWallet fix in 0.11.2); docs say keep passphrase/keyfile off source machine.
- Other: profile import/export as JSON (optional password, optional global settings), bootstrap via ~/.vorta-init.json, settings.db migration, i18n, autostart, inhibitor (sleep inhibit), dbus.

## Lacking in X-Backups, with scope fit
- Archive extract tree dialog with path select: partly present (browse/restore) - FITS; copy the full-path tree + choose target UX if not there.
- Mount archive: needs FUSE on the server and exposing files; marginal, OUT of scope (browse/restore covers it) unless read-only download of a path is wanted.
- Sources tab size/file-count display: FITS only as read-only info from last archive stats.
- Schedule display in UI: FITS read-only (X-Backups already shows systemctl timers); show next run and "last run missed" derived from timer + last archive.
- Missed-run handling / in-app scheduler: OUT (systemd timers with Persistent=true do this).
- Desktop notifications: OUT (X-Monitor alerts).
- Prune after each backup toggle: OUT (declarative in NixOS module).
- Pre/post commands: OUT (config).
- Profile import/export, repo creation, passphrase change, WiFi/metered rules, keyring, autostart, tray: OUT (declarative/desktop-only).
- BorgBase stale-backup alerts: OUT (X-Monitor via /api/health).
- Multiple profiles switcher: X-Backups already has multi-repo; N/A.

## Look at in source later
src/vorta/views/ (archive_tab, schedule_tab, extract_dialog, diff_result_dialog if present, source_tab), src/vorta/borg/ (jobs: create, prune, mount, diff, extract, list; JSON output parsing), src/vorta/scheduler/ (missed-run and next-run logic), src/vorta/notifications.py, src/vorta/store/ (models, settings), src/vorta/network_status/, tests/. Note this listing was truncated ("View all files").

## Pages that could not be used
vorta.borgbase.com/usage/settings/ only covers import/export; no pages found for schedule, notifications, diff, archives tab beyond restore/prune/local. Release years not shown.

## Sources
https://github.com/borgbase/vorta ; https://vorta.borgbase.com/ ; /usage/restore/ ; /usage/settings/ ; /usage/prune/ ; /usage/local/ ; /faq/ ; https://github.com/borgbase/vorta/releases ; https://github.com/borgbase/vorta/tree/master/src/vorta
