import { readFile } from 'node:fs/promises';
import { fetchCliniquesCsv } from '../core/fetchCliniques';
import { parseCliniques } from '../core/parseCliniques';
import { readCliniquesCache, writeCliniquesCache, type CacheConfig } from '../core/cliniquesCache';
import {
  CLINIQUE_BAND_KEYS,
  type Clinic,
  type ClinicReportRow,
  type ClinicSummary,
  type CliniquesReport,
  type CliniquesSummary,
  type ProfessionGroupSummary,
} from '../core/types';
import { MSSS_CLINIQUES_URL } from '../core/source';
import { resolveRegion, rssCodeOf, type RssRegion } from '../core/regions';
import { UsageError } from '../core/errors';

export interface CliniquesFilters {
  /**
   * Filter to a region: an RSS region in any spelling `resolveRegion` accepts
   * (all of its RTS sub-regions), else a three-digit RTS code, else an
   * accent-insensitive substring of the RTS name (e.g. "Montérégie-Est").
   */
  region?: string;
  /** Filter to an RLS (local service network) by name (accent-insensitive). */
  rls?: string;
  /** Filter to a clinic by name (accent-insensitive substring). */
  search?: string;
  /**
   * A specific date (YYYY-MM-DD), or the last day of the window when `days`
   * is more than 1. Defaults to the latest date present in the source.
   */
  date?: string;
  /**
   * Window length in calendar days, ending at `date` (default 1: that date
   * only). Lets one call cover the week a pattern needs.
   */
  days?: number;
}

/** Largest `days` window: a month keeps a region's output a manageable size. */
export const CLINIQUES_MAX_DAYS = 31;

