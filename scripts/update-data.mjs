// Pobiera dane klanu z API Clash of Clans i zapisuje je do data.json.
// Uruchamiane automatycznie przez GitHub Actions (.github/workflows/update-data.yml).
// Wymaga sekretu COC_TOKEN — klucza API z developer.clashofclans.com
// utworzonego dla adresu IP 45.79.218.79 (serwer pośredniczący RoyaleAPI).

import { writeFile, readFile } from "node:fs/promises";

const TAG = "#2GQQ8RGRL";
const DISCORD_INVITE = "7SquD7SF3";
const COUNTER = "https://api.counterapi.dev/v2/armia-maurycego/odwiedziny";
const BASE = "https://cocproxy.royaleapi.dev/v1";
const TOKEN = process.env.COC_TOKEN;
if (!TOKEN) { console.error("Brak sekretu COC_TOKEN"); process.exit(1); }

async function api(path) {
  const res = await fetch(BASE + path, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}
async function safe(label, fn, fallback = null) {
  try { return await fn(); } catch (e) { console.warn(`${label} niedostępne:`, e.message); return fallback; }
}

// "20261028T081500.000Z" → "2026-10-28"
const day = t => t ? `${t.slice(0,4)}-${t.slice(4,6)}-${t.slice(6,8)}` : null;
const enc = t => encodeURIComponent(t);
const round2 = v => Math.round((v ?? 0) * 100) / 100;

// Poprzedni stan — potrzebny do historii (ranking wojowników, ruchy w klanie)
let old = null;
try { old = JSON.parse(await readFile("data.json", "utf8")); } catch {}

/* ---------- Klan i członkowie ---------- */
const clan = await api(`/clans/${enc(TAG)}`);
const members = (clan.memberList || []).map(m => ({
  name: m.name, tag: m.tag,
  role: m.role,               // leader | coLeader | admin | member
  th: m.townHallLevel,
  given: m.donations, received: m.donationsReceived,
  trophies: m.trophies
}));

/* ---------- Profile graczy ---------- */
for (const m of members) {
  const p = await safe(`Profil ${m.name}`, () => api(`/players/${enc(m.tag)}`));
  if (!p) continue;
  m.profile = {
    level: p.expLevel,
    trophies: p.trophies, best: p.bestTrophies,
    league: p.leagueTier?.name ?? p.league?.name ?? null,
    warStars: p.warStars,
    attackWins: p.attackWins, defenseWins: p.defenseWins,
    capital: p.clanCapitalContributions ?? 0,
    warPref: p.warPreference ?? null,
    heroes: (p.heroes || []).filter(h => h.village === "home")
      .map(h => ({ name: h.name, level: h.level, max: h.maxLevel }))
  };
}

/* ---------- Dziennik wojen ---------- */
const warlog = await safe("Dziennik wojen", () => api(`/clans/${enc(TAG)}/warlog?limit=50`), { items: [] });
const wars = (warlog.items || [])
  .filter(w => w.opponent?.name)          // pomijamy wpisy CWL bez przeciwnika
  .map(w => ({
    date: day(w.endTime), enemy: w.opponent.name, size: w.teamSize,
    xp: w.clan.expEarned ?? 0, result: w.result,
    us:   { stars: w.clan.stars,     pct: round2(w.clan.destructionPercentage) },
    them: { stars: w.opponent.stars, pct: round2(w.opponent.destructionPercentage) }
  }));

/* ---------- Bieżąca wojna ---------- */
let currentWar = null;
const w = await safe("Bieżąca wojna", () => api(`/clans/${enc(TAG)}/currentwar`));
if (w && w.state && w.state !== "notInWar") {
  const side = c => ({ name: c.name, stars: c.stars ?? 0, pct: round2(c.destructionPercentage), attacks: c.attacks ?? 0 });
  const oppByTag = Object.fromEntries((w.opponent.members || []).map(m => [m.tag, m]));
  currentWar = {
    state: w.state,                       // preparation | inWar | warEnded
    size: w.teamSize, perMember: w.attacksPerMember ?? 2,
    start: w.startTime, end: w.endTime,
    us: side(w.clan), them: side(w.opponent),
    members: (w.clan.members || []).sort((a, b) => a.mapPosition - b.mapPosition).map(m => ({
      name: m.name, tag: m.tag, pos: m.mapPosition, th: m.townhallLevel,
      attacks: (m.attacks || []).map(a => {
        const d = oppByTag[a.defenderTag];
        return { stars: a.stars, pct: a.destructionPercentage, target: d ? `${d.mapPosition}. ${d.name}` : "" };
      })
    }))
  };
}

/* ---------- Archiwum wojen (do rankingu wojowników) ---------- */
let warArchive = Array.isArray(old?.warArchive) ? old.warArchive : [];
if (currentWar && currentWar.state !== "preparation") {
  const rec = {
    start: currentWar.start, end: currentWar.end, enemy: currentWar.them.name,
    size: currentWar.size, perMember: currentWar.perMember, state: currentWar.state,
    us: currentWar.us.stars, them: currentWar.them.stars,
    members: currentWar.members.map(m => ({
      name: m.name, tag: m.tag,
      attacks: m.attacks.map(a => ({ stars: a.stars, pct: a.pct }))
    }))
  };
  warArchive = warArchive.filter(x => x.start !== rec.start);
  warArchive.unshift(rec);
}
// Wojna, która zniknęła z API po zakończeniu, zostaje oznaczona jako zakończona
const nowStamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, ".000Z");
warArchive.forEach(x => { if (x.end && x.end < nowStamp) x.state = "warEnded"; });
warArchive = warArchive.slice(0, 30);

