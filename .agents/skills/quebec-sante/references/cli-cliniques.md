# `cliniques`: CLI reference

The output contract for [`cliniques.md`](cliniques.md). Load it when you
need the exact command contract or a field meaning. The module owns the
interpretation.

## Invocation

```bash
quebec-sante cliniques [options]
```

| Option | Description |
|--------|-------------|
| `--region <name\|code>` | An RSS region by name, alias or code (`montreal`, `06`) — all of its RTS sub-regions; otherwise one RTS by code (`061`) or name substring (`Montérégie-Est`). Same spellings in every command (`quebec-sante regions` lists them) |
| `--rls <name>` | Filter to a local service network (RLS) by name (accent-insensitive) |
| `--search <text>` | Filter clinics by name (accent-insensitive substring) |
| `--date <YYYY-MM-DD>` | The date to report; default = the latest date present in the source. With `--days`, the last day of the window |
| `--days <n>` | Report `n` calendar days ending at `--date`, in one call (1–31, default 1). Rows come newest date first |
| `--refresh` | Force a fresh fetch, ignoring the local cache |
| `--ttl <minutes>` | Cache TTL (default 1440; the dataset updates weekly) |
| `--json` | JSON output (default when piped) |
| `--table` | Human-readable table (default on a TTY) |
| `--fixture <path>` | Read a local CSV instead of the network (deterministic offline run) |
| `-h, --help` | Command help |

Exit codes: `0` success · `1` network/HTTP error · `2` structure changed or bad usage.

## Source

- Canonical URL: `https://msss.gouv.qc.ca/professionnels/statistiques/documents/urgences/rdvoffert_DOuv.csv`
- Dataset page: [Portrait quotidien des rendez-vous en clinique](https://www.donneesquebec.ca/recherche/dataset/portrait-quotidien-des-rendez-vous-en-clinique)
- Encoding: UTF-8 **with BOM** (stripped by the CLI) — differs from `urgences`
  which is Latin-1.
- Methodology notes: [Liste des variables et notes méthodologiques](https://www.donneesquebec.ca/recherche/dataset/660b82c5-71c0-4b2a-b51f-520bbdf65f74/resource/85489ee9-dcc7-4633-828d-046f92383a8a/download/liste-de-variables-et-notes-methodologiques-rendez-vous-en-clinique.pdf)
- What it counts: appointments **offered** for each date by the clinics
  connected to the provincial appointment hub (HUB, run by Petal), by
  professional group and scheduled time band. Not whether they were booked,
  who could book them, or clinics outside the hub. MSSS warns the counts
  depend on what the hub captures and on how each clinic configures and uses
  its medical record system.
- Cadence: one row per clinic, professional group and **date** (since
  2024-01-01). MSSS republishes the file **weekly, Thursdays at 14h**, up to
  the day before, so the newest date is 1 to 8 days old. It is never
  current availability.

## Output (data contract)

Top level: `source`, `fetchedAt`, `dataDate` (the day the report is for: the
last day of the window), `window`, `dates`, `cached`, `cacheAgeMinutes`,
`availableDates`, `availableRange`, `clinics[]` (newest date first, source
order within a date), `summary`.

| Field | Meaning |
|-------|---------|
| `window` | `{ from, to, days, missingDates }`: the calendar days reported, inclusive. `days` is 1 unless `--days` was given, and `to` equals `dataDate`. `missingDates` lists the window's days the source has no rows for at all, newest first: MSSS didn't publish them (or hasn't yet, past `availableRange.to`) |
| `dates` | The dates in `window` that the source has rows for, newest first. `dates` and `window.missingDates` together are every day of the window. A missing day isn't zero offers |
| `availableDates` | The newest 31 dates the source has, newest first: enough to pick any `--days` window that ends at the latest date. Not the whole source |
| `availableRange` | `{ from, to, count }`: the oldest and newest dates in the source, and how many distinct dates it has |

Each `clinic`:

| Field | Meaning |
|-------|---------|
| `date` | The appointments' scheduled date (YYYY-MM-DD) |
| `weekday` / `weekdayName` | DERIVED: that date's ISO weekday, 1 (Monday) to 7 (Sunday), and its English name (`Thursday`), as in `urgences-historique` |
| `regionCode` / `regionName` | RTS region code / display name |
| `rssCode` | DERIVED: the two-digit RSS region the RTS belongs to (`061` → `06`) — the same code as `urgences` `regionCode`, for joining |
| `rlsCode` / `rlsName` | Local service network (RLS) code / name |
| `name` | Clinic name (`clinique_nom_groupe`), verbatim except that accents are composed (Unicode NFC): MSSS mixes composed and decomposed forms (`médicale` can arrive as `me` + U+0301), so names compare and count as plain text. `--search` also ignores accents |
| `professionGroup` | `Médecin` (physicians and residents) / `Infirmière` (nurses and specialized nurse practitioners) |
| `slots.6h_9h … slots.21h_6h` | Appointments offered per band of scheduled time (`null` = no offers) |
| `totalOffered` | DERIVED: sum of non-null slots across all bands |

`null` slot = no appointments offered in that band (not missing data).

### `summary` (over the window)

DERIVED from the rows in `clinics[]`, so it follows the same filters and
window. It counts and sums; it doesn't rank. A **clinic** is a `name` within
its RTS and RLS. A **day with offers** is a date in `dates` with at least one
appointment offered (in that band, for a band). "Every day" means on every
date in `dates`, so state `dates.length` with it, and `window.missingDates`
when it isn't empty.

| Field | Meaning |
|-------|---------|
| `clinicsWithOffers` | Distinct clinics with at least one offer in the window, either professional group |
| `byProfessionGroup[]` | One entry per `professionGroup`, alphabetical |
| `byClinic[]` | One entry per clinic × `professionGroup`, alphabetical by `name`, then group |

Each `byProfessionGroup` entry:

| Field | Meaning |
|-------|---------|
| `professionGroup` | `Médecin` / `Infirmière` |
| `clinicsWithOffers` | Distinct clinics with an offer from this group on at least one date |
| `clinicsWithOffersEveryDay` | … on every date in `dates` |
| `totalOffered` | Appointments this group offered over the window, every clinic and band |
| `bands.6h_9h … bands.21h_6h` | Per band: `offered` (sum), `clinicsWithOffers`, `clinicsWithOffersEveryDay` |

Each `byClinic` entry:

| Field | Meaning |
|-------|---------|
| `name`, `professionGroup`, `regionCode`, `regionName`, `rssCode`, `rlsCode`, `rlsName` | As on the rows |
| `daysWithOffers` | Dates in the window with at least one offer, out of `dates.length` |
| `datesWithOffers` | Those dates, newest first. Rows give each one's `weekdayName` |
| `totalOffered` | Appointments offered over the window, all bands |
| `bands.6h_9h … bands.21h_6h` | Per band: `offered` (sum over the window; `0` = none offered) and `daysWithOffers` |

Select an entry by fields, e.g.
`summary.byClinic[name=District Médical&professionGroup=Médecin].bands.21h_6h.daysWithOffers`.
Add `rlsCode` when a name appears in more than one RLS.

## Freshness & cache

- Source is a large multi-year time-series, one row per date; the CLI caches the **parsed**
  slice (not the raw megabyte CSV), keyed on the source `date`, under
  `QUEBEC_SANTE_CACHE_DIR` (default `~/.cache/quebec-sante`).
- Default TTL 24h (the dataset updates weekly); `--refresh` forces a fresh fetch.
- The data is **past**, not real-time: always state `dataDate` and that the
  file is weekly.
