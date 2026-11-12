# `urgences` and `urgences-historique`: CLI reference

The output contract for [`urgences.md`](urgences.md) and
[`urgences-children.md`](urgences-children.md). Load it when you need the
exact command contract or a field meaning. Keep this file why-what: the modules
own the opinions.

## Invocation

```bash
quebec-sante urgences [options]
```

| Option | Description |
|--------|-------------|
| `--region <name\|code>` | Filter to a region: name, alias, unique name prefix or RSS code (`montreal`, `mtl`, `06`, `RSS06`). Same spellings in every command; list them with `quebec-sante regions` |
| `--id <n[,n...]>` | Filter to facility id(s) (MSSS permit number); repeatable or comma-separated. Explicit ids override `--available-only` |
| `--search <text>` | Filter facilities by name (accent-insensitive substring) |
| `--available-only` | Only facilities currently reporting live data |
| `--baseline` | Join each facility with its fiscal-year-to-date values from the cumulative ER file (by permit number) — adds `baseline` / `vsBaseline` |
| `--baseline-fixture <path>` | Read a local cumulative CSV for `--baseline` (offline; env `QUEBEC_SANTE_BASELINE_FIXTURE` also works) |
| `--refresh` | Force a fresh fetch, ignoring the local cache (both files with `--baseline`) |
| `--ttl <minutes>` | Cache TTL in minutes (default 30) |
| `--json` | JSON output (default when piped) |
| `--table` | Human-readable table (default on a TTY) |
| `-h, --help` / `-v, --version` | Help / version |

Exit codes: `0` success · `1` network/HTTP error · `2` structure changed or bad usage.

## Output (data contract)

