# Module: ER crowding (`urgences`, `urgences-historique`)

Live Québec ER data from the MSSS hourly open-data CSV, compared with each
hospital's own norm (`--baseline`) and history (`urgences-historique`), for
**any** hospital or region.

The CLI returns the numbers exactly as MSSS publishes them, plus objective
derived metrics (regional average, delta-from-average). This module owns the
interpretation: what the numbers say about crowding, what they can't say, and
the summary. Don't ask the CLI to rank or judge.

**[`answer-standard.md`](answer-standard.md) applies to every answer.** In
short: possible emergency → 911 / nearest ER first; occupancy is not a wait
time; always give the data's time and source.

> Montréal's **two pediatric ERs** have their own module,
> [`urgences-children.md`](urgences-children.md); it uses the rules below for
> `--baseline` and the history. Fiscal-year **trends** are in
> [`urgences-cumulatif.md`](urgences-cumulatif.md).

## 1. Get the data

Query it, **always with `--json`** so you parse structured data, not a table:

```bash
# A specific hospital by its stable id (MSSS permit number):
quebec-sante urgences --id <permit> --json

# A whole region (accent-insensitive name or slug):
quebec-sante urgences --region montreal --json

# All facilities in your region matching a name:
quebec-sante urgences --region montreal --search "verdun" --json

# Everything currently reporting data:
quebec-sante urgences --available-only --json

# "Is it worse than usual?" — add each hospital's fiscal-year-to-date baseline:
quebec-sante urgences --region montreal --baseline --json

# "When is it usually least busy?" — occupancy history from the archived hourly snapshots:
quebec-sante urgences-historique --id <permit> --by weekday-hour --days 28 --json
```

`--region` takes a name, an alias or an RSS code (`montreal`, `mtl`, `06`) and
means the same region in every `quebec-sante` command; `quebec-sante regions
--json` lists them.

