import { readFile, writeFile } from "node:fs/promises";

const GUILDS_FILE   = "guilds.json";
const HISTORY_FILE  = "snapshots.json";
const RETAIN_DAYS   = 14;
const RAID_LBS = {
  grootslang: "grootslangSrGuilds",
  nameless:   "namelessSrGuilds",
  colossus:   "colossusSrGuilds",
  orphion:    "orphionSrGuilds",
  fruma:      "frumaSrGuilds",
};
const TIMEOUT_MS = 20_000;
const UA = "race-tracker/1.0";

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

function latestSeason(seasonRanks) {
  if (!seasonRanks) return null;
  let max = null;
  for (const k of Object.keys(seasonRanks)) {
    const n = Number(k);
    if (Number.isFinite(n) && (max === null || n > max)) max = n;
  }
  return max;
}

async function fetchGuild(name) {
  const q = encodeURIComponent(name);
  return await fetchJson(`https://api.wynncraft.com/v3/guild/${q}`);
}

async function fetchRaidLeaderboards() {
  const out = {};
  await Promise.all(Object.entries(RAID_LBS).map(async ([raid, lb]) => {
    out[raid] = await fetchJson(`https://api.wynncraft.com/v3/leaderboards/${lb}?resultLimit=100`);
  }));
  return out;
}

function findGuildInLb(lbEntries, uuid) {
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

function summarize(name, data, raidLbs) {
  const season = latestSeason(data.seasonRanks);
  const sr = season != null ? data.seasonRanks[String(season)] : null;
  const perRaid = {};
  for (const key of Object.keys(RAID_LBS)) {
    perRaid[key] = findGuildInLb(raidLbs[key] || {}, data.uuid);
  }
  return {
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
    perRaid,
  };
}

async function loadHistory() {
  try {
    const raw = await readFile(HISTORY_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.snapshots)) return parsed;
    return { snapshots: [] };
  } catch {
    return { snapshots: [] };
  }
}

async function main() {
  const guildsCfg = JSON.parse(await readFile(GUILDS_FILE, "utf8"));
  const slots = ["left", "right"];

  const raidLbs = await fetchRaidLeaderboards();
  const guildData = {};
  for (const slot of slots) {
    const name = guildsCfg[slot].name;
    const data = await fetchGuild(name);
    guildData[slot] = summarize(name, data, raidLbs);
  }

  const snapshot = {
    ts: new Date().toISOString(),
    season: guildData.left.seasonNumber ?? guildData.right.seasonNumber,
    left: guildData.left,
    right: guildData.right,
  };

  const history = await loadHistory();
  history.snapshots.push(snapshot);

  const cutoff = Date.now() - RETAIN_DAYS * 86400_000;
  history.snapshots = history.snapshots.filter(s => new Date(s.ts).getTime() >= cutoff);

  history.updated = snapshot.ts;
  history.config = {
    left: guildsCfg.left,
    right: guildsCfg.right,
  };

  await writeFile(HISTORY_FILE, JSON.stringify(history, null, 2) + "\n");
  const gap = snapshot.left.seasonSr - snapshot.right.seasonSr;
  console.log(`OK season=${snapshot.season} L=${snapshot.left.seasonSr} R=${snapshot.right.seasonSr} gap=${gap} (n=${history.snapshots.length})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
