# `chirurgies`: CLI reference

The output contract for [`chirurgies.md`](chirurgies.md). Load it when you
need the exact command contract or a field meaning. The module owns the
interpretation.

## Invocation

```bash
quebec-sante chirurgies [options]
```

| Option | Description |
|--------|-------------|
| `--region <name\|code>` | Region by name, alias, unique name prefix or RSS code (`montreal`, `RSS06`, `06`, `6`); otherwise an accent-insensitive substring of the region name. Same spellings in every command (`quebec-sante regions` lists them) |
| `--specialty <name>` | Specialties by label or key (accent-insensitive substring), e.g. `ortho`, `gynécologie`. `chirurgie` matches six of them |
| `--period <YYZZ-Pnn>` | Fiscal period, e.g. `2627-P04`; default = latest in the source. With `--years`, the newest period |
| `--periods <list>` | Several periods in one call, comma-separated (up to 13), reported in that order. Not with `--period` |
| `--years <n>` | The same period number in each of the last `n` fiscal years (1–13), newest first: `2627-P04`, `2526-P04`, … |
| `--refresh` | Force a fresh fetch, ignoring the local cache |
| `--ttl <minutes>` | Cache TTL (default 1440) |
| `--json` | JSON output (default when piped) |
| `--table` | Human-readable table (default on a TTY) |
| `--fixture <path>` | Read a local CSV instead of the network (deterministic offline run) |
| `-h, --help` | Command help |

Specialty keys: `chirurgie_generale`, `chirurgie_orthopedique`,
`chirurgie_plastique`, `chirurgie_vasculaire`, `neurochirurgie`,
`obstetrique_gynecologie`, `ophtalmologie`, `orl`, `urologie`, `autres`.

Exit codes: `0` success · `1` network/HTTP error · `2` structure changed or bad
usage. Bad usage includes a malformed `--period` or `--periods` entry, a
`--period` absent from the source (the message lists the latest ones),
`--periods` none of which the source has, `--periods` with `--years` or
`--period`, and an unknown `--specialty` (the message lists the keys). MSSS
can skip a period, so with `--years` or `--periods` a period the source
doesn't have is not an error: it's listed in `notInSource`. A `--region` that
matches nothing is **not** an error: `regions` comes back empty.

## Source

- Canonical URL: `https://msss.gouv.qc.ca/professionnels/statistiques/documents/chirurgie/Chirurgie_ListeAttente.csv`
- Dataset page: [Chirurgies — Portrait de la liste d'attente](https://www.donneesquebec.ca/recherche/dataset/chirurgies-portrait-de-la-liste-d-attente)
- Encoding: UTF-8 **with BOM**, comma-separated, CRLF.
- Shape: one row per (`PeriodeAttente` × `Delais_d'attente` × `Region`), with one
  count column per specialty plus `Total`. History starts at `1920-P12`
  (February 2020).
- Cadence: once per **fiscal period**, 13 per year (April → March).
  `2627-P04` = period 4 of fiscal year 2026-2027.

## Output (data contract)

Top level: `source`, `fetchedAt`, `dataDate` (period code), `period`
(`code`, `fiscalYear`, `number`), `previousPeriod`, `missingPeriods`,
`cached`, `cacheAgeMinutes`, `availablePeriods` (newest first),
`missingRegions`, `province`, `regions[]`.

- `previousPeriod`: the last period before `dataDate` that the source has,
  which every delta compares with. `null` for the oldest.
- `missingPeriods`: the fiscal periods between `previousPeriod` and
  `dataDate` that the source doesn't have (MSSS didn't publish them), newest
  first. Usually `[]`. When it isn't, every `deltaFromPreviousPeriod` spans
  `missingPeriods.length + 1` periods, not one.

Each region (and `province`):

| Field | Meaning |
|-------|---------|
| `code` | RSS code (`RSS06`); `null` for `province` |
| `name` / `slug` | Name from the methodology notes' RSS reference table / ASCII slug |
| `overall` | All specialties combined, from the published `Total` column |
| `specialties[]` | One waitlist per specialty (narrowed by `--specialty`) |
| `previousPeriodTotal` | DERIVED: `overall.total` in `previousPeriod`; `null` if the region was absent |
| `deltaFromPreviousPeriod` | DERIVED: `overall.total − previousPeriodTotal`: all specialties, even with `--specialty` |

Each waitlist (`overall`, `specialties[]`):

| Field | Meaning |
|-------|---------|
| `key` / `label` | Specialty key (or `total`) / French label |
| `waiting.under6m` / `from6to12m` / `over12m` | Patients waiting, verbatim; `null` = not published |
| `total` | DERIVED: sum of non-null bands |
| `over6m` | DERIVED: `from6to12m + over12m` |
| `pctOver6m` / `pctOver12m` | DERIVED: integer % of `total`; `null` when `total` is 0 |
| `previousPeriodTotal` | DERIVED: this waitlist's `total` in `previousPeriod`; `null` if the region was absent or nothing was published for it there |
| `deltaFromPreviousPeriod` | DERIVED: `total − previousPeriodTotal` for this specialty; `null` when either period has nothing published for it. On `overall`, the same as the region's |

`province` is DERIVED by summing the regions present in the period. It ignores
`--region` and honours `--specialty`. It **excludes `missingRegions`**, and its
deltas (its own and each specialty's) are `null` when the previous period
covers a different set of regions.

### Several periods (`--periods`, `--years`)

Top level: `source`, `fetchedAt`, `cached`, `cacheAgeMinutes`,
`availablePeriods`, `periods` (the codes reported, in order), `notInSource`
(periods asked for that the source lacks: earlier years' with `--years`, any
listed code with `--periods`; they have no report), `reports[]`.

Each `reports[]` entry is the single-period report above without the shared
top-level fields: `dataDate`, `period`, `previousPeriod`, `missingRegions`,
`province`, `regions[]`. It's identical to a `--period` call for that period:
`missingRegions`, `missingPeriods` and `deltaFromPreviousPeriod` are per
period, so check coverage in each one before comparing them.

## Freshness & cache

- The whole history (~4k rows, ~250 KB) is parsed once and cached as JSON
  (`chirurgies-waitlist.json`) under `QUEBEC_SANTE_CACHE_DIR` (default
  `~/.cache/quebec-sante`). Every `--period` is then served from that one cache.
- Default TTL 24h. The source changes about every 4 weeks, on no fixed day.
  `--refresh` forces a fetch.
- A corrupt cache file prints one warning and falls back to a live fetch.
