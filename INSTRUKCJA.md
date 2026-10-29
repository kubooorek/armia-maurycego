# Strona klanu Armia Maurycego — instrukcja

## 1. Wgranie strony
Na github.com/kubooorek/armia-maurycego: **Add file → Upload files**, przeciągnij WSZYSTKIE pliki i foldery
z tej paczki (index.html, og.png, icon.png, scripts, .github) → **Commit changes**.

## 2. Automatyczna aktualizacja z gry (jednorazowa konfiguracja, ~5 minut)
1. Wejdź na https://developer.clashofclans.com i zaloguj się (konto Supercell ID / e-mail).
2. **My Account → Create New Key**. Nazwa: `strona-klanu`, opis dowolny.
   W polu **Allowed IP addresses** wpisz: `45.79.218.79`  (serwer pośredniczący RoyaleAPI).
3. Skopiuj wygenerowany **Token**.
4. Na GitHubie w repozytorium: **Settings → Secrets and variables → Actions → New repository secret**.
   Name: `COC_TOKEN`, Secret: wklej token → **Add secret**.
5. **Actions → Aktualizacja danych klanu → Run workflow** (pierwsze uruchomienie ręcznie).
   Po ok. minucie w repozytorium pojawi się plik `data.json`, a strona pokaże „Dane z gry, aktualizacja automatyczna”.

Od tej pory członkowie, ratusze, darowizny, role, historia wojen i liga CWL odświeżają się same co godzinę.
Uwaga: darowizny w grze zerują się z nowym sezonem — tak samo będzie na stronie.

## 3. Ręczne zmiany (w index.html, sekcja „DANE KLANU” na początku skryptu)
- `ANNOUNCE` — pasek ogłoszeń na górze (null = brak)
- `MVP` — gracz miesiąca
- `CWL` — liga, miejsce, top gwiazdek po sezonie
- `BASES` — bazy tygodnia (linki „Kopiuj bazę” z gry)
- `MILESTONES_EXTRA` — dodatkowe kamienie milowe
