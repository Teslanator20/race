import { readFile, writeFile } from "node:fs/promises";

const GUILDS_FILE       = "guilds.json";
const HISTORY_FILE      = "snapshots.json";
const MEMBERS_STATE_FILE = "members_state.json";
const EVENTS_FILE       = "events.json";

const RETAIN_DAYS       = 14;
const EVENTS_RETAIN_DAYS = 60;
const RANK_ORDER = ["owner", "chief", "strategist", "captain", "recruiter", "recruit"];
const RAID_LBS = {
  grootslang: "grootslangSrGuilds",
  nameless:   "namelessSrGuilds",
  colossus:   "colossusSrGuilds",
  orphion:    "orphionSrGuilds",
  fruma:      "frumaSrGuilds",
};
const TIMEOUT_MS = 25_000;
const UA = "race-tracker/2.0";

// ──────────────────────────────────────────────────────────────
// Fetch helpers
// ──────────────────────────────────────────────────────────────
async function fetchJson(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA }, signal: ctrl.signal });
    if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

async function fetchGuild(name) {
  return await fetchJson(`https://api.wynncraft.com/v3/guild/${encodeURIComponent(name)}`);
}

async function fetchRaidLeaderboards() {
  const out = {};
  await Promise.all(Object.entries(RAID_LBS).map(async ([raid, lb]) => {
    out[raid] = await fetchJson(`https://api.wynncraft.com/v3/leaderboards/${lb}?resultLimit=100`);
  }));
  return out;
}

// ──────────────────────────────────────────────────────────────
// Parsers
// ──────────────────────────────────────────────────────────────
function latestSeason(seasonRanks) {
  if (!seasonRanks) return null;
  let max = null;
  for (const k of Object.keys(seasonRanks)) {
    const n = Number(k);
    if (Number.isFinite(n) && (max === null || n > max)) max = n;
  }
  return max;
}

function findInLb(lbEntries, uuid) {
  for (const [rankStr, e] of Object.entries(lbEntries)) {
    if (e.uuid === uuid) {
      const meta = e.metadata || {};
      return {
        rank: Number(rankStr),
        sr: Number(e.score || 0),
        completions: Number(meta.completions || 0),
        gambits: Number(meta.gambits || 0),
      };
    }
  }
  return null;
}

function extractMembers(memData) {
  const out = [];
  let online = 0;
  for (const rank of RANK_ORDER) {
    const group = memData?.[rank] || {};
    for (const [username, m] of Object.entries(group)) {
      const isOnline = !!m.online;
      if (isOnline) online++;
      out.push({
        username,
        uuid: m.uuid,
        rank,
        joined: m.joined ?? null,
        online: isOnline,
        server: m.server ?? null,
        contributed: Number(m.contributed || 0),
        contributionRank: m.contributionRank ?? null,
        guildRaidsTotal: Number(m.globalData?.guildRaids?.total ?? 0),
      });
    }
  }
  return { members: out, online, total: out.length };
}

function summarize(name, data, raidLbs) {
  const season = latestSeason(data.seasonRanks);
  const sr = season != null ? data.seasonRanks[String(season)] : null;
  const perRaid = {};
  for (const key of Object.keys(RAID_LBS)) {
    perRaid[key] = findInLb(raidLbs[key] || {}, data.uuid);
  }
  const memInfo = extractMembers(data.members);
  return {
    snapshot: {
      name: data.name ?? name,
      prefix: data.prefix ?? "",
      uuid: data.uuid,
      level: data.level ?? null,
      xpPercent: data.xpPercent ?? null,
      territories: data.territories ?? 0,
      wars: data.wars ?? 0,
      raids: data.raids ?? 0,
      seasonNumber: season,
      seasonSr: Number(sr?.rating ?? 0),
      online: memInfo.online,
      memberCount: memInfo.total,
      perRaid,
    },
    members: {
      name: data.name ?? name,
      prefix: data.prefix ?? "",
      online: memInfo.online,
      total: memInfo.total,
      members: memInfo.members,
    },
  };
}

// ──────────────────────────────────────────────────────────────
// Event detection
// ──────────────────────────────────────────────────────────────
function rankIdx(r) { return RANK_ORDER.indexOf(r); }

