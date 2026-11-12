# Module: ER trends over fiscal years (`urgences-cumulatif`)

How a Québec ER (or establishment, region, the province) has performed **so
far this fiscal year** and how that compares with previous years, from the
MSSS cumulative ER file.

The CLI returns verbatim indicators per fiscal year, plus objective derived
shares and year-over-year differences. This module owns the opinions: which
direction is better, what counts as a meaningful change, and the summary.

**[`answer-standard.md`](answer-standard.md) applies to every answer.** For
this dataset: these are averages over months of past visits. They describe how
an ER has been performing, never how long a visit today would take.

> This is **trend** data (cumulated over months, updated every ~4 weeks). For
> **right-now** occupancy, see [`urgences.md`](urgences.md). To set
> *yesterday* against this fiscal year ("is it worse than usual right now?"),
> [`urgences.md`](urgences.md) uses `quebec-sante urgences --baseline`, which
> joins this file to the hourly one.

## 1. Get the data

Always pass **`--json`**:

```bash
# One or more hospitals (permit numbers), with every fiscal year:
quebec-sante urgences-cumulatif --id 51222800,51223279 --history --json

# A hospital by name:
quebec-sante urgences-cumulatif --search "sainte-justine" --json

# A region's total and its hospitals:
quebec-sante urgences-cumulatif --region montreal --level region,facility --json

# The province and every region:
quebec-sante urgences-cumulatif --level province,region --json

# Another year / baseline:
quebec-sante urgences-cumulatif --year 2024-2025 --compare 2021-2022 --id 51222800 --json
```

Each `entries[]` item has `indicators` (`total` / `ambulatory` / `stretcher`
groups: `visits`, `dmsHours`, `pecDelayHours`, `over24h`, `over48h`, …),
`derived` (`stretcherOver24hPct`, `stretcherOver48hPct`, `stretcherSharePct`),
`previous` (same entity in `compareTo`), `change` (current − previous), and for
aggregates `facilityCount`. For field meanings, units, ordering and exit codes,
see [`cli-urgences-cumulatif.md`](cli-urgences-cumulatif.md).

## 2. Interpret (the opinions)

0. **No occupancy here.** The cumulative file has no stretcher-occupancy rate.
   For "has overcrowding worsened?", use the strain indicators it has (stretcher
   `dmsHours`, `stretcherOver24hPct` / `stretcherOver48hPct`, `pecDelayHours`)
   and say that's what you used. Occupancy history only exists in
   `urgences-historique`, hourly, with gaps (some months long) that its
   `archive.gaps` lists.
1. **Lower is better** for `dmsHours` (length of stay), `pecDelayHours` (delay
   to first physician assessment), `over24h` / `over48h` and their `%` shares.
   A negative `change` on these is an improvement.
2. **`pecDelayHours` is a mean from the end of triage to the first physician,**
   over every patient seen since April 1, across all triage priorities. Say
   "on average"; never "you'll wait about X h".
3. **Visits are volume, not quality.** More visits is neither good nor bad;
   mention it as context ("busier than last year").
4. **Prefer rates over counts across years**: compare `stretcherOver24hPct`,
   not raw `over24h`, since volume changes.
5. **Meaningful change:** treat a stay/delay change under ~0.25 h (15 min) or a
   share change under ~1 point as "stable". Convert hours to h/min for humans
   (9.04 h → "about 9 h").
6. **Check coverage before calling a trend.** If an aggregate's
   `change.facilityCount` ≠ 0, facilities joined or dropped out of the data, so
   its totals are **not comparable** — say so instead of reporting a drop or
   surge. Its means and shares aren't comparable either: they describe a
   different set of ERs. Likewise, list anything in `missingFromFiscalYear` ("no 2026-2027
   data yet for Hôpital Fleury") rather than implying it closed. It names
   whole entities only: to name the facilities behind a region's drop,
   compare `--region R --level facility --year` for both years. (`urgences
   --baseline`'s `baseline.unmatched` lists live ERs with no row this year,
   which is often but not always the same set.)
7. **Same window every year.** All years are cumulated April 1 → the same
   `period`; say "April to period 7" (roughly mid-October), not "the whole year".
8. If a hospital has no entry for the latest year, re-query with
   `--year <previous>` and say which year you are reporting.

## 3. Summarize for the human

Lead with the verdict, then the numbers, then caveats. Example shape:

> **Sainte-Justine's ER is slightly slower than last year so far.**
> - Average stay: 5 h 01 (vs 4 h 30 in 2025-2026, +31 min).
> - Delay to see a physician: 1 h 35 (+11 min).
> - Stretcher stays over 24 h: 0.8% (stable).
> - Visits: 38,669 (+789).
>
> _Fiscal year 2026-2027, April 1 → period 7; MSSS cumulative file._

Always state the fiscal year, the period, and the baseline year.
