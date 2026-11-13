// Pobiera dane klanu z API Clash of Clans i zapisuje je do data.json.
// Uruchamiane automatycznie przez GitHub Actions (.github/workflows/update-data.yml).
// Wymaga sekretu COC_TOKEN — klucza API z developer.clashofclans.com
// utworzonego dla adresu IP 45.79.218.79 (serwer pośredniczący RoyaleAPI).

import { writeFile, readFile, mkdir, unlink, readdir } from "node:fs/promises";

// Siatka bezpieczeństwa: nieoczekiwany błąd nie kończy się czerwonym statusem, tylko wpisem w logu
process.on("unhandledRejection", e => { console.error("Nieoczekiwany błąd:", e); process.exit(0); });
process.on("uncaughtException", e => { console.error("Nieoczekiwany błąd:", e); process.exit(0); });

const TAG = "#2GQQ8RGRL";
const DISCORD_INVITE = "7SquD7SF3";
const COUNTER = "https://api.counterapi.dev/v2/armia-maurycego/odwiedziny";
const BASE = "https://cocproxy.royaleapi.dev/v1";
const TOKEN = process.env.COC_TOKEN;
if (!TOKEN) { console.error("Brak sekretu COC_TOKEN"); process.exit(1); }

// Zapytanie do API z ponawianiem (3 próby) i limitem czasu — chwilowe błędy serwera nie psują aktualizacji
async function api(path) {
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(BASE + path, { headers: { Authorization: `Bearer ${TOKEN}` }, signal: AbortSignal.timeout(20000) });
      if (res.ok) return res.json();
      const txt = await res.text();
      last = new Error(`${path} → HTTP ${res.status}: ${txt.slice(0, 300)}`);
      if (res.status === 404 || res.status === 403) throw last;   // tych błędów nie ponawiamy
    } catch (e) {
      last = e;
      if (/HTTP 40[34]/.test(e.message)) throw e;
    }
    await new Promise(r => setTimeout(r, 2000 * (i + 1)));
  }
  throw last;
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
let clan;
try { clan = await api(`/clans/${enc(TAG)}`); }
catch (e) {
  // API gry chwilowo niedostępne — kończymy spokojnie, dane zaktualizują się przy następnym uruchomieniu
  console.warn("API Clash of Clans nie odpowiada, pomijam tę aktualizację:", e.message);
  process.exit(0);
}
const members = (clan.memberList || []).map(m => ({
  name: m.name, tag: m.tag,
  role: m.role,               // leader | coLeader | admin | member
  th: m.townHallLevel,
  given: m.donations, received: m.donationsReceived,
  trophies: m.trophies
}));

/* ---------- % rusha (wojska, zaklęcia, herosi, zwierzęta vs maksimum poprzedniego TH) ---------- */
let CAPS = null;
try { CAPS = JSON.parse(await readFile(new URL("./th-caps.json", import.meta.url), "utf8")); } catch (e) { console.error("Brak th-caps.json — pomijam % rusha"); }
function rushOf(p, th) {
  if (!CAPS || !th || th < 2) return null;
  const units = [...(p.troops || []), ...(p.spells || []), ...(p.heroes || [])].filter(u => u.village === "home" && CAPS.caps[u.name]);
  const sum = { troops: [0, 0], spells: [0, 0], heroes: [0, 0], pets: [0, 0] }, behind = [];
  for (const u of units) {
    const need = CAPS.caps[u.name][th - 2] || 0;      // maksimum dla poprzedniego ratusza
    if (!need) continue;
    const c = CAPS.cat[u.name], have = Math.min(u.level, need);
    sum[c][0] += need; sum[c][1] += have;
    if (u.level < need) behind.push({ n: CAPS.pl[u.name] || u.name, lvl: u.level, need });
  }
  const pct = ([n, h]) => n ? Math.round((n - h) / n * 1000) / 10 : 0;
  const all = Object.values(sum).reduce((a, [n, h]) => [a[0] + n, a[1] + h], [0, 0]);
  return { pct: pct(all), troops: pct(sum.troops), spells: pct(sum.spells), heroes: pct([sum.heroes[0] + sum.pets[0], sum.heroes[1] + sum.pets[1]]),
           top: behind.sort((a, b) => (b.need - b.lvl) / b.need - (a.need - a.lvl) / a.need).slice(0, 6) };
}

/* ---------- Profile graczy ---------- */
for (const m of members) {
  const p = await safe(`Profil ${m.name}`, () => api(`/players/${enc(m.tag)}`));
  if (!p) continue;
  m.profile = {
    level: p.expLevel,
    trophies: p.trophies, best: p.bestTrophies,
    league: p.leagueTier?.name ?? p.league?.name ?? null,
    leagueId: p.leagueTier?.id ?? p.league?.id ?? null,
    warStars: p.warStars,
    attackWins: p.attackWins, defenseWins: p.defenseWins,
    capital: p.clanCapitalContributions ?? 0,
    warPref: p.warPreference ?? null,
    bh: p.builderHallLevel ?? null, bTrophies: p.builderBaseTrophies ?? null, bLeague: p.builderBaseLeague?.name ?? null,
    heroes: (p.heroes || []).filter(h => h.village === "home")
      .map(h => ({ name: h.name, level: h.level, max: h.maxLevel }))
  };
  m.rush = rushOf(p, m.th);
  const A = Object.fromEntries((p.achievements || []).map(a => [a.name, a.value]));
  m.ach = {
    cg: A["Games Champion"] ?? null,        // suma punktów z Gier Klanowych
    don: A["Friend in Need"] ?? null,       // suma przekazanych oddziałów (całe konto)
    capLoot: A["Aggressive Capitalism"] ?? null, // złoto stolicy zdobyte w rajdach
    gold: A["Gold Grab"] ?? null,           // złoto zrabowane w atakach
    elixir: A["Elixir Escapade"] ?? null,
    capContrib: A["Most Valuable Clanmate"] ?? null,
    wins: p.attackWins ?? null
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
// Bazy jednej strony: pozycja na mapie, TH i ile gwiazdek już z niej zdjęto (do prognozy wojny)
const basesOf = side => (side?.members || []).slice().sort((a, b) => a.mapPosition - b.mapPosition)
  .map(m => ({ pos: m.mapPosition, th: m.townhallLevel, best: m.bestOpponentAttack?.stars ?? 0 }));
// ataki przeciwnika na nasze bazy (do relacji na żywo na Discordzie)
function defsOf(enemy, ourByTag) {
  return (enemy.members || []).flatMap(om => (om.attacks || []).map(a => {
    const d = ourByTag[a.defenderTag];
    return { by: om.name, bpos: om.mapPosition, th: om.townhallLevel, tpos: d?.mapPosition ?? null, tname: d?.name ?? "", stars: a.stars, pct: a.destructionPercentage, order: a.order };
  })).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}
let currentWar = null;
const w = await safe("Bieżąca wojna", () => api(`/clans/${enc(TAG)}/currentwar`));
if (w && w.state && w.state !== "notInWar") {
  const side = c => ({ name: c.name, level: c.clanLevel ?? null, stars: c.stars ?? 0, pct: round2(c.destructionPercentage), attacks: c.attacks ?? 0 });
  const oppByTag = Object.fromEntries((w.opponent.members || []).map(m => [m.tag, m]));
  const ourByTag = Object.fromEntries((w.clan.members || []).map(m => [m.tag, m]));
  currentWar = {
    state: w.state,                       // preparation | inWar | warEnded
    size: w.teamSize, perMember: w.attacksPerMember ?? 2,
    start: w.startTime, end: w.endTime,
    us: { ...side(w.clan), bases: basesOf(w.clan) }, them: { ...side(w.opponent), bases: basesOf(w.opponent) },
    members: (w.clan.members || []).sort((a, b) => a.mapPosition - b.mapPosition).map(m => ({
      name: m.name, tag: m.tag, pos: m.mapPosition, th: m.townhallLevel,
      attacks: (m.attacks || []).map(a => {
        const d = oppByTag[a.defenderTag];
        return { stars: a.stars, pct: a.destructionPercentage, order: a.order, target: d ? `${d.mapPosition}. ${d.name}` : "", tpos: d?.mapPosition ?? null, tname: d?.name ?? "" };
      })
    })),
    defs: defsOf(w.opponent, ourByTag)
  };
}

// Kiedy robot pierwszy raz zobaczył każdy atak (API nie podaje godziny ataku) — potrzebne do zasady 12 h
if (currentWar && currentWar.state !== "preparation") {
  const oldW = old?.currentWar && old.currentWar.start === currentWar.start ? old.currentWar : null;
  const seenNow = new Date().toISOString();
  for (const m of currentWar.members) {
    const om = oldW?.members?.find(x => x.tag === m.tag);
    for (const a of m.attacks) {
      const oa = om?.attacks?.find(x => x.order != null && x.order === a.order);
      a.seen = oa ? (oa.seen ?? null) : seenNow;   // null = nie wiadomo (atak sprzed wprowadzenia śledzenia)
    }
  }
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
          us:   { name: us.name, level: us.clanLevel ?? null,   stars: us.stars ?? 0,   pct: round2(us.destructionPercentage),   attacks: us.attacks ?? 0, bases: basesOf(us) },
          them: { name: them.name, level: them.clanLevel ?? null, stars: them.stars ?? 0, pct: round2(them.destructionPercentage), attacks: them.attacks ?? 0, bases: basesOf(them) },
          members: (us.members || []).sort((a, b) => a.mapPosition - b.mapPosition).map(m => ({
            name: m.name, tag: m.tag, pos: m.mapPosition, th: m.townhallLevel,
            attacks: (m.attacks || []).map(at => {
              const d = oppByTag[at.defenderTag];
              return { stars: at.stars, pct: at.destructionPercentage, order: at.order, target: d ? `${d.mapPosition}. ${d.name}` : "", tpos: d?.mapPosition ?? null, tname: d?.name ?? "" };
            })
          })),
          defs: defsOf(them, Object.fromEntries((us.members || []).map(m => [m.tag, m])))
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
    final: currentWar.state === "warEnded",   // robot widział koniec wojny = komplet ataków
    pct: currentWar.us.pct, themPct: currentWar.them.pct, themBases: currentWar.them.bases,
    members: currentWar.members.map(m => ({
      name: m.name, tag: m.tag, pos: m.pos, th: m.th,
      attacks: m.attacks.map(a => ({ stars: a.stars, pct: a.pct, target: a.target, order: a.order }))
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
    us: cw.us.stars, them: cw.them.stars, pct: cw.us.pct, themPct: cw.them.pct, themBases: cw.them.bases, round: cw.round,
    members: cw.members.map(m => ({ name: m.name, tag: m.tag, pos: m.pos, th: m.th, attacks: m.attacks.map(a => ({ stars: a.stars, pct: a.pct, target: a.target })) }))
  };
  warArchive = warArchive.filter(x => x.start !== rec.start || x.enemy !== rec.enemy);
  warArchive.push(rec);
}
warArchive.sort((a, b) => (b.start || "").localeCompare(a.start || ""));
// Wojna, która zniknęła z API po zakończeniu, zostaje oznaczona jako zakończona
const nowStamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, ".000Z");
warArchive.forEach(x => { if (x.end && x.end < nowStamp) x.state = "warEnded"; });
warArchive = warArchive.slice(0, 40);

/* ---------- Podsumowanie sezonu CWL (gdy wszystkie rundy się skończą) ---------- */
let cwlSummary = old?.cwlSummary ?? null;
if (cwl && Array.isArray(cwl.wars) && cwl.wars.length >= (cwl.rounds || 7) && cwl.wars.every(w => w.state === "warEnded")) {
  const isWin = w => w.us.stars > w.them.stars || (w.us.stars === w.them.stars && w.us.pct > w.them.pct);
  const isDraw = w => w.us.stars === w.them.stars && w.us.pct === w.them.pct;
  const row = (cwl.standings || []).find(r => r.tag === TAG) || {};
  const miss = {}, three = {};
  for (const w of cwl.wars) for (const m of w.members) {
    if (!m.attacks.length) miss[m.name] = (miss[m.name] || 0) + 1;
    three[m.name] = (three[m.name] || 0) + m.attacks.filter(a => a.stars === 3).length;
  }
  const same = cwlSummary && cwlSummary.season === cwl.season;
  cwlSummary = {
    season: cwl.season, place: cwl.place, groupSize: cwl.groupSize,
    wins: cwl.wars.filter(isWin).length, draws: cwl.wars.filter(isDraw).length,
    losses: cwl.wars.filter(w => !isWin(w) && !isDraw(w)).length,
    stars: row.stars ?? null, pct: row.pct ?? null,
    rounds: cwl.wars.map(w => ({ round: w.round, enemy: w.them.name, us: w.us.stars, them: w.them.stars, win: isWin(w), draw: isDraw(w) })),
    top: (cwl.top || []).slice(0, 5).map(x => ({ ...x, three: three[x.name] || 0 })),
    missed: Object.entries(miss).map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n),
    posted: same ? !!cwlSummary.posted : false
  };
}

/* ---------- Galeria sezonów CWL (każdy zakończony sezon zostaje na zawsze) ---------- */
const cwlHistory = Array.isArray(old?.cwlHistory) ? old.cwlHistory.slice() : [];
if (cwlSummary && cwlSummary.season) {
  const best = (cwlSummary.top || [])[0] || null;
  const prev = cwlHistory.find(x => x.season === cwlSummary.season);
  const entry = {
    season: cwlSummary.season,
    league: prev?.league || data_cwlLeagueAtSeason(),
    place: cwlSummary.place, groupSize: cwlSummary.groupSize,
    wins: cwlSummary.wins, draws: cwlSummary.draws, losses: cwlSummary.losses,
    stars: cwlSummary.stars, pct: cwlSummary.pct,
    best: best ? { name: best.name, stars: best.stars, three: best.three } : null
  };
  if (prev) Object.assign(prev, entry); else cwlHistory.push(entry);
  cwlHistory.sort((a, b) => b.season.localeCompare(a.season));
}
function data_cwlLeagueAtSeason() { return clan?.warLeague?.name || old?.cwlLeague || null; }

/* ---------- Kary za łamanie zasad wojennych (tylko zwykłe wojny, 2 ataki) ---------- */
// konta zwolnione z kar (lista KARY_ZWOLNIENI w index.html)
let karyZw = [];
try { const h = await readFile(new URL("../index.html", import.meta.url), "utf8"); const m = h.match(/const KARY_ZWOLNIENI\s*=\s*\[([\s\S]*?)\n\];/);
  if (m) karyZw = [...m[1].matchAll(/"(#[0-9A-Z]+)"/g)].map(x => x[1]); } catch (e) { console.warn("index.html (zwolnieni z kar) niedostępny:", e.message); }
// zamiany numerów zgłoszone przez graczy w „Moim panelu” (serwer logowania) — za nie nie ma kary
const SWAPS_URL = "https://armia-login.fifacz39.workers.dev/swaps";
let swaps = Array.isArray(old?.swaps) ? old.swaps : [];
try { const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 8000);
  const r = await fetch(SWAPS_URL, { signal: ctl.signal }); clearTimeout(tm);
  if (r.ok) { const j = await r.json(); if (Array.isArray(j.swaps)) swaps = j.swaps; } } catch (e) { console.warn("Zamiany numerów niedostępne:", e.message); }
const swapped = (war, tag) => swaps.some(s => s.war === war && s.tag === tag);
// wypisania z wojny (Mój panel) — za opuszczony atak w tym czasie nie ma kary; historia trzymana 30 dni
let optHist = Array.isArray(old?.optHist) ? old.optHist : [];
try { const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 8000);
  const r = await fetch("https://armia-login.fifacz39.workers.dev/optouts", { signal: ctl.signal }); clearTimeout(tm);
  if (r.ok) { const j = await r.json(); for (const o of (j.optouts || [])) { const i = optHist.findIndex(x => x.id === o.id); if (i >= 0) optHist[i] = o; else optHist.push(o); } } } catch (e) { console.warn("Wypisania niedostępne:", e.message); }
