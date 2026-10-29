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

/* ---------- Liga Wojen Klanów (CWL) ---------- */
let cwl = old?.cwl ?? null;
const group = await safe("Grupa CWL", () => api(`/clans/${enc(TAG)}/currentwar/leaguegroup`));
if (group && group.state && group.state !== "notInWar" && Array.isArray(group.rounds)) {
  const S = {};   // tabela grupy
  for (const c of group.clans || []) S[c.tag] = { tag: c.tag, name: c.name, level: c.clanLevel, stars: 0, pct: 0, wins: 0, played: 0 };
  const ours = [];
  for (let i = 0; i < group.rounds.length; i++) {
    for (const wt of group.rounds[i].warTags || []) {
      if (!wt || wt === "#0") continue;
      const war = await safe(`Wojna CWL ${wt}`, () => api(`/clanwarleagues/wars/${enc(wt)}`));
      if (!war || war.state === "notInWar") continue;
      const live = war.state === "inWar" || war.state === "warEnded";
      for (const [a, b] of [[war.clan, war.opponent], [war.opponent, war.clan]]) {
        const row = S[a.tag]; if (!row || !live) continue;
        row.stars += a.stars ?? 0;
        row.pct += (a.destructionPercentage ?? 0) * war.teamSize;
        if (war.state === "warEnded") {
          row.played++;
          const win = (a.stars > b.stars) || (a.stars === b.stars && a.destructionPercentage > b.destructionPercentage);
          if (win) { row.wins++; row.stars += 10; }   // +10 gwiazdek za wygraną wojnę ligową
        }
      }
      // Nasza wojna w tej rundzie
      const us = war.clan.tag === TAG ? war.clan : war.opponent.tag === TAG ? war.opponent : null;
      if (us) {
        const them = us === war.clan ? war.opponent : war.clan;
        const oppByTag = Object.fromEntries((them.members || []).map(m => [m.tag, m]));
        ours.push({
          round: i + 1, state: war.state, size: war.teamSize, perMember: 1,
          start: war.startTime, end: war.endTime,
          us:   { name: us.name,   stars: us.stars ?? 0,   pct: round2(us.destructionPercentage),   attacks: us.attacks ?? 0 },
          them: { name: them.name, stars: them.stars ?? 0, pct: round2(them.destructionPercentage), attacks: them.attacks ?? 0 },
          members: (us.members || []).sort((a, b) => a.mapPosition - b.mapPosition).map(m => ({
            name: m.name, tag: m.tag, pos: m.mapPosition, th: m.townhallLevel,
            attacks: (m.attacks || []).map(at => {
              const d = oppByTag[at.defenderTag];
              return { stars: at.stars, pct: at.destructionPercentage, target: d ? `${d.mapPosition}. ${d.name}` : "" };
            })
          }))
        });
      }
    }
  }
  // Najwięcej gwiazdek w CWL (nasi gracze)
  const T = {};
  for (const w of ours) if (w.state !== "preparation") for (const m of w.members) {
    const t = T[m.tag] || (T[m.tag] = { name: m.name, stars: 0, attacks: 0, wars: 0 });
    t.wars++; t.attacks += m.attacks.length; for (const at of m.attacks) t.stars += at.stars;
  }
  const standings = Object.values(S).map(r => ({ ...r, pct: Math.round(r.pct) }))
    .sort((a, b) => b.stars - a.stars || b.pct - a.pct);
  cwl = {
    season: group.season, state: group.state,
    rounds: group.rounds.length,
    place: standings.findIndex(r => r.tag === TAG) + 1 || null,
    groupSize: standings.length,
    standings,
    wars: ours,
    top: Object.values(T).sort((a, b) => b.stars - a.stars || a.attacks - b.attacks).slice(0, 10)
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
// Wojny ligowe (CWL) też trafiają do archiwum — 1 atak na gracza
for (const cw of (cwl?.wars || [])) {
  if (cw.state === "preparation") continue;
  const rec = {
    start: cw.start, end: cw.end, enemy: cw.them.name, size: cw.size, perMember: 1, state: cw.state, cwl: true,
    us: cw.us.stars, them: cw.them.stars,
    members: cw.members.map(m => ({ name: m.name, tag: m.tag, attacks: m.attacks.map(a => ({ stars: a.stars, pct: a.pct })) }))
  };
  warArchive = warArchive.filter(x => x.start !== rec.start || x.enemy !== rec.enemy);
  warArchive.push(rec);
}
warArchive.sort((a, b) => (b.start || "").localeCompare(a.start || ""));
// Wojna, która zniknęła z API po zakończeniu, zostaje oznaczona jako zakończona
const nowStamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, ".000Z");
warArchive.forEach(x => { if (x.end && x.end < nowStamp) x.state = "warEnded"; });
warArchive = warArchive.slice(0, 40);

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

/* ---------- Historia klanu (wykresy) ---------- */
const today = new Date().toISOString().slice(0, 10);
let history = Array.isArray(old?.history) ? old.history : [];
const snap = {
  d: today, members: members.length,
  avgTh: Math.round(members.reduce((a, m) => a + m.th, 0) / (members.length || 1) * 10) / 10,
  level: clan.clanLevel, wins: clan.warWins ?? null, points: clan.clanPoints ?? null
};
history = history.filter(h => h.d !== today);
history.push(snap);
history = history.slice(-180);

/* ---------- Bazowy stan tygodnia (wyzwanie tygodnia) ---------- */
function weekKey(dt) {
  const d = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()));
  const day = (d.getUTCDay() + 6) % 7;            // poniedziałek = 0
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);            // data poniedziałku
}
const wk = weekKey(new Date());
let weekBase = old?.weekBase;
if (!weekBase || weekBase.week !== wk) {
  weekBase = { week: wk, players: {} };
  for (const m of (old?.members || members)) {
    weekBase.players[m.tag] = { given: m.given ?? 0, warStars: m.profile?.warStars ?? null, capital: m.profile?.capital ?? null };
  }
}
for (const m of members) {   // gracze, którzy dołączyli w trakcie tygodnia
  if (!weekBase.players[m.tag]) weekBase.players[m.tag] = { given: m.given ?? 0, warStars: m.profile?.warStars ?? null, capital: m.profile?.capital ?? null };
}

