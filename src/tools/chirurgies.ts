import { readFile } from 'node:fs/promises';
import { fetchUtf8Csv } from '../core/fetchUtf8';
import { parseChirurgies } from '../core/parseChirurgies';
import { readChirurgiesCache, writeChirurgiesCache, type CacheConfig } from '../core/chirurgiesCache';
import { slugify } from '../core/parse';
import { UsageError } from '../core/errors';
import { MSSS_CHIRURGIES_URL } from '../core/source';
import { resolveRegion } from '../core/regions';
import {
  CHIRURGIE_SPECIALTIES,
  RSS_REGIONS,
  type ChirurgieRegion,
  type ChirurgieRow,
  type ChirurgiePeriod,
  type ChirurgieSpecialtyKey,
  type ChirurgieWaitBands,
  type ChirurgieWaitlist,
  type ChirurgiesReport,
  type ChirurgiesMultiReport,
} from '../core/types';

export interface ChirurgiesFilters {
  /** Region by name/slug (accent-insensitive substring) or RSS code ("RSS06", "06", "6"). */
  region?: string;
  /** Specialty by label or key (accent-insensitive substring), e.g. "ortho". */
  specialty?: string;
  /** A fiscal period code, e.g. "2627-P04". Defaults to the latest present. */
  period?: string;
}

export interface ChirurgiesMultiFilters extends Omit<ChirurgiesFilters, 'period'> {
  /** Explicit period codes, reported in this order. */
  periods?: string[];
  /** The same period number in each of the last `years` fiscal years, ending at `period`. */
  years?: number;
  /** With `years`: the newest period (default: the latest in the source). */
  period?: string;
}

/** Most periods one multi-period call reports: a full fiscal year of periods. */
export const CHIRURGIES_MAX_PERIODS = 13;

export const SOURCE_URL = MSSS_CHIRURGIES_URL;
const PROVINCE_NAME = 'Ensemble du Québec';