optHist = optHist.filter(o => Date.now() - o.until < 30 * 864e5);
const optedOut = (war, end, tag) => { const a = Date.parse(`${war.slice(0,4)}-${war.slice(4,6)}-${war.slice(6,8)}T${war.slice(9,11)}:${war.slice(11,13)}:${war.slice(13,15)}Z`), b = end ? Date.parse(`${end.slice(0,4)}-${end.slice(4,6)}-${end.slice(6,8)}T${end.slice(9,11)}:${end.slice(11,13)}:${end.slice(13,15)}Z`) : a + 2 * 864e5;
  return optHist.some(o => o.tag === tag && o.t < b && o.until > a); };
let penalties = (Array.isArray(old?.penalties) ? old.penalties : []).filter(p => !karyZw.includes(p.tag) && !((p.type === "own" || p.type === "steal") && swapped(p.war, p.tag)) && !(p.type === "missed" && optedOut(p.war, p.end, p.tag)));
const addPen = p => { if (karyZw.includes(p.tag)) return; if (p.type === "missed" && optedOut(p.war, p.end, p.tag)) return; if ((p.type === "own" || p.type === "steal") && swapped(p.war, p.tag)) return; if (!penalties.some(x => x.id === p.id)) penalties.unshift({ ...p, t: new Date().toISOString() }); };
const WOLNE_PO_H = 12;   // po tylu godzinach od startu bitwy można atakować cudze numery bez kary
const stampMs = t => t ? Date.parse(`${t.slice(0,4)}-${t.slice(4,6)}-${t.slice(6,8)}T${t.slice(9,11)}:${t.slice(11,13)}:${t.slice(13,15)}Z`) : 0;
if (currentWar && currentWar.state !== "preparation" && currentWar.perMember === 2) {
  const W = currentWar, byPos = Object.fromEntries(W.members.map(m => [m.pos, m]));
  const tp = a => parseInt(a.target, 10);
  const firstOrder = m => m.attacks.length ? Math.min(...m.attacks.map(a => a.order ?? 999)) : Infinity;
  const base = m => ({ tag: m.tag, name: m.name, war: W.start, end: W.end, enemy: W.them.name });
  // Zasada klanu: po 12 h od startu bitwy wolno bić cudze numery (kto nie zaatakował swojego do 12 h, ten może być bity)
  const free = stampMs(W.start) + WOLNE_PO_H * 36e5;
  const late = a => a && a.seen && Date.parse(a.seen) >= free;
  penalties = penalties.filter(p => {
    if (p.war !== W.start || (p.type !== "own" && p.type !== "steal")) return true;
    const mm = W.members.find(x => x.tag === p.tag); if (!mm) return true;
    const at = mm.attacks.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0))[p.type === "own" ? 0 : 1];
    return !late(at);
  });
  for (const m of W.members) {
    const atts = m.attacks.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    // 1) pierwszy atak nie na swój numer
    // wyjątek: ktoś wcześniej zrobił już 3★ na jego numerze — wtedy nie miał czego bić
    const mirrorTaken = atts[0] && W.members.some(o => o.attacks.some(x => tp(x) === m.pos && x.stars === 3 && (x.order ?? 0) < (atts[0].order ?? 0)));
    if (atts[0] && tp(atts[0]) && m.pos && tp(atts[0]) !== m.pos && !mirrorTaken && !late(atts[0]))
      addPen({ id: `${W.start}:${m.tag}:own`, type: "own", detail: `nr ${tp(atts[0])} zamiast nr ${m.pos}`, ...base(m) });
    // 2) drugi atak na numer kogoś, kto jeszcze nie zaatakował (podkradanie ataku)
    const a2 = atts[1];
    if (a2 && a2.order != null && tp(a2) && tp(a2) !== m.pos && !late(a2)) {
      const owner = byPos[tp(a2)];
      if (owner && owner.tag !== m.tag && firstOrder(owner) > a2.order)
        addPen({ id: `${W.start}:${m.tag}:steal`, type: "steal", detail: `nr ${tp(a2)}, zanim ${owner.name} zaatakował(a) swój numer`, ...base(m) });
    }
  }
}
// 3) opuszczone ataki — tylko z wojen, których koniec robot widział (pewny komplet ataków), z ostatnich 7 dni
for (const x of warArchive) {
  if (x.cwl || !x.final || x.perMember !== 2 || Date.now() - stampMs(x.end) > 7 * 864e5) continue;
  // wszystkie bazy przeciwnika na 3★ = drugim atakiem nie było już czego bić → brak kary, jeśli 1. atak był zrobiony
  const allDone = x.size && x.us >= x.size * 3;
  // kara tylko za wojnę bez żadnego ataku (0/2); jeden wykorzystany atak (1/2) nie jest karany
  for (const m of x.members) if (m.attacks.length === 0)
    addPen({ id: `${x.start}:${m.tag}:missed`, type: "missed", detail: `wykorzystane ataki: ${m.attacks.length}/${x.perMember}`,
             tag: m.tag, name: m.name, war: x.start, end: x.end, enemy: x.enemy });
}
penalties = penalties.filter(p => { if (p.type !== "missed") return true;
  const x = warArchive.find(w => w.start === p.war && !w.cwl); if (!x || !(x.size && x.us >= x.size * 3)) return true;
  const mm = (x.members || []).find(m => m.tag === p.tag); return !(mm && mm.attacks.length >= 1); });
