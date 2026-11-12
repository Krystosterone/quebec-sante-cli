/**
 * `urgences-historique`: ER occupancy history from the static history API
 * (built from the hourly snapshots archived in archive/; see core/history.ts).
 *
 * Facts only: every figure is a mean/min/max over the archived snapshots in the
 * window, labelled DERIVED. Which hour is "best" is for the consumer to say.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FetchError, ParseError, UsageError } from '../core/errors';
import {
  DEFAULT_HISTORY_API_URL,
  GAP_HOURS,
  HISTORY_FIELDS,
  findGaps,
  hoursBetween,
  isHistoryIndex,
  isHistoryMonth,
  type HistoryGap,
  type HistoryIndex,
  type UrgencesHistoryMonth,
} from '../core/history';
import { readJsonCache, writeJsonCache, type CacheConfig } from '../core/jsonCache';
import { slugify } from '../core/parse';
import { resolveRegion } from '../core/regions';
import { normalize } from './urgences';

export type HistoryGroupBy = 'hour' | 'weekday-hour' | 'day';
export const HISTORY_GROUP_BY: readonly HistoryGroupBy[] = ['hour', 'weekday-hour', 'day'];
export const HISTORY_DEFAULT_DAYS = 28;
export const HISTORY_DEFAULT_TTL_MINUTES = 30;

export interface UrgencesHistoriqueFilters {
  region?: string;
  ids?: string[];
  search?: string;
}

/** DERIVED aggregates over the snapshots in one group (nulls ignored; 1 decimal). */
export interface HistoryAggregate {
  samples: number;
  occupancyPctMean: number | null;
  occupancyPctMin: number | null;
  occupancyPctMax: number | null;
  waitingForCareMean: number | null;
  totalPresentMean: number | null;
  over24hMean: number | null;
  dmsStretcherMean: number | null;
}

export interface HistoryProfileRow extends HistoryAggregate {
  /** Hour of day 0–23 (Québec local time, from MSSS's Mise_a_jour). Absent for --by day. */
  hour?: number;
  /** ISO weekday 1 (Monday) – 7 (Sunday). Only for --by weekday-hour. */
  weekday?: number;
  weekdayName?: string;
  /** YYYY-MM-DD. Only for --by day. */
  date?: string;
}

export interface HistoryLatest {
  dataDate: string;
  occupancyPct: number | null;
  waitingForCare: number | null;
  totalPresent: number | null;
  /** DERIVED: mean occupancy at the same hour of day over the rest of the window. */
  typicalOccupancyPct: number | null;
  /** DERIVED: mean occupancy at the same weekday and hour over the rest of the window. */
  typicalOccupancyPctSameWeekday: number | null;
  /** DERIVED: occupancyPct − typicalOccupancyPct. */
  deltaFromTypicalPct: number | null;
}

export interface HistoryFacilityReport {
  id: string;
  name: string;
  establishment: string;
  regionCode: string | null;
  region: string;
  /**
   * The window's archived snapshots, split three ways (they sum to
   * `window.snapshots`): `reporting` (listed with stretcher figures),
   * `notReporting` (listed with every stretcher figure blank, live
   * `available: false`), `absent` (not in that snapshot's file at all).
   */
  snapshots: { reporting: number; notReporting: number; absent: number };
  /** DERIVED: over every snapshot in the window. */
  summary: HistoryAggregate;
  /** The facility's most recent snapshot in the window, vs its typical level. */
  latest: HistoryLatest | null;
  profile: HistoryProfileRow[];
}

export interface UrgencesHistoriqueReport {
  source: string;
  dataset: 'urgences';
  /** When the API was built from the archive. */
  generatedAt: string;
  fetchedAt: string;
  /** True when every API document came from the local cache. */
  cached: boolean;
  window: {
    /** Exclusive lower bound (to − days). */
    from: string;
    /** The latest snapshot in the archive (not the wall clock). */
    to: string;
    days: number;
    /** Snapshots in the window. */
    snapshots: number;
    /** Earliest snapshot the archive has; a window starting earlier is truncated. */
    archiveStart: string | null;
    coverage: HistoryCoverage;
  };
  /** The whole archive, whatever the window. */
  archive: {
    first: string | null;
    last: string | null;
    snapshots: number;
    /** Every gap over 6 h in the archive, oldest first; null when the API predates the field. */
    gaps: HistoryGap[] | null;
  };
  groupBy: HistoryGroupBy;
  facilities: HistoryFacilityReport[];
}

