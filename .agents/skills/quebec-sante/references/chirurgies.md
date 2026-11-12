# Module: surgical waitlists (`chirurgies`)

The province's elective-surgery waitlist from the MSSS
`Chirurgie_ListeAttente.csv` dataset: how many people are waiting, for which
specialty, in which region, and for how long since the surgeon decided to
operate.

The CLI returns waitlist counts exactly as MSSS publishes them, plus a few
objective derived figures: totals, % waiting over 6 and 12 months, the delta
from the previous period, and a province-wide sum. This module owns the
opinions: which figure leads, how to compare, and how to state the limits.

**[`answer-standard.md`](answer-standard.md) applies to every answer.**

> This is a **planning / context** dataset, not a triage tool. Someone worried
> about their health while waiting for surgery should contact their surgeon's
> office, or 811.

## 1. Get the data

Query with **always `--json`**:

```bash
# Latest period, every region (+ derived province total):
quebec-sante chirurgies --json

# One region (name, slug or RSS code) and/or a specialty:
quebec-sante chirurgies --region montreal --specialty ortho --json

# A past fiscal period:
quebec-sante chirurgies --region RSS03 --period 2627-P01 --json

# For a trend, in one call: the same period in each of the last 3 fiscal
# years (comparable windows), or any list of periods:
quebec-sante chirurgies --region montreal --specialty ortho --years 3 --json
quebec-sante chirurgies --region montreal --periods 2627-P04,2627-P03,2627-P02 --json
```

`--years` and `--periods` return `periods`, `notInSource` and `reports[]`:
one entry per period, each with the fields below.

Key fields: `dataDate` / `period` (fiscal period), `previousPeriod`,
`missingRegions`, `province` (derived), `regions[]`. Each region has
`overall` (all specialties) and `specialties[]`. Each of those has
`waiting.{under6m, from6to12m, over12m}`, `total`, `over6m`, `pctOver6m`,
`pctOver12m`, and `deltaFromPreviousPeriod` (that waitlist's change since
`previousPeriod`). Regions also carry their own all-specialty
`deltaFromPreviousPeriod`. For the full contract, exit codes and cache
semantics, see [`cli-chirurgies.md`](cli-chirurgies.md).

## 2. Interpret (the opinions)

1. **Lead with the people waiting over 6 months** (`over6m`, `pctOver6m`), then
   over a year (`over12m`). The raw `total` mostly reflects population size and
   surgical volume. The long-wait share is what tells you whether access is
   strained.
2. **Compare regions by percentage, not by count.** Montréal will always have the
   largest count. A small region with a high `pctOver6m` is the more telling
   signal.
3. **Trend = `deltaFromPreviousPeriod`**, which is one fiscal period (~4 weeks).
   One period is noise. Before calling a trend, look at 3–4 periods
   (`--years 3` for the same period across fiscal years, `--periods` for
   consecutive ones) and say so. `--years` compares like with like, since
   waitlists move with the season; name any period listed in `notInSource`.
   `deltaFromPreviousPeriod` compares with `previousPeriod`, the last period
   MSSS published. When `missingPeriods` isn't empty, MSSS skipped the
   periods in it, and the delta covers `missingPeriods.length + 1` periods:
   say so ("since P02; MSSS published no P03"), never "in one period".
   For one specialty, quote that specialty's own
   `specialties[].deltaFromPreviousPeriod`. The region-level
   `deltaFromPreviousPeriod` is all specialties, even with `--specialty`, so
   don't put it next to a specialty's figures.
4. **Read `missingRegions` before quoting the province.** `province` sums only
   the regions present. When a region is missing, say the provincial figure
   excludes it. `province.deltaFromPreviousPeriod`, and each of its
   specialties' deltas, are `null` when the two periods cover different regions. Never compute your own delta across that gap.
   The same goes across years: when one period lists a region in
   `missingRegions` and the other doesn't, say the provincial change partly
   reflects the missing region, or compare percentages or regions instead.
5. **`null` means not published**, not zero. Say "not reported" instead of
   treating it as 0 people.
6. **`autres`** = non-surgical interventions needing general anesthesia. Do not
   present it as a surgical specialty.

## 3. State the limits

Always say, briefly:

- Counts come from a **snapshot at the end of the fiscal period** (`dataDate`),
  not from today. The data is published 13 times a year, and the latest
  period can be several months old: say so (period 4 ends in late July).
- Wait time starts at **the surgeon's decision to operate**. Time spent getting a
  family doctor or a specialist appointment is not measured.
- These are **regional aggregates**. They are not per-hospital and they do not
  predict any one person's wait. Their surgeon's office is the authority on that.
- When the question covers all specialties, or cardiac or vascular surgery:
  cardiac and cardio-thoracic surgery are only **partially** covered by the
  source system (SIMASS).

## 4. Summarize for the human

Lead with the answer, then the numbers, then the caveats. Example shape:

> **Orthopedic surgery in Montréal: 6,265 people waiting, 30% for over 6 months
> (period 2627-P04, fiscal 2026-2027).**
> - 4,374 under 6 months · 1,665 between 6 and 12 months · 226 over a year.
> - Province-wide, 27% of orthopedic patients wait over 6 months, so Montréal
>   runs a bit above the provincial share.
> - Excludes Mauricie et Centre-du-Québec, which is not reported this period.
>   These are end-of-period snapshots from the decision to operate. Individual
>   waits vary.
