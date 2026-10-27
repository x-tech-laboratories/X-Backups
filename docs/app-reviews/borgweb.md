# BorgWeb review (docs only)

## Summary
BorgWeb is a small Flask web UI plus JavaScript front end for Borg, run on the machine being backed up (built-in server on 127.0.0.1:5000, or WSGI via borgweb.wsgi). Scope is deliberately tiny: review backup log files and start a backup. Maturity: README says "software in development"; releases 0.1.4 (first PyPI), 0.2.0, 0.3.0 (Flask 1.0 compat, Python 3.5/3.6), 280 commits, 399 stars, 12 open issues. No release dates visible; looks effectively unmaintained/stagnant (my inference from the 0.3.0 era), not confirmed.

## Features
- Views: list of log files with backup status (success/warning/danger from return code 0/1/other), scrollbar list, current log highlighted, log content view, path/status line; German translation; JavaScript required.
- Jobs: start a backup (borg create with --list --stats --show-version --show-rc); stdin disconnected.
- Scheduling: none. Notifications: none.
- Restore/browse/diff/mount: none (admin must restore).
- Repo management: none; config file via BORGWEB_CONFIG, KEY = value lines (repo and logs dir defaults); borg does not write logs itself, user redirects output.
- Security: no auth documented, nothing on access control; keep to localhost/behind a reverse proxy.
- Other: Flask debugger disabled, logging.conf.

## Lacking in X-Backups
Nothing: X-Backups is a strict superset. Only ideas: log-file list with coloured overall status from the borg return code (0 ok, 1 warning, other danger) - FITS, X-Backups could distinguish warning (rc 1) from failed in job results/events. Everything else (start backup) already exists.

## Look at in source later
borgweb/app.py, borgweb/views/ (log list and backup start endpoints), borgweb/config.py (supported keys), borgweb/templates/, js/ (front end log polling), borgweb/_tests. Low priority.

## Pages that could not be used
Docs index mostly empty; no changelog dates, no license stated on README fetch. Installation and usage pages were fetched and are thin.

## Sources
https://github.com/borgbackup/borgweb ; https://borgweb.readthedocs.io/en/stable/ ; /installation.html ; /usage.html ; https://raw.githubusercontent.com/borgbackup/borgweb/master/CHANGES ; https://github.com/borgbackup/borgweb/tree/master/borgweb