penalties = penalties.filter(p => !(p.type === "missed" && /: [1-9]\d*\//.test(p.detail || "")));   // stare kary za 1/2 znikają
penalties = penalties.slice(0, 80);

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
  const r = await fetch(`https://discord.com/api/v10/invites/${DISCORD_INVITE}?with_counts=true`, { signal: AbortSignal.timeout(15000) });
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
  const r = await fetch(COUNTER, { signal: AbortSignal.timeout(15000) });
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
// Konkurencja tygodnia zmienia się co tydzień: gwiazdki → oddane wojska → złoto Stolicy → …
// (ta sama kolejność jest na stronie w CHALLENGE.rotation)
const ROTATION = ["warStars", "donations", "capital"];
const metricFor = week => ROTATION[(((Math.round((Date.parse(week) - Date.parse("2026-10-26")) / 6048e5)) % 3) + 3) % 3];
const UNIT = { warStars: "★", donations: "oddanych wojsk", capital: "złota Stolicy" };
const valOf = (m, metric) => metric === "donations" ? (m.given ?? 0) : metric === "capital" ? (m.profile?.capital ?? null) : (m.profile?.warStars ?? null);
const baseOf = (b, metric) => metric === "donations" ? b.given : metric === "capital" ? b.capital : b.warStars;
// Zwycięzcy kończącego się tygodnia (liczone przed wyzerowaniem)
let weekWinners = null;
let donWeek = null;   // donacje zakończonego tygodnia (post w poniedziałek)
let lastWeek = old?.lastWeek ?? null;
if (weekBase && weekBase.week !== wk) {
  donWeek = { week: weekBase.week, list: members.map(m => {
    const b = weekBase.players[m.tag]; let d = b ? (m.given ?? 0) - (b.given ?? 0) : 0;
    if (d < 0) d = m.given ?? 0;                          // reset sezonu donacji w trakcie tygodnia
    return { name: m.name, d };
  }).sort((a, b) => b.d - a.d) };
  const metric = weekBase.metric || metricFor(weekBase.week);
  weekWinners = members.map(m => {
    const b = weekBase.players[m.tag];
    const n = valOf(m, metric), o = b ? baseOf(b, metric) : null;
    let d = (n != null && o != null) ? n - o : 0;
    if (metric === "donations" && d < 0) d = n;          // reset sezonu w trakcie tygodnia
    return { name: m.name, tag: m.tag, d };
  }).filter(x => x.d > 0).sort((a, b) => b.d - a.d).slice(0, 3);
  lastWeek = { week: weekBase.week, metric, winners: weekWinners };
}
if (!weekBase || weekBase.week !== wk) {
  weekBase = { week: wk, metric: metricFor(wk), players: {} };
  for (const m of (old?.members || members)) {
    weekBase.players[m.tag] = { given: m.given ?? 0, warStars: m.profile?.warStars ?? null, capital: m.profile?.capital ?? null };
  }
}
if (!weekBase.metric) weekBase.metric = metricFor(weekBase.week);
for (const m of members) {   // gracze, którzy dołączyli w trakcie tygodnia
  if (!weekBase.players[m.tag]) weekBase.players[m.tag] = { given: m.given ?? 0, warStars: m.profile?.warStars ?? null, capital: m.profile?.capital ?? null };
}

/* ---------- Staż w klanie (data dołączenia) ---------- */
// orig: true = gracz był w klanie, zanim robot zaczął liczyć staż (prawdziwa data może być wcześniejsza)
let joined = old?.joined && typeof old.joined === "object" ? old.joined : null;
if (!joined) {
  joined = {};
  for (const m of members) {
    const ev = events.filter(e => e.type === "join" && e.name === m.name).map(e => e.t).sort()[0];
    joined[m.tag] = ev ? { d: ev } : { d: new Date().toISOString(), orig: true };
  }
}
for (const m of members) if (!joined[m.tag]) joined[m.tag] = { d: new Date().toISOString() };
joined = Object.fromEntries(Object.entries(joined).filter(([t]) => members.some(m => m.tag === t)));   // odejście = staż od nowa

/* ---------- Aktywność graczy (wykrywanie nieaktywnych) ---------- */
// Sygnatura z rzeczy, które zmieniają się tylko gdy gracz SAM coś robi (bez pucharów — te spadają też od obron)
const nowIso = new Date().toISOString();
let activity = old?.activity && typeof old.activity === "object" ? old.activity : {};
for (const m of members) {
  const a = m.ach || {};
  const sig = [m.given, a.gold, a.elixir, a.cg, a.don, a.capLoot, a.capContrib, a.wins, m.profile?.warStars, m.profile?.level, m.th].join("|");
  const prev = activity[m.tag];
  if (!prev) activity[m.tag] = { sig, last: nowIso, since: nowIso };
  else if (prev.sig !== sig) activity[m.tag] = { ...prev, sig, last: nowIso };
}
activity = Object.fromEntries(Object.entries(activity).filter(([t]) => members.some(m => m.tag === t)));
const afkWarned = old?.afkWarned && typeof old.afkWarned === "object" ? { ...old.afkWarned } : {};

/* ---------- Gry Klanowe (22.–28. dnia miesiąca, 08:00 UTC) ---------- */
const nowD = new Date();
const cgStart = new Date(Date.UTC(nowD.getUTCFullYear(), nowD.getUTCMonth(), 22, 8));
const cgEnd = new Date(Date.UTC(nowD.getUTCFullYear(), nowD.getUTCMonth(), 28, 8));
const cgKey = cgStart.toISOString().slice(0, 7);
let clanGames = old?.clanGames ? JSON.parse(JSON.stringify(old.clanGames)) : null;
const prevCgState = old?.clanGames?.state ?? null;
if (nowD >= cgStart && nowD < new Date(+cgEnd + 6 * 3600e3)) {        // trwa (z 6h zapasu na ostatnie punkty)
  if (!clanGames || clanGames.key !== cgKey) {
    clanGames = { key: cgKey, start: cgStart.toISOString(), end: cgEnd.toISOString(),
      partial: nowD - cgStart > 3 * 3600e3, base: {}, points: {} };
  }
  for (const m of members) {
    const v = m.ach?.cg; if (v == null) continue;
    if (clanGames.base[m.tag] == null) clanGames.base[m.tag] = v;
    clanGames.points[m.tag] = { name: m.name, pts: Math.max(0, v - clanGames.base[m.tag]) };
  }
  clanGames.state = nowD < cgEnd ? "ongoing" : "ended";
} else if (clanGames && clanGames.state === "ongoing" && nowD >= cgEnd) {
  clanGames.state = "ended";
}


/* ---------- MVP miesiąca (wybierany automatycznie 1. dnia miesiąca) ---------- */
// Punkty: gwiazdki wojenne ×10, oddane wojska ÷10, pkt Gier Klanowych ÷50, złoto z rajdów ÷500, każda kara −30.
// Ta sama osoba nie może wygrać dwa miesiące z rzędu (przerwa MVP_PRZERWA miesięcy).
const MVP_PRZERWA = 2;
const MVP_START = "2026-11";   // pierwszy miesiąc liczony przez robota (MVP za listopad wybierany 1 grudnia)
const MIES = ["styczeń","luty","marzec","kwiecień","maj","czerwiec","lipiec","sierpień","wrzesień","październik","listopad","grudzień"];
const MIES_D = ["stycznia","lutego","marca","kwietnia","maja","czerwca","lipca","sierpnia","września","października","listopada","grudnia"];
const plural = (n, a, b, c) => n === 1 ? a : (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14)) ? b : c;
const nf = n => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
// kary anulowane / ręczne wpisane w index.html
let karyAnul = [], karyRecz = [], mvpRecz = [], mvpBez = [];
try {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const grab = name => { const m = html.match(new RegExp(`const ${name}\\s*=\\s*\\[([\\s\\S]*?)\\n\\];`)); if (!m) return [];
    return [...m[1].matchAll(/\{\s*name\s*:\s*"([^"]+)"\s*,\s*date\s*:\s*"([^"]+)"/g)].map(x => ({ name: x[1], date: x[2] })); };
  karyAnul = grab("KARY_ANULOWANE"); karyRecz = grab("KARY_RECZNE");
  const mr = html.match(/const MVP_RECZNE\s*=\s*\[([\s\S]*?)\n\];/);
  const mb = html.match(/const MVP_BEZ\s*=\s*\[([\s\S]*?)\n\];/);
  if (mb) mvpBez = [...mb[1].matchAll(/"(#[0-9A-Z]+)"/g)].map(x => x[1]);
  if (mr) mvpRecz = [...mr[1].matchAll(/\{\s*key\s*:\s*"(\d{4}-\d{2})"\s*,\s*name\s*:\s*"([^"]+)"/g)].map(x => ({ month: x[1], name: x[2] }));
} catch (e) { console.warn("index.html (kary) niedostępny:", e.message); }
const warStartMs = t => t && t.length > 15 ? Date.parse(`${t.slice(0,4)}-${t.slice(4,6)}-${t.slice(6,8)}T${t.slice(9,11)}:${t.slice(11,13)}:${t.slice(13,15)}Z`) : Date.parse(t);
const plDay = ms => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Warsaw" }).format(new Date(ms));
function mvpScores(base, fromIso, toMs) {
  if (!base?.players) return [];
  const from = Date.parse(fromIso || 0);
  const pens = [
    ...penalties.map(p => ({ tag: p.tag, name: p.name, t: warStartMs(p.war) })).filter(p => !karyAnul.some(a => a.name === p.name && a.date === plDay(p.t))),
    ...karyRecz.map(k => ({ tag: null, name: k.name, t: Date.parse(k.date + "T12:00:00Z") }))
  ].filter(p => p.t >= from && p.t < toMs);
  const wars = warArchive.filter(w => w.state === "warEnded" && warStartMs(w.end) >= from && warStartMs(w.end) < toMs);
  return members.map(m => {
    const b = base.players[m.tag] || {};
    const d = (cur, st) => (cur != null && st != null) ? Math.max(0, cur - st) : 0;
    const stars = d(m.profile?.warStars, b.warStars), don = d(m.ach?.don, b.don), cg = d(m.ach?.cg, b.cg), cap = d(m.ach?.capLoot, b.capLoot);
    let att = 0, three = 0, missed = 0, wcount = 0;
    for (const w of wars) { const me = (w.members || []).find(x => x.tag === m.tag); if (!me) continue;
      wcount++; att += me.attacks.length; three += me.attacks.filter(a => a.stars === 3).length; missed += Math.max(0, (w.perMember || 2) - me.attacks.length); }
    const pen = pens.filter(p => p.tag ? p.tag === m.tag : p.name === m.name).length;
    const score = Math.max(0, Math.round(stars * 10 + don / 10 + cg / 50 + cap / 500) - pen * 30);
    return { name: m.name, tag: m.tag, score, stars, don, cg, cap, wars: wcount, att, three, missed, pen };
  }).sort((a, b) => b.score - a.score);
}
function mvpText(w, all, monthIdx) {
  const h = [...(w.tag + monthIdx)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const pick = arr => arr[h % arr.length];
  const rank = k => all.filter(x => x[k] > w[k]).length;   // 0 = najlepszy w klanie
  const mi = MIES[monthIdx], md = MIES_D[monthIdx];
  const out = [pick([`${w.name} zgarnia MVP za ${mi}.`, `MVP ${md} to ${w.name}.`, `Za ${mi} MVP bierze ${w.name}.`, `${w.name} z tytułem MVP ${md}.`])];
  const parts = [];
  if (w.stars) parts.push({ r: rank("stars"), k: "stars", t: `${nf(w.stars)} ${plural(w.stars, "gwiazdka", "gwiazdki", "gwiazdek")} w wojnach` });
  if (w.don) parts.push({ r: rank("don"), t: `${nf(w.don)} ${plural(w.don, "oddana jednostka", "oddane jednostki", "oddanych jednostek")}` });
  if (w.cg) parts.push({ r: rank("cg"), t: `${nf(w.cg)} pkt w Grach Klanowych` });
  if (w.cap) parts.push({ r: rank("cap"), t: `${nf(w.cap)} złota z rajdów na Stolicę` });
  parts.sort((a, b) => a.r - b.r);
  const top = parts.slice(0, 3);
  if (top[0] && top[0].k === "stars" && w.three >= 2) top[0].t += ` (${w.three} ${plural(w.three, "atak", "ataki", "ataków")} na 3 gwiazdki)`;
  if (top[0]) out.push(top[0].t.charAt(0).toUpperCase() + top[0].t.slice(1) + (top[0].r === 0 ? pick([", najwięcej w klanie.", ". Nikt w klanie nie miał więcej.", ", najlepszy wynik w klanie."]) : "."));
  if (top[1]) out.push(pick(["Do tego ", "Poza tym ", "Plus "]) + top[1].t + (top[2] ? ` i ${top[2].t}.` : "."));
  if (!w.pen && !w.missed && w.wars) out.push(pick(["Zero kar i żadnego opuszczonego ataku.", "Ani jednej kary, wszystkie ataki wykorzystane.", "Bez kar i bez opuszczonych ataków."]));
  out.push(pick(["Gratulacje!", "Brawo, tak trzymać!", "Szacun!", "Gratki!", "Dobra robota!"]));
  return out.join(" ");
}
let mvp = old?.mvp && typeof old.mvp === "object" ? old.mvp : { history: [] };
if (!Array.isArray(mvp.history)) mvp.history = [];
// kto ma przerwę: zwycięzcy z MVP_PRZERWA poprzednich miesięcy (wybór robota albo wpis ręczny)
const prevMonths = (key, n) => { let [y, m] = key.split("-").map(Number); const out = []; for (let i = 0; i < n; i++) { m--; if (!m) { m = 12; y--; } out.push(`${y}-${String(m).padStart(2, "0")}`); } return out; };
const blockedFor = key => { const ms = prevMonths(key, MVP_PRZERWA), tags = new Set();
  for (const k of ms) { const r = mvpRecz.find(x => x.month === k); const h = mvp.history.find(x => x.month === k);
    const name = r ? r.name : h?.name; const tag = r ? (members.find(m => m.name === r.name)?.tag || h?.tag) : h?.tag;
    if (tag) tags.add(tag); else if (name) members.filter(m => m.name === name).forEach(m => tags.add(m.tag)); }
  mvpBez.forEach(x => tags.add(x));
  return [...tags]; };
const curMonth = nowIso.slice(0, 7);
if (old?.monthBase?.month && old.monthBase.month >= MVP_START && old.monthBase.month !== curMonth && !mvp.history.some(x => x.month === old.monthBase.month)) {
  const all = mvpScores(old.monthBase, old.monthBase.since, Date.now());
  const recent = blockedFor(old.monthBase.month);
  const manual = mvpRecz.find(x => x.month === old.monthBase.month);
  const win = manual ? null : all.find(x => x.score > 0 && !recent.includes(x.tag));
  if (manual) {
    const st = all.find(x => x.name === manual.name) || { name: manual.name, tag: (members.find(m => m.name === manual.name) || {}).tag || null };
    mvp.history.unshift({ month: old.monthBase.month, since: old.monthBase.since, picked: nowIso, ...st, manual: true });
    console.log(`MVP ${old.monthBase.month}: ${manual.name} (wybór zarządu)`);
  } else if (win) {
    const mIdx = Number(old.monthBase.month.slice(5, 7)) - 1;
    mvp.history.unshift({ month: old.monthBase.month, since: old.monthBase.since, picked: nowIso, ...win, text: mvpText(win, all, mIdx),
      runnersUp: all.filter(x => x.tag !== win.tag && x.score > 0).slice(0, 2).map(x => ({ name: x.name, score: x.score })) });
    console.log(`MVP ${old.monthBase.month}: ${win.name} (${win.score} pkt)`);
  }
}
mvp.history = mvp.history.slice(0, 24);
/* ---------- Gracz dnia: kto wczoraj zrobił najwięcej dla klanu (dzień liczony wg czasu w Polsce) ---------- */
const POTD_PRZERWA = 3;   // ta sama osoba nie wygrywa częściej niż raz na tyle dni
const todayPl = plDay(Date.now());
const daySnap = m => ({ warStars: m.profile?.warStars ?? null, don: m.ach?.don ?? null, cg: m.ach?.cg ?? null, capLoot: m.ach?.capLoot ?? null });
let dayBase = old?.dayBase;
let potd = old?.potd ?? null;
let potdHistory = Array.isArray(old?.potdHistory) ? old.potdHistory : [];
if (dayBase && dayBase.day !== todayPl) {
  const recent = potdHistory.slice(0, POTD_PRZERWA).map(x => x.tag);
  const all = mvpScores(dayBase, dayBase.since, Date.now());
  const win = all.find(x => x.score > 0 && !recent.includes(x.tag) && !mvpBez.includes(x.tag));
  if (win) {
    const m = members.find(x => x.tag === win.tag) || {};
    potd = { day: dayBase.day, picked: nowIso, name: win.name, tag: win.tag, th: m.th ?? null, role: m.role ?? null,
      score: win.score, stars: win.stars, don: win.don, cg: win.cg, cap: win.cap, att: win.att, three: win.three };
    potdHistory = [{ day: dayBase.day, name: win.name, tag: win.tag, score: win.score }, ...potdHistory].slice(0, 14);
    console.log(`Gracz dnia ${dayBase.day}: ${win.name} (${win.score} pkt)`);
  }
}
if (!dayBase || dayBase.day !== todayPl) {
  dayBase = { day: todayPl, since: nowIso, players: {} };
  for (const m of members) dayBase.players[m.tag] = daySnap(m);
} else {
  for (const m of members) { const b = dayBase.players[m.tag]; const cur = daySnap(m);
    if (!b) dayBase.players[m.tag] = cur; else for (const k of Object.keys(cur)) if (b[k] == null && cur[k] != null) b[k] = cur[k]; }
}


/* ---------- Historia graczy (do wykresów w profilu): 1 wpis dziennie, 60 dni ---------- */
// wpis: [dzień (dni od 1970), gwiazdki wojenne, oddane wojska (łącznie z osiągnięcia), ratusz]
const dayNo = Math.floor(Date.parse(plDay(Date.now()) + "T12:00:00Z") / 864e5);
const playerHistory = {};
for (const m of members) {
  const prev = Array.isArray(old?.playerHistory?.[m.tag]) ? old.playerHistory[m.tag] : [];
  const e = [dayNo, m.profile?.warStars ?? null, m.ach?.don ?? null, m.th ?? null];
  const arr = prev.filter(x => x[0] !== dayNo); arr.push(e);
  playerHistory[m.tag] = arr.slice(-60);
}

/* ---------- Bilans miesiąca (kandydaci na MVP i do awansu) ---------- */
const monthKey = nowIso.slice(0, 7);
let monthBase = old?.monthBase;
if (!monthBase || monthBase.month !== monthKey) {
  monthBase = { month: monthKey, since: nowIso, players: {} };
  for (const m of (old?.members?.length ? old.members : members)) {
    monthBase.players[m.tag] = { warStars: m.profile?.warStars ?? null, don: m.ach?.don ?? null, cg: m.ach?.cg ?? null, capLoot: m.ach?.capLoot ?? null };
  }
}
for (const m of members) {
  const cur = { warStars: m.profile?.warStars ?? null, don: m.ach?.don ?? null, cg: m.ach?.cg ?? null, capLoot: m.ach?.capLoot ?? null };
  const b = monthBase.players[m.tag];
  if (!b) { monthBase.players[m.tag] = { ...cur, joined: nowIso }; continue; }
  for (const k of Object.keys(cur)) if (b[k] == null && cur[k] != null) b[k] = cur[k];   // uzupełnij brakujące wartości startowe
}

// wyścig o MVP bieżącego miesiąca (na żywo) — bez zwycięzców z ostatnich miesięcy
if (monthBase.month < MVP_START) { mvp.race = { month: monthBase.month, start: MVP_START, top: [] }; }
else {
  const recent = blockedFor(monthBase.month);
  const all = mvpScores(monthBase, monthBase.since, Date.now());
  mvp.race = { month: monthBase.month, since: monthBase.since, blocked: recent,
    top: all.filter(x => x.score > 0 && !recent.includes(x.tag)).slice(0, 5).map(x => ({ name: x.name, tag: x.tag, score: x.score, stars: x.stars, don: x.don, cg: x.cg, cap: x.cap })) };
}

/* ---------- Powiadomienia na Discordzie (webhook) ---------- */
/* ---------- Księga rekordów klanu (rekordy wszech czasów, tylko rosną) ---------- */
let records = old?.records && typeof old.records === "object" ? JSON.parse(JSON.stringify(old.records)) : {};
const recDay = t => (t ? day(t) : null) || nowIso.slice(0, 10);
const setRec = (key, value, name, tag, date, detail) => {
  if (value == null || !(value > 0)) return;
  const r = records[key];
  if (!r || value > r.value) records[key] = { value, name, tag, date, ...(detail ? { detail } : {}) };
  else if (r.tag === tag && value === r.value && name !== r.name) r.name = name;   // zmiana nicku rekordzisty
};
// 1) Najwięcej gwiazdek jednego gracza w jednej wojnie (zakończone wojny, także CWL)
const endedWars = warArchive.filter(x => x.state === "warEnded").sort((a, b) => String(a.end).localeCompare(String(b.end)));
for (const wr of endedWars) for (const m of wr.members || []) {
  const st = (m.attacks || []).reduce((a, x) => a + (x.stars || 0), 0);
  setRec("warStars", st, m.name, m.tag, recDay(wr.end), `vs ${wr.enemy}`);
}
// 2) Najdłuższa seria ataków za 3★ z rzędu (opuszczony atak przerywa serię)
const streak = {};
for (const wr of endedWars) for (const m of wr.members || []) {
  const s = streak[m.tag] || (streak[m.tag] = { cur: 0, name: m.name });
  s.name = m.name;
  const atts = m.attacks || [];
  for (let i = 0; i < (wr.perMember || atts.length); i++) {
    const a = atts[i];
    if (a && a.stars === 3) { s.cur++; setRec("tripleStreak", s.cur, m.name, m.tag, recDay(wr.end)); }
    else s.cur = 0;
  }
}
// 3) Najwięcej łupów w jednym weekendzie rajdowym
for (const r of raids.filter(x => x.state === "ended")) for (const m of r.members || [])
  setRec("raidLoot", m.loot, m.name, m.tag, recDay(r.end));
// 4) Najwięcej oddanych wojsk w jednym sezonie
for (const m of members) setRec("donSeason", m.given, m.name, m.tag, today);
// 5) Najwięcej punktów w jednych Grach Klanowych
for (const [t, v] of Object.entries(clanGames?.points || {})) setRec("clanGames", v.pts, v.name, t, today);
// 6) Najwięcej wygranych Wyzwań Tygodnia
let weekWins = old?.weekWins && typeof old.weekWins === "object" ? old.weekWins : {};
if (weekWinners && weekWinners[0]) {
  const w = weekWinners[0];
  weekWins[w.tag] = { name: w.name, n: (weekWins[w.tag]?.n || 0) + 1 };
  setRec("weekWins", weekWins[w.tag].n, w.name, w.tag, today);
}
// 7) Rekord liczebności klanu
setRec("members", clan.members, "Armia Maurycego", TAG, today);

const WEBHOOK = process.env.DISCORD_WEBHOOK;                         // kanał wojenny: przypomnienia, wyniki, Gry Klanowe
const WEBHOOK_INFO = process.env.DISCORD_WEBHOOK_INFO || WEBHOOK;      // #ogłoszenia: powitania, MVP, Wojownik Tygodnia
const WEBHOOK_RUCHY = process.env.DISCORD_WEBHOOK_RUCHY || "";         // #ruchy-w-klanie: dołączenia, odejścia, ratusze, awanse
const WEBHOOK_WOJNY = process.env.DISCORD_WEBHOOK_WOJNY || WEBHOOK;    // #wojny-klanu: wszystko o wojnach i CWL
const WEBHOOK_RAJDY = process.env.DISCORD_WEBHOOK_RAJDY || "";         // #rajdy-stolica: rajdy na Stolicę
const WEBHOOK_POWITANIA = process.env.DISCORD_WEBHOOK_POWITANIA || WEBHOOK_INFO; // #powitania: nowi gracze
const WEBHOOK_REKRUTACJA = process.env.DISCORD_WEBHOOK_REKRUTACJA || "";  // #rekrutacja: post co tydzień
const WEBHOOK_WYMAGANIA = process.env.DISCORD_WEBHOOK_WYMAGANIA || "";
const WEBHOOK_KARY = process.env.DISCORD_WEBHOOK_KARY || "";
const WEBHOOK_STATY = process.env.DISCORD_WEBHOOK_STATYSTYKI || WEBHOOK_INFO;   // #statystyki-klanu: awanse klanu, ligi, serie (karty)              // #kary: kary za łamanie zasad wojen (jak zakładka Kary na stronie)    // #wymagania-klanu: jedna wiadomość, aktualizowana
let notified = old?.notified && typeof old.notified === "object" ? old.notified : {};
const SITE = "https://kubooorek.github.io/armia-maurycego/";
async function postEmbed(embed, url = WEBHOOK) {
  if (!url) return false;
  try {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "Armia Maurycego", avatar_url: SITE + "icon-512.png", embeds: [embed], allowed_mentions: { parse: [] } }) });
    if (!r.ok) console.warn("Webhook (karta):", r.status, await r.text());
    await new Promise(res => setTimeout(res, 1200));
    return r.ok;
  } catch (e) { console.warn("Webhook niedostępny:", e.message); return false; }
}

async function post(content, url = WEBHOOK, ping = false, embed = false) {
  if (!url) return false;
  try {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "Armia Maurycego", avatar_url: SITE + "icon-512.png", content, allowed_mentions: { parse: ping ? ["everyone"] : [] }, flags: embed ? 0 : 4 }) });
    if (!r.ok) console.warn("Webhook:", r.status, await r.text());
    await new Promise(res => setTimeout(res, 1200));
    return r.ok;
  } catch (e) { console.warn("Webhook niedostępny:", e.message); return false; }
}

// Jednorazowe ogłoszenia — każde wysyłane tylko raz (zapamiętywane w data.json -> oneShots)
const oneShots = Array.isArray(old?.oneShots) ? old.oneShots : [];
const OGLOSZENIA = [
  { id: "discord-dm-2026-11", text:
`📢 **Nowość na stronie klanu!** @everyone

Od teraz robot klanu może Wam przypominać **na priv na Discordzie**, kiedy macie jeszcze nieużyty atak na wojnie albo w CWL. Koniec z zapominaniem! ⚔️

**Jak to włączyć (zajmie 1 minutę):**
1️⃣ Wejdź na stronę: ${"https://kubooorek.github.io/armia-maurycego/"}
2️⃣ Zaloguj się swoim tagiem gracza i tokenem z gry (w grze: Ustawienia → Więcej ustawień → Token API)
3️⃣ Otwórz **Mój panel** i kliknij **Połącz Discord**
4️⃣ Zatwierdź w okienku Discorda i gotowe ✅

W **Moim panelu** możecie też:
🛑 zgłosić, że nie gracie w najbliższej wojnie (nie dostaniecie wtedy minusa za brak ataku)
🏆 zapisać się na kolejny sezon CWL

Pytania? Piszcie śmiało! 🔥` }
];
for (const o of OGLOSZENIA) {
  if (oneShots.includes(o.id) || !WEBHOOK_INFO) continue;
  if (await post(o.text, WEBHOOK_INFO, true)) oneShots.push(o.id);
}
const parseT = t => t ? new Date(`${t.slice(0,4)}-${t.slice(4,6)}-${t.slice(6,8)}T${t.slice(9,11)}:${t.slice(11,13)}:${t.slice(13,15)}Z`) : null;
const firstRun = !old;   // przy pierwszym uruchomieniu nic nie wysyłamy (brak historii)

