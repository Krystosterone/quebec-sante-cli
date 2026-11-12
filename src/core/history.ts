/**
 * The static history API (schema v1): types, and the pure builder that turns
 * archived snapshots of the hourly ER CSV into monthly documents.
 *
 * Layout, served from GitHub Pages under <base> (e.g.
 * https://krystosterone.github.io/quebec-sante-cli/api/v1):
 *
 *   <base>/index.json                  HistoryIndex: what exists
 *   <base>/urgences/<YYYY-MM>.json     UrgencesHistoryMonth: every snapshot of a month
 *
 * Months are keyed by the snapshot's own `Mise_a_jour` (Québec local time, as
 * MSSS publishes it). A month before the latest snapshot's month is
 * `complete`: the live archive no longer adds to it. A backfill still can, so a
 * client keeps a cached complete month only while it matches the index entry.
 *
 * The archive always has gaps (the job runs on one computer; MSSS skips or
 * delays publications), so the index lists every gap over GAP_HOURS.
 */
import { parseUrgences } from './parse';
import { MSSS_URGENCES_URL } from './source';

export const HISTORY_SCHEMA = 1;

/** Default public API base (GitHub Pages of this repo). Override with QUEBEC_SANTE_API_URL or --api. */
export const DEFAULT_HISTORY_API_URL = 'https://krystosterone.github.io/quebec-sante-cli/api/v1';

/** Per-snapshot values, in this order (verbatim from the CSV; null when blank). */
export const HISTORY_FIELDS = [
  'stretchersFunctional',
  'stretchersOccupied',
  'over24h',
  'over48h',
  'totalPresent',
  'waitingForCare',
  'dmsStretcher',
  'dmsAmbulatory',
] as const;
export type HistoryField = (typeof HISTORY_FIELDS)[number];

/**
 * A span between two consecutive archived snapshots longer than GAP_HOURS:
 * nothing was archived in it, whether the job missed it or MSSS published
 * nothing (the archive can't tell which).
 */
export interface HistoryGap {
  /** Last snapshot before the gap (YYYY-MM-DDTHH:MM, Québec local time). */
  from: string;
  /** First snapshot after it. */
  to: string;
  /** Wall-clock hours between them, 1 decimal. */
  hours: number;
}

/** MSSS publishes hourly; a longer silence than this counts as a gap. */
export const GAP_HOURS = 6;

