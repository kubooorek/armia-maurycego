// Jednorazowe ustawienie uprawnień kanałów na Discordzie klanu.
// Uruchamiane ręcznie: Actions → "Uprawnienia Discorda" → Run workflow.
//   tryb "podglad"   – tylko wypisuje, co by zmienił (nic nie rusza)
//   tryb "zastosuj"  – naprawdę ustawia uprawnienia
// Rusza tylko role klanowe (@everyone, Member, Elder, Co-Leader, Leader). War Master to nagroda – bez uprawnień.
// Uprawnień botów (Ticket Tool, ClashPerk, Arcane, Carl-bot…) i pojedynczych osób NIE zmienia.
// Kategorii "Podania" i kanałów ticket-xxxx nie dotyka (tym zarządza Ticket Tool).

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const TRYB = (process.env.TRYB || "podglad").toLowerCase();
const API = "https://discord.com/api/v10";
if (!TOKEN) { console.error("Brak sekretu DISCORD_BOT_TOKEN"); process.exit(1); }

// --- bity uprawnień Discorda ---
const B = n => 1n << BigInt(n);
const P = {
  VIEW: B(10), SEND: B(11), REACT: B(6), EMBED: B(14), ATTACH: B(15), HISTORY: B(16),
  MENTION_ALL: B(17), APP_CMDS: B(31), MANAGE_MSG: B(13),
  THREADS_PUB: B(35), SEND_THREADS: B(38),
  CONNECT: B(20), SPEAK: B(21), MUTE: B(22), MOVE: B(24), STREAM: B(9), VAD: B(25)
};
const sum = (...a) => a.reduce((x, y) => x | y, 0n);
const CZYTA = sum(P.VIEW, P.HISTORY, P.REACT);
const PISZE = sum(CZYTA, P.SEND, P.EMBED, P.ATTACH, P.APP_CMDS, P.SEND_THREADS, P.THREADS_PUB);
const GLOS = sum(P.VIEW, P.CONNECT, P.SPEAK, P.STREAM, P.VAD);

// --- nazwy ---
const norm = s => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ł/g, "l").replace(/[^a-z0-9-]+/g, " ").trim();
const has = (name, ...keys) => keys.some(k => norm(name).includes(k));

// profil kanału na podstawie nazwy (kanał) lub nazwy kategorii (gdy nic nie pasuje)
function profilKanalu(ch, kat) {
  const n = norm(ch.name);
  if (ch.type === 2 || ch.type === 13) return "GLOS";
  if (/^ticket-/.test(n) || has(kat?.name, "podania")) return "POMIN";
  if (has(n, "powitania")) return "WEJSCIE";
  if (has(n, "regulamin", "ogloszenia", "wymagania") || n.replace(/^[^a-z]*/, "") === "rekrutacja") return "INFO";
  if (has(n, "statystyki", "wojny-klanu", "rajdy-stolica", "ruchy-w-klanie")) return "RAPORT";
  if (has(n, "ataki-cwl")) return "SKLADY";
  return "KLAN";
}

async function dc(path, opt = {}) {
  for (let i = 0; i < 5; i++) {
    const r = await fetch(API + path, { ...opt, headers: { Authorization: `Bot ${TOKEN}`, "Content-Type": "application/json", ...(opt.headers || {}) } });
    if (r.status === 429) { const j = await r.json(); await new Promise(res => setTimeout(res, (j.retry_after || 1) * 1000 + 200)); continue; }
    if (!r.ok) throw new Error(`${opt.method || "GET"} ${path}: ${r.status} ${await r.text()}`);
    return r.status === 204 ? null : r.json();
  }
  throw new Error("Za dużo prób (limit Discorda)");
}

const guilds = await dc("/users/@me/guilds");
if (!guilds.length) { console.error("Bot nie jest na żadnym serwerze."); process.exit(1); }
const guild = guilds.find(g => has(g.name, "armia")) || guilds[0];
console.log(`Serwer: ${guild.name} (${guild.id}) · tryb: ${TRYB}\n`);

const [roles, channels] = await Promise.all([dc(`/guilds/${guild.id}/roles`), dc(`/guilds/${guild.id}/channels`)]);
const rola = (...keys) => roles.find(r => !r.managed && keys.some(k => norm(r.name).replace(/^[^a-z]*/, "") === k));
const R = {
  everyone: roles.find(r => r.id === guild.id),
  member: rola("member", "czlonek"),
  elder: rola("elder", "starszy"),
  warmaster: null,   // War Master to ranga-nagroda bez uprawnień – nie ruszamy jej
  coleader: rola("co-leader", "co leader", "wspollider"),
  leader: rola("leader", "lider", "wodz")
};
for (const [k, v] of Object.entries(R)) if (k !== "warmaster") console.log(`Rola ${k.padEnd(9)} → ${v ? v.name : "❌ NIE ZNALEZIONO"}`);
if (!R.member) { console.error("\nNie znalazłem roli Member – przerywam, żeby nikomu nie zabrać dostępu."); process.exit(1); }
const KLAN = [R.member, R.elder, R.warmaster, R.coleader, R.leader].filter(Boolean);

