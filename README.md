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

## Private tracking

The same cron can poll extra guilds and push their data into a **private** repo instead of
this one (`private-poll.js`, last two workflow steps). It stays off until these repo secrets
are set:

- `PRIVATE_REPO` — `owner/name` of the private data repo (needs an initial commit)
- `PRIVATE_REPO_TOKEN` — fine-grained PAT with *Contents: read and write* on that repo only
- `PRIVATE_GUILD_PREFIXES` — comma-separated guild prefixes, e.g. `Alps`

Data lands in `data/` of the private repo (`snapshots.json`, `members_state.json`,
`events.json`, `member_raids.json`, `presence.json`, keyed by guild name). Secret values are
masked in the public Actions logs, and a failure there never blocks the race snapshot.