/* ---------- Rajdy Stolicy ---------- */
const raidsRaw = await safe("Rajdy Stolicy", () => api(`/clans/${enc(TAG)}/capitalraidseasons?limit=2`), { items: [] });
const raids = (raidsRaw.items || []).map(r => ({
  state: r.state,                         // ongoing | ended
  start: r.startTime, end: r.endTime,
  loot: r.capitalTotalLoot ?? 0,
  raids: r.raidsCompleted ?? 0,
  attacks: r.totalAttacks ?? 0,
  districts: r.enemyDistrictsDestroyed ?? 0,
  medals: r.offensiveReward ?? null,
  members: (r.members || []).map(m => ({
    name: m.name, tag: m.tag, attacks: m.attacks,
    limit: (m.attackLimit ?? 5) + (m.bonusAttackLimit ?? 0),
    loot: m.capitalResourcesLooted ?? 0
  })).sort((a, b) => b.loot - a.loot)
}));

/* ---------- Ruchy w klanie ---------- */
let events = Array.isArray(old?.events) ? old.events : [];
if (Array.isArray(old?.members) && old.members.length) {
  const RANK = { member: 0, admin: 1, coLeader: 2, leader: 3 };
  const ts = new Date().toISOString();
  const before = Object.fromEntries(old.members.map(m => [m.tag || m.name, m]));
  const after = Object.fromEntries(members.map(m => [m.tag, m]));
  const fresh = [];
  for (const m of members) {
    const o = before[m.tag];
    if (!o) { fresh.push({ t: ts, type: "join", name: m.name, th: m.th }); continue; }
    if (m.th > o.th) fresh.push({ t: ts, type: "th", name: m.name, from: o.th, to: m.th });
    if (o.role !== m.role) fresh.push({ t: ts, type: RANK[m.role] > RANK[o.role] ? "promote" : "demote", name: m.name, role: m.role });
  }
  for (const o of old.members) if (o.tag && !after[o.tag]) fresh.push({ t: ts, type: "leave", name: o.name });
  events = [...fresh, ...events].slice(0, 60);
}

/* ---------- Discord ---------- */
const discord = await safe("Discord", async () => {
  const r = await fetch(`https://discord.com/api/v10/invites/${DISCORD_INVITE}?with_counts=true`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const d = await r.json();
  return {
    name: d.guild?.name ?? null,
    icon: d.guild?.icon ? `https://cdn.discordapp.com/icons/${d.guild.id}/${d.guild.icon}.png?size=128` : null,
    online: d.approximate_presence_count ?? null,
    members: d.approximate_member_count ?? null
  };
});

/* ---------- Licznik odwiedzin ---------- */
const visits = await safe("Licznik odwiedzin", async () => {
  const r = await fetch(COUNTER);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const d = (await r.json()).data || {};
  return (d.up_count ?? 0) - (d.down_count ?? 0);
});

/* ---------- Zapis ---------- */
const data = {
  updated: new Date().toISOString(),
  clanLevel: clan.clanLevel,
  memberCount: clan.members,
  cwlLeague: clan.warLeague?.name ?? null,
  warWinStreak: clan.warWinStreak,
  currentWar,
  visits,
  discord,
  raids,
  events,
  warArchive,
  members,
  wars
};

// Zapisz tylko, gdy coś się zmieniło (pomijając datę aktualizacji)
const strip = d => JSON.stringify({ ...d, updated: null });
if (old && strip(old) === strip(data)) { console.log("Bez zmian."); process.exit(0); }

await writeFile("data.json", JSON.stringify(data, null, 2) + "\n");
console.log(`Zapisano: ${members.length} członków, ${wars.length} wojen, ${warArchive.length} w archiwum, ${events.length} zdarzeń.`);