// Które wiadomości robot wysyła na Discorda (false = wyłączone, bo robi to ClashPerk)
const POSTY = {
  dolaczenie: true,        // powitanie nowego gracza z instrukcją /link (ClashPerk pisze tylko „dołączył”)
  ratusz: true,            // nowy ratusz (#ruchy-w-klanie)
  awans: true,             // awans w grze
  odejscie: true,          // ktoś opuścił klan
  mvp: true,               // MVP miesiąca
  wojownikTygodnia: true,  // Wojownik Tygodnia
  gryKlanowe: true,        // kto zrobił normę 1000 pkt w Grach Klanowych
  przygotowania: true,     // start dnia przygotowań (wyślijcie wojska do zamków)
  startBitwy: true,        // start dnia bitwy + zasada „pierwszy atak na swój numer”
  wolneNumery: true,       // po 12 h: które numery są wolne (zasada 12 h)
  przypomnienia: true,     // 4 h i 1 h przed końcem: kto jeszcze nie zaatakował
  wynikWojny: false,       // stary krótki wynik (zastąpiony podsumowaniem poniżej)
  podsumowanieWojny: true, // po każdej wojnie i rundzie CWL: wynik, najlepsi, 3★, opuszczone, kary
  podsumowanieCWL: true,   // po ostatniej rundzie CWL: miejsce, bilans, najlepsi gracze sezonu
  rajdy: true,             // rajdy na Stolicę: start, przypomnienia, podsumowanie (#rajdy-stolica)
  rekrutacja: true,        // post rekrutacyjny raz w tygodniu (#rekrutacja)
  atakiNaZywo: true,       // każdy atak w wojnie/CWL + tablica wojny (#wojny-klanu)
  aktywnosc: true,         // tablica aktywności graczy (#statystyki-klanu)
  donacje: true,           // donacje tygodnia (pon.) i miesiąca (#statystyki-klanu)
  osiagniecia: true,       // poziom klanu, ligi, serie wygranych (#ogłoszenia)
  kary: true,              // #kary: automatyczne ogłaszanie kar za łamanie zasad wojen
  rangiDiscord: true,      // role Leader/Co-Leader/Elder/Member i nick z gry dla połączonych przez stronę
  wymagania: true          // stała, aktualizowana wiadomość z wymaganiami (#wymagania-klanu)
};
if ((WEBHOOK || WEBHOOK_INFO || WEBHOOK_RUCHY || WEBHOOK_WOJNY || WEBHOOK_POWITANIA) && !firstRun) {
  // 1) Ruchy w klanie z tego uruchomienia
  const RN = { leader: "Wodza", coLeader: "Współlidera", admin: "Starszego", member: "Członka" };
  const freshEvents = events.filter(e => e.t === events[0]?.t && !(old.events || []).some(o => o.t === e.t && o.name === e.name && o.type === e.type));
  for (const e of freshEvents.reverse()) {
    if (e.type === "join" && POSTY.dolaczenie) await post(`👋 **Witamy w Armii Maurycego, ${e.name}!** (TH${e.th}) 🛡️\n` +
      `• Przeczytaj <#1564012902996770886> i <#1564015161419767818>\n` +
      `• **Odblokuj serwer:** wpisz na <#1564035430817730570> komendę \`/link\` i swój tag z gry. Dostaniesz rangę z klanu i nick z gry, ` +
      `a robot przypomni Ci na priv o ataku w wojnie 🔔\n` +
      `Powodzenia i do zobaczenia na wojnach! ⚔️ ${SITE}`, WEBHOOK_POWITANIA);
    if (e.type === "join" && WEBHOOK_RUCHY) await post(`➕ **${e.name}** dołączył(a) do klanu (TH${e.th}).`, WEBHOOK_RUCHY);
    if (e.type === "th" && POSTY.ratusz && WEBHOOK_RUCHY) await post(`🏰 **${e.name}** ulepszył(a) ratusz: TH${e.from} → **TH${e.to}**! Gratulacje! 🎉`, WEBHOOK_RUCHY);
    if (e.type === "leave" && POSTY.odejscie && WEBHOOK_RUCHY) await post(`➖ **${e.name}** opuścił(a) klan.`, WEBHOOK_RUCHY);
    if (e.type === "promote" && POSTY.awans && WEBHOOK_RUCHY) await post(`⬆️ **${e.name}** awansował(a) na ${RN[e.role] || e.role}! 👏`, WEBHOOK_RUCHY);
  }

  // Nowy MVP miesiąca (wybrany w tym uruchomieniu)
  const newMvp = mvp.history[0];
  if (POSTY.mvp && newMvp && newMvp.picked === nowIso && !newMvp.manual && newMvp.text) await post(`🏆 ${newMvp.text}\n${SITE}#kadra`, WEBHOOK_INFO);

  // Wojownik Tygodnia (pierwsze uruchomienie po północy z niedzieli na poniedziałek)
  if (POSTY.wojownikTygodnia && weekWinners && weekWinners.length) {
    const md = ["🥇", "🥈", "🥉"];
    const u = UNIT[lastWeek.metric] || "";
    await post(`⚔️ **WOJOWNIK TYGODNIA: ${weekWinners[0].name}** (+${weekWinners[0].d} ${u})! Gratulacje — ranga ⚔️ Wojownik Tygodnia leci do Ciebie! 🏆\n` +
      weekWinners.map((w, i) => `${md[i]} ${w.name} — +${w.d} ${u}`).join("\n") + `\nNowe wyzwanie: **${({ warStars: "najwięcej gwiazdek wojennych", donations: "najwięcej oddanych wojsk", capital: "najwięcej złota dla Stolicy" })[weekBase.metric]}**! ${SITE}`, WEBHOOK_INFO);
  }

  // Podsumowanie Gier Klanowych
  if (POSTY.gryKlanowe && clanGames && clanGames.state === "ended" && prevCgState === "ongoing") {
    const rows = Object.values(clanGames.points || {});
    const low = rows.filter(r => r.pts < 1000).sort((a, b) => a.pts - b.pts);
    await post(`🎯 **Gry Klanowe zakończone!** Normę 1000 pkt zrobiło **${rows.length - low.length}/${rows.length}** graczy. 💪` +
      (low.length ? `\nPoniżej normy: ${low.map(r => `${r.name} (${r.pts})`).join(", ")}` : `\nWszyscy zrobili normę — brawo! 🔥`));
  }

  // 2) Wojny: start, przypomnienia, wynik (zwykła wojna lub runda CWL)
  const liveWars = [];
  if (currentWar) liveWars.push({ ...currentWar, key: `w:${currentWar.start}`, label: "Wojna" });
  for (const cw of (cwl?.wars || [])) liveWars.push({ ...cw, key: `c:${cw.start}:${cw.them.name}`, label: `CWL · Runda ${cw.round}` });
  for (const w of liveWars) {
    const sent = notified[w.key] || (notified[w.key] = []);
    const once = async (id, msg) => { if (!sent.includes(id)) { sent.push(id); await post(msg, WEBHOOK_WOJNY); } };
    const sinceStart = (Date.now() - parseT(w.start)) / 3600e3, sinceEnd = (Date.now() - parseT(w.end)) / 3600e3;
    if (w.state === "preparation" && POSTY.przygotowania) {
      await once("prep", `🛡️ **${w.label}** rozpoczyna się! Przeciwnik: **${w.them.name}** (${w.size} vs ${w.size}). Dzień przygotowań — wyślijcie wojska do zamków obronnych!`);
    }
    if (w.state === "inWar") {
      const left = (parseT(w.end) - Date.now()) / 3600e3;
      const missing = w.members.filter(m => m.attacks.length < w.perMember).map(m => `${m.name}${w.perMember - m.attacks.length > 1 ? ` ×${w.perMember - m.attacks.length}` : ""}`);
      if (sinceStart < 6 && POSTY.startBitwy) await once("start", `⚔️ **${w.label}** — dzień bitwy ruszył! Przeciwnik: **${w.them.name}**. Pierwszy atak na swój numer! ${SITE}`);
      // Zasada 12 h (zwykłe wojny): numery graczy, którzy jeszcze nie zaatakowali, są wolne
      if (POSTY.wolneNumery && w.perMember === 2 && sinceStart >= 12 && left > 0.5) {
        const free = w.members.filter(m => m.attacks.length === 0 && m.pos).map(m => m.pos).sort((a, b) => a - b);
        const open = free.filter(p => { const b = (w.them.bases || []).find(x => x.pos === p); return !b || b.best < 3; });
        if (open.length) await once("free12", `🔓 **${w.label}** — minęło 12 h od startu bitwy. Te numery są teraz wolne i może je bić każdy: **${open.join(", ")}**. Zostało ok. ${Math.max(1, Math.round(left))} h.`);
        else sent.includes("free12") || sent.push("free12");
      }
      // przypomnienie na progach 4 h i 1 h — wysyłamy tylko najmniejszy osiągnięty
      const hit = [1, 4].find(h => left <= h && left > 0);
      if (POSTY.przypomnienia && hit && missing.length && !sent.includes(`r${hit}`)) {
        for (const h of [4, 1]) if (h >= hit && !sent.includes(`r${h}`)) sent.push(`r${h}`);
        await post(`⏰ **${w.label}** — zostało ok. **${Math.max(1, Math.round(left))}h** do końca! Wynik: ${w.us.stars} ★ ${w.them.stars}.\nBrakujące ataki: ${missing.join(", ")}`, WEBHOOK_WOJNY);
      }
    }
    if (w.state === "warEnded" && sinceEnd < 12 && POSTY.podsumowanieWojny) {
      const win = w.us.stars > w.them.stars || (w.us.stars === w.them.stars && w.us.pct > w.them.pct);
      const draw = w.us.stars === w.them.stars && w.us.pct === w.them.pct;
      const atts = w.members.flatMap(m => m.attacks), threes = atts.filter(a => a.stars === 3).length;
      const best = w.members.map(m => ({ name: m.name, s: m.attacks.reduce((a, x) => a + x.stars, 0), p: m.attacks.reduce((a, x) => a + x.pct, 0), n: m.attacks.length }))
        .filter(x => x.n).sort((a, b) => b.s - a.s || b.p - a.p).slice(0, 3);
      const missing = w.members.filter(m => m.attacks.length < w.perMember).map(m => m.name + (w.perMember - m.attacks.length > 1 ? ` ×${w.perMember - m.attacks.length}` : ""));
      const pens = w.perMember === 2 ? penalties.filter(p => p.war === w.start && (p.type === "own" || p.type === "steal") && !karyAnul.some(a => a.name === p.name && a.date === plDay(stampMs(p.war)))).length : 0;
      const pl = n => String(n).replace(".", ",");
      const lines = [
        `${win ? "🏆 **Wygrana!**" : draw ? "🤝 **Remis**" : "❌ **Przegrana**"} ${w.label} vs **${w.them.name}** — **${w.us.stars} ★ ${w.them.stars}** (${pl(w.us.pct)}% : ${pl(w.them.pct)}%)`,
        `⭐ Ataki za 3★: **${threes}** z ${atts.length}${atts.length ? ` · średnio ${pl((atts.reduce((a, x) => a + x.stars, 0) / atts.length).toFixed(2))}★ na atak` : ""}`,
        best.length ? `🎯 Najlepsi: ${best.map(b => `${b.name} (${b.s}★${w.perMember === 1 ? ` ${Math.round(b.p)}%` : ""})`).join(", ")}` : "",
        missing.length ? `💤 Bez ataku: ${missing.join(", ")}` : "💪 Wszyscy zaatakowali!",
        pens ? `⚠️ Kary za łamanie zasad: ${pens} (szczegóły na stronie)` : "",
        w.label.startsWith("CWL") && cwl?.place ? `📊 Tabela grupy: **${cwl.place}. miejsce** z ${cwl.groupSize}` : "",
        SITE
      ].filter(Boolean);
      await once("summary", lines.join("\n"));
    }
    if (w.state === "warEnded" && sinceEnd < 6 && POSTY.wynikWojny) {
      const res = w.us.stars > w.them.stars || (w.us.stars === w.them.stars && w.us.pct > w.them.pct) ? "🏆 **Wygrana!**"
        : (w.us.stars === w.them.stars && w.us.pct === w.them.pct) ? "🤝 **Remis**" : "❌ **Przegrana**";
      const missing = w.members.filter(m => m.attacks.length < w.perMember).map(m => m.name);
      await once("end", `${res} ${w.label} vs **${w.them.name}** — ${w.us.stars} ★ ${w.them.stars} (${w.us.pct}% : ${w.them.pct}%).${missing.length ? `\nOpuszczone ataki: ${missing.join(", ")}` : "\nWszyscy zaatakowali — brawo! 💪"}`);
    }
  }
}
// Podsumowanie całego sezonu CWL (raz, po ostatniej rundzie)
if (WEBHOOK_WOJNY && !firstRun && POSTY.podsumowanieCWL && cwlSummary && !cwlSummary.posted) {
  const s = cwlSummary, medal = ["🥇", "🥈", "🥉"];
  const msg = [
    `🏁 **Koniec sezonu Ligi Wojen Klanów!** Armia Maurycego kończy na **${s.place}. miejscu** z ${s.groupSize}.`,
    `📈 Bilans rund: **${s.wins}** wygranych, ${s.draws ? `${s.draws} remisów, ` : ""}${s.losses} przegranych · ${s.stars ?? "?"} ★ w tabeli`,
    `🔹 Rundy: ${s.rounds.map(r => `${r.round}. ${r.win ? "✅" : r.draw ? "🤝" : "❌"} ${r.us}:${r.them}`).join(" · ")}`,
    s.top.length ? `⭐ Najlepsi: ${s.top.slice(0, 3).map((x, i) => `${medal[i]} ${x.name} ${x.stars}★`).join("  ")}` : "",
    s.missed.length ? `💤 Opuszczone ataki: ${s.missed.map(x => `${x.name}${x.n > 1 ? ` ×${x.n}` : ""}`).join(", ")}` : "💪 Nikt nie opuścił ataku!",
    `Dzięki wszystkim za walkę! ${SITE}`
  ].filter(Boolean).join("\n");
  await post(msg, WEBHOOK_WOJNY); cwlSummary.posted = true;
}

/* ---------- Rajdy na Stolicę (#rajdy-stolica) ----------
   start weekendu, przypomnienia 12 h i 3 h przed końcem, podsumowanie po zakończeniu */
