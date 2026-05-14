# the race

Side-by-side tracker for Sequoia vs Aequitas. Polls every 5 min, retains 14 days of snapshots,
renders charts on a static page hosted via GitHub Pages.

- `guilds.json` — the two guilds to compare
- `poll.js` — fetches both guilds + 5 raid SR leaderboards, appends to `snapshots.json`
- `snapshots.json` — rolling history (committed by the action)
- `index.html` — comparison dashboard

Workflow: `.github/workflows/poll.yml` runs every 5 min on cron + workflow_dispatch.
Reliable trigger via cron-job.org → `POST /actions/workflows/poll.yml/dispatches`.