/** The ISO date `n` calendar days before `iso` (UTC, so no DST drift). */
export function shiftDate(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

export const SOURCE_URL = MSSS_CLINIQUES_URL;

/** Normalize text for accent-insensitive matching. */
export function normalize(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function regionMatches(c: Clinic, filter: string, resolved: RssRegion | null): boolean {
  if (resolved) return rssCodeOf(c.regionCode) === resolved.code;
  const f = filter.trim();
  if (/^\d{3}$/.test(f)) return c.regionCode === f;
  return normalize(c.regionName).toLowerCase().includes(normalize(f).toLowerCase());
}

function clinicMatches(
  c: Clinic,
  filters: CliniquesFilters,
  window: { from: string; to: string },
  resolved: RssRegion | null,
): boolean {
  if (c.date < window.from || c.date > window.to) return false;
  if (filters.region && !regionMatches(c, filters.region, resolved)) return false;
  if (
    filters.rls &&
    !normalize(c.rlsName).toLowerCase().includes(normalize(filters.rls).toLowerCase())
  )
    return false;
  if (
    filters.search &&
    !normalize(c.name).toLowerCase().includes(normalize(filters.search).toLowerCase())
  )
    return false;
  return true;
}

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** ISO weekday (1 = Monday … 7 = Sunday) and its English name for a YYYY-MM-DD date. */
export function weekdayOf(iso: string): { weekday: number; weekdayName: string } {
  const weekday = ((new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
  return { weekday, weekdayName: WEEKDAYS[weekday - 1]! };
}

type Band = (typeof CLINIQUE_BAND_KEYS)[number];
const byBand = <T>(f: (b: Band) => T): Record<Band, T> =>
  Object.fromEntries(CLINIQUE_BAND_KEYS.map((b) => [b, f(b)])) as Record<Band, T>;
const compareFr = (a: string, b: string): number => a.localeCompare(b, 'fr');
/** A clinic is a name within its RTS and RLS (the same name elsewhere is another clinic). */
const clinicKey = (c: Pick<Clinic, 'regionCode' | 'rlsCode' | 'name'>): string =>
  [c.regionCode, c.rlsCode, c.name].join('\u0000');

/**
 * Sum the rows per clinic × professional group and per professional group.
 * `dates` (the window's dates with data) is the "every day" denominator.
 * Alphabetical, so nothing is ranked.
 */
export function summarizeClinics(rows: ClinicReportRow[], dates: string[]): CliniquesSummary {
  const perClinic = new Map<string, ClinicSummary>();
  const bandDates = new Map<string, Record<Band, Set<string>>>();
  for (const r of rows) {
    const key = `${clinicKey(r)}\u0000${r.professionGroup}`;
    let s = perClinic.get(key);
    if (!s) {
      s = {
        name: r.name,
        professionGroup: r.professionGroup,
        regionCode: r.regionCode,
        regionName: r.regionName,
        rssCode: r.rssCode,
        rlsCode: r.rlsCode,
        rlsName: r.rlsName,
        daysWithOffers: 0,
        datesWithOffers: [],
        totalOffered: 0,
        bands: byBand(() => ({ offered: 0, daysWithOffers: 0 })),
      };
      perClinic.set(key, s);
      bandDates.set(key, byBand(() => new Set<string>()));
    }
    s.totalOffered += r.totalOffered;
    if (r.totalOffered > 0 && !s.datesWithOffers.includes(r.date)) s.datesWithOffers.push(r.date);
    const seen = bandDates.get(key)!;
    for (const b of CLINIQUE_BAND_KEYS) {
      const v = r.slots[b];
      if (v === null || v <= 0) continue;
      s.bands[b].offered += v;
      seen[b].add(r.date);
    }
  }
  for (const [key, s] of perClinic) {
    s.datesWithOffers.sort().reverse();
    s.daysWithOffers = s.datesWithOffers.length;
    for (const b of CLINIQUE_BAND_KEYS) s.bands[b].daysWithOffers = bandDates.get(key)![b].size;
  }
  const byClinic = [...perClinic.values()].sort(
    (a, b) =>
      compareFr(a.name, b.name) ||
      compareFr(a.professionGroup, b.professionGroup) ||
      compareFr(a.rlsName, b.rlsName) ||
      compareFr(a.regionName, b.regionName),
  );

  const everyDay = (n: number) => dates.length > 0 && n >= dates.length;
  const groups = [...new Set(byClinic.map((s) => s.professionGroup))].sort(compareFr);
  const byProfessionGroup: ProfessionGroupSummary[] = groups.map((g) => {
    const inGroup = byClinic.filter((s) => s.professionGroup === g);
    return {
      professionGroup: g,
      clinicsWithOffers: inGroup.filter((s) => s.daysWithOffers > 0).length,
      clinicsWithOffersEveryDay: inGroup.filter((s) => everyDay(s.daysWithOffers)).length,
      totalOffered: inGroup.reduce((n, s) => n + s.totalOffered, 0),
      bands: byBand((b) => ({
        offered: inGroup.reduce((n, s) => n + s.bands[b].offered, 0),
        clinicsWithOffers: inGroup.filter((s) => s.bands[b].daysWithOffers > 0).length,
        clinicsWithOffersEveryDay: inGroup.filter((s) => everyDay(s.bands[b].daysWithOffers)).length,
      })),
    };
  });
  const withOffers = new Set(byClinic.filter((s) => s.daysWithOffers > 0).map(clinicKey));
  return { clinicsWithOffers: withOffers.size, byProfessionGroup, byClinic };
}

/**
 * Assemble the report from parsed rows and the source's dates (newest first).
 * Pure except for `fetchedAt`.
 */
export function buildCliniquesReport(
  clinics: Clinic[],
  dates: string[],
  filters: CliniquesFilters,
  meta: { cached: boolean; cacheAgeMinutes: number },
): CliniquesReport {
  const days = filters.days ?? 1;
  if (!Number.isInteger(days) || days < 1 || days > CLINIQUES_MAX_DAYS) {
    throw new UsageError(`days must be a whole number from 1 to ${CLINIQUES_MAX_DAYS} (got ${days})`);
  }
  const to = filters.date ?? dates[0]!;
  const from = shiftDate(to, days - 1);
  const windowDates = dates.filter((d) => d >= from && d <= to);
  // MSSS can skip a date: name it, so "every day" (over `dates`) isn't read as the whole window.
  const have = new Set(windowDates);
  const missingDates = Array.from({ length: days }, (_, i) => shiftDate(to, i)).filter((d) => !have.has(d));
  const window = { from, to, days, missingDates };
  const resolved = filters.region ? resolveRegion(filters.region) : null;
  // rssCode is re-derived so rows from a cache written before it existed carry it too.
  // Newest date first, the same order as availableDates; source order within a date.
  const matched: ClinicReportRow[] = clinics
    .filter((c) => clinicMatches(c, filters, window, resolved))
    .map(({ date, ...rest }) => ({ date, ...weekdayOf(date), ...rest, rssCode: rssCodeOf(rest.regionCode) }))
    .sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? 1 : -1));

  return {
    source: SOURCE_URL,
    fetchedAt: new Date().toISOString(),
    dataDate: to,
    window,
    dates: windowDates,
    cached: meta.cached,
    cacheAgeMinutes: meta.cacheAgeMinutes,
    availableDates: dates.slice(0, CLINIQUES_MAX_DAYS),
    availableRange: { from: dates[dates.length - 1]!, to: dates[0]!, count: dates.length },
    clinics: matched,
    summary: summarizeClinics(matched, windowDates),
  };
}

/**
 * Build the filtered clinic report.
 *
 * Caching: the source is a large multi-year daily time-series. We cache the
 * *parsed* clinic list (not the raw file) so repeated `--date` queries hit the
 * cache instead of re-parsing the megabyte CSV. Serve from cache when fresh
 * unless `refresh`; on a miss, fetch + parse + cache, then return.
 */
export async function fetchCliniquesReport(opts: {
  filters?: CliniquesFilters;
  cache?: CacheConfig;
  fixture?: string;
}): Promise<CliniquesReport> {
  const cache = opts.cache ?? {};
  const cached = readCliniquesCache(cache);
  const { clinics, dates } =
    cached && cached.clinics.length > 0 && cached.dates.length > 0
      ? { clinics: cached.clinics, dates: cached.dates }
      : await loadFresh(opts.fixture, cache);
  return buildCliniquesReport(clinics, dates, opts.filters ?? {}, {
    cached: cached !== null,
    cacheAgeMinutes:
      cached !== null ? Math.round((Date.now() - Date.parse(cached.storedAt)) / 60_000) : 0,
  });
}

async function loadFresh(
  fixture: string | undefined,
  cache: CacheConfig,
): Promise<{ clinics: Clinic[]; dates: string[] }> {
  const fp = fixture ?? process.env.QUEBEC_SANTE_FIXTURE;
  const text = fp ? await readFile(fp, 'utf8') : await fetchCliniquesCsv();
  const { clinics, dates } = parseCliniques(text);
  writeCliniquesCache(clinics, dates, cache);
  return { clinics, dates };
}