Each facility in the JSON has an `id` (the stable MSSS permit number), `name`,
`occupancyPct`, `totalPresent`, `waitingForCare`, `over24h`, `over48h`,
`available`, and `deltaFromRegionAvgPct`; each region has `averageOccupancyPct`
(the plain mean of its ERs) and `total` (MSSS's own "Total régional" row, with
its `occupancyPct`), and the report has `province` (MSSS's "Ensemble du
Québec" row).
`null` metrics / `available: false` mean the hospital isn't reporting right now.
For the exact field dictionary, all CLI flags, exit codes, and cache/freshness
semantics, see [`cli-urgences.md`](cli-urgences.md) — load
it when you need the full contract or a field's precise meaning.

## 2. Stable hospital ids

Target a specific hospital by its **stable MSSS permit number** (`id`), never
by name. To find one, query its region with `--json` and read the `id` field:

```bash
quebec-sante urgences --region <name> --json
```

Common ids (for convenience): CHU Sainte-Justine `51222800`,
L'Hôpital de Montréal pour enfants `51223279`, Hôpital de Verdun `51218097`,
Hôpital Maisonneuve-Rosemont `12934659`. The answer standard lists the ERs that
serve a specific population (pediatric, psychiatric, cardiology).

## 3. Interpret (the opinions)

For a general ER-occupancy question, apply these rules:

1. **`occupancyPct` measures how full the stretcher area is.** It is the derived
   occupied/functional ratio and routinely exceeds 100% at busy ERs (MSSS counts
   overflow stretchers as occupied, not as functional). Higher means more
   crowded. It doesn't measure the waiting room or say how fast anyone is seen.
2. **`over24h` / `over48h`** count patients on a stretcher for 24 h / 48 h or
   more right now, mostly people waiting for a hospital bed. They're a strain
   signal for the hospital, not a measure of the wait to be seen.
3. **For the region as a whole, quote `region.total.occupancyPct`:** MSSS's
   own regional rate, the one Québec.ca and Index Santé show, and `province`
   for Québec. To place one hospital, compare its `occupancyPct` with the
   region's `averageOccupancyPct`: `deltaFromRegionAvgPct` says how much more or
   less crowded it is than the mean of its ERs. Name which one you quote ("the
   Montréal rate", "the mean of Montréal's ERs"). Set specialized ERs apart.
4. **`waitingForCare`** counts people present who haven't seen a physician yet,
   at every triage priority. Report it as a count. It's not a queue position.
5. If a hospital is `available: false`, say its data isn't being reported right
   now. Never treat it as calm or closed.
6. **"Which hospital should I go to?" / "Where will I be seen fastest?"**
   Don't pick one from the numbers. First apply §1 of the answer standard. For
   a non-urgent problem, offer the §5 routes (811, pharmacist, clinic) as well.
   If they still want the comparison, give the indicators of the general ERs
   near them (every ER not in the answer standard's specialized list; with no
   location given, the region's) and say plainly that the data can't predict
   who is seen sooner. List them by name, not sorted by occupancy: for this
   question the top of a sorted list reads as a pick.
   For "how long?", point to Québec.ca's official estimate (answer standard
   §2); never compute one.

**With `--baseline`** ("is this normal for this hospital?"):

7. **`vsBaseline.dmsStretcherPct` answers "worse than usual?"** It compares
   yesterday's mean stretcher stay with the same hospital's fiscal-year-to-date
   mean. Treat roughly **±10% as normal day-to-day noise**; +10% to +25% is
   "somewhat longer than usual"; **+25% or more** is "noticeably longer than
   usual"; **−25% or less** is "unusually quick" (−10% to −25%: "somewhat
   quicker"). Say
   it is *yesterday's* stay (the CLI's `dmsStretcher` is previous-day data), not
   the stay of someone arriving now. Read `vsBaseline.dmsAmbulatoryPct` (walk-in
   patients, the waiting room) with the same thresholds, and report it
   separately: the two can disagree.
8. **Occupancy and the baseline answer different questions.** A hospital can be
   at 200% and still in line with its own norm (chronically full), or at 90%
   and well above it. Report both: "busy, but normal for it" vs "busier than it
   usually is".
9. **`baseline: null`** means MSSS has not validated that hospital's data for
   the fiscal year yet (listed in the top-level `baseline.unmatched`). Say so;
   don't infer a norm. If `baseline.status` is `unavailable`, answer from the
   live data alone and mention the comparison couldn't be made.
10. `baseline.pecDelayHours` and `baseline.stretcherOver24hPct` are context only
    ("this ER usually takes ~2 h to see a physician"); they have no live
    counterpart to subtract. Don't present the delay as anyone's expected wait.

**With `urgences-historique`** ("when is it usually calm?", "is now unusual?"):

11. **Calmest times = the slots with the lowest `occupancyPctMean`** in
    `profile` (`--by weekday-hour` for a weekday-specific answer, `--by hour`
    for a general one). Name two or three calm slots, not just one, and give
    their `occupancyPctMax` too: a slot that is calm on average but sometimes
    packed is a weaker pattern. It describes past crowding, not a promise of a
    shorter wait, and it's never a reason to delay care for a possible
    emergency.
12. **Check the sample size and the coverage before trusting a slot.** Each
    profile row has `samples`; with fewer than ~3 per slot, say the history is
    thin. The archive always has gaps, at times nobody can predict, so never
    assume a window is full and never carry gap dates from an earlier answer:
    read this call's `window.snapshots` against
    `window.coverage.expectedSnapshots`, and its `window.coverage.gaps`. When
    gaps cover much of the window, say how much history it really holds ("112
    of the 672 hourly snapshots, in two stretches") rather than calling it
    "the last 28 days". To pick a window that reaches real
    data, read `archive.gaps` (any call shows it). Name a missing span for
    what it is: "the archive has no snapshot from … to …", never "MSSS
    reported nothing" (the archive can't tell a missed fetch from a skipped
    publication). An ER with `snapshots.notReporting` or `snapshots.absent`
    is a different thing: the file was archived, and MSSS listed it with
    blanks or left it out.
13. **"Is now unusual?" = `latest.deltaFromTypicalPct`.** Treat roughly ±10
    points as normal; +10 to +20 is "somewhat busier"; +20 or more is "busier
    than usual for this hour"; −20 or less is "quieter than usual". Only once
    enough other snapshots back the typical value (rule 12). `latest.dataDate` is the archive's latest
    snapshot, which usually lags the live file by up to an hour, and by much
    more while the archive job is down; for "right now", pair it with a live
    `urgences` call, and say so when `window.to` is hours behind its
    `dataDate`. A long window can also mix stretches years apart: say which
    ones the typical value covers (`window.coverage.ranges`).
14. Hours are **Québec local time** (MSSS's `Mise_a_jour`). Say "around 15h",
    not "at 15:00 exactly": a snapshot stands for that hour.

More generally: lower occupancy and fewer long stays mean a less strained ER,
not a faster visit. Always give the regional rate as context so a
percentage means something.

## 4. Summarize for the human

Lead with the answer to the question asked, then the numbers, then what they
can't tell. Example shape:

> **Hôpital de Verdun's ER is less crowded than most of Montréal's right now.**
> - Verdun: 104% stretcher occupancy, 6 people waiting to see a physician,
>   2 on a stretcher for over 24 h.
> - Montréal's rate is 154% (MSSS's regional total); the mean of its ERs is
>   144%, so Verdun sits well below it (Δ −40).
> - These are counts, not wait times: patients are seen by triage priority,
>   and MSSS warns a low count doesn't mean being seen sooner.
>
> _MSSS hourly ER file, snapshot of 21:00, published 2026-11-04 21:45._

With `--baseline`, add one line per hospital mentioned, e.g.:

> - Patients who left yesterday stayed 14.9 h on a stretcher on average, 11%
>   less than its 16.7 h so far this fiscal year (April 1 → period 7): close to
>   its usual, slightly shorter.

Round nothing the CLI didn't round; quote occupancy as shown. Always give the
`dataDate` (and `extractedAt`), say if it's `cached`, and flag it when it's
more than about 2 hours old.
