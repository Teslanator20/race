import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  fetchJson, fetchRaidLeaderboards, summarize, pruneSnapshots, detectEvents,
  updatePresence, loadJson, EVENTS_RETAIN_DAYS,
} from "./poll.js";

// Tracks extra guilds whose data must not end up in this public repo. The guild list and the
// output directory come from the workflow (secrets), and the output directory is a checkout
// of a private repo that the workflow commits to. Only generic counts are logged, since
// Actions logs of a public repo are public too.
//
//   PRIVATE_GUILD_PREFIXES="Alps,Foo"  node private-poll.js <outDir>
//
// Per guild name it keeps the same data the race keeps: snapshots, member state, join/leave/
// rank events, per-day raid totals and online sessions.

const outDir = process.argv[2];
const prefixes = (process.env.PRIVATE_GUILD_PREFIXES || "")
  .split(",").map(s => s.trim()).filter(Boolean);

async function main() {
  if (!outDir) throw new Error("usage: node private-poll.js <outDir>");
  if (!prefixes.length) throw new Error("PRIVATE_GUILD_PREFIXES is empty");
  await mkdir(outDir, { recursive: true });
  const file = name => join(outDir, name);

  const raidLbs = await fetchRaidLeaderboards();
  const summaries = [];
  for (const prefix of prefixes) {
    const data = await fetchJson(`https://api.wynncraft.com/v3/guild/prefix/${encodeURIComponent(prefix)}`);
    summaries.push(summarize(data.name ?? prefix, data, raidLbs));
  }

  const nowMs = Date.now();
  const ts = new Date(nowMs).toISOString();

  // 1) snapshot history
  const guilds = {};
  for (const s of summaries) guilds[s.snapshot.name] = s.snapshot;
  const history = await loadJson(file("snapshots.json"), { snapshots: [] });
  if (!Array.isArray(history.snapshots)) history.snapshots = [];
  history.snapshots.push({
    ts,
    season: summaries.find(s => s.snapshot.seasonNumber != null)?.snapshot.seasonNumber ?? null,
    guilds,
  });
  history.snapshots = pruneSnapshots(history.snapshots, nowMs);
  history.updated = ts;

  // 2) members state + 3) events
  const prevState = await loadJson(file("members_state.json"), null);
  const newState = { updated: ts, guilds: {} };
  for (const s of summaries) newState.guilds[s.members.name] = s.members;

  const eventLog = await loadJson(file("events.json"), { events: [] });
  if (!Array.isArray(eventLog.events)) eventLog.events = [];
  for (const [name, g] of Object.entries(newState.guilds)) {
    const prev = prevState?.guilds?.[name];
    if (prev) eventLog.events.push(...detectEvents(prev, g, name, ts));
  }
  const eventsCutoff = nowMs - EVENTS_RETAIN_DAYS * 86400_000;
  eventLog.events = eventLog.events.filter(e => new Date(e.ts).getTime() >= eventsCutoff);
  eventLog.updated = ts;

  // 4) per-member daily raid totals
  const prevMr = await loadJson(file("member_raids.json"), null);
  const dayKey = ts.slice(0, 10);
  const cutoffKey = new Date(nowMs - 14 * 86400_000).toISOString().slice(0, 10);
  const newMr = { updated: ts, guilds: {} };
  for (const [name, g] of Object.entries(newState.guilds)) {
    const prevG = prevMr?.guilds?.[name] || {};
    newMr.guilds[name] = {};
    for (const m of g.members) {
      const byDay = {};
      for (const [d, v] of Object.entries(prevG[m.uuid]?.byDay || {})) if (d >= cutoffKey) byDay[d] = v;
      byDay[dayKey] = m.guildRaidsTotal;
      newMr.guilds[name][m.uuid] = { username: m.username, byDay };
    }
  }

  // 5) per-member online sessions
  const prevPresence = await loadJson(file("presence.json"), null);
  const presence = updatePresence(prevPresence, Object.values(newState.guilds), nowMs);

  await writeFile(file("snapshots.json"), JSON.stringify(history, null, 2) + "\n");
  await writeFile(file("members_state.json"), JSON.stringify(newState, null, 2) + "\n");
  await writeFile(file("events.json"), JSON.stringify(eventLog, null, 2) + "\n");
  await writeFile(file("member_raids.json"), JSON.stringify(newMr, null, 2) + "\n");
  await writeFile(file("presence.json"), JSON.stringify(presence) + "\n");

  console.log(`OK private guilds=${summaries.length} snaps=${history.snapshots.length}`);
}

main().catch((e) => {
  // The error text can contain the guild prefix via the URL; blank it out.
  let msg = String(e?.message || e);
  for (const p of prefixes) msg = msg.split(encodeURIComponent(p)).join("***").split(p).join("***");
  console.error("private poll failed:", msg);
  process.exit(1);
});