if (WEBHOOK_RAJDY && !firstRun && POSTY.rajdy) {
  const fmt = n => Number(n || 0).toLocaleString("pl-PL");
  for (const r of raids.slice(0, 1)) {
    const key = `raid:${r.start}`;
    const sent = notified[key] || (notified[key] = []);
    const once = async (id, msg) => { if (!sent.includes(id)) { sent.push(id); await post(msg, WEBHOOK_RAJDY); } };
    const sinceStart = (Date.now() - parseT(r.start)) / 3600e3, left = (parseT(r.end) - Date.now()) / 3600e3;
    const inRaid = Object.fromEntries((r.members || []).map(m => [m.tag, m]));
    const nobody = members.filter(m => !inRaid[m.tag]).map(m => m.name);
    const partial = (r.members || []).filter(m => m.attacks < m.limit).map(m => `${m.name} (${m.attacks}/${m.limit})`);
    if (r.state === "ongoing") {
      if (sinceStart < 6) await once("start", `🏰 **Weekend rajdów na Stolicę ruszył!** Każdy ma **5 ataków** (+1 bonusowy za zniszczenie dzielnicy). Wbijajcie i zbierajcie złoto dla klanu! 💰\nKoniec w poniedziałek o 8:00. ${SITE}`);
      const hit = [3, 12].find(h => left <= h && left > 0);
      if (hit && !sent.includes(`r${hit}`) && (nobody.length || partial.length)) {
        for (const h of [12, 3]) if (h >= hit && !sent.includes(`r${h}`)) sent.push(`r${h}`);
        await post([
          `⏰ **Rajdy na Stolicę** — zostało ok. **${Math.max(1, Math.round(left))} h** do końca! Zebrane złoto: **${fmt(r.loot)}** 💰`,
          nobody.length ? `💤 Jeszcze nie zaatakowali: ${nobody.join(", ")}` : "",
          partial.length ? `🔸 Mają jeszcze ataki: ${partial.join(", ")}` : ""
        ].filter(Boolean).join("\n"), WEBHOOK_RAJDY);
      }
    }
    if (r.state === "ended" && (Date.now() - parseT(r.end)) / 3600e3 < 24) {
      const medal = ["🥇", "🥈", "🥉"];
      const top = (r.members || []).slice(0, 3);
      const full = (r.members || []).filter(m => m.attacks >= m.limit).length;
      await once("summary", [
        `🏁 **Koniec weekendu rajdów na Stolicę!**`,
        `💰 Zdobyte złoto: **${fmt(r.loot)}** · ⚔️ ataki: **${r.attacks}** · 🏚️ zniszczone dzielnice: **${r.districts}** · ✅ ukończone rajdy: **${r.raids}**`,
        top.length ? `⭐ Najlepsi: ${top.map((m, i) => `${medal[i]} ${m.name} ${fmt(m.loot)}`).join("  ")}` : "",
        `👥 Wykorzystali wszystkie ataki: **${full}/${(r.members || []).length}** graczy`,
        partial.length ? `🔸 Niewykorzystane ataki: ${partial.join(", ")}` : "",
        nobody.length ? `💤 Nie zaatakowali wcale: ${nobody.join(", ")}` : "",
        `Dzięki za rajdy! ${SITE}`
      ].filter(Boolean).join("\n"));
    }
  }
}
const LIGA = n => !n ? "brak" : n.replace("Unranked", "Bez ligi").replace("Bronze", "Brąz").replace("Silver", "Srebro").replace("Gold", "Złoto")
  .replace("Crystal", "Kryształ").replace("Master", "Mistrz").replace("Champion", "Czempion").replace(" League", "");
/* ---------- Na żywo jak ClashPerk, tylko czytelniej ----------
   ataki wojenne, tablice (wojna, rajdy, Gry Klanowe, aktywność), donacje, osiągnięcia klanu, nicki */