/** Normalize text for accent-insensitive matching. */
export function normalize(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Decode "2627-P04" → { fiscalYear: "2026-2027", number: 4 }. */
export function decodePeriod(code: string): ChirurgiePeriod {
  const m = /^(\d{2})(\d{2})-P(\d{2})$/.exec(code);
  if (!m) return { code, fiscalYear: '', number: 0 };
  return { code, fiscalYear: `20${m[1]}-20${m[2]}`, number: Number(m[3]) };
}

/** The fiscal period before `code`: "2627-P01" → "2526-P13"; null when `code` isn't a period. */
export function previousFiscalPeriod(code: string): string | null {
  const m = /^(\d{2})(\d{2})-P(\d{2})$/.exec(code);
  if (!m) return null;
  const n = Number(m[3]);
  if (n > 1) return `${m[1]}${m[2]}-P${String(n - 1).padStart(2, '0')}`;
  return `${samePeriodYearsBack(code, 1).slice(0, 4)}-P13`;
}

/**
 * The fiscal periods strictly between `previous` and `period` (newest first):
 * the ones a delta from `previous` spans without the source having them.
 */
export function periodsBetween(period: string, previous: string | null): string[] {
  if (!previous) return [];
  const out: string[] = [];
  for (let p = previousFiscalPeriod(period); p && p > previous && out.length <= 13 * 100; p = previousFiscalPeriod(p)) {
    out.push(p);
  }
  return out;
}

/** Resolve a --specialty filter to the matching specialty keys (all when absent). */
export function resolveSpecialties(filter: string | undefined): ChirurgieSpecialtyKey[] {
  if (!filter) return CHIRURGIE_SPECIALTIES.map((s) => s.key);
  const want = normalize(filter).replace(/[^a-z0-9]+/g, ' ').trim();
  const hits = CHIRURGIE_SPECIALTIES.filter((s) => {
    const hay = `${normalize(s.label)} ${s.key.replace(/_/g, ' ')}`.replace(/[^a-z0-9]+/g, ' ');
    return hay.includes(want);
  }).map((s) => s.key);
  if (hits.length === 0) {
    throw new UsageError(
      `unknown specialty "${filter}". Known: ${CHIRURGIE_SPECIALTIES.map((s) => s.key).join(', ')}`,
    );
  }
  return hits;
}

function regionMatches(code: string, name: string, filter: string): boolean {
  const resolved = resolveRegion(filter);
  if (resolved) return code === `RSS${resolved.code}`;
  const f = filter.trim();
  const asCode = /^(?:rss)?\s*(\d{1,2})$/i.exec(f);
  if (asCode) return code === `RSS${asCode[1]!.padStart(2, '0')}`;
  const want = slugify(f);
  return want !== '' && slugify(name).includes(want);
}

/** Build a waitlist (verbatim bands + derived totals/percentages, and the change from `previous`). */
function waitlist(
  key: ChirurgieWaitlist['key'],
  label: string,
  waiting: ChirurgieWaitBands,
  previous: { total: number | null; delta: number | null },
): ChirurgieWaitlist {
  const total = (waiting.under6m ?? 0) + (waiting.from6to12m ?? 0) + (waiting.over12m ?? 0);
  const over6m = (waiting.from6to12m ?? 0) + (waiting.over12m ?? 0);
  const pct = (n: number) => (total === 0 ? null : Math.round((100 * n) / total));
  return {
    key,
    label,
    waiting,
    total,
    over6m,
    pctOver6m: pct(over6m),
    pctOver12m: pct(waiting.over12m ?? 0),
    previousPeriodTotal: previous.total,
    deltaFromPreviousPeriod: previous.delta,
  };
}

/** True when at least one band was published. */
const published = (b: ChirurgieWaitBands): boolean =>
  b.under6m !== null || b.from6to12m !== null || b.over12m !== null;
const bandsTotal = (b: ChirurgieWaitBands): number => (b.under6m ?? 0) + (b.from6to12m ?? 0) + (b.over12m ?? 0);

const emptyBands = (): ChirurgieWaitBands => ({ under6m: null, from6to12m: null, over12m: null });

/** Add `v` into a band cell; null + null stays null (nothing published anywhere). */
function addInto(bands: ChirurgieWaitBands, band: keyof ChirurgieWaitBands, v: number | null): void {
  if (v === null) return;
  bands[band] = (bands[band] ?? 0) + v;
}

/** Per-band sums of the `Total` column and of each specialty column over `rows`. */
function sumBands(rows: ChirurgieRow[], specialties: ChirurgieSpecialtyKey[]) {
  const overall = emptyBands();
  const perSpecialty = new Map(specialties.map((k) => [k, emptyBands()]));
  for (const r of rows) {
    addInto(overall, r.band, r.total);
    for (const [k, bands] of perSpecialty) addInto(bands, r.band, r.counts[k]);
  }
  return { overall, perSpecialty };
}

/**
 * Aggregate a set of rows (one region, or every region) into a ChirurgieRegion.
 * `previousRows` is the same scope in the previous period, or null when there
 * is nothing comparable (the region was absent, or the province covered other regions).
 */
function buildRegion(
  code: string | null,
  name: string,
  rows: ChirurgieRow[],
  specialties: ChirurgieSpecialtyKey[],
  previousRows: ChirurgieRow[] | null,
): ChirurgieRegion {
  const current = sumBands(rows, specialties);
  const previous = previousRows ? sumBands(previousRows, specialties) : null;
  const previousPeriodTotal = previousRows ? sumTotals(previousRows) : null;
  const overallTotal = bandsTotal(current.overall);
  const deltaFromPreviousPeriod = previousPeriodTotal === null ? null : overallTotal - previousPeriodTotal;
  const overall = waitlist('total', 'Toutes spécialités', current.overall, {
    total: previousPeriodTotal,
    delta: deltaFromPreviousPeriod,
  });
  const specialtyWaitlist = (k: ChirurgieSpecialtyKey, label: string): ChirurgieWaitlist => {
    const now = current.perSpecialty.get(k)!;
    const before = previous?.perSpecialty.get(k);
    const prevTotal = before && published(before) ? bandsTotal(before) : null;
    const delta = prevTotal !== null && published(now) ? bandsTotal(now) - prevTotal : null;
    return waitlist(k, label, now, { total: prevTotal, delta });
  };
  return {
    code,
    name,
    slug: slugify(name),
    overall,
    specialties: CHIRURGIE_SPECIALTIES.filter((s) => current.perSpecialty.has(s.key)).map((s) =>
      specialtyWaitlist(s.key, s.label),
    ),
    previousPeriodTotal,
    deltaFromPreviousPeriod,
  };
}

/** Sum of the published `Total` column over rows (null when nothing published). */
function sumTotals(rows: ChirurgieRow[]): number | null {
  const vals = rows.map((r) => r.total).filter((v): v is number => v !== null);
  return vals.length === 0 ? null : vals.reduce((a, b) => a + b, 0);
}

function groupByRegion(rows: ChirurgieRow[]): Map<string, ChirurgieRow[]> {
  const out = new Map<string, ChirurgieRow[]>();
  for (const r of rows) {
    if (!out.has(r.regionCode)) out.set(r.regionCode, []);
    out.get(r.regionCode)!.push(r);
  }
  return new Map([...out.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

/** Assemble the report for one period from parsed rows. Pure (except timestamps). */
export function buildChirurgiesReport(
  rows: ChirurgieRow[],
  periods: string[],
  filters: ChirurgiesFilters,
  meta: { cached: boolean; cacheAgeMinutes: number },
): ChirurgiesReport {
  const period = filters.period ?? periods[0]!;
  const idx = periods.indexOf(period);
  if (idx === -1) {
    throw new UsageError(
      `period ${period} is not in the source. Latest: ${periods.slice(0, 6).join(', ')}` +
        ` (${periods.length} periods, oldest ${periods[periods.length - 1]})`,
    );
  }
  const previousPeriod = periods[idx + 1] ?? null;
  const specialties = resolveSpecialties(filters.specialty);

  const current = groupByRegion(rows.filter((r) => r.period === period));
  const previous = previousPeriod
    ? groupByRegion(rows.filter((r) => r.period === previousPeriod))
    : new Map<string, ChirurgieRow[]>();

  const regions: ChirurgieRegion[] = [];
  for (const [code, regionRows] of current) {
    const name = RSS_REGIONS[code] ?? code;
    const prevRows = previous.get(code);
    regions.push(buildRegion(code, name, regionRows, specialties, prevRows ?? null));
  }

  // Province: like-for-like only — compare with the previous period when it
  // covers exactly the same set of regions, otherwise the delta is meaningless.
  const sameRegionSet =
    previous.size === current.size && [...current.keys()].every((c) => previous.has(c));
  const province = buildRegion(
    null,
    PROVINCE_NAME,
    [...current.values()].flat(),
    specialties,
    previousPeriod && sameRegionSet ? [...previous.values()].flat() : null,
  );

  return {
    source: SOURCE_URL,
    fetchedAt: new Date().toISOString(),
    dataDate: period,
    period: decodePeriod(period),
    previousPeriod,
    missingPeriods: periodsBetween(period, previousPeriod),
    cached: meta.cached,
    cacheAgeMinutes: meta.cacheAgeMinutes,
    availablePeriods: periods,
    missingRegions: Object.keys(RSS_REGIONS).filter((c) => !current.has(c)),
    province,
    regions: filters.region ? regions.filter((r) => regionMatches(r.code!, r.name, filters.region!)) : regions,
  };
}

/** The same period number `back` fiscal years earlier: ("2627-P04", 1) → "2526-P04". */
export function samePeriodYearsBack(code: string, back: number): string {
  const m = /^(\d{2})(\d{2})-P(\d{2})$/.exec(code);
  if (!m) throw new UsageError(`not a fiscal period: ${code}`);
  const start = (Number(m[1]) - back + 100) % 100;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(start)}${pad((start + 1) % 100)}-P${m[3]}`;
}

/** Resolve `--periods` / `--years` to the period codes to report. */
export function selectPeriods(
  available: string[],
  filters: ChirurgiesMultiFilters,
): { codes: string[]; notInSource: string[] } {
  if (filters.periods && filters.years !== undefined) {
    throw new UsageError('give either periods or years, not both');
  }
  if (filters.periods) {
    const asked = [...new Set(filters.periods)];
    if (asked.length === 0 || asked.length > CHIRURGIES_MAX_PERIODS) {
      throw new UsageError(`periods takes 1 to ${CHIRURGIES_MAX_PERIODS} period codes (got ${asked.length})`);
    }
    // MSSS can skip a period: one the source lacks is listed, not fatal. If it
    // has none of them, the first fails in buildChirurgiesReport, naming the available ones.
    const codes = asked.filter((c) => available.includes(c));
    if (codes.length === 0) return { codes: asked.slice(0, 1), notInSource: [] };
    return { codes, notInSource: asked.filter((c) => !available.includes(c)) };
  }
  const years = filters.years;
  if (years === undefined || !Number.isInteger(years) || years < 1 || years > CHIRURGIES_MAX_PERIODS) {
    throw new UsageError(`years must be a whole number from 1 to ${CHIRURGIES_MAX_PERIODS} (got ${years})`);
  }
  const newest = filters.period ?? available[0]!;
  // The newest period must exist (buildChirurgiesReport names the available ones if not);
  // an earlier year the source lacks is listed in notInSource rather than failing the call.
  const codes = [newest];
  const notInSource: string[] = [];
  for (let back = 1; back < years; back++) {
    const code = samePeriodYearsBack(newest, back);
    (available.includes(code) ? codes : notInSource).push(code);
  }
  return { codes, notInSource };
}

/** Assemble a multi-period report (one entry per period) from parsed rows. */
export function buildChirurgiesMultiReport(
  rows: ChirurgieRow[],
  periods: string[],
  filters: ChirurgiesMultiFilters,
  meta: { cached: boolean; cacheAgeMinutes: number },
): ChirurgiesMultiReport {
  const { codes, notInSource } = selectPeriods(periods, filters);
  const reports = codes.map((period) => {
    const full = buildChirurgiesReport(rows, periods, { region: filters.region, specialty: filters.specialty, period }, meta);
    const { source: _s, fetchedAt: _f, cached: _c, cacheAgeMinutes: _a, availablePeriods: _p, ...rest } = full;
    return rest;
  });
  return {
    source: SOURCE_URL,
    fetchedAt: new Date().toISOString(),
    cached: meta.cached,
    cacheAgeMinutes: meta.cacheAgeMinutes,
    availablePeriods: periods,
    periods: codes,
    notInSource,
    reports,
  };
}

/** Several periods in one call: `--periods` codes, or the same period over `--years` fiscal years. */
export async function fetchChirurgiesMultiReport(opts: {
  filters: ChirurgiesMultiFilters;
  cache?: CacheConfig;
  fixture?: string;
}): Promise<ChirurgiesMultiReport> {
  const cache = opts.cache ?? {};
  const cached = readChirurgiesCache(cache);
  const { rows, periods } = cached ?? (await loadFresh(opts.fixture, cache));
  return buildChirurgiesMultiReport(rows, periods, opts.filters, {
    cached: cached !== null,
    cacheAgeMinutes: cached ? Math.round((Date.now() - Date.parse(cached.storedAt)) / 60_000) : 0,
  });
}

/**
 * Build the filtered surgical-waitlist report.
 *
 * Caching: the whole history (~4k rows) is parsed once and cached as JSON;
 * any --period query is then served from the cache until the TTL lapses.
 */
export async function fetchChirurgiesReport(opts: {
  filters?: ChirurgiesFilters;
  cache?: CacheConfig;
  fixture?: string;
}): Promise<ChirurgiesReport> {
  const cache = opts.cache ?? {};
  const cached = readChirurgiesCache(cache);
  const { rows, periods } = cached ?? (await loadFresh(opts.fixture, cache));
  return buildChirurgiesReport(rows, periods, opts.filters ?? {}, {
    cached: cached !== null,
    cacheAgeMinutes: cached ? Math.round((Date.now() - Date.parse(cached.storedAt)) / 60_000) : 0,
  });
}

async function loadFresh(
  fixture: string | undefined,
  cache: CacheConfig,
): Promise<{ rows: ChirurgieRow[]; periods: string[] }> {
  const fp = fixture ?? process.env.QUEBEC_SANTE_FIXTURE;
  const text = fp ? await readFile(fp, 'utf8') : await fetchUtf8Csv(SOURCE_URL);
  const parsed = parseChirurgies(text);
  writeChirurgiesCache(parsed.rows, parsed.periods, cache);
  return parsed;
}