/** What the window holds (an archive always has gaps; this says where). */
export interface HistoryCoverage {
  /** One snapshot per hour of the window (`days` × 24): what a gap-free archive would hold. */
  expectedSnapshots: number;
  /** Runs of archived snapshots with no gap over 6 h inside, oldest first. */
  ranges: Array<{ from: string; to: string; snapshots: number }>;
  /**
   * Spans over 6 h with no archived snapshot, oldest first. The first one
   * starts at `window.from` when the window opens before its first snapshot.
   */
  gaps: HistoryGap[];
}

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const IDX = Object.fromEntries(HISTORY_FIELDS.map((f, i) => [f, i])) as Record<(typeof HISTORY_FIELDS)[number], number>;
const TIMEOUT_MS = 60_000;

// ---------- loading ----------

interface LoadOpts {
  api: string;
  fixtureDir?: string;
  cache: CacheConfig;
}

async function fetchJson(url: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { 'user-agent': 'quebec-sante-cli (+open-data; history API client)' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new FetchError(`network error fetching ${url}: ${(err as Error).message}`);
  }
  if (res.status === 404) {
    throw new FetchError(
      `HTTP 404 fetching ${url}: no history API there yet (GitHub Pages not enabled, or the archive job has not deployed)`,
    );
  }
  if (!res.ok) throw new FetchError(`HTTP ${res.status} ${res.statusText} fetching ${url}`);
  try {
    return await res.json();
  } catch (err) {
    throw new ParseError(`invalid JSON from ${url}: ${(err as Error).message}`);
  }
}

/** Read one API document: fixture dir, else cache, else network (then cache). */
async function loadDoc<T>(
  rel: string,
  opts: LoadOpts,
  isValid: (x: unknown) => x is T,
  ttlMinutes: number,
  acceptCached: (x: T) => boolean = () => true,
): Promise<{ doc: T; cached: boolean }> {
  if (opts.fixtureDir) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(join(opts.fixtureDir, rel), 'utf8'));
    } catch (err) {
      throw new FetchError(`cannot read ${join(opts.fixtureDir, rel)}: ${(err as Error).message}`);
    }
    if (!isValid(parsed)) throw new ParseError(`${rel}: not a schema-1 history document`);
    return { doc: parsed, cached: false };
  }
  const file = `history-v1-${slugify(opts.api)}-${rel.replace(/[^A-Za-z0-9.-]+/g, '_')}`;
  const hit = readJsonCache(file, opts.cache, ttlMinutes, isValid);
  if (hit && acceptCached(hit.payload)) return { doc: hit.payload, cached: true };
  const doc = await fetchJson(`${opts.api.replace(/\/+$/, '')}/${rel}`);
  if (!isValid(doc)) throw new ParseError(`${rel}: not a schema-1 history document (API changed?)`);
  writeJsonCache(file, doc, opts.cache);
  return { doc, cached: false };
}

// ---------- pure aggregation ----------

/** Naive local "YYYY-MM-DDTHH:MM" ± days, computed on the wall-clock fields (no time zone). */
export function shiftDays(stamp: string, days: number): string {
  const ms = Date.parse(`${stamp}:00Z`) + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 16);
}

