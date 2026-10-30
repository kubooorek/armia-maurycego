# Strona klanu Armia Maurycego — instrukcja

Strona: https://kubooorek.github.io/armia-maurycego/

## Jak to działa
1. **cron-job.org** (zadanie „Robot klanu”) co 15 minut uruchamia robota na GitHubie.
2. **Robot** (`scripts/update-data.mjs`, uruchamiany przez `.github/workflows/update-data.yml`) pobiera dane z API Clash of Clans
   i zapisuje je do `data.json`: członkowie, profile, wojny, wojna na żywo, CWL, rajdy, ruchy w klanie,
   Gry Klanowe, aktywność graczy, Discord i licznik odwiedzin.
3. **Strona** (`index.html`) wczytuje `data.json` i sama się aktualizuje.
4. Jeśli ustawiony jest webhook, robot pisze na **Discordzie** (przypomnienia, wyniki wojen, powitania, Wojownik Tygodnia).

## Pliki w repozytorium
| Plik | Do czego |
|---|---|
| `index.html` | cała strona |
| `data.json` | dane z gry — zapisuje je robot, **nie edytować ręcznie** |
| `scripts/update-data.mjs` | robot |
| `.github/workflows/update-data.yml` | uruchamianie robota na GitHubie |
| `og.png`, `icon.png`, `icon-192.png`, `icon-512.png` | obrazek podglądu linku i ikony |
| `manifest.webmanifest`, `sw.js` | aplikacja na telefon |

## Sekrety na GitHubie (Settings → Secrets and variables → Actions)
| Nazwa | Co to | Skąd |
|---|---|---|
| `COC_TOKEN` | klucz API Clash of Clans | developer.clashofclans.com → My Account → klucz z IP `45.79.218.79` |
| `DISCORD_WEBHOOK` | kanał wojenny: przypomnienia o atakach, wyniki wojen i CWL, podsumowanie Gier Klanowych | Discord → Edytuj kanał → Integracje → Webhooki |
| `DISCORD_WEBHOOK_INFO` | (opcjonalnie) kanał ogólny: powitania, awanse, nowe TH, Wojownik Tygodnia. Bez niego wszystko idzie na kanał wojenny | jw. |

Kluczy i linków webhooków **nikomu nie wysyłamy**.

## Budzik cron-job.org (zadanie „Robot klanu”)
- **URL:** `https://api.github.com/repos/kubooorek/armia-maurycego/actions/workflows/update-data.yml/dispatches`
- **Harmonogram:** co 15 minut
- **Metoda:** POST, **treść:** `{"ref":"main"}`
- **Nagłówki:** `Accept: application/vnd.github+json`, `Authorization: Bearer <klucz GitHub>`, `Content-Type: application/json`
- **Klucz GitHub** (Fine-grained token „budzik-strony”): tylko repozytorium `armia-maurycego`, uprawnienie **Actions: Read and write**.
- Poprawny test zwraca **204**.

## ⚠️ Terminy do zapamiętania
- **28.10.2027** — wygasa klucz GitHub „budzik-strony”. Przed tą datą: github.com/settings/personal-access-tokens → nowy klucz
  z tymi samymi ustawieniami → wklej go w nagłówku `Authorization` zadania na cron-job.org.
- **Marzec 2028** — GitHub wyłącza wersję API `2022-11-28` używaną przez budzik (wtedy dopisać nagłówek
  `X-GitHub-Api-Version` z nowszą wersją).

## Ręczne zmiany w `index.html` (sekcja „DANE KLANU” na początku skryptu)
| Ustawienie | Co zmienia |
|---|---|
| `ANNOUNCE` | pasek ogłoszeń na górze strony (`null` = brak) |
| `MVP` / `MVP_HISTORY` | MVP miesiąca i galeria poprzednich MVP |
| `CHALLENGE` | wyzwanie tygodnia: lista konkurencji `rotation` (zmieniają się co tydzień, po kolei), nagroda. Kolejność musi zgadzać się z `ROTATION` w `scripts/update-data.mjs` |
| `BADGE_LIMITS` | progi odznak przy nickach: gwiazdki wojenne, oddane wojska w sezonie, złoto Stolicy, punkty w Grach Klanowych |
| `FACTS` | ciekawostki z historii gry (jedna na dobę) |
| `UPGRADES`, `UPG_RULES` | plan ulepszeń dla każdego TH (sekcja Poradnik, zmienia się z suwakiem TH) |
| `GLOSSARY` | słowniczek pojęć w Poradniku |
| `SEASONS` | motywy sezonowe (Halloween, Święta, Nowy Rok) — daty w formacie MM-DD. Podgląd: dopisz do adresu `?motyw=halloween`, `?motyw=swieta`, `?motyw=nowyrok` albo `?motyw=urodziny` |
| `JUBILEES` | okrągłe liczby dni istnienia klanu, w które strona świętuje (plus urodziny klanu co roku, według `FOUNDED`) |
| `GOALS` | cele klanu (paski postępu) |
| `BASES` | bazy tygodnia: `th`, link `war`, link `ranked` |
| `CWL` | sezon CWL wpisywany ręcznie (gdy brak danych z robota) |
| `MILESTONES_EXTRA` | dodatkowe kamienie milowe |
| `COUNTER` | licznik odwiedzin (workspace `armia-maurycego`, licznik `odwiedziny` na counterapi.dev) |

Członków, wojen, ról i darowizn **nie trzeba** wpisywać — robi to robot.

## Wgrywanie zmian
GitHub → **Add file → Upload files** → przeciągnij pliki (nazwa musi być dokładnie `index.html`, bez „(1)”) → **Commit changes**.
Po 1–2 minutach odśwież stronę przez **Ctrl+F5**.

## Gdy coś nie działa
- **Dane się nie odświeżają:** cron-job.org → Zadania cykliczne → „Robot klanu” → HISTORIA (ma być 204)
  oraz GitHub → Actions (uruchomienia „Aktualizacja danych klanu”).
- **401 w historii cron-job.org:** wygasł lub jest błędny klucz GitHub.
- **Robot kończy się błędem:** sprawdź sekret `COC_TOKEN` (klucz z IP `45.79.218.79`).
- **Licznik odwiedzin pokazuje „TH6+”:** bloker reklam w przeglądarce — liczba i tak odświeża się co 15 min z `data.json`.

## Odznaki i staż

- **Odznaki** przy nickach liczy strona sama z danych robota (wojny, profile, Gry Klanowe, wyzwanie tygodnia). Lista i opis są w FAQ na stronie.
- **Staż** robot zapisuje w `data.json` (pole `joined`) od momentu, gdy pierwszy raz zobaczy gracza w klanie. Gracze, którzy byli w klanie przed włączeniem tej funkcji, mają przy stażu dopisek „lub dłużej”. Odejście z klanu zeruje staż.
- **Rocznice** (miesiąc, 3 miesiące, pół roku, rok) pokazują się w sekcji „Sława klanowa” przez 7 dni od rocznicy.

## Księga rekordów

Robot zapisuje w `data.json` (pole `records`) rekordy wszech czasów: najwięcej gwiazdek w jednej wojnie, najdłuższa seria ataków za 3★, najwięcej łupów w weekendzie rajdowym, najwięcej oddanych wojsk w sezonie, najwięcej punktów w Grach Klanowych, najwięcej wygranych Wyzwań Tygodnia i rekord liczebności klanu. Rekord zmienia się tylko wtedy, gdy ktoś go pobije.