/* ---------- Powiadomienia na Discordzie (webhook) ---------- */
const WEBHOOK = process.env.DISCORD_WEBHOOK;
let notified = old?.notified && typeof old.notified === "object" ? old.notified : {};
const SITE = "https://kubooorek.github.io/armia-maurycego/";
async function post(content) {
  if (!WEBHOOK) return;
  try {
    const r = await fetch(WEBHOOK, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "Armia Maurycego", content, allowed_mentions: { parse: [] } }) });
    if (!r.ok) console.warn("Webhook:", r.status, await r.text());
    await new Promise(res => setTimeout(res, 1200));
  } catch (e) { console.warn("Webhook niedostępny:", e.message); }
}
const parseT = t => t ? new Date(`${t.slice(0,4)}-${t.slice(4,6)}-${t.slice(6,8)}T${t.slice(9,11)}:${t.slice(11,13)}:${t.slice(13,15)}Z`) : null;
const firstRun = !old;   // przy pierwszym uruchomieniu nic nie wysyłamy (brak historii)

if (WEBHOOK && !firstRun) {
  // 1) Ruchy w klanie z tego uruchomienia
  const RN = { leader: "Wodza", coLeader: "Współlidera", admin: "Starszego", member: "Członka" };
  const freshEvents = events.filter(e => e.t === events[0]?.t && !(old.events || []).some(o => o.t === e.t && o.name === e.name && o.type === e.type));
  for (const e of freshEvents.reverse()) {
    if (e.type === "join") await post(`➕ **${e.name}** dołączył(a) do klanu (TH${e.th}). Witamy w Armii! 🛡️`);
    if (e.type === "th") await post(`🏰 **${e.name}** ulepszył(a) ratusz: TH${e.from} → **TH${e.to}**! Gratulacje! 🎉`);
    if (e.type === "promote") await post(`⬆️ **${e.name}** awansował(a) na ${RN[e.role] || e.role}! 👏`);
  }

  // 2) Wojny: start, przypomnienia, wynik (zwykła wojna lub runda CWL)
  const liveWars = [];
  if (currentWar) liveWars.push({ ...currentWar, key: `w:${currentWar.start}`, label: "Wojna" });
  for (const cw of (cwl?.wars || [])) liveWars.push({ ...cw, key: `c:${cw.start}:${cw.them.name}`, label: `CWL · Runda ${cw.round}` });
  for (const w of liveWars) {
    const sent = notified[w.key] || (notified[w.key] = []);
    const once = async (id, msg) => { if (!sent.includes(id)) { sent.push(id); await post(msg); } };
    const sinceStart = (Date.now() - parseT(w.start)) / 3600e3, sinceEnd = (Date.now() - parseT(w.end)) / 3600e3;
    if (w.state === "preparation") {
      await once("prep", `🛡️ **${w.label}** rozpoczyna się! Przeciwnik: **${w.them.name}** (${w.size} vs ${w.size}). Dzień przygotowań — wyślijcie wojska do zamków obronnych!`);
    }
    if (w.state === "inWar") {
      const left = (parseT(w.end) - Date.now()) / 3600e3;
      const missing = w.members.filter(m => m.attacks.length < w.perMember).map(m => `${m.name}${w.perMember - m.attacks.length > 1 ? ` ×${w.perMember - m.attacks.length}` : ""}`);
      if (sinceStart < 6) await once("start", `⚔️ **${w.label}** — dzień bitwy ruszył! Przeciwnik: **${w.them.name}**. Pierwszy atak na swój numer! ${SITE}`);
      // jedno przypomnienie na próg (12h, 4h, 1h) — wysyłamy tylko najmniejszy osiągnięty
      const hit = [1, 4, 12].find(h => left <= h && left > 0);
      if (hit && missing.length && !sent.includes(`r${hit}`)) {
        for (const h of [12, 4, 1]) if (h >= hit && !sent.includes(`r${h}`)) sent.push(`r${h}`);
        await post(`⏰ **${w.label}** — zostało ok. **${Math.max(1, Math.round(left))}h** do końca! Wynik: ${w.us.stars} ★ ${w.them.stars}.\nBrakujące ataki: ${missing.join(", ")}`);
      }
    }
    if (w.state === "warEnded" && sinceEnd < 6) {
      const res = w.us.stars > w.them.stars || (w.us.stars === w.them.stars && w.us.pct > w.them.pct) ? "🏆 **Wygrana!**"
        : (w.us.stars === w.them.stars && w.us.pct === w.them.pct) ? "🤝 **Remis**" : "❌ **Przegrana**";
      const missing = w.members.filter(m => m.attacks.length < w.perMember).map(m => m.name);
      await once("end", `${res} ${w.label} vs **${w.them.name}** — ${w.us.stars} ★ ${w.them.stars} (${w.us.pct}% : ${w.them.pct}%).${missing.length ? `\nOpuszczone ataki: ${missing.join(", ")}` : "\nWszyscy zaatakowali — brawo! 💪"}`);
    }
  }
}
// sprzątanie starych kluczy powiadomień
notified = Object.fromEntries(Object.entries(notified).slice(-40));

/* ---------- Zapis ---------- */
const data = {
  updated: new Date().toISOString(),
  clanLevel: clan.clanLevel,
  memberCount: clan.members,
  cwlLeague: clan.warLeague?.name ?? null,
  warWinStreak: clan.warWinStreak,
  warWins: clan.warWins ?? null,
  currentWar,
  cwl,
  visits,
  discord,
  raids,
  events,
  warArchive,
  history,
  weekBase,
  notified,
  members,
  wars
};

// Zapisz tylko, gdy coś się zmieniło (pomijając datę aktualizacji)
const strip = d => JSON.stringify({ ...d, updated: null });
if (old && strip(old) === strip(data)) { console.log("Bez zmian."); process.exit(0); }

await writeFile("data.json", JSON.stringify(data, null, 2) + "\n");
console.log(`Zapisano: ${members.length} członków, ${wars.length} wojen, ${warArchive.length} w archiwum, ${events.length} zdarzeń.`);