Top level: `source`, `fetchedAt`, `dataDate` (the source's `Mise_a_jour`: when
MSSS published the file, Québec local time, hour zero-padded), `extractedAt`
(when the snapshot was taken, `Heure_de_l'extraction_(image)`, usually 45 min
before `dataDate`; `null` if the file doesn't say), `cached`,
`cacheAgeMinutes`, `regions[]`, `province`.

Each `region`: `name`, `slug`, `regionCode`, `averageOccupancyPct`
(DERIVED: the plain mean of its reporting facilities' `occupancyPct`), `total`,
`facilities[]`.

`region.total` is MSSS's own "Total régional" row and top-level `province` its
"Ensemble du Québec" row, verbatim. Both describe the whole region or province
whatever `--id`, `--search` or `--available-only` keep, and are `null` when the
file has no such row:

| Field | Meaning |
|-------|---------|
| `stretchersFunctional` / `stretchersOccupied` | Region/province totals |
| `occupancyPct` | DERIVED: occupied/functional as an integer %: MSSS's regional rate, the figure Québec.ca and Index Santé show. It weights big ERs more than `averageOccupancyPct` does, so the two differ |
| `over24h`, `over48h`, `totalPresent`, `waitingForCare` | Region/province head counts |
| `dmsStretcher` / `dmsAmbulatory` (+ `…Display`) | Previous-day mean stays for the region/province, decimal hours (HH:MM) |

A region whose ERs aren't reporting has a `total` of `null` metrics (MSSS
writes "pas d'information disponible"), not zeros.

Each `facility`:

| Field | Meaning |
|-------|---------|
| `id` | Stable MSSS permit number (target by this, never by name) |
| `name` | Facility name (`Nom_installation`) |
| `establishment` | Establishment name (`Nom_etablissement`) |
| `stretchersFunctional` | Civières fonctionnelles |
| `stretchersOccupied` | Civières occupées |
| `occupancyPct` | DERIVED: occupied/functional as an integer % (routinely >100%, not an error) |
| `over24h` | Patients on a stretcher > 24 h |
| `over48h` | Patients on a stretcher > 48 h |
| `totalPresent` | Total patients present |
| `waitingForCare` | Patients waiting to be seen (en attente de PEC) |
| `dmsStretcher` / `dmsAmbulatory` | Avg length of stay, decimal hours |
| `dmsStretcherDisplay` / `dmsAmbulatoryDisplay` | Same, HH:MM |
| `available` | False when the facility reports no live data |
| `deltaFromRegionAvgPct` | DERIVED: occupancyPct − region average |

`null` metrics / `available: false` = not reporting right now.

### With `--baseline`

Each facility also gets `baseline` (null when the cumulative file has no row
for it in the baseline fiscal year) and `vsBaseline` (null with it):

| Field | Meaning |
|-------|---------|
| `baseline.fiscalYear` / `baseline.period` | Fiscal year and period (1–13) the values are cumulated through (April 1 → end of period) |
| `baseline.dmsStretcher` / `baseline.dmsAmbulatory` | Fiscal-year-to-date mean stay, decimal hours (`dms_sur_civiere` / `dms_ambulatoire`) |
| `baseline.pecDelayHours` | Context only: FYTD mean delay to first physician assessment, hours (no live equivalent) |
| `baseline.stretcherOver24hPct` / `stretcherOver48hPct` | Context only: FYTD share of stretcher visits lasting 24 h+ / 48 h+, % |
| `vsBaseline.dmsStretcherHours` / `dmsAmbulatoryHours` | DERIVED: live − baseline, hours (2 decimals) |
| `vsBaseline.dmsStretcherPct` / `dmsAmbulatoryPct` | DERIVED: the same difference as an integer % of the baseline |

**Window:** the live `dmsStretcher` / `dmsAmbulatory` are MSSS's *previous-day*
mean stay (patients who left the ER yesterday); `baseline.*` is the mean over
every stay since April 1. Same indicator, different window. The live
`over24h` / `waitingForCare` are head counts *now* and have no FYTD equivalent.

Top level gains `baseline`: `status` (`ok` | `unavailable`), `source`,
`fiscalYear`, `period`, `cached`, `cacheAgeMinutes`, `matched` (facilities with
a baseline row), `unmatched` (their ids without one) and, when unavailable,
`error`. An unavailable baseline never fails the command: live data is still
returned, every `baseline` is null, exit code stays `0`.

## `urgences-historique` (history)

```bash
quebec-sante urgences-historique [--region R] [--id N,...] [--search T]
  [--days 28] [--by hour|weekday-hour|day] [--api URL] [--refresh] [--ttl 30]
  [--json|--table] [--fixture DIR]
```

Reads the static history API built from the hourly snapshots archived in the
repo (`archive/`), served by GitHub Pages at
`https://krystosterone.github.io/quebec-sante-cli/api/v1` (override with
`--api` or `QUEBEC_SANTE_API_URL`). The window is the `--days` before the
**latest archived snapshot**, not the wall clock. Every number is DERIVED from
the snapshots in the window (mean/min/max, 1 decimal; nulls ignored).
`--by` defaults to `hour`. `latest.occupancyPct` keeps 1 decimal (87.5) where
live `urgences` rounds to a whole percent (88); for "right now", quote the live
figure.

**The archive has gaps, and always will.** It's fetched by one computer, from
cron, and MSSS sometimes skips or delays a publication, so hours or days can
have no snapshot at all. `window.from` is `--days` back in calendar time
whatever the archive holds. The output says what it holds; there's no list of
gap dates to keep anywhere else:

- `window.snapshots`: snapshots in the window, against
  `window.coverage.expectedSnapshots` (`days` × 24, one an hour).
- `window.coverage.ranges[]`: `{ from, to, snapshots }`, the runs of snapshots
  with no gap over 6 h inside, oldest first.
- `window.coverage.gaps[]`: `{ from, to, hours }`, every span over 6 h with no
  snapshot, oldest first. `from` and `to` are the snapshots either side; the
  first gap starts at `window.from` when the window opens before its first
  snapshot. A gap of 6 h or less is MSSS's usual jitter, not listed.
- `archive`: `{ first, last, snapshots, gaps }` for the whole archive,
  whatever the window, so any call (`--days 1` is the cheapest) shows where
  history exists. `gaps` is `null` from an API built before the field existed.
  `window.archiveStart` equals `archive.first`.
- A window with a gap writes one `note:` line on stderr; the JSON is unchanged.

Three kinds of missing data, kept apart:

| What's missing | Where it shows |
|----------------|----------------|
| **Nothing archived** for a span: the job missed it, or MSSS published nothing. The archive can't tell which. | `window.coverage.gaps`, `archive.gaps` |
| **MSSS says the ER isn't reporting**: it's listed, every stretcher figure blank (live `available: false`) | facility `snapshots.notReporting`; counted in `samples`, ignored by the means |
| **The ER isn't in the file at all** for a snapshot | facility `snapshots.absent`; not in `samples` |

Each facility's `snapshots` (`reporting` + `notReporting` + `absent`) sums to
`window.snapshots`.

```jsonc
{
  "source": "https://krystosterone.github.io/quebec-sante-cli/api/v1",
  "generatedAt": "…",          // when the API was built from the archive
  "cached": false,
  "window": { "from": "2026-10-14T19:45", "to": "2026-11-11T19:45", "days": 28,
              "snapshots": 141, "archiveStart": "2023-02-01T13:46",
              "coverage": {
                "expectedSnapshots": 672,
                "ranges": [ { "from": "2026-11-03T22:45", "to": "2026-11-08T21:45", "snapshots": 120 },
                            { "from": "2026-11-10T23:45", "to": "2026-11-11T19:45", "snapshots": 21 } ],
                "gaps": [ { "from": "2026-10-14T19:45", "to": "2026-11-03T22:45", "hours": 483 },
                          { "from": "2026-11-08T21:45", "to": "2026-11-10T23:45", "hours": 50 } ] } },
  "archive": { "first": "2023-02-01T13:46", "last": "2026-11-11T19:45", "snapshots": 22998,
               "gaps": [ { "from": "2023-02-03T13:46", "to": "2023-02-06T09:46", "hours": 68 }, … ] },
  "groupBy": "weekday-hour",
  "facilities": [{
    "id": "51222800", "name": "CHU SAINTE-JUSTINE", "region": "Montréal", "regionCode": "06",
    "snapshots": { "reporting": 137, "notReporting": 4, "absent": 0 },
    "summary": { "samples": 141, "occupancyPctMean": 112.4, "occupancyPctMin": 50,
                 "occupancyPctMax": 175, "waitingForCareMean": 28.1,
                 "totalPresentMean": 61.3, "over24hMean": 0.4, "dmsStretcherMean": 7.2 },
    "latest": { "dataDate": "2026-11-11T19:45", "occupancyPct": 125, "waitingForCare": 34,
                "totalPresent": 79, "typicalOccupancyPct": 108.3,
                "typicalOccupancyPctSameWeekday": 115, "deltaFromTypicalPct": 16.7 },
    "profile": [ { "weekday": 1, "weekdayName": "Monday", "hour": 0, "samples": 1,
                   "occupancyPctMean": 96.9, "occupancyPctMin": 96.9, "occupancyPctMax": 96.9,
                   "waitingForCareMean": 9.5, "totalPresentMean": 31, "over24hMean": 0,
                   "dmsStretcherMean": 7.1 } ]
  }]
}
```

- `profile` keys: `hour` (0–23) for `--by hour`; `weekday` (ISO 1 = Monday …
  7 = Sunday), `weekdayName`, `hour` for `--by weekday-hour`; `date`
  (YYYY-MM-DD) for `--by day`. Each row's `samples` is its snapshot count,
  including snapshots where the facility wasn't reporting: a row can have
  `samples: 1` and all-null values. Means ignore the nulls.
- `latest.typicalOccupancyPct`: mean at the same hour over the rest of the
  window; `…SameWeekday`: same weekday and hour. `null` when there's no other
  sample.
- Caching: the index and the current month for `--ttl` minutes (default 30).
  A complete month (one the live archive no longer adds to) stays cached while
  it matches its index entry (snapshot count, first, last); a backfill changes
  that, and the month is fetched again. `--refresh` re-fetches the index and
  the current month.
- Exit codes: `1` when the API can't be reached (HTTP 404 means Pages isn't
  deployed yet), `2` for a bad `--days`/`--by` or a document that doesn't match
  schema 1.

## Regions

`quebec-sante regions --json` lists the 18 RSS regions (`code`, `name`, `slug`,
`aliases`, and `datasetCodes` — how each dataset writes the code).
`quebec-sante regions --region <input>` shows what an input resolves to, exit
`2` if it names no region or several (e.g. `mont`). Static, no network.

## Freshness & cache

- Source updates **hourly**; CLI caches locally for **30 min** by default (wall-clock TTL).
- Repeated calls within the hour are cheap and return `cached: true`.
- `--refresh` forces a fresh fetch. Always give `dataDate` / `extractedAt`, and `cached`.
- The `--baseline` file updates once per fiscal period (~4 weeks) and keeps its
  own 24 h cache, shared with `urgences-cumulatif`.
