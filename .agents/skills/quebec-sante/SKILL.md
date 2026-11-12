---
name: quebec-sante
description: Answer questions about Québec's public health-care system from MSSS open data via the deterministic quebec-sante CLI. Covers live ER crowding for any hospital or region (stretcher occupancy, people waiting to see a physician, 24h/48h stretcher stays), Montréal's two pediatric ERs, whether an ER is busier than its own norm or history and when it is usually calmer, fiscal-year ER trends, which clinics usually offer appointments and the routes to non-urgent care, and surgical waitlists. Use for any question about Québec ERs, clinics or surgery waits ("how busy is Verdun's ER right now?", "compare Sainte-Justine and the Children's", "has Montréal's ER overcrowding worsened?", "which clinics near Ahuntsic offer evening appointments?", "how long are orthopedic waitlists?"), including questions that span several datasets. It puts emergencies first (911, 811), never predicts a personal wait time, never picks an ER for the person, and never decides between a clinic and the ER.
version: 0.2.0
author: Krystian
license: MIT
---

# quebec-sante

Answer questions about Québec's ERs, clinics and surgical waitlists from the
Ministère de la Santé et des Services sociaux (MSSS) open data.

**The seam:** the `quebec-sante` CLI is a deterministic *facts machine*. It
returns MSSS's numbers verbatim, plus objective metrics labelled `DERIVED`, and
ranks or recommends nothing. **This skill owns the interpretation**: what the
numbers say, what they can't say, and the answer. Keep it that way.

## 1. Rules for every answer

**Read [`references/answer-standard.md`](references/answer-standard.md) before
answering.** It holds the safety, provenance, freshness and uncertainty rules,
and it wins wherever a module disagrees. The essentials:

- **Possible emergency first.** If the symptoms described could be serious,
  start with **911 or the nearest ER now**, before any number; **Info-Santé
  811** when the person is unsure. Never use crowding to pick an ER or to wait:
  ERs see people by triage priority, so the most serious cases go first
  wherever they arrive. Don't triage the person yourself.
- **Occupancy is not a wait time.** Never turn occupancy, counts, stays or
  history into "you'll wait about X". For how long someone would wait, point to
  Québec.ca's official estimate (quebec.ca/SituationUrgences, answer standard
  §2); never compute one.
- **Clinic counts are past offers, published weekly.** They're never "free
  today", and this data never decides between a clinic and the ER.
- **Every answer names its source and the data's time**, flags stale data, and
  keeps MSSS facts, derived values and your reading apart.
- **State samples and coverage** (history sample counts, archive gaps, missing
  regions, facilities, dates or periods) before calling something usual, a
  trend or a total. Every dataset has gaps that come and go; read them from
  the output each time, never from memory.

## 2. Pick the module

Load only the modules the question needs. Each one says how to query and read
one dataset; each has a CLI reference with the full output contract, to load
when you need a field's exact meaning.

| The question | Read | Command |
|--------------|------|---------|
| How busy is this ER or region right now? How do ERs compare? | [`urgences.md`](references/urgences.md) | `urgences` |
| Is it worse than this hospital's own norm? | [`urgences.md`](references/urgences.md), rules 7–10 | `urgences --baseline` |
| Is now unusual for this hour or weekday? When is it usually calmer? | [`urgences.md`](references/urgences.md), rules 11–14 | `urgences-historique`, with a live `urgences` call |
| Sainte-Justine and the Montreal Children's | [`urgences-children.md`](references/urgences-children.md) | `urgences --id 51222800,51223279` |
| Has an ER, region or the province done better or worse over fiscal years? | [`urgences-cumulatif.md`](references/urgences-cumulatif.md) | `urgences-cumulatif` |
| Which clinics near me usually offer appointments, and when? What non-urgent options exist? | [`cliniques.md`](references/cliniques.md) | `cliniques` |
| How long are surgery waitlists, by region or specialty? | [`chirurgies.md`](references/chirurgies.md) | `chirurgies` |

CLI references: [`cli-urgences.md`](references/cli-urgences.md) (`urgences`,
`urgences-historique`),
[`cli-urgences-cumulatif.md`](references/cli-urgences-cumulatif.md),
[`cli-cliniques.md`](references/cli-cliniques.md),
[`cli-chirurgies.md`](references/cli-chirurgies.md).

Questions that are about a decision more than a dataset:

- **"Which ER should I go to?", "where will I be seen fastest?", "how long
  will I wait?"** Answer standard §1, §2 and §5 first. Then, only as context,
  [`urgences.md`](references/urgences.md) rule 6, or rule 7 of
  [`urgences-children.md`](references/urgences-children.md) for the two
  pediatric ERs. Don't choose for them.
- **"No clinic has openings, so should I go to the ER?"** (or the reverse)
  That's a medical decision the data can't make. Answer standard §1, §2 and §5
  (811, a pharmacist, their own clinic, the GAP); then
  [`cliniques.md`](references/cliniques.md) if they want to know which clinics
  usually offer appointments.
- **Worried while waiting for surgery:** their surgeon's office, or 811,
  before any waitlist number.

## 3. Questions that span datasets

- **"Is it unusually crowded right now?"** Three views answer different
  questions; report each one you use, and don't merge them into one verdict
  unless they agree:
  - live `urgences`: how crowded it is now, against the region's ERs;
  - `--baseline`: yesterday's stretcher stay against this fiscal year's mean;
  - `urgences-historique`: now against the same hour (and weekday), with its
    sample count.
- **"Has overcrowding worsened over time?"** Fiscal years come from
  `urgences-cumulatif`, which has no occupancy rate (use its strain
  indicators). Hourly occupancy from `urgences-historique` has gaps, some of
  them months long: read `archive.gaps` (any call) to see which stretches
  exist, compare like periods that both have data (`--by day` with a `--days`
  that reaches back far enough), and check `window.coverage` before quoting
  either. Say which stretches you used.
- **ERs and clinics in the same region:** match a clinic's `rssCode` with the
  ER report's `regionCode`. Put them side by side as context, without claiming
  one explains the other, and never as a reason to choose one over the other.
- Every dataset has its own time (an hourly snapshot, a weekly clinic file, a
  fiscal period): give each one its own date in the answer.

## 4. Calling the CLI

- **Install:** the CLI must be built and linked onto your PATH (see **Install &
  link** in the repo README). If it isn't linked, run `node dist/cli.js` from
  the repo root instead of `quebec-sante`.
- **Always pass `--json`.** Tables are for humans.
- **Identify hospitals by `id`**, the MSSS permit number. It's stable; names
  aren't.
- **`--region`** takes an RSS code, a name or an alias (`06`, `montreal`,
  `mtl`) and means the same region in every command; `quebec-sante regions
  --json` lists every accepted spelling.
- **Freshness:** `dataDate` is MSSS's own update time; `cached` and
  `cacheAgeMinutes` describe the local cache. `--refresh` forces a fetch.
- **`null` means not published**, never zero. In `urgences`,
  `available: false` means the hospital isn't reporting right now.
- **Exit codes:** `0` ok · `1` network or HTTP error · `2` bad usage, or MSSS
  changed its file format.

## 5. Answer shape

Lead with the answer to the question asked, then the numbers, then what they
can't tell, and end with the source and the data's time (each module has an
example). If asked, forward the summary by email or message; that's an action
on top of this skill, whose job ends at the answer.