let feed = old?.feed && typeof old.feed === "object" ? old.feed : {};
let boards = old?.boards && typeof old.boards === "object" ? old.boards : {};
const STAR = n => "★".repeat(n) + "☆".repeat(Math.max(0, 3 - n));
const PCT = p => String(Math.round((p ?? 0) * 10) / 10).replace(".", ",") + "%";
const TS = (t, f = "R") => `<t:${Math.floor((typeof t === "number" ? t : (parseT(t) || new Date(t))) / 1000)}:${f}>`;
// odliczanie: tekst "5 h 12 min" + pasek postępu (odświeżane przy każdym uruchomieniu robota)
const LICZ = (cel, total, kolor = "🟥") => {
  const ms = Math.max(0, cel - Date.now()), h = Math.floor(ms / 3600e3), m = Math.floor(ms % 3600e3 / 60e3);
  const txt = h >= 24 ? `${Math.floor(h / 24)} d ${h % 24} h` : h ? `${h} h ${String(m).padStart(2, "0")} min` : `${m} min`;
  const done = total ? Math.min(1, Math.max(0, 1 - ms / total)) : 0, n = 12, f = Math.round(done * n);
  return { txt, bar: kolor.repeat(f) + "⬛".repeat(n - f) + ` **${Math.round(done * 100)}%**` };
};
const hashOf = c => c.length + ":" + [...c].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7);
const fit = (lines, max = 1950) => { let out = lines.filter(x => x !== null && x !== undefined && x !== false).join("\n"); return out.length > max ? out.slice(0, max - 1) + "…" : out; };
const listFit = (arr, max = 700) => { let s = ""; for (let i = 0; i < arr.length; i++) { const nx = (s ? s + ", " : "") + arr[i]; if (nx.length > max) return s + ` …i ${arr.length - i} więcej`; s = nx; } return s; };
async function board(slot, url, content) {
  if (!url || !content) return;
  const hash = hashOf(content), b = boards[slot];
  try {
    if (b?.id) {
      if (b.hash === hash) return;
      const r = await fetch(`${url}/messages/${b.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, allowed_mentions: { parse: [] }, flags: 4 }) });
      if (r.ok) { b.hash = hash; b.t = nowIso; await new Promise(res => setTimeout(res, 700)); return; }
      if (r.status !== 404) { console.warn("Tablica", slot, r.status); return; }
    }
    const r = await fetch(`${url}?wait=true`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "Armia Maurycego", avatar_url: SITE + "icon-512.png", content, allowed_mentions: { parse: [] }, flags: 4 }) });
    if (r.ok) { const m = await r.json(); boards[slot] = { id: m.id, hash, t: nowIso }; } else console.warn("Tablica", slot, r.status, await r.text());
    await new Promise(res => setTimeout(res, 1200));
  } catch (e) { console.warn("Tablica niedostępna:", e.message); }
}
const chunks = (head, lines, max = 1900) => { const out = []; let cur = head; for (const l of lines) { if ((cur + "\n" + l).length > max) { out.push(cur); cur = head + " (cd.)"; } cur += "\n" + l; } out.push(cur); return out; };

if (!firstRun) {
  // --- 1) Wojny: relacja atak po ataku + tablica wojny (#wojny-klanu) ---
  if (WEBHOOK_WOJNY && POSTY.atakiNaZywo !== false) {
    const lw = [];
    if (currentWar) lw.push({ ...currentWar, key: `w:${currentWar.start}`, label: "Wojna" });
    for (const cw of (cwl?.wars || [])) lw.push({ ...cw, key: `c:${cw.start}:${cw.them.name}`, label: `CWL · Runda ${cw.round}` });
    for (const w of lw) {
      if ((Date.now() - parseT(w.end)) / 3600e3 > 6) continue;
      const cwlW = w.label.startsWith("CWL");
      if (w.state === "preparation" && cwlW) continue;          // w CWL przygotowania nakładają się z bitwą poprzedniej rundy
      const per = w.perMember || (cwlW ? 1 : 2);
      // relacja: nowe ataki od ostatniego sprawdzenia (nasze 🗡️ i przeciwnika 🛡️)
      const all = [
        ...w.members.flatMap(m => m.attacks.map(a => ({ our: true, who: m.name, wpos: m.pos, ...a }))),
        ...(w.defs || []).map(a => ({ our: false, who: a.by, wpos: a.bpos, ...a }))
      ].filter(a => a.order != null).sort((a, b) => a.order - b.order);
      const best = {}, fresh = new Map();
      for (const a of all) { const k = (a.our ? "u" : "t") + a.tpos; const nw = Math.max(0, a.stars - (best[k] || 0)); best[k] = Math.max(best[k] || 0, a.stars); fresh.set(a, nw); }
      const maxOrder = all.length ? all[all.length - 1].order : 0;
      if (feed[w.key] === undefined)   // pierwszy raz widzimy tę wojnę: bez zaległości (chyba że bitwa dopiero ruszyła)
        feed[w.key] = (w.state === "preparation" || (w.state === "inWar" && (Date.now() - parseT(w.start)) / 3600e3 < 0.5)) ? 0 : maxOrder;
      const nowe = all.filter(a => a.order > feed[w.key]);
      if (nowe.length) {
        const head = `⚔️ **${w.label}** vs **${w.them.name}** · teraz **${w.us.stars} ★ ${w.them.stars}** · ${PCT(w.us.pct)} : ${PCT(w.them.pct)}`;
        const lines = nowe.map(a => {
          const f = fresh.get(a), plus = f > 0 ? ` · **+${f}★**` : " · +0★";
          return a.our
            ? `🗡️ \`${String(a.wpos).padStart(2)}\` **${a.who}** ➜ \`${String(a.tpos ?? "?").padStart(2)}\` ${a.tname} · ${STAR(a.stars)} ${PCT(a.pct)}${plus}${a.stars === 3 ? " 🔥" : ""}`
            : `🛡️ \`${String(a.wpos).padStart(2)}\` ${a.who} ➜ \`${String(a.tpos ?? "?").padStart(2)}\` **${a.tname}** · ${STAR(a.stars)} ${PCT(a.pct)}${plus}`;
        });
        for (const msg of chunks(head, lines)) await post(msg, WEBHOOK_WOJNY);
        feed[w.key] = maxOrder;
      }
      // tablica wojny (jedna wiadomość, aktualizowana)
      const win = w.us.stars > w.them.stars || (w.us.stars === w.them.stars && w.us.pct > w.them.pct);
      const draw = w.us.stars === w.them.stars && w.us.pct === w.them.pct;
      const tS = +parseT(w.start), tE = +parseT(w.end);
      const cP = LICZ(tS, 23 * 3600e3, "🟨"), cB = LICZ(tE, tE - tS, "🟥");
      const stan = w.state === "preparation" ? [`### 🛡️ Dzień przygotowań`, `⏳ Bitwa za **${cP.txt}** · start o **${TS(w.start, "t")}** (${TS(w.start)})`, cP.bar].join("\n")
        : w.state === "inWar" ? [`### ⚔️ Trwa bitwa`, `⏳ Koniec za **${cB.txt}** · o **${TS(w.end, "t")}** (${TS(w.end)})`, cB.bar].join("\n")
        : `### 🏁 Koniec wojny · ${win ? "🏆 WYGRANA" : draw ? "🤝 REMIS" : "❌ PRZEGRANA"}`;
      const open = (w.them.bases || []).filter(b => b.best < 3).map(b => b.pos);
      const thWroga = Object.fromEntries((w.them.bases || []).map(b => [b.pos, b.th]));
      const rows = w.members.map(m => {
        const left = Math.max(0, per - m.attacks.length);
        const ik = w.state === "preparation" ? "▫️" : left === 0 ? "✅" : m.attacks.length ? "🟡" : w.state === "warEnded" ? "❌" : "🔴";
        const tok = w.state === "preparation" ? "" : "  " + [...m.attacks.map(a => STAR(a.stars)), ...Array(left).fill(w.state === "warEnded" ? "✖" : "⏳")].join(" ");
        return { left, txt: `${ik} \`${String(m.pos).padStart(2, "0")}\` **${m.name}** · TH${m.th} ⚔️ TH${thWroga[m.pos] ?? "?"}${tok}` };
      });
      const zostalo = w.members.reduce((a, m) => a + Math.max(0, per - m.attacks.length), 0);
      const top = [
        `## 📋 ${w.label.toUpperCase()} · ${w.size} vs ${w.size}`,
        stan,
        ``,
        `**${w.us.name}**${w.us.level ? ` 🛡️${w.us.level}` : ""}  \` ${w.us.stars} ★ ${w.them.stars} \`  ${w.them.level ? `🛡️${w.them.level} ` : ""}**${w.them.name}**`,
        w.state !== "preparation" ? `💥 Zniszczenia: **${PCT(w.us.pct)}** : ${PCT(w.them.pct)}` : null,
        w.state !== "preparation" ? `⚔️ Ataki: **${w.us.attacks ?? 0}/${w.size * per}** : ${w.them.attacks ?? 0}/${w.size * per}${w.state === "inWar" && zostalo ? ` · zostało nam **${zostalo}**` : ""}` : null,
        w.state !== "preparation" ? (open.length ? `🎯 Bez 3★ u przeciwnika: ${open.join(", ")}` : `🎯 Wszystkie bazy przeciwnika zbite na 3★! 🔥`) : null,
        `━━━━━━━━━━━━━━━━━━`,
        `**Nasz skład** · nasz TH ⚔️ TH przeciwnika na tym samym numerze`
      ];
      const stopka = [`━━━━━━━━━━━━━━━━━━`, w.state === "inWar" ? `-# ✅ wszystkie ataki · 🟡 został 1 · 🔴 jeszcze nie atakował` : null, `-# 🔄 Aktualizuje się sama co kilka minut · ${SITE}#wojny`];
      let tresc = fit([...top, ...rows.map(r => r.txt), ...stopka], 4000);
      if (tresc.length > 1950) {   // duża wojna: pokaż tylko graczy z atakami do zrobienia
        const left = rows.filter(r => r.left > 0);
        tresc = fit([...top.slice(0, -1), `**Jeszcze atakują (${left.length}):**`, ...left.map(r => r.txt), ``, `✅ Pozostali (${rows.length - left.length}) zrobili już wszystkie ataki.`, ...stopka]);
      }
      if (w.state !== "warEnded" || boards[`war:${w.key}`]) await board(`war:${w.key}`, WEBHOOK_WOJNY, tresc);   // nie zakładamy tablicy dla wojny, która już się skończyła
    }
    for (const k of Object.keys(feed)) if (!lw.some(w => w.key === k)) delete feed[k];
  }

  // --- 2) Rajdy: tablica na żywo (#rajdy-stolica) ---
  const r0 = raids[0];
  if (WEBHOOK_RAJDY && POSTY.rajdy && r0 && (r0.state === "ongoing" || ((Date.now() - parseT(r0.end)) / 3600e3 < 24 && boards[`raid:${r0.start}`]))) {
    const fmt = n => Number(n || 0).toLocaleString("pl-PL");
    const inRaid = Object.fromEntries((r0.members || []).map(m => [m.tag, m]));
    const nobody = members.filter(m => !inRaid[m.tag]).map(m => m.name);
    const partial = (r0.members || []).filter(m => m.attacks < m.limit).map(m => `${m.name} (${m.attacks}/${m.limit})`);
    const md = ["🥇", "🥈", "🥉", "4.", "5."];
    await board(`raid:${r0.start}`, WEBHOOK_RAJDY, fit([
      `## 🏰 RAJDY NA STOLICĘ`,
      r0.state === "ongoing" ? (c => `⏳ Koniec za **${c.txt}** · ${TS(r0.end, "f")}\n${c.bar}`)(LICZ(+parseT(r0.end), 72 * 3600e3, "🟦")) : "### 🏁 Weekend zakończony",
      ``,
      `💰 Złoto: **${fmt(r0.loot)}** · ⚔️ Ataki: **${r0.attacks}** · 🏚️ Dzielnice: **${r0.districts}** · ✅ Rajdy: **${r0.raids}**`,
      `👥 Zaatakowało **${(r0.members || []).length}** z ${members.length} graczy`,
      ``,
      (r0.members || []).length ? `**Najlepsi:**\n` + (r0.members || []).slice(0, 5).map((m, i) => `${md[i]} ${m.name} · ${fmt(m.loot)} · ${m.attacks}/${m.limit}`).join("\n") : null,
      partial.length ? `\n🔸 **Mają jeszcze ataki:** ${listFit(partial)}` : null,
      nobody.length ? `💤 **${r0.state === "ongoing" ? "Jeszcze nie zaatakowali" : "Nie zaatakowali"}:** ${listFit(nobody)}` : null,
      ``,
      `_Aktualizuje się sama co kilka minut_`
    ]));
  }

  // --- 3) Gry Klanowe: tablica na żywo (#statystyki-klanu) ---
  if (WEBHOOK && POSTY.gryKlanowe && clanGames && (clanGames.state === "ongoing" || (prevCgState === "ongoing" && boards[`cg:${clanGames.key}`]))) {
    const rows = Object.values(clanGames.points || {}).sort((a, b) => b.pts - a.pts);
    const sum = rows.reduce((a, r) => a + r.pts, 0), done = rows.filter(r => r.pts >= 1000).length;
    const md = ["🥇", "🥈", "🥉"];
    const low = rows.filter(r => r.pts > 0 && r.pts < 1000).map(r => `${r.name} (${r.pts})`), zero = rows.filter(r => r.pts === 0).map(r => r.name);
    await board(`cg:${clanGames.key}`, WEBHOOK, fit([
      `## 🎯 GRY KLANOWE`,
      clanGames.state === "ongoing" ? (c => `⏳ Koniec za **${c.txt}** · ${TS(Date.parse(clanGames.end), "f")}\n${c.bar}`)(LICZ(Date.parse(clanGames.end), 6 * 864e5, "🟩")) : "### 🏁 Gry zakończone",
      ``,
      `Razem: **${nf(sum)} pkt** · normę 1000 pkt ma **${done}/${rows.length}**`,
      ``,
      `**Top 10:**`,
      ...rows.slice(0, 10).map((r, i) => `${md[i] || `\`${String(i + 1).padStart(2)}\``} ${r.name} · ${nf(r.pts)}${r.pts >= 1000 ? " ✅" : ""}`),
      low.length ? `\n⏳ **Przed normą:** ${listFit(low)}` : null,
      zero.length ? `💤 **Jeszcze 0 pkt:** ${listFit(zero)}` : null,
      ``,
      `_Aktualizuje się sama co kilka minut_`
    ]));
  }

  // --- 4) Aktywność graczy (#statystyki-klanu) ---
  if (WEBHOOK && POSTY.aktywnosc !== false) {
    const L = members.map(m => ({ name: m.name, t: Date.parse(activity[m.tag]?.last || nowIso) })).sort((a, b) => b.t - a.t);
    const h = x => (Date.now() - x.t) / 3600e3;
    const g1 = L.filter(x => h(x) < 24), g2 = L.filter(x => h(x) >= 24 && h(x) < 72), g3 = L.filter(x => h(x) >= 72 && h(x) < 168), g4 = L.filter(x => h(x) >= 168);
    const withT = arr => listFit(arr.map(x => `${x.name} ${TS(x.t)}`), 900);
    await board("aktywnosc", WEBHOOK, fit([
      `👀 **AKTYWNOŚĆ GRACZY** · ${members.length}/50`,
      ``,
      `🟢 **Ostatnie 24 h** (${g1.length}): ${listFit(g1.map(x => x.name), 900) || "—"}`,
      g2.length ? `🟡 **1–3 dni** (${g2.length}): ${withT(g2)}` : null,
      g3.length ? `🟠 **3–7 dni** (${g3.length}): ${withT(g3)}` : null,
      g4.length ? `🔴 **Ponad 7 dni** (${g4.length}): ${withT(g4)}` : `🔴 **Ponad 7 dni:** nikt 💪`,
      ``,
      `_Aktywność = robot widzi, że gracz coś zrobił w grze (donacje, ataki, Gry, Stolica). Aktualizuje się sama._`
    ]));
  }

  // --- 5) Donacje: tydzień (w poniedziałek) i miesiąc (#statystyki-klanu) ---
  const md5 = ["🥇", "🥈", "🥉", "4.", "5."];
  if (WEBHOOK && POSTY.donacje !== false && donWeek && donWeek.list.length) {
    const L = donWeek.list, sum = L.reduce((a, x) => a + x.d, 0), zero = L.filter(x => x.d === 0).length;
    const od = new Date(donWeek.week + "T12:00:00Z"), doD = new Date(+od + 6 * 864e5);
    const dz = d => `${d.getUTCDate()} ${MIES_D[d.getUTCMonth()].slice(0, 3)}`;
    await post(fit([
      `🎁 **DONACJE TYGODNIA** · ${dz(od)} – ${dz(doD)}`,
      `Razem oddaliśmy **${nf(sum)}** wojsk 💪`,
      ``,
      ...L.filter(x => x.d > 0).slice(0, 5).map((x, i) => `${md5[i]} ${x.name} · **${nf(x.d)}**`),
      zero ? `\n💤 Bez donacji w tym tygodniu: **${zero}** ${plural(zero, "gracz", "graczy", "graczy")}` : `\n✅ Każdy coś oddał!`
    ]), WEBHOOK);
  }
  if (WEBHOOK && POSTY.donacje !== false && old?.monthBase?.month && old.monthBase.month !== monthBase.month) {
    const L = members.map(m => { const b = old.monthBase.players?.[m.tag]?.don, c = m.ach?.don; return { name: m.name, d: (b != null && c != null) ? Math.max(0, c - b) : 0 }; }).sort((a, b) => b.d - a.d);
    const sum = L.reduce((a, x) => a + x.d, 0);
    if (sum > 0) await post(fit([
      `🎁 **DONACJE MIESIĄCA** · ${MIES[Number(old.monthBase.month.slice(5, 7)) - 1]}`,
      `Razem oddaliśmy **${nf(sum)}** wojsk`,
      ``,
      ...L.filter(x => x.d > 0).slice(0, 5).map((x, i) => `${md5[i]} ${x.name} · **${nf(x.d)}**`)
    ]), WEBHOOK);
  }

  // --- 6) Osiągnięcia i statystyki klanu (#statystyki-klanu) — karty jak w ClashPerk, tylko po polsku ---
  if (WEBHOOK_STATY && POSTY.osiagniecia !== false && old) {
    const TIER = ["Unranked", "Bronze", "Silver", "Gold", "Crystal", "Master", "Champion"];
    const rank = n => { if (!n) return -1; const t = TIER.findIndex(x => n.startsWith(x)); const r = { I: 3, II: 2, III: 1 }[(n.split(" ").pop() || "")] || 0; return t * 10 + r; };
    const herb = clan.badgeUrls?.large || clan.badgeUrls?.medium || (SITE + "icon-512.png");
    const karta = (opis, kolor, stopka) => postEmbed({
      author: { name: `${clan.name} (${TAG})`, icon_url: clan.badgeUrls?.small || undefined, url: SITE },
      description: opis, color: kolor, thumbnail: { url: herb },
      footer: stopka ? { text: stopka } : undefined, timestamp: new Date().toISOString()
    }, WEBHOOK_STATY);
    const ZIEL = 0x57c84d, CZER = 0xe5484d, ZLOTO = 0xf5b72a, NIEB = 0x29c4e6;
    if (process.env.DISCORD_WEBHOOK_STATYSTYKI && !oneShots.includes("staty-start-v1")) {   // jednorazowa karta na start kanału
      const ok = await karta(`## 📊 Statystyki klanu\n> 🛡️ Poziom klanu: **${clan.clanLevel}**\n> ⚔️ Liga CWL: **${LIGA(clan.warLeague?.name)}**\n> 🏰 Liga Stolicy: **${LIGA(clan.capitalLeague?.name)}**\n> 🏆 Wygrane wojny: **${clan.warWins ?? "?"}**\n> 👥 Gracze: **${members.length}/50**\n\nTutaj bot będzie wrzucał awanse klanu, ligi i serie zwycięstw.`, NIEB);
      if (ok) oneShots.push("staty-start-v1");
    }
    if (old.clanLevel != null && clan.clanLevel > old.clanLevel)
      await karta(`## 🛡️ Awans klanu!\nKlan wbił **poziom ${clan.clanLevel}**.\nDzięki za każdą wojnę, Grę Klanową i rajd — lecimy dalej! 🔥`, NIEB, `Poziom ${old.clanLevel} ➜ ${clan.clanLevel}`);
    const nowCwl = clan.warLeague?.name ?? null;
    if (old.cwlLeague && nowCwl && old.cwlLeague !== nowCwl) {
      const up = rank(nowCwl) > rank(old.cwlLeague);
      await karta(up ? `## 🏆 Awans w Lidze Wojen Klanów!\nWchodzimy do **${LIGA(nowCwl)}**. Brawo wszyscy! ⚔️`
                     : `## 📉 Spadek w Lidze Wojen Klanów\nW następnym sezonie gramy w **${LIGA(nowCwl)}**. Odbijemy się! 💪`, up ? ZIEL : CZER, `${LIGA(old.cwlLeague)} ➜ ${LIGA(nowCwl)}`);
    }
    const nowCap = clan.capitalLeague?.name ?? null;
    if (old.capitalLeague && nowCap && old.capitalLeague !== nowCap) {
      const up = rank(nowCap) > rank(old.capitalLeague);
      await karta(up ? `## 🏰 Awans Stolicy Klanu!\nLiga Stolicy: **${LIGA(nowCap)}**. Dzięki za rajdy! 💰`
                     : `## 🏰 Spadek Stolicy Klanu\nLiga Stolicy: **${LIGA(nowCap)}**. W ten weekend odrabiamy! 💪`, up ? ZIEL : CZER, `${LIGA(old.capitalLeague)} ➜ ${LIGA(nowCap)}`);
    }
    const ws = clan.warWinStreak ?? 0;
    if (old.warWinStreak != null && ws > old.warWinStreak && ws >= 3)
      await karta(`## 🔥 Seria zwycięstw!\n**${ws} ${plural(ws, "wygrana wojna", "wygrane wojny", "wygranych wojen")} z rzędu.** Nie zwalniamy! ⚔️`, ZLOTO);
    const ww = clan.warWins ?? null;
    if (old.warWins != null && ww != null && Math.floor(ww / 10) > Math.floor(old.warWins / 10))
      await karta(`## 🏅 ${Math.floor(ww / 10) * 10} wygranych wojen!\nKolejna dziesiątka na koncie klanu 💪`, ZLOTO, `Wygrane wojny: ${ww}`);
    const pts = clan.clanPoints ?? null;
    if (old.clanPoints != null && pts != null && Math.floor(pts / 5000) > Math.floor(old.clanPoints / 5000))
      await karta(`## 🏆 ${nf(Math.floor(pts / 5000) * 5000)} pucharów klanu!\nRazem pchamy klan w górę rankingu 📈`, ZLOTO, `Punkty klanu: ${nf(pts)}`);
    const ile = members.length;
    if (old.memberCount != null && ile >= 50 && old.memberCount < 50)
      await karta(`## 👥 Klan pełny — 50/50!\nWszystkie miejsca zajęte. Witamy nowych! 🛡️`, NIEB);
  }

  // --- 6b) Wpłaty Złota Stolicy (#rajdy-stolica, inaczej #statystyki-klanu) — karta na każdą wpłatę ---
  const WEBHOOK_ZLOTO = WEBHOOK_RAJDY || WEBHOOK_STATY;
  if (WEBHOOK_ZLOTO && POSTY.zlotoStolicy !== false && Array.isArray(old?.members)) {
    const przed = Object.fromEntries(old.members.map(m => [m.tag, m.profile?.capital]));
    const wplaty = members.map(m => ({ m, d: (m.profile?.capital ?? 0) - (przed[m.tag] ?? m.profile?.capital ?? 0) })).filter(x => x.d > 0).sort((a, b) => b.d - a.d);
    if (wplaty.length > 6) {   // dużo naraz (np. po przerwie) — jedna zbiorcza karta zamiast spamu
      await postEmbed({ author: { name: `${clan.name} (${TAG})`, icon_url: clan.badgeUrls?.small || undefined },
        title: "🪙 Wpłaty Złota Stolicy", color: 0xf5b72a, timestamp: new Date().toISOString(),
        description: wplaty.slice(0, 25).map(x => `**${x.m.name}** · ${nf(x.d)}`).join("\n") + `\n\nRazem: **${nf(wplaty.reduce((a, x) => a + x.d, 0))}**` }, WEBHOOK_ZLOTO);
    } else for (const { m, d } of wplaty) {
      await postEmbed({ title: `${m.name} (${m.tag})`, url: SITE + "#gracz-" + m.tag.replace("#", ""),
        description: `🪙 Wpłacił(a) **${nf(d)}** Złota Stolicy`, color: 0x57c84d,
        footer: { text: clan.name, icon_url: clan.badgeUrls?.small || undefined }, timestamp: new Date().toISOString() }, WEBHOOK_ZLOTO);
    }
  }

  // --- 6c) Ruchy graczy jak w ClashPerk: liga, Baza Budowniczego, Liga Legend, Gry Klanowe, nieaktywność ---
  if (Array.isArray(old?.members) && POSTY.ruchyGraczy !== false) {
    const byTag = Object.fromEntries(old.members.map(m => [m.tag, m]));
    const kartaGracza = (m, opis, kolor, url) => postEmbed({ title: `${m.name} (${m.tag})`, url: SITE + "#gracz-" + m.tag.replace("#", ""),
      description: opis, color: kolor, footer: { text: clan.name, icon_url: clan.badgeUrls?.small || undefined }, timestamp: new Date().toISOString() }, url);
    for (const m of members) {
      const o = byTag[m.tag]; if (!o?.profile || !m.profile) continue;
      const P = m.profile, OP = o.profile;
      // 1) awans w lidze (tylko w górę, żeby nie spamować spadkami po obronach)
      if (WEBHOOK_RUCHY && P.leagueId && OP.leagueId && P.leagueId > OP.leagueId && P.league && P.league !== OP.league)
        await kartaGracza(m, `🏆 Awans do ligi **${LIGA(P.league)}**\n-# ${LIGA(OP.league)} ➜ ${LIGA(P.league)} · ${nf(P.trophies)} 🏆`, 0x57c84d, WEBHOOK_RUCHY);
      // 3) Baza Budowniczego
      if (WEBHOOK_RUCHY && P.bh && OP.bh && P.bh > OP.bh)
        await kartaGracza(m, `🔨 Ulepszył(a) Bazę Budowniczego na **BH${P.bh}**`, 0x29c4e6, WEBHOOK_RUCHY);
      // 4) Liga Legend: każda zmiana pucharów = atak albo obrona
      const legenda = /legend/i.test(P.league || "") && /legend/i.test(OP.league || "");
      if (WEBHOOK_STATY && legenda && P.trophies != null && OP.trophies != null && P.trophies !== OP.trophies) {
        const d = P.trophies - OP.trophies, plus = d > 0;
        await kartaGracza(m, `${plus ? "⚔️ Atak" : "🛡️ Obrona"} w Lidze Legend: **${plus ? "+" : ""}${d}** 🏆\n-# Teraz: **${nf(P.trophies)}** 🏆`, plus ? 0x57c84d : 0xe5484d, WEBHOOK_STATY);
      }
    }
    // 6) Gry Klanowe: kto zrobił normę (1000) i maksimum (4000)
    if (WEBHOOK_STATY && clanGames?.state === "ongoing" && old?.clanGames?.key === clanGames.key) {
      for (const [tag, p2] of Object.entries(clanGames.points || {})) {
        const by = old.clanGames.points?.[tag]?.pts ?? 0, teraz = p2.pts ?? 0, m = members.find(x => x.tag === tag); if (!m) continue;
        if (by < 4000 && teraz >= 4000) await kartaGracza(m, `🎯 **Maksimum w Grach Klanowych!** 4000 pkt 🔥`, 0xf5b72a, WEBHOOK_STATY);
        else if (by < 1000 && teraz >= 1000) await kartaGracza(m, `🎯 Zrobił(a) normę w Grach Klanowych: **${nf(teraz)} pkt** ✅`, 0x57c84d, WEBHOOK_STATY);
      }
    }
  }
  // 7) nieaktywność: ostrzeżenie po 5 dniach, informacja po 7 dniach (zasada: 7 dni AFK = kick)
  const WEBHOOK_AFK = WEBHOOK_KARY || WEBHOOK_RUCHY;
  if (WEBHOOK_AFK && POSTY.afk !== false) {
    const ZW = new Set(karyZw || []), pierwszy = old && old.afkWarned === undefined, lista = [];
    for (const m of members) {
      const a = activity[m.tag]; if (!a?.last || !a?.since) continue;
      const dni = (Date.now() - Date.parse(a.last)) / 864e5, sledzony = (Date.now() - Date.parse(a.since)) / 864e5;
      if (sledzony < 5 || ZW.has(m.tag) || m.role === "leader") continue;
      const w = afkWarned[m.tag] || {};
      if (w.last && w.last !== a.last) { delete afkWarned[m.tag]; continue; }     // wrócił do gry
      if (pierwszy) { if (dni >= 5) { lista.push(`**${m.name}** (TH${m.th}) · ${Math.floor(dni)} dni`); afkWarned[m.tag] = { last: a.last, d5: true, d7: dni >= 7 }; } continue; }
      if (dni >= 7 && !w.d7) { await post(`💤 **${m.name}** (TH${m.th}) jest nieaktywny/a od **${Math.floor(dni)} dni** — zgodnie z zasadą 7 dni AFK do decyzji zarządu.`, WEBHOOK_AFK); afkWarned[m.tag] = { ...w, last: a.last, d5: true, d7: true }; }
      else if (dni >= 5 && !w.d5) { await post(`⏰ **${m.name}** (TH${m.th}) nie był/a aktywny/a od **${Math.floor(dni)} dni**. Za 2 dni minie limit 7 dni AFK.`, WEBHOOK_AFK); afkWarned[m.tag] = { ...w, last: a.last, d5: true }; }
    }
    if (pierwszy && lista.length) await post(`💤 **Nieaktywni od 5+ dni** (zasada: 7 dni AFK = kick):\n${lista.map(x => `> ${x}`).join("\n")}`, WEBHOOK_AFK);
    for (const t of Object.keys(afkWarned)) if (!members.some(m => m.tag === t)) delete afkWarned[t];
  }

  // --- 7) Nicki, ranga w dół, udział w wojnach (#ruchy-w-klanie) ---
  if (WEBHOOK_RUCHY && Array.isArray(old?.members)) {
    const RNd = { leader: "Wodza", coLeader: "Współlidera", admin: "Starszego", member: "Członka" };
    const byTag = Object.fromEntries(old.members.map(m => [m.tag, m]));
    for (const m of members) {
      const o = byTag[m.tag]; if (!o) continue;
      if (o.name && o.name !== m.name) await post(`✏️ **${o.name}** zmienił(a) nick na **${m.name}**`, WEBHOOK_RUCHY);
      const RANK = { member: 0, admin: 1, coLeader: 2, leader: 3 };
      if (o.role && m.role && RANK[m.role] < RANK[o.role]) await post(`⬇️ **${m.name}** ma teraz rangę ${RNd[m.role] || m.role}`, WEBHOOK_RUCHY);
      const a = o.profile?.warPref, b = m.profile?.warPref;
      if (a && b && a !== b) await post(b === "in" ? `🟢 **${m.name}** zapisał(a) się do wojen ⚔️` : `🔴 **${m.name}** wypisał(a) się z wojen`, WEBHOOK_RUCHY);
    }
  }
}
// sprzątanie starych tablic (po 10 dniach)
boards = Object.fromEntries(Object.entries(boards).filter(([k, v]) => k === "aktywnosc" || Date.now() - Date.parse(v.t || 0) < 10 * 864e5));

/* ---------- Rekrutacja i wymagania ---------- */
let rekrutacjaWeek = old?.rekrutacjaWeek || null;
let wymaganiaMsg = old?.wymaganiaMsg || null;
if (!firstRun && clan) {
  const ile = clan.members ?? members.length, wolne = Math.max(0, 50 - ile);
  // 1) #rekrutacja — raz w tygodniu (sobota od 12:00), tylko gdy są wolne miejsca
  const now = new Date(), wk = (() => { const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())); const day = d.getUTCDay() || 7; d.setUTCDate(d.getUTCDate() + 4 - day); const y = new Date(Date.UTC(d.getUTCFullYear(), 0, 1)); return d.getUTCFullYear() + "-" + Math.ceil(((d - y) / 864e5 + 1) / 7); })();
  const czas = !rekrutacjaWeek || (now.getUTCDay() === 6 && now.getUTCHours() >= 11 && rekrutacjaWeek !== wk);
  if (WEBHOOK_REKRUTACJA && POSTY.rekrutacja && wolne > 0 && czas) {
    const ok = await post([
      `# 📣 ARMIA MAURYCEGO REKRUTUJE!`,
      `-# Polski klan Clash of Clans · klan otwarty, wchodzisz od razu`,
      ``,
      `> 👥 Wolne miejsca: **${wolne}** (w klanie ${ile}/50)`,
      `> ✅ Przyjmujemy od **TH8**, początkujący mile widziani`,
      `> 🏰 Poziom klanu **${clan.clanLevel}** · ⚔️ CWL **${LIGA(clan.warLeague?.name)}** · 🏛️ Stolica **${LIGA(clan.capitalLeague?.name)}**`,
      clan.warWins != null ? `> 🏆 Wygrane wojny: **${clan.warWins}**${(clan.warWinStreak ?? 0) > 1 ? ` · seria **${clan.warWinStreak}** z rzędu 🔥` : ""}` : null,
      ``,
      `## 🎁 Co dajemy`,
      `> ⚔️ Wojny i CWL non-stop`,
      `> 🎁 Bogate donacje i pomoc nowym graczom`,
      `> ⬆️ Awanse za aktywność, Wojownik Tygodnia i MVP miesiąca`,
      `> 🤖 Robot z wojną na żywo i przypomnieniami o ataku`,
      `> 💬 Zgrany Discord`,
      ``,
      `**Tag klanu:** \`${TAG}\``,
      `🌐 ${SITE}`,
      `-# Znasz kogoś, kto szuka klanu? Podeślij mu tę wiadomość! 💪`
    ].filter(x => x !== null).join("\n"), WEBHOOK_REKRUTACJA, false, true);
    if (ok) rekrutacjaWeek = wk;
  }
  // 2) #wymagania-klanu — jedna wiadomość, którą robot edytuje, gdy coś się zmieni
  if (WEBHOOK_WYMAGANIA && POSTY.wymagania) {
    const cw = currentWar, lastCwl = cwl?.place ? cwl : null;
    const medal = p => p === 1 ? " 🥇" : p === 2 ? " 🥈" : p === 3 ? " 🥉" : "";
    const teraz = !cw ? "brak wojny, czekamy na kolejną"
      : cw.state === "preparation" ? `dzień przygotowań z **${cw.them.name}** · bitwa ${TS(cw.start)}`
      : cw.state === "inWar" ? `wojna z **${cw.them.name}** · **${cw.us.stars} ★ ${cw.them.stars}** · koniec ${TS(cw.end)}`
      : `ostatnia wojna z **${cw.them.name}**: ${cw.us.stars} ★ ${cw.them.stars}`;
    const avgTh = Math.round(members.reduce((a, m) => a + m.th, 0) / (members.length || 1) * 10) / 10;
    const tresc = [
      `## 📊 ARMIA MAURYCEGO · NA ŻYWO`,
      `-# Ta wiadomość aktualizuje się sama co kilka minut`,
      ``,
      `> 🏰 Poziom klanu: **${clan.clanLevel}**`,
      `> 👥 Gracze: **${ile}/50** · ${wolne > 0 ? `wolne miejsca: **${wolne}** ✅` : "klan pełny 🔒"}`,
      `> 📈 Średni ratusz: **TH${String(avgTh).replace(".", ",")}**`,
      `> ⚔️ Liga CWL: **${LIGA(clan.warLeague?.name)}**${lastCwl ? ` · ostatni sezon: **${lastCwl.place}. miejsce**${medal(lastCwl.place)}` : ""}`,
      `> 🏛️ Liga Stolicy: **${LIGA(clan.capitalLeague?.name)}**`,
      clan.warWins != null ? `> 🏆 Wygrane wojny: **${clan.warWins}**${(clan.warWinStreak ?? 0) > 1 ? ` · seria **${clan.warWinStreak}** 🔥` : ""}` : null,
      `> 🔥 Teraz: ${teraz}`,
      ``,
      `-# 🏷️ Tag **${TAG}** · 🌐 ${SITE}`
    ].filter(x => x !== null).join("\n");
    const hash = tresc.length + ":" + [...tresc].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
    try {
      let done = false;
      if (wymaganiaMsg?.id) {
        if (wymaganiaMsg.hash === hash) done = true;
        else {
          const r = await fetch(`${WEBHOOK_WYMAGANIA}/messages/${wymaganiaMsg.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: tresc, allowed_mentions: { parse: [] }, flags: 4 }) });
          if (r.ok) { wymaganiaMsg.hash = hash; done = true; } else if (r.status !== 404) { console.warn("Wymagania (edycja):", r.status); done = true; }
        }
      }
      if (!done) {
        const r = await fetch(`${WEBHOOK_WYMAGANIA}?wait=true`, { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: "Armia Maurycego", avatar_url: SITE + "icon-512.png", content: tresc, allowed_mentions: { parse: [] }, flags: 4 }) });
        if (r.ok) { const m = await r.json(); wymaganiaMsg = { id: m.id, hash }; } else console.warn("Wymagania:", r.status, await r.text());
      }
    } catch (e) { console.warn("Wymagania niedostępne:", e.message); }
  }
}

/* ---------- Prywatne przypomnienia na Discordzie (DM) ----------
   Gracze łączą Discorda w „Moim panelu” na stronie. Robot pobiera listę z serwera logowania
   i 4 h / 1 h przed końcem wojny pisze prywatnie do tych, którzy mają jeszcze ataki.
   Sekrety w GitHubie: DISCORD_BOT_TOKEN, ROBOT_KEY. */
const BOT = process.env.DISCORD_BOT_TOKEN, ROBOT_KEY = process.env.ROBOT_KEY;
const LOGIN_API = "https://armia-login.fifacz39.workers.dev";
let srv = null;
if (ROBOT_KEY) {
  try { const r = await fetch(LOGIN_API + "/robot", { headers: { "X-Robot-Key": ROBOT_KEY } }); if (r.ok) srv = await r.json(); else console.warn("Serwer logowania:", r.status); }
  catch (e) { console.warn("Serwer logowania niedostępny:", e.message); }
}
async function dm(userId, content) {
  try {
    const h = { Authorization: `Bot ${BOT}`, "Content-Type": "application/json" };
    const ch = await (await fetch("https://discord.com/api/v10/users/@me/channels", { method: "POST", headers: h, body: JSON.stringify({ recipient_id: userId }) })).json();
    if (!ch.id) { console.warn("DM: brak kanału", JSON.stringify(ch).slice(0, 120)); return false; }
    const r = await fetch(`https://discord.com/api/v10/channels/${ch.id}/messages`, { method: "POST", headers: h, body: JSON.stringify({ content, allowed_mentions: { parse: [] }, flags: 4 }) });
    if (!r.ok) console.warn("DM:", r.status, (await r.text()).slice(0, 120));
    await new Promise(res => setTimeout(res, 700));
    return r.ok;
  } catch (e) { console.warn("DM niedostępny:", e.message); return false; }
}
if (BOT && srv && srv.discord && !firstRun) {
  const ids = srv.discord;
  const wars = [];
  if (currentWar) wars.push({ ...currentWar, key: `w:${currentWar.start}`, label: "Wojna" });
  for (const cw of (cwl?.wars || [])) wars.push({ ...cw, key: `c:${cw.start}:${cw.them.name}`, label: `CWL · Runda ${cw.round}` });
  for (const w of wars) {
    if (w.state !== "inWar") continue;
    const left = (parseT(w.end) - Date.now()) / 3600e3;
    const hit = [1, 4].find(h => left <= h && left > 0); if (!hit) continue;
    const sent = notified["dm:" + w.key] || (notified["dm:" + w.key] = []);
    for (const m of w.members) {
      const uid = ids[m.tag]; const leftAtt = w.perMember - m.attacks.length;
      if (!uid || leftAtt <= 0 || sent.includes(`${m.tag}:${hit}`)) continue;
      for (const h of [4, 1]) if (h >= hit) sent.push(`${m.tag}:${h}`);
      const base = (w.them.bases || []).find(b => b.pos === m.pos);
      await dm(uid, `⏰ Hej **${m.name}**! ${w.label} vs **${w.them.name}** kończy się za ok. **${Math.max(1, Math.round(left))} h**, a masz jeszcze **${leftAtt} ${leftAtt > 1 ? "ataki" : "atak"}**.` +
        (m.pos && m.attacks.length === 0 ? `\nTwój numer: **${m.pos}**${base ? ` (TH${base.th}${base.best ? `, ma już ${base.best}★` : ""})` : ""}.` : "") +
        `\nWynik teraz: ${w.us.stars} ★ ${w.them.stars} · ${SITE}#wojny`);
    }
  }
}
/* ---------- Rangi i nicki na Discordzie (zamiast ClashPerka) ----------
   Kto połączył Discorda w „Moim panelu” na stronie (logowanie tokenem z gry = konto na pewno jego),
   dostaje rolę według rangi w klanie (Leader / Co-Leader / Elder / Member) i nick z gry.
   Kto wyjdzie z klanu, traci role klanowe. Dotyczy tylko osób połączonych przez stronę. */
let rangiLog = [];
if (BOT && srv && srv.discord && !firstRun && POSTY.rangiDiscord !== false) {
  const DAPI = "https://discord.com/api/v10", H = { Authorization: `Bot ${BOT}`, "Content-Type": "application/json", "X-Audit-Log-Reason": "Ranga z klanu (robot)" };
  const call = async (path, opt = {}) => {
    for (let i = 0; i < 4; i++) {
      const r = await fetch(DAPI + path, { ...opt, headers: H });
      if (r.status === 429) { const j = await r.json().catch(() => ({})); await new Promise(res => setTimeout(res, (j.retry_after || 1) * 1000 + 200)); continue; }
      return r;
    }
    return { ok: false, status: 429, json: async () => ({}), text: async () => "" };
  };
  try {
    const gs = await (await call("/users/@me/guilds")).json();
    const g = Array.isArray(gs) && (gs.find(x => /armia/i.test(x.name)) || gs[0]);
    if (g) {
      const guild = await (await call(`/guilds/${g.id}`)).json();
      const roles = guild.roles || [];
      const nrm = x => (x || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/ł/g, "l").replace(/[^a-z -]+/g, "").trim();
      const find = (...k) => roles.find(r => !r.managed && k.includes(nrm(r.name)));
      const RR = { leader: find("leader", "lider", "wodz"), coLeader: find("co-leader", "co leader", "wspollider"), admin: find("elder", "starszy"), member: find("member", "czlonek") };
      const klanowe = Object.values(RR).filter(Boolean).map(r => r.id);
      const GOSC = find("guest", "gosc");   // połączony, ale konto spoza klanu
      // jednorazowo: rejestracja komend /link i /unlink na serwerze
      if (!oneShots.includes("cmds-v1")) {
        const app = await (await call("/oauth2/applications/@me")).json();
        const cmds = [
          { name: "link", description: "Połącz Discorda z kontem w Clash of Clans i dostań rangę z klanu", dm_permission: false, options: [
            { type: 3, name: "tag", description: "Tag gracza, np. #ABC123 (profil w grze, pod nickiem)", required: true },
            { type: 3, name: "token", description: "Token API z gry (Ustawienia → Więcej ustawień). Potwierdza konto i daje pełną rangę", required: false },
            { type: 6, name: "uzytkownik", description: "(Zarząd) połącz za kogoś innego", required: false } ] },
          { name: "unlink", description: "Odłącz swoje konta z gry od Discorda", dm_permission: false, options: [
            { type: 6, name: "uzytkownik", description: "(Zarząd) odłącz kogoś innego", required: false } ] }
        ];
        const x = app.id ? await call(`/applications/${app.id}/guilds/${g.id}/commands`, { method: "PUT", body: JSON.stringify(cmds) }) : null;
        if (x?.ok) { oneShots.push("cmds-v1"); console.log("Komendy /link i /unlink zarejestrowane."); } else console.warn("Komendy:", x?.status, x && (await x.text()).slice(0, 200));
      }
      const slabe = new Set(srv.slabe || []);
      // role „z gry” (dawniej od ClashPerka): TH 12, BH 5, „Valkyrie League”, liga bazy budowniczego (Copper…), zakres trofeów
      const BLIGI = ["wood", "clay", "stone", "copper", "brass", "iron", "steel", "titanium", "platinum", "emerald", "ruby", "diamond"];
      const liczba = x => Number(String(x).replace(/[^\d]/g, ""));
      const LIGI = /^(skeleton|barbarian|archer|wizard|valkyrie|witch|golem|p\.?e\.?k\.?k\.?a|titan|dragon|electro|legend|unranked)( \d)?$/i;
      let bazyLig = new Set();
      // liga gracza: "Legend League 2" → "legend 2" (jeśli jest taka rola), inaczej "legend"; brak ligi → "unranked"
      const ligaGracza = p => {
        if (!p?.league || /^unranked/i.test(p.league)) return "unranked";
        const full = p.league.replace(/ League/i, "").trim().toLowerCase(), first = full.replace(/ \d+$/, "");
        return bazyLig.has(full) ? full : first;
      };
      const gra = [];
      for (const r of roles) {
        if (r.managed) continue;
        const n = r.name.replace(/[^\p{L}\p{N}.,+\-–— ]/gu, "").trim(); let x;
        if ((x = n.match(/^TH ?(\d{1,2})$/i))) gra.push({ id: r.id, name: r.name, test: (m, p) => m.th === +x[1] });
        else if ((x = n.match(/^BH ?(\d{1,2})$/i))) gra.push({ id: r.id, name: r.name, test: (m, p) => p?.bh === +x[1] });
        else if (/ League$/i.test(n) || LIGI.test(n)) { const base = n.replace(/ League$/i, "").toLowerCase(); gra.push({ id: r.id, name: r.name, liga: base, test: (m, p) => ligaGracza(p) === base }); }
        else if (BLIGI.includes(n.toLowerCase())) { const base = n.toLowerCase(); gra.push({ id: r.id, name: r.name, test: (m, p) => !!p?.bLeague && p.bLeague.split(" ")[0].toLowerCase() === base }); }
        else if ((x = n.match(/^([\d.,\s]+?)\s*[–—-]\s*([\d.,\s]+)$/))) { const lo = liczba(x[1]), hi = liczba(x[2]); gra.push({ id: r.id, name: r.name, test: (m, p) => (p?.trophies ?? -1) >= lo && (p?.trophies ?? -1) <= hi }); }
        else if ((x = n.match(/^([\d.,\s]+)\+$/))) { const lo = liczba(x[1]); gra.push({ id: r.id, name: r.name, test: (m, p) => (p?.trophies ?? -1) >= lo }); }
      }
      bazyLig = new Set(gra.filter(x => x.liga).map(x => x.liga));   // połączone samym tagiem (bez tokenu) – maksymalnie Elder
      const RANK = { member: 0, admin: 1, coLeader: 2, leader: 3 };
      // jeden Discord może mieć kilka kont w klanie: bierzemy najwyższą rangę, nick z najwyższego TH
      const byUser = {};
      for (const [tag, uid] of Object.entries(srv.discord)) {
        const m = members.find(x => x.tag === tag);
        (byUser[uid] ||= []).push(m && slabe.has(tag) && RANK[m.role] > 1 ? { ...m, role: "admin" } : m);
      }
      for (const [uid, accs] of Object.entries(byUser)) {
        const inClan = accs.filter(Boolean);
        const r = await call(`/guilds/${g.id}/members/${uid}`);
        if (!r.ok) continue;                       // nie ma go na serwerze
        const mem = await r.json(), has = new Set(mem.roles || []);
        const top = inClan.sort((a, b) => RANK[b.role] - RANK[a.role] || b.th - a.th)[0];
        const want = top ? (RR[top.role] || RR.member)?.id : null;
        const name = mem.user?.username || uid;
        for (const rid of klanowe) {
          if (rid === want && !has.has(rid)) {
            const x = await call(`/guilds/${g.id}/members/${uid}/roles/${rid}`, { method: "PUT" });
            if (x.ok) rangiLog.push(`+ ${name}: ${roles.find(q => q.id === rid).name}`); else console.warn("Ranga +", name, x.status);
          } else if (rid !== want && has.has(rid)) {
            const x = await call(`/guilds/${g.id}/members/${uid}/roles/${rid}`, { method: "DELETE" });
            if (x.ok) rangiLog.push(`- ${name}: ${roles.find(q => q.id === rid).name}`); else console.warn("Ranga -", name, x.status);
          }
        }
        // Guest: połączył konto, ale żadnego nie ma w klanie
        if (GOSC) {
          if (!top && !has.has(GOSC.id)) { const x = await call(`/guilds/${g.id}/members/${uid}/roles/${GOSC.id}`, { method: "PUT" }); if (x.ok) rangiLog.push(`+ ${name}: ${GOSC.name}`); }
          else if (top && has.has(GOSC.id)) { const x = await call(`/guilds/${g.id}/members/${uid}/roles/${GOSC.id}`, { method: "DELETE" }); if (x.ok) rangiLog.push(`- ${name}: ${GOSC.name}`); }
        }
        // role z gry – według głównego konta (najwyższy ratusz)
        const main = [...inClan].sort((a, b) => b.th - a.th)[0];
        for (const gr of gra) {
          const chce = !!main && gr.test(main, main.profile);
          if (chce && !has.has(gr.id)) { const x = await call(`/guilds/${g.id}/members/${uid}/roles/${gr.id}`, { method: "PUT" }); if (x.ok) rangiLog.push(`+ ${name}: ${gr.name}`); }
          else if (!chce && has.has(gr.id)) { const x = await call(`/guilds/${g.id}/members/${uid}/roles/${gr.id}`, { method: "DELETE" }); if (x.ok) rangiLog.push(`- ${name}: ${gr.name}`); }
        }
        // nick z gry (właścicielowi serwera Discord nie pozwala zmienić nicku)
        const glowne = inClan.sort((a, b) => b.th - a.th)[0], nick = glowne ? `${glowne.name} ${glowne.th}` : null;   // jak dawniej: "Nazwa 12"
        if (nick && uid !== guild.owner_id && (mem.nick || mem.user?.global_name || mem.user?.username) !== nick) {
          const x = await call(`/guilds/${g.id}/members/${uid}`, { method: "PATCH", body: JSON.stringify({ nick: nick.slice(0, 32) }) });
          if (x.ok) rangiLog.push(`✏️ ${name} → ${nick}`);
        }
      }
      if (rangiLog.length) console.log("Rangi Discord:\n" + rangiLog.join("\n"));
    }
  } catch (e) { console.warn("Rangi Discord niedostępne:", e.message); }
}

/* ---------- Galeria: screeny z kanału #galeria na Discordzie trafiają na stronę ----------
   Robot czyta ostatnie wiadomości z kanału, którego nazwa zawiera „galeria”, pobiera obrazki do img/galeria/
   (linki z Discorda wygasają) i zapisuje listę w data.json -> galeria. Usunięta wiadomość = zdjęcie znika ze strony.
   Wymaga: w Discord Developer Portal → Bot włączonego „Message Content Intent”. */
let galeria = Array.isArray(old?.galeria) ? old.galeria : [];
if (BOT && POSTY.galeria !== false) {
  const DAPI = "https://discord.com/api/v10", H = { Authorization: `Bot ${BOT}` };
  const call = async path => {
    for (let i = 0; i < 4; i++) {
      const r = await fetch(DAPI + path, { headers: H });
      if (r.status === 429) { const j = await r.json().catch(() => ({})); await new Promise(res => setTimeout(res, (j.retry_after || 1) * 1000 + 200)); continue; }
      return r;
    }
    return { ok: false, status: 429, json: async () => ({}) };
  };
  try {
    await mkdir("img/galeria", { recursive: true });
    await writeFile("img/galeria/.gitkeep", "");
    const gs = await (await call("/users/@me/guilds")).json();
    const g = Array.isArray(gs) && (gs.find(x => /armia/i.test(x.name)) || gs[0]);
    const chans = g ? await (await call(`/guilds/${g.id}/channels`)).json() : [];
    const ch = Array.isArray(chans) && chans.find(c => (c.type === 0 || c.type === 5) && /galeri/i.test(c.name));
    if (!ch) console.log("Galeria: brak kanału #galeria na Discordzie.");
    else {
      const r = await call(`/channels/${ch.id}/messages?limit=100`);
      const msgs = r.ok ? await r.json() : [];
      if (!r.ok) console.warn("Galeria: brak dostępu do kanału", r.status);
      if (Array.isArray(msgs) && msgs.length && msgs.every(m => !m.content && !(m.attachments || []).length)) console.warn("Galeria: wiadomości są puste — włącz „Message Content Intent” w Discord Developer Portal → Bot.");
      const nazwa = {};   // id Discorda -> nick z gry
      for (const [tag, id] of Object.entries(srv?.discord || {})) { const m = members.find(x => x.tag === tag); if (m) nazwa[typeof id === "object" ? id.id : id] = m.name; }
      const czysc = t => (t || "").replace(/<[@#&!:a-z0-9_]+>/gi, "").replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim().slice(0, 160);
      const stare = new Map(galeria.map(x => [x.id, x]));
      const nowa = [];
      if (Array.isArray(msgs)) for (const m of msgs) {
        if (m.author?.bot) continue;
        for (const a of m.attachments || []) {
          const ext = ((a.filename || "").split(".").pop() || "").toLowerCase();
          if (!/^(png|jpe?g|webp|gif)$/.test(ext) && !/^image\//.test(a.content_type || "")) continue;
          if (a.size > 8e6) continue;
          if (nowa.length >= 60) break;
          const e = /^(png|jpe?g|webp|gif)$/.test(ext) ? ext.replace("jpeg", "jpg") : "png";
          const file = `img/galeria/${a.id}.${e}`;
          let x = stare.get(a.id);
          if (!x) {
            try {
              const img = await fetch(a.url);
              if (!img.ok) continue;
              await writeFile(file, Buffer.from(await img.arrayBuffer()));
            } catch { continue; }
          }
          nowa.push({ id: a.id, file, autor: nazwa[m.author.id] || m.author.global_name || m.author.username || "Gracz",
            t: m.timestamp, opis: czysc(m.content), w: a.width || null, h: a.height || null });
        }
      }
      nowa.sort((a, b) => String(b.t).localeCompare(String(a.t)));
      // sprzątanie: pliki zdjęć, których nie ma już na Discordzie
      const zostaja = new Set(nowa.map(x => x.file.split("/").pop()));
      for (const f of await readdir("img/galeria").catch(() => [])) if (f !== ".gitkeep" && !zostaja.has(f)) await unlink(`img/galeria/${f}`).catch(() => {});
      const dodane = nowa.filter(x => !stare.has(x.id)).length, usuniete = galeria.filter(x => !nowa.some(y => y.id === x.id)).length;
      if (dodane || usuniete) console.log(`Galeria: +${dodane} / -${usuniete} (razem ${nowa.length})`);
      galeria = nowa;
    }
  } catch (e) { console.warn("Galeria niedostępna:", e.message); }
}

/* ---------- #kary: automatyczne ogłaszanie kar (te same zasady co zakładka „Kary” na stronie) ---------- */
let karyPosted = old?.karyPosted && typeof old.karyPosted === "object" ? old.karyPosted : null;
if (WEBHOOK_KARY && !firstRun && POSTY.kary !== false) {
  const REASON = { own: p => `pierwszy atak nie na swój numer (${p.detail})`, steal: p => `drugi atak na cudzy numer (${p.detail})`, missed: p => `opuszczony atak (${p.detail})` };
  const RULE = { own: "Pierwszy atak zawsze na swój numer. Cudze numery są wolne dopiero po 12 h od startu bitwy.",
                 steal: "Drugim atakiem czekamy albo poprawiamy bazy bez 3★. Cudze numery są wolne dopiero po 12 h od startu bitwy.",
                 missed: "Każdy w składzie wykorzystuje oba ataki. Nie możesz grać? Wypisz się w Moim panelu na stronie." };
  const anul = p => karyAnul.some(a => a.name === p.name && (a.date === plDay(stampMs(p.war)) || a.date === plDay(stampMs(p.end || p.war))));
  const aktualne = penalties.filter(p => REASON[p.type] && !anul(p));
  const kto = p => { const id = srv?.discord?.[p.tag]; return id ? `<@${id}> (**${p.name}**)` : `**${p.name}**`; };
  const dzien = w => { const d = new Date(stampMs(w)); return `${String(d.getUTCDate()).padStart(2, "0")}.${String(d.getUTCMonth() + 1).padStart(2, "0")}`; };
  if (!karyPosted) {   // pierwsze uruchomienie: ogłaszamy tylko kary z ostatniej wojny, starsze uznajemy za ogłoszone
    karyPosted = {};
    const last = aktualne.reduce((m, p) => String(p.war) > m ? String(p.war) : m, "");
    for (const p of aktualne) if (String(p.war) !== last) karyPosted[p.id] = { name: p.name, war: p.war, t: nowIso };
  }
  // nowe kary, zgrupowane: gracz + wojna
  const G = {};
  for (const p of aktualne) if (!karyPosted[p.id]) (G[(p.tag || p.name) + "|" + p.war] ||= []).push(p);
  for (const list of Object.values(G)) {
    const p0 = list[0];
    const ok = await post([
      `## ⛔ Przerwa od CW · ${p0.name}`,
      `> 👤 Gracz: ${kto(p0)}`,
      `> ⚔️ Wojna z **${p0.enemy || "?"}** · ${dzien(p0.war)}`,
      ...list.map(p => `> 📌 Powód: ${REASON[p.type](p)}`),
      `> 🔁 Wraca od **kolejnej wojny**`,
      `-# 📖 ${[...new Set(list.map(p => RULE[p.type]))].join(" ")}`,
      `-# Pomyłka? Zgłoszona zamiana numerów albo wypisanie w Moim panelu anuluje karę automatycznie. Pytania: Wódz lub Co-Leader.`
    ].join("\n"), WEBHOOK_KARY);
    if (ok) for (const p of list) karyPosted[p.id] = { name: p.name, war: p.war, t: nowIso };
  }
  // anulowane (zamiana numerów, wypisanie, atak po 12 h, ręczne anulowanie na stronie)
  const ids = new Set(aktualne.map(p => p.id)), doAnul = {};
  for (const [id, v] of Object.entries(karyPosted)) if (!v.anul && !ids.has(id) && Date.now() - stampMs(v.war) < 10 * 864e5) (doAnul[v.name + "|" + v.war] ||= []).push(id);
  for (const [k, list] of Object.entries(doAnul)) {
    const v = karyPosted[list[0]];
    if (aktualne.some(p => p.name === v.name && p.war === v.war)) { for (const id of list) karyPosted[id].anul = true; continue; }   // inna kara z tej wojny dalej aktywna
    const ok = await post(`✅ **Kara anulowana** · ${v.name} · wojna ${dzien(v.war)}\n-# Zgłoszona zamiana numerów, wypisanie albo decyzja zarządu.`, WEBHOOK_KARY);
    if (ok) for (const id of list) karyPosted[id].anul = true;
  }
  karyPosted = Object.fromEntries(Object.entries(karyPosted).filter(([, v]) => Date.now() - Date.parse(v.t || 0) < 45 * 864e5));
}

// zapisy do CWL i wypisania z wojny — widoczne na stronie (zarząd)
const requests = srv ? { optouts: srv.optouts || [], cwl: srv.cwl || null } : (old?.requests || null);

// sprzątanie starych kluczy powiadomień
notified = Object.fromEntries(Object.entries(notified).slice(-40));

/* ---------- Zapis ---------- */
const data = {
  updated: new Date().toISOString(),
  clanLevel: clan.clanLevel,
  memberCount: clan.members,
  cwlLeague: clan.warLeague?.name ?? null,
  capitalLeague: clan.capitalLeague?.name ?? null,
  warWinStreak: clan.warWinStreak,
  warWins: clan.warWins ?? null,
  clanPoints: clan.clanPoints ?? null,
  afkWarned,
  currentWar,
  cwl,
  visits,
  discord,
  raids,
  events,
  warArchive,
  history,
  weekBase,
  lastWeek,
  joined,
  records,
  weekWins,
  penalties,
  activity,
  clanGames,
  monthBase,
  mvp,
  swaps: swaps.slice(0, 100),
  playerHistory,
  cwlSummary,
  cwlHistory,
  requests,
  optHist,
  dayBase,
  potd,
  potdHistory,
  notified,
  oneShots,
  feed,
  boards,
  rekrutacjaWeek,
  karyPosted,
  wymaganiaMsg,
  galeria,
  members,
  wars
};

// Zapisz tylko, gdy coś się zmieniło (pomijając datę aktualizacji)
const strip = d => JSON.stringify({ ...d, updated: null });
if (old && strip(old) === strip(data)) { console.log("Bez zmian."); process.exit(0); }

await writeFile("data.json", JSON.stringify(data, null, 2) + "\n");
console.log(`Zapisano: ${members.length} członków, ${wars.length} wojen, ${warArchive.length} w archiwum, ${events.length} zdarzeń.`);
