// Pobiera dane klanu z API Clash of Clans i zapisuje je do data.json.
// Uruchamiane automatycznie przez GitHub Actions (.github/workflows/update-data.yml).
// Wymaga sekretu COC_TOKEN — klucza API z developer.clashofclans.com
// utworzonego dla adresu IP 45.79.218.79 (serwer pośredniczący RoyaleAPI).

import { writeFile, readFile } from "node:fs/promises";

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
    warStars: p.warStars,
    attackWins: p.attackWins, defenseWins: p.defenseWins,
    capital: p.clanCapitalContributions ?? 0,
    warPref: p.warPreference ?? null,
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
let currentWar = null;
const w = await safe("Bieżąca wojna", () => api(`/clans/${enc(TAG)}/currentwar`));
if (w && w.state && w.state !== "notInWar") {
  const side = c => ({ name: c.name, stars: c.stars ?? 0, pct: round2(c.destructionPercentage), attacks: c.attacks ?? 0 });
  const oppByTag = Object.fromEntries((w.opponent.members || []).map(m => [m.tag, m]));
  currentWar = {
    state: w.state,                       // preparation | inWar | warEnded
    size: w.teamSize, perMember: w.attacksPerMember ?? 2,
    start: w.startTime, end: w.endTime,
    us: { ...side(w.clan), bases: basesOf(w.clan) }, them: { ...side(w.opponent), bases: basesOf(w.opponent) },
    members: (w.clan.members || []).sort((a, b) => a.mapPosition - b.mapPosition).map(m => ({
      name: m.name, tag: m.tag, pos: m.mapPosition, th: m.townhallLevel,
      attacks: (m.attacks || []).map(a => {
        const d = oppByTag[a.defenderTag];
        return { stars: a.stars, pct: a.destructionPercentage, order: a.order, target: d ? `${d.mapPosition}. ${d.name}` : "" };
      })
    }))
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
          us:   { name: us.name,   stars: us.stars ?? 0,   pct: round2(us.destructionPercentage),   attacks: us.attacks ?? 0, bases: basesOf(us) },
          them: { name: them.name, stars: them.stars ?? 0, pct: round2(them.destructionPercentage), attacks: them.attacks ?? 0, bases: basesOf(them) },
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
  for (const m of x.members) if (m.attacks.length < x.perMember && !(allDone && m.attacks.length >= 1))
    addPen({ id: `${x.start}:${m.tag}:missed`, type: "missed", detail: `wykorzystane ataki: ${m.attacks.length}/${x.perMember}`,
             tag: m.tag, name: m.name, war: x.start, end: x.end, enemy: x.enemy });
}
penalties = penalties.filter(p => { if (p.type !== "missed") return true;
  const x = warArchive.find(w => w.start === p.war && !w.cwl); if (!x || !(x.size && x.us >= x.size * 3)) return true;
  const mm = (x.members || []).find(m => m.tag === p.tag); return !(mm && mm.attacks.length >= 1); });
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
let lastWeek = old?.lastWeek ?? null;
if (weekBase && weekBase.week !== wk) {
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
const WEBHOOK_WYMAGANIA = process.env.DISCORD_WEBHOOK_WYMAGANIA || "";    // #wymagania-klanu: jedna wiadomość, aktualizowana
let notified = old?.notified && typeof old.notified === "object" ? old.notified : {};
const SITE = "https://kubooorek.github.io/armia-maurycego/";
async function post(content, url = WEBHOOK, ping = false) {
  if (!url) return false;
  try {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "Armia Maurycego", avatar_url: SITE + "icon-512.png", content, allowed_mentions: { parse: ping ? ["everyone"] : [] }, flags: 4 }) });
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
  wymagania: true          // stała, aktualizowana wiadomość z wymaganiami (#wymagania-klanu)
};
if ((WEBHOOK || WEBHOOK_INFO || WEBHOOK_RUCHY || WEBHOOK_WOJNY || WEBHOOK_POWITANIA) && !firstRun) {
  // 1) Ruchy w klanie z tego uruchomienia
  const RN = { leader: "Wodza", coLeader: "Współlidera", admin: "Starszego", member: "Członka" };
  const freshEvents = events.filter(e => e.t === events[0]?.t && !(old.events || []).some(o => o.t === e.t && o.name === e.name && o.type === e.type));
  for (const e of freshEvents.reverse()) {
    if (e.type === "join" && POSTY.dolaczenie) await post(`👋 **Witamy w Armii Maurycego, ${e.name}!** (TH${e.th}) 🛡️\n` +
      `• Przeczytaj <#1564012902996770886> i **#wymagania-klanu**\n` +
      `• Połącz konto z Discordem komendą \`/link create\`\n` +
      `• Na stronie klanu zaloguj się i w **Moim panelu** kliknij **Połącz Discord**, to robot przypomni Ci na priv o ataku w wojnie\n` +
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
/* ---------- Rekrutacja i wymagania ---------- */
const LIGA = n => !n ? "brak" : n.replace("Unranked", "Bez ligi").replace("Bronze", "Brąz").replace("Silver", "Srebro").replace("Gold", "Złoto")
  .replace("Crystal", "Kryształ").replace("Master", "Mistrz").replace("Champion", "Czempion").replace(" League", "");
let rekrutacjaWeek = old?.rekrutacjaWeek || null;
let wymaganiaMsg = old?.wymaganiaMsg || null;
if (!firstRun && clan) {
  const ile = clan.members ?? members.length, wolne = Math.max(0, 50 - ile);
  // 1) #rekrutacja — raz w tygodniu (sobota od 12:00), tylko gdy są wolne miejsca
  const now = new Date(), wk = (() => { const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())); const day = d.getUTCDay() || 7; d.setUTCDate(d.getUTCDate() + 4 - day); const y = new Date(Date.UTC(d.getUTCFullYear(), 0, 1)); return d.getUTCFullYear() + "-" + Math.ceil(((d - y) / 864e5 + 1) / 7); })();
  const czas = !rekrutacjaWeek || (now.getUTCDay() === 6 && now.getUTCHours() >= 11 && rekrutacjaWeek !== wk);
  if (WEBHOOK_REKRUTACJA && POSTY.rekrutacja && wolne > 0 && czas) {
    const ok = await post([
      `📣 **ARMIA MAURYCEGO REKRUTUJE!** 🔥`,
      `Wolnych miejsc: **${wolne}** · w klanie **${ile}/50** graczy`,
      ``,
      `🏰 Poziom klanu: **${clan.clanLevel}**`,
      `⚔️ Liga CWL: **${LIGA(clan.warLeague?.name)}**${clan.warWins != null ? ` · wygrane wojny: **${clan.warWins}**` : ""}`,
      `🏛️ Liga Stolicy: **${LIGA(clan.capitalLeague?.name)}**`,
      ``,
      `✅ Przyjmujemy od **TH8**, klan otwarty, nie czekasz na akceptację`,
      `🎁 Wojny i CWL non-stop, bogate donacje, awanse za aktywność, zgrany Discord`,
      ``,
      `Tag klanu: **${TAG}**`,
      `Wszystko o klanie: ${SITE}`,
      `Znasz kogoś, kto szuka klanu? Podeślij mu tę wiadomość! 💪`
    ].join("\n"), WEBHOOK_REKRUTACJA);
    if (ok) rekrutacjaWeek = wk;
  }
  // 2) #wymagania-klanu — jedna wiadomość, którą robot edytuje, gdy coś się zmieni
  if (WEBHOOK_WYMAGANIA && POSTY.wymagania) {
    const tresc = [
      `📜 **WYMAGANIA I ZASADY KLANU ARMIA MAURYCEGO**`,
      ``,
      `🏰 **Ratusz:** od **TH8** wzwyż (początkujący mile widziani)`,
      `🎯 **Gry Klanowe:** minimum **1000 pkt** w każdych Grach`,
      `⚔️ **Wojny:** jeśli jesteś w składzie, **oba ataki** są obowiązkowe (pierwszy na swój numer, po 12 h numery wolne)`,
      `🏆 **CWL:** zapisy w **Moim panelu** na stronie`,
      `💤 **Aktywność:** 7 dni nieaktywności bez uprzedzenia = usunięcie z klanu`,
      `🛑 Nie możesz grać wojny? Zgłoś to w **Moim panelu**, wtedy nie dostaniesz minusa`,
      ``,
      `📊 **Klan teraz:** poziom **${clan.clanLevel}** · **${ile}/50** graczy · Liga CWL: **${LIGA(clan.warLeague?.name)}** · Stolica: **${LIGA(clan.capitalLeague?.name)}**`,
      `🏷️ Tag: **${TAG}** · Strona: ${SITE}`,
      ``,
      `_Wiadomość aktualizuje się sama._`
    ].join("\n");
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
  rekrutacjaWeek,
  wymaganiaMsg,
  members,
  wars
};

// Zapisz tylko, gdy coś się zmieniło (pomijając datę aktualizacji)
const strip = d => JSON.stringify({ ...d, updated: null });
if (old && strip(old) === strip(data)) { console.log("Bez zmian."); process.exit(0); }

await writeFile("data.json", JSON.stringify(data, null, 2) + "\n");
console.log(`Zapisano: ${members.length} członków, ${wars.length} wojen, ${warArchive.length} w archiwum, ${events.length} zdarzeń.`);
