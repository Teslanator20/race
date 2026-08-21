# the race

Side-by-side tracker for Sequoia vs Aequitas. Polls every 5 min, retains the whole current
season (plus a 14-day floor across season changes), renders charts on a static page hosted
via GitHub Pages.

- `guilds.json` — the two guilds to compare
- `poll.js` — fetches both guilds + 5 raid SR leaderboards, appends to `snapshots.json`
- `snapshots.json` — season history (committed by the action). Older entries are thinned by
  age — full 5-min resolution for 3 days, 30 min up to 14 days, 2 h beyond — so a full season
  stays a few MB instead of tens.
- `index.html` — comparison dashboard

Workflow: `.github/workflows/poll.yml` runs every 5 min on cron + workflow_dispatch.
Reliable trigger via cron-job.org → `POST /actions/workflows/poll.yml/dispatches`.