// docelowe nadpisania dla ról, którymi zarządzamy: [rola, allow, deny]
function plan(profil) {
  const o = [];
  const add = (r, allow = 0n, deny = 0n) => r && o.push([r, allow, deny]);
  switch (profil) {
    case "WEJSCIE":  // #powitania – każdy widzi i może wpisać /link
      add(R.everyone, sum(PISZE), P.MENTION_ALL);
      break;
    case "INFO":     // regulamin, ogłoszenia, wymagania, rekrutacja – wszyscy czytają, pisze zarząd
      add(R.everyone, CZYTA, P.SEND);
      for (const r of [R.member, R.elder, R.warmaster]) add(r, CZYTA, P.SEND);
      add(R.coleader, sum(PISZE, P.MENTION_ALL, P.MANAGE_MSG));
      break;
    case "RAPORT":   // kanały robota – klan czyta i reaguje
      add(R.everyone, 0n, P.VIEW);
      for (const r of [R.member, R.elder, R.warmaster]) add(r, CZYTA, P.SEND);
      add(R.coleader, sum(PISZE, P.MANAGE_MSG));
      break;
    case "SKLADY":   // ataki-cwl-war – składy ustala zarząd
      add(R.everyone, 0n, P.VIEW);
      for (const r of [R.member, R.elder]) add(r, CZYTA, P.SEND);
      add(R.warmaster, sum(PISZE, P.MENTION_ALL, P.MANAGE_MSG));
      add(R.coleader, sum(PISZE, P.MENTION_ALL, P.MANAGE_MSG));
      break;
    case "KLAN":     // zwykłe kanały klanu – tylko dla członków
      add(R.everyone, 0n, P.VIEW);
      for (const r of KLAN) add(r, PISZE);
      add(R.coleader, sum(PISZE, P.MANAGE_MSG));
      break;
    case "GLOS":
      add(R.everyone, 0n, sum(P.VIEW, P.CONNECT));
      for (const r of [R.member, R.elder]) add(r, GLOS);
      add(R.warmaster, sum(GLOS, P.MUTE));
      add(R.coleader, sum(GLOS, P.MUTE, P.MOVE));
      break;
  }
  // Leader dostaje to samo co Co-Leader (na wypadek, gdyby nie miał Administratora)
  for (const [r, a, d] of [...o]) if (r === R.coleader && R.leader) o.push([R.leader, a, d]);
  // jedna rola może się pojawić dwa razy (co-leader w KLAN) – scal
  const m = new Map();
  for (const [r, a, d] of o) { const x = m.get(r.id) || { r, a: 0n, d: 0n }; x.a |= a; x.d |= d; m.set(r.id, x); }
  for (const x of m.values()) x.d &= ~x.a;
  return [...m.values()];
}

const NAZWY = { WEJSCIE: "każdy pisze (wejście)", INFO: "wszyscy czytają, pisze zarząd", RAPORT: "klan tylko czyta", SKLADY: "klan czyta, pisze zarząd", KLAN: "tylko klan, pisze", GLOS: "głosowy dla klanu", POMIN: "pomijam (Ticket Tool)" };
const zarzadzane = new Set(Object.values(R).filter(Boolean).map(r => r.id));
const kategorie = Object.fromEntries(channels.filter(c => c.type === 4).map(c => [c.id, c]));
const posort = channels.filter(c => c.type !== 4).sort((a, b) => (kategorie[a.parent_id]?.position ?? -1) - (kategorie[b.parent_id]?.position ?? -1) || a.position - b.position);

let zmian = 0;
const profileKat = {};
for (const ch of posort) {
  const kat = kategorie[ch.parent_id];
  const profil = profilKanalu(ch, kat);
  if (kat) (profileKat[kat.id] ||= []).push(profil);
  console.log(`${kat ? `[${kat.name}] ` : ""}#${ch.name} → ${NAZWY[profil]}`);
  if (profil === "POMIN") continue;
  const docel = plan(profil);
  const zostaw = (ch.permission_overwrites || []).filter(o => !(o.type === 0 && zarzadzane.has(o.id)));
  const nowe = [...zostaw, ...docel.map(x => ({ id: x.r.id, type: 0, allow: String(x.a), deny: String(x.d) }))];
  zmian++;
  if (TRYB === "zastosuj") await dc(`/channels/${ch.id}`, { method: "PATCH", body: JSON.stringify({ permission_overwrites: nowe }), headers: { "X-Audit-Log-Reason": "Uprawnienia klanu (robot)" } });
}
// kategorie: ustaw jak większość kanałów w środku (żeby nowe kanały dziedziczyły sensownie)
for (const kat of Object.values(kategorie)) {
  const p = profileKat[kat.id] || [];
  if (!p.length || p.includes("POMIN") || has(kat.name, "podania")) continue;
  const najcz = Object.entries(p.reduce((a, x) => (a[x] = (a[x] || 0) + 1, a), {})).sort((a, b) => b[1] - a[1])[0][0];
  const docel = plan(najcz === "GLOS" ? "GLOS" : najcz);
  const zostaw = (kat.permission_overwrites || []).filter(o => !(o.type === 0 && zarzadzane.has(o.id)));
  console.log(`Kategoria ${kat.name} → ${NAZWY[najcz]}`);
  zmian++;
  if (TRYB === "zastosuj") await dc(`/channels/${kat.id}`, { method: "PATCH", body: JSON.stringify({ permission_overwrites: [...zostaw, ...docel.map(x => ({ id: x.r.id, type: 0, allow: String(x.a), deny: String(x.d) }))] }) });
}
console.log(`\n${TRYB === "zastosuj" ? "✅ Ustawiono" : "👀 Podgląd – do zmiany"}: ${zmian} kanałów/kategorii.`);
if (TRYB !== "zastosuj") console.log('Jeśli wszystko się zgadza, uruchom jeszcze raz z trybem "zastosuj".');