function isoWeekday(stamp: string): number {
  const d = new Date(`${stamp.slice(0, 10)}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return d === 0 ? 7 : d;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const mean = (xs: number[]) => (xs.length ? round1(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

interface Sample {
  stamp: string;
  occupancyPct: number | null;
  waitingForCare: number | null;
  totalPresent: number | null;
  over24h: number | null;
  dmsStretcher: number | null;
}

function aggregate(samples: Sample[]): HistoryAggregate {
  const pick = (k: keyof Omit<Sample, 'stamp'>) => samples.map((s) => s[k]).filter((v): v is number => v !== null);
  const occ = pick('occupancyPct');
  return {
    samples: samples.length,
    occupancyPctMean: mean(occ),
    occupancyPctMin: occ.length ? round1(Math.min(...occ)) : null,
    occupancyPctMax: occ.length ? round1(Math.max(...occ)) : null,
    waitingForCareMean: mean(pick('waitingForCare')),
    totalPresentMean: mean(pick('totalPresent')),
    over24hMean: mean(pick('over24h')),
    dmsStretcherMean: mean(pick('dmsStretcher')),
  };
}

function groupKey(stamp: string, by: HistoryGroupBy): string {
  if (by === 'day') return stamp.slice(0, 10);
  const hour = stamp.slice(11, 13);
  return by === 'hour' ? hour : `${isoWeekday(stamp)}-${hour}`;
}

function profileRow(key: string, by: HistoryGroupBy, samples: Sample[]): HistoryProfileRow {
  const agg = aggregate(samples);
  if (by === 'day') return { date: key, ...agg };
  if (by === 'hour') return { hour: Number(key), ...agg };
  const [wd, hour] = key.split('-');
  return { weekday: Number(wd), weekdayName: WEEKDAYS[Number(wd) - 1], hour: Number(hour), ...agg };
}

/** Ranges and gaps of the window's snapshots (ascending), from `from` (exclusive). */
export function windowCoverage(from: string, days: number, snapshots: readonly string[]): HistoryCoverage {
  const gaps = findGaps(snapshots);
  const first = snapshots[0];
  if (first === undefined) {
    return { expectedSnapshots: days * 24, ranges: [], gaps: [] };
  }
  const lead = hoursBetween(from, first);
  const ranges: HistoryCoverage['ranges'] = [];
  let start = 0;
  for (let i = 1; i <= snapshots.length; i++) {
    if (i === snapshots.length || hoursBetween(snapshots[i - 1]!, snapshots[i]!) > GAP_HOURS) {
      ranges.push({ from: snapshots[start]!, to: snapshots[i - 1]!, snapshots: i - start });
      start = i;
    }
  }
  return {
    expectedSnapshots: days * 24,
    ranges,
    gaps: lead > GAP_HOURS ? [{ from, to: first, hours: lead }, ...gaps] : gaps,
  };
}

/** Live `urgences`' `available`: at least one stretcher figure published. */
const STRETCHER_FIELDS = [IDX.stretchersFunctional, IDX.stretchersOccupied, IDX.over24h, IDX.over48h];

function facilityMatches(
  f: { id: string; name: string; regionCode: string | null; region: string },
  filters: UrgencesHistoriqueFilters,
): boolean {
  if (filters.ids && filters.ids.length > 0) return filters.ids.includes(f.id);
  if (filters.region) {
    const resolved = resolveRegion(filters.region);
    if (resolved) {
      if (f.regionCode !== resolved.code) return false;
    } else if (
      normalize(f.region).toLowerCase() !== normalize(filters.region).toLowerCase() &&
      slugify(f.region) !== slugify(filters.region)
    ) {
      return false;
    }
  }
  if (filters.search && !normalize(f.name).toLowerCase().includes(normalize(filters.search).toLowerCase())) {
    return false;
  }
  return true;
}

/**
 * Pure: build the report from the index and the month documents covering the
 * window. Deterministic for given inputs (`fetchedAt` supplied by the caller).
 */
export function buildHistoriqueReport(
  index: HistoryIndex,
  months: UrgencesHistoryMonth[],
  opts: { days: number; groupBy: HistoryGroupBy; filters: UrgencesHistoriqueFilters; source: string; fetchedAt: string; cached: boolean },
): UrgencesHistoriqueReport {
  const u = index.datasets.urgences;
  const to = u.last;
  if (!to) throw new FetchError('the history API has no snapshots yet');
  const from = shiftDays(to, -opts.days);

  const facilities = new Map<
    string,
    { meta: Omit<HistoryFacilityReport, 'snapshots' | 'summary' | 'latest' | 'profile'>; samples: Sample[]; notReporting: number }
  >();
  const windowSnapshots = new Set<string>();
  for (const m of [...months].sort((a, b) => a.month.localeCompare(b.month))) {
    for (const f of m.facilities) {
      const meta = { id: f.id, name: f.name, establishment: f.establishment, regionCode: f.regionCode, region: f.region };
      if (!facilityMatches(meta, opts.filters)) continue;
      let entry = facilities.get(f.id);
      if (!entry) {
        entry = { meta, samples: [], notReporting: 0 };
        facilities.set(f.id, entry);
      }
      entry.meta = meta; // latest naming wins (months are ascending)
      m.snapshots.forEach((stamp, i) => {
        if (stamp <= from || stamp > to) return;
        const v = f.values[i];
        if (!v) return;
        if (STRETCHER_FIELDS.every((k) => v[k] == null)) entry!.notReporting++;
        const functional = v[IDX.stretchersFunctional] ?? null;
        const occupied = v[IDX.stretchersOccupied] ?? null;
        entry!.samples.push({
          stamp,
          occupancyPct: functional && occupied !== null ? (occupied / functional) * 100 : null,
          waitingForCare: v[IDX.waitingForCare] ?? null,
          totalPresent: v[IDX.totalPresent] ?? null,
          over24h: v[IDX.over24h] ?? null,
          dmsStretcher: v[IDX.dmsStretcher] ?? null,
        });
      });
    }
  }
  for (const m of months) for (const s of m.snapshots) if (s > from && s <= to) windowSnapshots.add(s);

  const reports: HistoryFacilityReport[] = [...facilities.values()].map(({ meta, samples, notReporting }) => {
    samples.sort((a, b) => a.stamp.localeCompare(b.stamp));
    const groups = new Map<string, Sample[]>();
    for (const s of samples) {
      const k = groupKey(s.stamp, opts.groupBy);
      const g = groups.get(k);
      if (g) g.push(s);
      else groups.set(k, [s]);
    }
    const profile = [...groups.keys()].sort().map((k) => profileRow(k, opts.groupBy, groups.get(k)!));

    let latest: HistoryLatest | null = null;
    const last = samples[samples.length - 1];
    if (last) {
      const others = samples.slice(0, -1);
      const sameHour = others.filter((s) => s.stamp.slice(11, 13) === last.stamp.slice(11, 13));
      const sameSlot = sameHour.filter((s) => isoWeekday(s.stamp) === isoWeekday(last.stamp));
      const typical = aggregate(sameHour).occupancyPctMean;
      const occ = last.occupancyPct === null ? null : round1(last.occupancyPct);
      latest = {
        dataDate: last.stamp,
        occupancyPct: occ,
        waitingForCare: last.waitingForCare,
        totalPresent: last.totalPresent,
        typicalOccupancyPct: typical,
        typicalOccupancyPctSameWeekday: aggregate(sameSlot).occupancyPctMean,
        deltaFromTypicalPct: occ !== null && typical !== null ? round1(occ - typical) : null,
      };
    }
    const snapshots = {
      reporting: samples.length - notReporting,
      notReporting,
      absent: windowSnapshots.size - samples.length,
    };
    return { ...meta, snapshots, summary: aggregate(samples), latest, profile };
  });

  reports.sort((a, b) => (a.regionCode ?? '').localeCompare(b.regionCode ?? '') || a.name.localeCompare(b.name));
  return {
    source: opts.source,
    dataset: 'urgences',
    generatedAt: index.generatedAt,
    fetchedAt: opts.fetchedAt,
    cached: opts.cached,
    window: {
      from,
      to,
      days: opts.days,
      snapshots: windowSnapshots.size,
      archiveStart: u.first,
      coverage: windowCoverage(from, opts.days, [...windowSnapshots].sort()),
    },
    archive: { first: u.first, last: u.last, snapshots: u.snapshots, gaps: u.gaps ?? null },
    groupBy: opts.groupBy,
    facilities: reports,
  };
}

// ---------- orchestration ----------

export async function fetchUrgencesHistoriqueReport(opts: {
  filters?: UrgencesHistoriqueFilters;
  days?: number;
  groupBy?: HistoryGroupBy;
  /** API base URL (default $QUEBEC_SANTE_API_URL, else the GitHub Pages API). */
  api?: string;
  /** Read a local API directory (containing index.json) instead of the network. */
  fixture?: string;
  cache?: CacheConfig;
}): Promise<UrgencesHistoriqueReport> {
  const days = opts.days ?? HISTORY_DEFAULT_DAYS;
  const groupBy = opts.groupBy ?? 'hour';
  if (!Number.isInteger(days) || days < 1) throw new UsageError('--days must be a positive whole number');
  const api = opts.api ?? process.env.QUEBEC_SANTE_API_URL ?? DEFAULT_HISTORY_API_URL;
  const fixtureDir = opts.fixture ?? process.env.QUEBEC_SANTE_API_FIXTURE;
  const cache = opts.cache ?? {};
  const ttl = cache.ttlMinutes ?? HISTORY_DEFAULT_TTL_MINUTES;
  const load: LoadOpts = { api, fixtureDir, cache };

  const { doc: index, cached: indexCached } = await loadDoc('index.json', load, isHistoryIndex, ttl);
  const u = index.datasets.urgences;
  let allCached = indexCached;
  const months: UrgencesHistoryMonth[] = [];
  if (u.last) {
    const from = shiftDays(u.last, -days);
    const wanted = u.months.filter((m) => m.last > from && m.first <= u.last!);
    for (const m of wanted) {
      // The live archive no longer adds to a complete month, but a backfill
      // can: keep a cached copy only while it matches the index entry.
      const matchesIndex = (d: UrgencesHistoryMonth) =>
        d.complete &&
        d.snapshots.length === m.snapshots &&
        d.snapshots[0] === m.first &&
        d.snapshots[d.snapshots.length - 1] === m.last;
      const { doc, cached } = m.complete
        ? await loadDoc(m.path, { ...load, cache: { ...cache, refresh: false } }, isHistoryMonth, Infinity, matchesIndex)
        : await loadDoc(m.path, load, isHistoryMonth, ttl);
      allCached &&= cached;
      months.push(doc);
    }
  }
  return buildHistoriqueReport(index, months, {
    days,
    groupBy,
    filters: opts.filters ?? {},
    source: fixtureDir ? `file://${fixtureDir}` : api,
    fetchedAt: new Date().toISOString(),
    cached: allCached,
  });
}
