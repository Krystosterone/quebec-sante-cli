# Module: clinic appointment offers (`cliniques`)

Which clinics in an area have been offering appointments, and when, from
MSSS's clinic file, and the ways of actually getting a non-urgent
consultation.

The CLI returns offered-appointment counts per clinic and date, exactly as
MSSS publishes them. This module owns the interpretation: what those counts can
and can't say, and the summary.

**[`answer-standard.md`](answer-standard.md) applies to every answer.** For
this dataset, its key rules are:

- **This is past data.** MSSS publishes the file **weekly** (Thursdays at 14h),
  up to the day before. The newest date is 1 to 8 days old. Never say a
  clinic "has appointments today" or "has capacity now".
- **Offered isn't free or bookable.** The counts are appointments clinics
  connected to the booking hub offered for a date. Some were booked, some are
  reserved for the clinic's own patients, and clinics outside the hub aren't
  counted at all.
- **This data never decides between a clinic and the ER.** No offers doesn't
  mean "go to the ER", and many offers don't mean the ER isn't needed. If symptoms
  could be serious, 911 or the nearest ER comes first (§1). If unsure, 811.

## 1. Get the data

Query with **always `--json`**:

```bash
# A region (defaults to the latest date in the source):
quebec-sante cliniques --region <name> --json

# One local service network (RLS), e.g. a neighbourhood:
quebec-sante cliniques --region montreal --rls ahuntsic --json

# A specific clinic by name:
quebec-sante cliniques --search <clinic> --json

# The last 7 days in one call, to see whether a pattern holds:
quebec-sante cliniques --region montreal --rls ahuntsic --days 7 --json

# A window ending on an earlier date (here, the 7 days to that date):
quebec-sante cliniques --date YYYY-MM-DD --days 7 --rls ahuntsic --json
```

`--region` takes the same names and RSS codes as every other `quebec-sante`
command (`montreal`, `06`) and covers all of that region's RTS sub-regions.
To pair clinics with ERs in the same region, match a clinic's `rssCode` with
the ER report's `regionCode`.

The report has `clinics[]` (each: `name`, `regionName`, `rlsName`, `rssCode`,
`date`, `weekdayName`, `professionGroup`, `totalOffered`, and `slots` with six
time bands `6h_9h, 9h_12h, 12h_15h, 15h_18h, 18h_21h, 21h_6h`), `dataDate`
(the date of the appointments: the last day of the window), `window` (`from`,
`to`, `days`, and `missingDates`: the window's days the source has no rows
for), `dates` (the days in the window that have rows, newest first),
`availableDates` (the newest 31 dates in the source) and `availableRange`
(the whole source). `null` slots = no appointments offered in that band.

`summary` adds up those rows over the window: `byClinic[]` (one per clinic
and professional group: `daysWithOffers`, `datesWithOffers`, `totalOffered`,
and per band `offered` and `daysWithOffers`), `byProfessionGroup[]` (how many
clinics offered, and how many on every date, overall and per band) and
`clinicsWithOffers`. For the full command contract, field dictionary, exit
codes, and cache semantics, see [`cli-cliniques.md`](cli-cliniques.md).

## 2. Interpret

1. **The question this data answers:** "which clinics around here usually
   offer appointments, and at what times?". Not "is there a slot for me now?".
2. **Look at several dates before calling a pattern.** One day can be unusual,
   and weekdays differ from weekends. Use `--days 7`, so the window includes
   the same weekday as the person's need, in one call. Each row carries its
   `date` and `weekdayName`. Take a clinic's days and band totals from
   `summary.byClinic` ("evening slots on 4 of 7 days" is its band
   `daysWithOffers` against `dates`), and counts of clinics from
   `summary.byProfessionGroup`, rather than counting rows yourself. State the
   window (`window.from` to `window.to`) and how many of its `dates` had data.
   MSSS can leave a date out of the file: `window.missingDates` names it.
   Say so ("MSSS published no data for Oct 27"), and don't count it as a day
   without offers. "Every day" in the summary then means every day MSSS
   published, so say "all 6 published days of the 7".
3. **Time bands are the appointment's scheduled time.** A clinic that offered
   `18h_21h` slots on most recent days is one that does evening appointments.
   Don't call it open tonight.
4. **`professionGroup`:** `Médecin` covers physicians and residents;
   `Infirmière` covers nurses and specialized nurse practitioners. Say which.
   Each row is one clinic *and* group, so a clinic offering both appears
   twice: say how many clinics from `summary.clinicsWithOffers` (either
   group) or `byProfessionGroup[].clinicsWithOffers` (one group), not from
   the number of rows.
5. **More offers = a clinic that offers more appointments through the hub,**
   not better odds for this person. Don't rank clinics as if it were.
6. **Match the RLS to where the person is,** and name it. A clinic in a
   neighbouring RLS may be closer.
7. **Always add the routes to get care (answer standard §5):** 811 for advice,
   a pharmacist, their own clinic or GMF, the GAP if they have no family
   doctor, and the clinic's own booking system or Rendez-vous santé Québec to
   find an actual slot.

## 3. Summarize for the human

Lead with what the data shows, then the routes to care, then the limits.
Example shape:

> **Several Ahuntsic and Montréal-Nord clinics regularly offer appointments,
> including some in the evening.**
> - On 2026-10-28, the latest date MSSS has published, 15 clinics in the
>   Ahuntsic – Montréal-Nord RLS offered appointments.
>   District Médical offered 426 physician appointments, 25 between 18h and
>   21h. Clinique médicale Désy and District Médical Junior also offered evening
>   physician slots.
> - To get one: book through Rendez-vous santé Québec or the clinic. Call
>   Info-Santé 811 for advice, or ask a pharmacist. Without a family doctor,
>   the GAP (Québec.ca or 811) can direct you.
> - These are appointments offered a week ago, not openings now, and they
>   include only clinics on the provincial booking hub.
>
> _MSSS "Rendez-vous en clinique" file, published weekly; data for 2026-10-28._

Always state `dataDate` and that the file is weekly, so the reader knows it's
past data.
