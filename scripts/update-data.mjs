// Pobiera dane klanu z API Clash of Clans i zapisuje je do data.json.
// Uruchamiane automatycznie przez GitHub Actions (.github/workflows/update-data.yml).
// Wymaga sekretu COC_TOKEN — klucza API z developer.clashofclans.com
// utworzonego dla adresu IP 45.79.218.79 (serwer pośredniczący RoyaleAPI).

import { writeFile, readFile } from "node:fs/promises";

const TAG = "#2GQQ8RGRL";
const BASE = "https://cocproxy.royaleapi.dev/v1";
const TOKEN = process.env.COC_TOKEN;
if (!TOKEN) { console.error("Brak sekretu COC_TOKEN"); process.exit(1); }

async function api(path) {
  const res = await fetch(BASE + path, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

// "20261028T081500.000Z" → "2026-10-28"
const day = t => t ? `${t.slice(0,4)}-${t.slice(4,6)}-${t.slice(6,8)}` : null;
const tag = encodeURIComponent(TAG);

const clan = await api(`/clans/${tag}`);
let warlog = { items: [] };
try { warlog = await api(`/clans/${tag}/warlog?limit=50`); }
catch (e) { console.warn("Dziennik wojen niedostępny (czy jest publiczny?):", e.message); }

const data = {
  updated: new Date().toISOString(),
  clanLevel: clan.clanLevel,
  memberCount: clan.members,
  cwlLeague: clan.warLeague?.name ?? null,
  warWinStreak: clan.warWinStreak,
  members: (clan.memberList || []).map(m => ({
    name: m.name,
    tag: m.tag,
    role: m.role,               // leader | coLeader | admin | member
    th: m.townHallLevel,
    given: m.donations,
    received: m.donationsReceived,
    trophies: m.trophies
  })),
  wars: (warlog.items || [])
    .filter(w => w.opponent?.name)          // pomijamy wpisy CWL bez przeciwnika
    .map(w => ({
      date: day(w.endTime),
      enemy: w.opponent.name,
      size: w.teamSize,
      xp: w.clan.expEarned ?? 0,
      result: w.result,
      us:   { stars: w.clan.stars,     pct: Math.round((w.clan.destructionPercentage ?? 0) * 100) / 100 },
      them: { stars: w.opponent.stars, pct: Math.round((w.opponent.destructionPercentage ?? 0) * 100) / 100 }
    }))
};

// Zapisz tylko, gdy coś się zmieniło (pomijając datę aktualizacji)
let old = null;
try { old = JSON.parse(await readFile("data.json", "utf8")); } catch {}
const strip = d => JSON.stringify({ ...d, updated: null });
if (old && strip(old) === strip(data)) { console.log("Bez zmian."); process.exit(0); }

await writeFile("data.json", JSON.stringify(data, null, 2) + "\n");
console.log(`Zapisano: ${data.members.length} członków, ${data.wars.length} wojen.`);