function detectEvents(prevGuild, newGuild, guildName, ts) {
  const events = [];
  const prevMap = new Map((prevGuild?.members || []).map(m => [m.uuid, m]));
  const newMap  = new Map(newGuild.members.map(m => [m.uuid, m]));

  for (const [uuid, m] of newMap) {
    const prev = prevMap.get(uuid);
    if (!prev) {
      events.push({
        ts, guild: guildName, uuid, username: m.username,
        type: "joined", rank: m.rank, joinedAt: m.joined,
        raidsTotal: m.guildRaidsTotal,
      });
    } else if (prev.rank !== m.rank) {
      const up = rankIdx(m.rank) < rankIdx(prev.rank);
      events.push({
        ts, guild: guildName, uuid, username: m.username,
        type: up ? "promoted" : "demoted",
        from: prev.rank, to: m.rank,
      });
    }
  }
  for (const [uuid, m] of prevMap) {
    if (!newMap.has(uuid)) {
      events.push({
        ts, guild: guildName, uuid, username: m.username,
        type: "left", from: m.rank,
      });
    }
  }
  return events;
}

// ──────────────────────────────────────────────────────────────
// File IO
// ──────────────────────────────────────────────────────────────
async function loadJson(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch { return fallback; }
}

// ──────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────
async function main() {
  const guildsCfg = JSON.parse(await readFile(GUILDS_FILE, "utf8"));
  const sides = ["left", "right"];

  const raidLbs = await fetchRaidLeaderboards();
  const summaries = {};
  for (const side of sides) {
    const name = guildsCfg[side].name;
    const data = await fetchGuild(name);
    summaries[side] = summarize(name, data, raidLbs);
  }

  const ts = new Date().toISOString();

  // 1) snapshot history
  const snapshot = {
    ts,
    season: summaries.left.snapshot.seasonNumber ?? summaries.right.snapshot.seasonNumber,
    left: summaries.left.snapshot,
    right: summaries.right.snapshot,
  };
  const history = await loadJson(HISTORY_FILE, { snapshots: [] });
  if (!Array.isArray(history.snapshots)) history.snapshots = [];
  history.snapshots.push(snapshot);
  const cutoff = Date.now() - RETAIN_DAYS * 86400_000;
  history.snapshots = history.snapshots.filter(s => new Date(s.ts).getTime() >= cutoff);
  history.updated = ts;
  history.config = { left: guildsCfg.left, right: guildsCfg.right };
  await writeFile(HISTORY_FILE, JSON.stringify(history, null, 2) + "\n");

  // 2) members state + 3) events
  const prevState = await loadJson(MEMBERS_STATE_FILE, null);
  const newState = {
    updated: ts,
    left: summaries.left.members,
    right: summaries.right.members,
  };
  const eventLog = await loadJson(EVENTS_FILE, { events: [] });
  if (!Array.isArray(eventLog.events)) eventLog.events = [];

  if (prevState?.left && prevState?.right) {
    eventLog.events.push(...detectEvents(prevState.left, newState.left, guildsCfg.left.name, ts));
    eventLog.events.push(...detectEvents(prevState.right, newState.right, guildsCfg.right.name, ts));
  }
  const eventsCutoff = Date.now() - EVENTS_RETAIN_DAYS * 86400_000;
  eventLog.events = eventLog.events.filter(e => new Date(e.ts).getTime() >= eventsCutoff);
  eventLog.updated = ts;

  await writeFile(MEMBERS_STATE_FILE, JSON.stringify(newState, null, 2) + "\n");
  await writeFile(EVENTS_FILE, JSON.stringify(eventLog, null, 2) + "\n");

  const gap = snapshot.left.seasonSr - snapshot.right.seasonSr;
  console.log(`OK season=${snapshot.season} L=${snapshot.left.seasonSr} R=${snapshot.right.seasonSr} gap=${gap} | online L=${snapshot.left.online}/${snapshot.left.memberCount} R=${snapshot.right.online}/${snapshot.right.memberCount} | snaps=${history.snapshots.length} events=${eventLog.events.length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