/** Hours between two naive local stamps (wall clock, so ±1 across a DST change). */
export function hoursBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}:00Z`) - Date.parse(`${a}:00Z`)) / 360_000) / 10;
}

/** Gaps over GAP_HOURS between consecutive snapshots of an ascending list. */
export function findGaps(snapshots: readonly string[]): HistoryGap[] {
  const gaps: HistoryGap[] = [];
  for (let i = 1; i < snapshots.length; i++) {
    const hours = hoursBetween(snapshots[i - 1]!, snapshots[i]!);
    if (hours > GAP_HOURS) gaps.push({ from: snapshots[i - 1]!, to: snapshots[i]!, hours });
  }
  return gaps;
}

export interface HistoryFacility {
  /** MSSS permit number (stable id). */
  id: string;
  /** Latest name/establishment/region seen for this id in the month. */
  name: string;
  establishment: string;
  regionCode: string | null;
  region: string;
  /**
   * One entry per `snapshots[i]`: the HISTORY_FIELDS values, or null when the
   * facility was absent from that snapshot.
   */
  values: Array<Array<number | null> | null>;
}

export interface UrgencesHistoryMonth {
  schema: number;
  dataset: 'urgences';
  source: string;
  month: string; // YYYY-MM
  /**
   * True once a later month has data: the live archive no longer adds to it.
   * A backfill can, so check `snapshots`/`first`/`last` against the index.
   */
  complete: boolean;
  fields: readonly HistoryField[];
  /** Each snapshot's `Mise_a_jour` (YYYY-MM-DDTHH:MM, Québec local time), ascending, unique. */
  snapshots: string[];
  facilities: HistoryFacility[];
}

export interface HistoryMonthEntry {
  month: string;
  path: string; // relative to the API base
  snapshots: number;
  first: string;
  last: string;
  complete: boolean;
}

export interface HistoryIndex {
  schema: number;
  generatedAt: string;
  /** Commit of the archive the API was built from, when known. */
  archiveCommit: string | null;
  datasets: {
    urgences: {
      source: string;
      snapshots: number;
      first: string | null;
      last: string | null;
      /** Archived versions that could not be parsed (skipped). */
      skippedVersions: number;
      /**
       * Every gap over GAP_HOURS between `first` and `last`, oldest first.
       * Absent from APIs built before it existed.
       */
      gaps?: HistoryGap[];
      months: HistoryMonthEntry[];
    };
  };
}

/** One archived version of the hourly CSV, already decoded to text. */
export interface ArchivedVersion {
  /** Commit (or any label) the version came from; used in warnings only. */
  ref: string;
  csv: string;
}

const DATA_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/**
 * Build the monthly documents + index from archived versions, oldest first.
 * When two versions carry the same `Mise_a_jour`, the later one wins (a
 * republished correction). Versions that fail to parse are skipped and counted.
 * Pure: the caller supplies `generatedAt`.
 */
export function buildHistory(
  versions: Iterable<ArchivedVersion>,
  opts: { generatedAt: string; archiveCommit?: string | null; warn?: (msg: string) => void },
): { index: HistoryIndex; months: UrgencesHistoryMonth[] } {
  const bySnapshot = new Map<string, Map<string, { meta: Omit<HistoryFacility, 'values'>; values: Array<number | null> }>>();
  let skipped = 0;

  for (const v of versions) {
    let parsed: ReturnType<typeof parseUrgences>;
    try {
      parsed = parseUrgences(v.csv);
    } catch (err) {
      skipped++;
      opts.warn?.(`skipping ${v.ref}: ${(err as Error).message}`);
      continue;
    }
    if (!DATA_DATE_RE.test(parsed.dataDate)) {
      skipped++;
      opts.warn?.(`skipping ${v.ref}: unexpected Mise_a_jour "${parsed.dataDate}"`);
      continue;
    }
    const rows = new Map<string, { meta: Omit<HistoryFacility, 'values'>; values: Array<number | null> }>();
    for (const region of parsed.regions) {
      for (const f of region.facilities) {
        if (!f.id) continue;
        rows.set(f.id, {
          meta: {
            id: f.id,
            name: f.name,
            establishment: f.establishment,
            regionCode: f.regionCode,
            region: region.name,
          },
          values: HISTORY_FIELDS.map((k) => f[k]),
        });
      }
    }
    bySnapshot.set(parsed.dataDate, rows);
  }

  const snapshots = [...bySnapshot.keys()].sort();
  const latestMonth = snapshots.length ? snapshots[snapshots.length - 1]!.slice(0, 7) : null;
  const monthKeys = [...new Set(snapshots.map((s) => s.slice(0, 7)))];

  const months: UrgencesHistoryMonth[] = monthKeys.map((month) => {
    const snaps = snapshots.filter((s) => s.startsWith(month));
    const facilities = new Map<string, HistoryFacility>();
    snaps.forEach((snap, i) => {
      for (const [id, row] of bySnapshot.get(snap)!) {
        let f = facilities.get(id);
        if (!f) {
          f = { ...row.meta, values: new Array(snaps.length).fill(null) };
          facilities.set(id, f);
        }
        Object.assign(f, row.meta); // keep the latest naming
        f.values[i] = row.values;
      }
    });
    return {
      schema: HISTORY_SCHEMA,
      dataset: 'urgences',
      source: MSSS_URGENCES_URL,
      month,
      complete: month !== latestMonth,
      fields: HISTORY_FIELDS,
      snapshots: snaps,
      facilities: [...facilities.values()].sort((a, b) => a.id.localeCompare(b.id)),
    };
  });

  const index: HistoryIndex = {
    schema: HISTORY_SCHEMA,
    generatedAt: opts.generatedAt,
    archiveCommit: opts.archiveCommit ?? null,
    datasets: {
      urgences: {
        source: MSSS_URGENCES_URL,
        snapshots: snapshots.length,
        first: snapshots[0] ?? null,
        last: snapshots[snapshots.length - 1] ?? null,
        skippedVersions: skipped,
        gaps: findGaps(snapshots),
        months: months.map((m) => ({
          month: m.month,
          path: `urgences/${m.month}.json`,
          snapshots: m.snapshots.length,
          first: m.snapshots[0]!,
          last: m.snapshots[m.snapshots.length - 1]!,
          complete: m.complete,
        })),
      },
    },
  };
  return { index, months };
}

export function isHistoryIndex(x: unknown): x is HistoryIndex {
  const i = x as HistoryIndex | null;
  return !!i && i.schema === HISTORY_SCHEMA && Array.isArray(i.datasets?.urgences?.months);
}

export function isHistoryMonth(x: unknown): x is UrgencesHistoryMonth {
  const m = x as UrgencesHistoryMonth | null;
  return (
    !!m &&
    m.schema === HISTORY_SCHEMA &&
    m.dataset === 'urgences' &&
    Array.isArray(m.snapshots) &&
    Array.isArray(m.facilities) &&
    Array.isArray(m.fields)
  );
}
