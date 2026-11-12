#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { fetchUrgencesReport, type UrgencesFilters } from './tools/urgences';
import { fetchCliniquesReport, CLINIQUES_MAX_DAYS, type CliniquesFilters } from './tools/cliniques';
import {
  fetchUrgencesCumulatifReport,
  DEFAULT_TTL_MINUTES as CUMULATIF_DEFAULT_TTL,
  type UrgencesCumulatifFilters,
} from './tools/urgencesCumulatif';
import {
  fetchChirurgiesReport,
  fetchChirurgiesMultiReport,
  CHIRURGIES_MAX_PERIODS,
  type ChirurgiesFilters,
  type ChirurgiesMultiFilters,
} from './tools/chirurgies';
import {
  fetchUrgencesHistoriqueReport,
  HISTORY_DEFAULT_DAYS,
  HISTORY_DEFAULT_TTL_MINUTES,
  HISTORY_GROUP_BY,
  type HistoryGroupBy,
  type UrgencesHistoriqueFilters,
  type UrgencesHistoriqueReport,
} from './tools/urgencesHistorique';
import { CHIRURGIES_DEFAULT_TTL_MINUTES } from './core/chirurgiesCache';
import { FetchError, ParseError, UsageError } from './core/errors';
import { REGIONS, datasetCodes, resolveRegion, type RssRegion } from './core/regions';
import type { Facility, Region, UrgencesReport } from './core/types';
import type { Clinic, CliniquesReport } from './core/types';
import { CLINIQUE_BAND_KEYS, CUMULATIF_LEVELS, CHIRURGIE_SPECIALTIES } from './core/types';
import type {
  ChirurgieRegion,
  ChirurgiesMultiReport,
  ChirurgiesPeriodReport,
  ChirurgiesReport,
  ChirurgieWaitlist,
} from './core/types';
import type { CumulatifEntry, CumulatifLevel, UrgencesCumulatifReport } from './core/types';
import { formatVersion, type BuildInfo } from './core/version';

declare const require: ((id: string) => unknown) & { main?: NodeJS.Module };
const VERSION: string = formatVersion((require('../package.json') as { version: string }).version, readBuildInfo());

/** dist/build-info.json, written by `npm run build`; absent under `npm run dev`. */
function readBuildInfo(): BuildInfo | undefined {
  try {
    return require('./build-info.json') as BuildInfo;
  } catch {
    return undefined;
  }
}

const HELP = `quebec-sante — deterministic data from MSSS open-data CSVs

Usage:
  quebec-sante <command> [options]

Commands:
  urgences    Live Québec ER occupancy/wait data (MSSS hourly CSV)
  cliniques   Clinic appointments offered per day and time slot (MSSS, published weekly,
              past dates only: not current availability)
  urgences-cumulatif
              Fiscal-year-to-date ER indicators + year-over-year trends
              (MSSS cumulative CSV, updated each fiscal period)
  chirurgies  Surgical waitlist by region, specialty and wait time (MSSS, per fiscal period)
  urgences-historique
              ER occupancy history from the archived hourly snapshots: typical
              level by hour / weekday+hour / day, and now vs typical
  regions     The 18 Québec health regions (RSS): codes, names and accepted
              --region spellings, shared by every command (offline)

Global options:
  -h, --help      Show this help
  -v, --version   Show version and the code commit it was built from

Run "quebec-sante <command> --help" for command options.
`;

const URGENCES_HELP = `quebec-sante urgences — Québec ER occupancy/wait data (MSSS hourly CSV)

Usage:
  quebec-sante urgences [options]

Options:
  --region <name|code> Filter to a region (name, alias or RSS code; see "quebec-sante regions"),
                      e.g. "montreal", "06"
  --id <n[,n...]>     Filter to facility id(s) (MSSS permit number); repeatable or comma-separated
  --search <text>     Filter facilities by name (accent-insensitive substring)
  --available-only    Only facilities currently reporting live data
  --baseline          Add each facility's fiscal-year-to-date values (MSSS cumulative file) and
                      the live-minus-baseline length-of-stay difference ("worse than usual?")
  --baseline-fixture <path>
                      Read a local cumulative CSV for --baseline (offline run)
  --refresh           Force a fresh fetch, ignoring the local cache (both files with --baseline)
  --ttl <minutes>     Cache TTL (default 30)
  --json              Output JSON (default when piped)
  --table             Output a human-readable table (default on a TTY)
  --fixture <path>    Read a local CSV instead of the network (deterministic offline run)
  -h, --help          Show this help

Examples:
  quebec-sante urgences --region montreal --table
  quebec-sante urgences --id 51222800,51223279 --json
  quebec-sante urgences --region 06 --baseline --table
`;

const CLINIQUES_HELP = `quebec-sante cliniques — clinic appointments offered per day and time slot (MSSS)

The counts are appointments clinics connected to the provincial booking hub
offered for each past date. MSSS republishes the file weekly (Thursdays), up to
the day before; it does not say which slots are still free, or bookable now.

Usage:
  quebec-sante cliniques [options]

Options:
  --region <name|code> Filter to an RSS region (name, alias or code, e.g. "montreal", "06": all
                      its RTS sub-regions), or one RTS by code ("061") or name ("Montérégie-Est")
  --rls <name>        Filter to a local service network (RLS) by name (accent-insensitive)
  --search <text>     Filter clinics by name (accent-insensitive substring)
  --date <YYYY-MM-DD> The date to report (default: the latest date in the source); with
                      --days, the last day of the window
  --days <n>          Report n calendar days ending at --date, in one call (1-${CLINIQUES_MAX_DAYS},
                      default 1). Rows come newest date first; "dates" lists the days present,
                      "window.missingDates" the ones the source has no rows for, and "summary"
                      totals each clinic and professional group over the dates present
  --refresh           Force a fresh fetch, ignoring the local cache
  --ttl <minutes>     Cache TTL (default 1440; the dataset updates weekly)
  --json              Output JSON (default when piped)
  --table             Output a human-readable table (default on a TTY)
  --fixture <path>    Read a local CSV instead of the network (deterministic offline run)
  -h, --help          Show this help

Examples:
  quebec-sante cliniques --region montreal --table
  quebec-sante cliniques --search "Sainte-Justine" --json
  quebec-sante cliniques --region montreal --rls ahuntsic --days 7 --json
`;

const CUMULATIF_HELP = `quebec-sante urgences-cumulatif — fiscal-year-to-date ER indicators and
year-over-year trends (MSSS cumulative CSV, updated each fiscal period)

Each row is cumulated from April 1 through the latest validated fiscal period;
every fiscal year in the file is cumulated through the same period, so years
compare like-for-like.

Usage:
  quebec-sante urgences-cumulatif [options]

Options:
  --region <name|code>  Filter to a region by name, alias or RSS code, e.g. "montreal" or "06"
  --id <n[,n...]>       Filter to facility id(s) (MSSS permit number); repeatable or comma-separated
  --search <text>       Filter by facility/establishment/region name (accent-insensitive substring)
  --year <YYYY-YYYY>    Fiscal year to report (default: the latest in the source)
  --compare <YYYY-YYYY> Baseline fiscal year for previous/change (default: the year before --year)
  --level <list>        Comma-separated levels: facility, establishment, region, province, or all
                        (default: facility)
  --history             Attach every fiscal year present for each entry (oldest first)
  --refresh             Force a fresh fetch, ignoring the local cache
  --ttl <minutes>       Cache TTL (default 1440)
  --json                Output JSON (default when piped)
  --table               Output a human-readable table (default on a TTY)
  --fixture <path>      Read a local CSV instead of the network (deterministic offline run)
  -h, --help            Show this help

Examples:
  quebec-sante urgences-cumulatif --region montreal --table
  quebec-sante urgences-cumulatif --id 51222800,51223279 --history --json
  quebec-sante urgences-cumulatif --level province,region --json
`;

const CHIRURGIES_HELP = `quebec-sante chirurgies — surgical waitlist (MSSS, updated each fiscal period)

Patients waiting for an operating-room intervention, by region (RSS), specialty
and wait time since the decision to operate (0-6 months, 6-12 months, >1 year).

Usage:
  quebec-sante chirurgies [options]

Options:
  --region <name|code> Filter to a region by name, alias or RSS code ("montreal", "RSS06", "06")
  --specialty <name>   Filter to specialties by name (accent-insensitive substring), e.g. "ortho"
  --period <YYZZ-Pnn>  Fiscal period to report, e.g. "2627-P04" (default: the latest in the source);
                       with --years, the newest period
  --periods <list>     Several periods in one call, comma-separated, e.g. "2627-P04,2627-P03"
                       (up to ${CHIRURGIES_MAX_PERIODS}); output is { periods, reports[] }, one report per period
  --years <n>          The same period in each of the last n fiscal years, newest first
                       (1-${CHIRURGIES_MAX_PERIODS}), e.g. 2627-P04, 2526-P04, 2425-P04; same output as --periods.
                       With either, a period the source lacks is listed in notInSource

A period MSSS didn't publish is listed in missingPeriods; the deltas then
compare with previousPeriod, the last one published before it.
  --refresh            Force a fresh fetch, ignoring the local cache
  --ttl <minutes>      Cache TTL (default ${CHIRURGIES_DEFAULT_TTL_MINUTES}; the source updates ~every 4 weeks)
  --json               Output JSON (default when piped)
  --table              Output a human-readable table (default on a TTY)
  --fixture <path>     Read a local CSV instead of the network (deterministic offline run)
  -h, --help           Show this help

Specialties: ${CHIRURGIE_SPECIALTIES.map((s) => s.key).join(', ')}

Examples:
  quebec-sante chirurgies --region montreal --table
  quebec-sante chirurgies --specialty ortho --json
  quebec-sante chirurgies --region RSS03 --period 2627-P01 --json
  quebec-sante chirurgies --region montreal --specialty ortho --years 3 --json
`;

const REGIONS_HELP = `quebec-sante regions — Québec health regions (RSS) shared by every command

Lists the 18 régions sociosanitaires with their two-digit code, official name,
slug and accepted aliases, plus how each dataset writes the code. Static: no
network. Every command's --region accepts any of these spellings, a 1–2 digit
code ("6", "06", "RSS06") or an unambiguous prefix of the name ("laurent").

Usage:
  quebec-sante regions [options]

Options:
  --region <name|code>  Show only the region this input resolves to (exit 2 if none)
  --json                Output JSON (default when piped)
  --table               Output a human-readable table (default on a TTY)
  -h, --help            Show this help

Examples:
  quebec-sante regions --table
  quebec-sante regions --region "bas-st-laurent" --json
`;

/** JSON shape of one `regions` entry. */
function regionEntry(r: RssRegion) {
  return { code: r.code, name: r.name, slug: r.slug, aliases: r.aliases, datasetCodes: datasetCodes(r) };
}

/** Render the region registry as an aligned table. */
export function formatRegionsTable(regions: readonly RssRegion[]): string {
  const rows = regions.map((r) => [r.code, r.name, [r.slug, ...r.aliases].join(', ')]);
  return renderGrid([['RSS', 'NAME', 'ACCEPTED (--region)'], ...rows]);
}

/** Parse `--id` values (repeated flags and/or comma lists) into non-empty strings. */
export function parseIdList(raw: string | string[] | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const ids = (Array.isArray(raw) ? raw : [raw])
    .flatMap((v) => v.split(','))
    .map((p) => p.trim())
    .filter((p) => p !== '');
  return ids.length > 0 ? ids : undefined;
}

/** Map parsed CLI option values to ER-tool filters. */
export function buildFilters(values: Record<string, unknown>, ttl: number): {
  filters: UrgencesFilters;
  cache: { ttlMinutes: number; refresh: boolean };
} {
  const filters: UrgencesFilters = {};
  if (typeof values.region === 'string') filters.region = values.region;
  const ids = parseIdList(values.id as string | string[] | undefined);
  if (ids) filters.ids = ids;
  if (typeof values.search === 'string' && values.search !== '') filters.search = values.search;
  if (values['available-only'] === true) filters.availableOnly = true;
  return {
    filters,
    cache: { ttlMinutes: ttl, refresh: values.refresh === true },
  };
}

function fmtCell(value: number | null | undefined, suffix = ''): string {
  return value == null ? '—' : `${value}${suffix}`;
}
function fmtDelta(value: number | null | undefined): string {
  if (value == null) return '—';
  return value > 0 ? `+${value}` : `${value}`;
}
function renderGrid(rows: string[][]): string {
  const cols = rows[0]?.length ?? 0;
  const widths = Array.from({ length: cols }, (_, c) => Math.max(...rows.map((r) => r[c]!.length)));
  return rows
    .map((row) => row.map((v, c) => (c === cols - 1 ? v : v.padEnd(widths[c]!))).join('  '))
    .join('\n');
}

/** Render an ER report as an aligned human-readable table. */
export function formatTable(report: UrgencesReport): string {
  if (report.regions.length === 0) return 'No facilities matched the filters.';
  const b = report.baseline;
  const header = ['OCC', 'ΔAVG', 'TOT', 'WAIT', '>24h', '>48h'];
  if (b) header.push('DMS', 'FY-DMS', 'ΔDMS%');
  header.push('ID', 'FACILITY');
  const blocks = report.regions.map((region) => {
    const title =
      `${region.name} — MSSS regional rate ${fmtCell(region.total?.occupancyPct, '%')}` +
      ` · mean of ERs ${fmtCell(region.averageOccupancyPct, '%')} · ${region.facilities.length} facilities`;
    const rows = region.facilities.map((f) => {
      const row = [
        fmtCell(f.occupancyPct, '%'),
        fmtDelta(f.deltaFromRegionAvgPct),
        fmtCell(f.totalPresent),
        fmtCell(f.waitingForCare),
        fmtCell(f.over24h),
        fmtCell(f.over48h),
      ];
      if (b) {
        row.push(fmtHours(f.dmsStretcher), fmtHours(f.baseline?.dmsStretcher), fmtSigned(f.vsBaseline?.dmsStretcherPct));
      }
      row.push(f.id ?? '—', f.name);
      return row;
    });
    return `${title}\n${renderGrid([header, ...rows])}`;
  });
  let meta =
    `source: ${report.source}\ndataDate: ${report.dataDate}` +
    `${report.extractedAt ? ` (snapshot taken ${report.extractedAt})` : ''}` +
    ` · ${report.cached ? 'cached' : 'live'} · fetched ${report.fetchedAt}` +
    `\nprovince (MSSS "Ensemble du Québec"): ${fmtCell(report.province?.occupancyPct, '%')} occupancy · ` +
    `${fmtCell(report.province?.waitingForCare)} waiting · ${fmtCell(report.province?.over24h)} on a stretcher >24h`;
  if (b) {
    meta +=
      b.status === 'ok'
        ? `\nbaseline: ${b.source}\n  fiscal year ${b.fiscalYear} (Apr 1 → period ${b.period}) · ${b.cached ? 'cached' : 'live'} · ` +
          `${b.matched} matched${b.unmatched.length ? ` · no baseline row: ${b.unmatched.join(', ')}` : ''}\n` +
          `  DMS = stretcher length of stay in hours, patients who left yesterday · FY-DMS = same, fiscal year to date · ΔDMS% = DMS vs FY-DMS`
        : `\nbaseline: unavailable (${b.error})`;
  }
  return `${blocks.join('\n\n')}\n\n${meta}`;
}

function fmtHours(value: number | null | undefined): string {
  return value == null ? '—' : value.toFixed(2);
}
function fmtSigned(value: number | null | undefined, digits = 0): string {
  if (value == null) return '—';
  const s = value.toFixed(digits);
  return value > 0 ? `+${s}` : s;
}

const LEVEL_TAG: Record<CumulatifLevel, string> = { province: 'P', region: 'R', establishment: 'E', facility: 'F' };

/** Render a cumulative report as an aligned human-readable table, grouped by region. */
export function formatCumulatifTable(report: UrgencesCumulatifReport): string {
  const meta =
    `source: ${report.source}\n` +
    `fiscal year ${report.fiscalYear} (Apr 1 → period ${report.period}) vs ${report.compareTo ?? '—'} · ` +
    `${report.cached ? 'cached' : 'live'} · fetched ${report.fetchedAt}\n` +
    `available fiscal years: ${report.availableFiscalYears.join(', ')}\n` +
    `L: P=province R=region E=establishment F=facility (* = facility coverage differs from baseline) · ` +
    `DMS/PEC in hours · Δ vs ${report.compareTo ?? '—'}`;
  const missing =
    report.missingFromFiscalYear.length === 0
      ? ''
      : `\n\nNo ${report.fiscalYear} data for ${report.missingFromFiscalYear.length} matching entr${report.missingFromFiscalYear.length === 1 ? 'y' : 'ies'} ` +
        `(present in other years):\n` +
        report.missingFromFiscalYear
          .map((m) => `  ${LEVEL_TAG[m.level]}  ${m.id ?? '—'}  ${m.name} (${m.regionName}) — ${m.fiscalYears.join(', ')}`)
          .join('\n');
  if (report.entries.length === 0) return `No entries matched the filters.${missing}\n\n${meta}`;
  const header = ['VISITS', 'ΔVISITS', 'DMS', 'ΔDMS', 'DMS-CIV', 'ΔCIV', 'PEC', 'ΔPEC', '>24h%', '>48h%', 'L', 'ID', 'NAME'];
  const byRegion = new Map<string, CumulatifEntry[]>();
  for (const e of report.entries) {
    const k = e.level === 'province' ? e.name : e.regionName;
    if (!byRegion.has(k)) byRegion.set(k, []);
    byRegion.get(k)!.push(e);
  }
  const blocks = [...byRegion.entries()].map(([region, entries]) => {
    const rows = entries.map((e) => [
      fmtCell(e.indicators.total.visits),
      fmtSigned(e.change?.total.visits),
      fmtHours(e.indicators.total.dmsHours),
      fmtSigned(e.change?.total.dmsHours, 2),
      fmtHours(e.indicators.stretcher.dmsHours),
      fmtSigned(e.change?.stretcher.dmsHours, 2),
      fmtHours(e.indicators.total.pecDelayHours),
      fmtSigned(e.change?.total.pecDelayHours, 2),
      fmtCell(e.derived.stretcherOver24hPct),
      fmtCell(e.derived.stretcherOver48hPct),
      LEVEL_TAG[e.level] + (e.change?.facilityCount ? '*' : ''),
      e.id ?? '—',
      e.name,
    ]);
    return `${region} — ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}\n${renderGrid([header, ...rows])}`;
  });
  return `${blocks.join('\n\n')}${missing}\n\n${meta}`;
}

/** Validate a "YYYY-YYYY" fiscal year (consecutive years). Returns an error message or null. */
export function fiscalYearError(flag: string, value: string): string | null {
  const m = /^(\d{4})-(\d{4})$/.exec(value);
  if (!m || Number(m[2]) !== Number(m[1]) + 1) {
    return `${flag} must be a fiscal year like 2025-2026 (got "${value}").`;
  }
  return null;
}

/** Parse `--level` (comma list or "all"). Returns the levels or an error message. */
export function parseLevels(raw: string): CumulatifLevel[] | string {
  const parts = raw.split(',').map((p) => p.trim().toLowerCase()).filter((p) => p !== '');
  if (parts.length === 0) return `--level must list at least one level.`;
  if (parts.includes('all')) return [...CUMULATIF_LEVELS];
  const bad = parts.filter((p) => !(CUMULATIF_LEVELS as readonly string[]).includes(p));
  if (bad.length > 0) {
    return `--level: unknown level(s) ${bad.join(', ')} (expected ${CUMULATIF_LEVELS.join(', ')} or all).`;
  }
  return CUMULATIF_LEVELS.filter((l) => parts.includes(l));
}

/** Render a clinc report as an aligned human-readable table. */
function formatCliniquesTable(report: CliniquesReport): string {
  if (report.clinics.length === 0) return 'No clinics matched the filters.';
  const multiDay = report.window.days > 1;
  const header = [
    ...(multiDay ? ['DATE'] : []),
    'TOTAL', '6-9', '9-12', '12-15', '15-18', '18-21', '21-6', 'REGION', 'CLINIC',
  ];
  // Group by region so a table reads naturally.
  const byRegion = new Map<string, Clinic[]>();
  for (const c of report.clinics) {
    const key = c.regionName;
    if (!byRegion.has(key)) byRegion.set(key, []);
    byRegion.get(key)!.push(c);
  }
  const blocks = [...byRegion.entries()].map(([region, clinics]) => {
    const title = `${region} — ${clinics.length} clinic row(s)`;
    const rows = clinics.map((c) => [
      ...(multiDay ? [c.date] : []),
      String(c.totalOffered),
      ...CLINIQUE_BAND_KEYS.map((k) => fmtCell(c.slots[k])),
      region,
      `${c.name} (${c.professionGroup})`,
    ]);
    return `${title}\n${renderGrid([header, ...rows])}`;
  });
  if (multiDay) blocks.push(formatCliniquesSummary(report));
  const when = multiDay
    ? `${report.window.from} → ${report.window.to} (${report.window.days} days, ${report.dates.length} with data)`
    : report.dataDate;
  const notPublished = report.window.missingDates.length
    ? `\nnot in the source: ${report.window.missingDates.join(', ')}`
    : '';
  const range = report.availableRange;
  const meta =
    `source: ${report.source}\ndate: ${when} · ${report.cached ? 'cached' : 'live'} · fetched ${report.fetchedAt}\n` +
    `available dates: ${range.from} → ${range.to} (${range.count} dates)${notPublished}`;
  return `${blocks.join('\n\n')}\n\n${meta}`;
}

/** The window summary: per clinic × group, each band as "offered/days with offers". */
function formatCliniquesSummary(report: CliniquesReport): string {
  const n = report.dates.length;
  const header = ['DAYS', 'TOTAL', '6-9', '9-12', '12-15', '15-18', '18-21', '21-6', 'CLINIC'];
  const rows = report.summary.byClinic.map((s) => [
    `${s.daysWithOffers}/${n}`,
    String(s.totalOffered),
    ...CLINIQUE_BAND_KEYS.map((k) => (s.bands[k].daysWithOffers ? `${s.bands[k].offered}/${s.bands[k].daysWithOffers}d` : '—')),
    `${s.name} (${s.professionGroup})`,
  ]);
  const groups = report.summary.byProfessionGroup
    .map((g) => `${g.professionGroup}: ${g.clinicsWithOffers} clinic(s) with offers, ${g.clinicsWithOffersEveryDay} every day`)
    .join(' · ');
  const title = `Summary over ${n} date(s) with data — ${report.summary.clinicsWithOffers} clinic(s) with offers (${groups})`;
  return `${title}\n${renderGrid([header, ...rows])}`;
}

function fmtWaitRow(w: ChirurgieWaitlist): string[] {
  return [
    fmtCell(w.waiting.under6m),
    fmtCell(w.waiting.from6to12m),
    fmtCell(w.waiting.over12m),
    String(w.total),
    fmtCell(w.pctOver6m, '%'),
    fmtCell(w.pctOver12m, '%'),
    fmtDelta(w.deltaFromPreviousPeriod),
    w.label,
  ];
}

function chirurgiesBlock(r: ChirurgieRegion, previousPeriod: string | null, showOverall: boolean): string {
  const delta =
    r.deltaFromPreviousPeriod === null ? '' : ` · ${fmtDelta(r.deltaFromPreviousPeriod)} vs ${previousPeriod}`;
  const title = `${r.name}${r.code ? ` (${r.code})` : ' (derived)'} — ${r.overall.total} waiting${delta}`;
  const header = ['0-6m', '6-12m', '>12m', 'TOTAL', '%>6m', '%>12m', 'Δ PREV', 'SPECIALTY'];
  const rows = r.specialties.map(fmtWaitRow);
  if (showOverall) rows.push(fmtWaitRow(r.overall));
  return `${title}\n${renderGrid([header, ...rows])}`;
}

/** Render a surgical-waitlist report as aligned human-readable tables. */
function chirurgiesPeriodBlocks(report: ChirurgiesPeriodReport): { blocks: string[]; missing: string } {
  // The overall row only adds information when every specialty is listed.
  const showOverall = report.province.specialties.length === CHIRURGIE_SPECIALTIES.length;
  const blocks = report.regions.map((r) => chirurgiesBlock(r, report.previousPeriod, showOverall));
  if (blocks.length === 0) blocks.push('No regions matched the filters.');
  blocks.push(chirurgiesBlock(report.province, report.previousPeriod, showOverall));
  const notes = [
    report.missingRegions.length
      ? `missing from this period (not in province total): ${report.missingRegions.join(', ')}`
      : '',
    report.missingPeriods.length
      ? `not in the source: ${report.missingPeriods.join(', ')}, so deltas vs ${report.previousPeriod} span ` +
        `${report.missingPeriods.length + 1} periods`
      : '',
  ];
  return { blocks, missing: notes.filter(Boolean).join('\n') };
}

function formatChirurgiesTable(report: ChirurgiesReport): string {
  const { blocks, missing } = chirurgiesPeriodBlocks(report);
  const p = report.period;
  const meta =
    `source: ${report.source}\nperiod: ${p.code} (fiscal ${p.fiscalYear}, P${p.number}) · ` +
    `${report.cached ? 'cached' : 'live'} · fetched ${report.fetchedAt}${missing ? `\n${missing}` : ''}`;
  return `${blocks.join('\n\n')}\n\n${meta}`;
}

function formatChirurgiesMultiTable(report: ChirurgiesMultiReport): string {
  const sections = report.reports.map((r) => {
    const { blocks, missing } = chirurgiesPeriodBlocks(r);
    const p = r.period;
    const title = `== ${p.code} (fiscal ${p.fiscalYear}, P${p.number}) ==`;
    return [title, ...blocks, ...(missing ? [missing] : [])].join('\n\n');
  });
  const absent = report.notInSource.length ? `\nnot in the source: ${report.notInSource.join(', ')}` : '';
  const meta =
    `source: ${report.source}\nperiods: ${report.periods.join(', ')} · ` +
    `${report.cached ? 'cached' : 'live'} · fetched ${report.fetchedAt}${absent}`;
  return `${sections.join('\n\n')}\n\n${meta}`;
}

const HISTORIQUE_HELP = `quebec-sante urgences-historique — ER occupancy history (archived hourly snapshots)

Reads the static history API built from the hourly MSSS ER snapshots archived in
this repo (archive/), served by GitHub Pages. The window ends at the latest
archived snapshot; hours are Québec local time (MSSS's Mise_a_jour). Every
figure is a DERIVED mean/min/max over the snapshots in the window.

The archive has gaps (hours or days with no snapshot). The window is calendar
time either way: window.coverage lists the ranges it holds and every gap over
6 h, archive.gaps every gap in the whole archive, and a note on stderr says
when the window has one.

Usage:
  quebec-sante urgences-historique [options]

Options:
  --region <name|code> Filter to a region (name, alias or RSS code), e.g. "montreal", "06"
  --id <n[,n...]>      Filter to facility id(s) (MSSS permit number); repeatable or comma-separated
  --search <text>      Filter facilities by name (accent-insensitive substring)
  --days <n>           Window length in days, ending at the latest snapshot (default ${HISTORY_DEFAULT_DAYS})
  --by <grouping>      Profile grouping: hour (default), weekday-hour, or day
  --api <url>          History API base (default $QUEBEC_SANTE_API_URL, else
                       https://krystosterone.github.io/quebec-sante-cli/api/v1)
  --refresh            Re-fetch the index and the current month (complete months stay
                       cached while they match the index)
  --ttl <minutes>      Cache TTL for the index and the current month (default ${HISTORY_DEFAULT_TTL_MINUTES})
  --json               Output JSON (default when piped)
  --table              Output a human-readable table (default on a TTY)
  --fixture <dir>      Read a local API directory (with index.json) instead of the network
  -h, --help           Show this help

Examples:
  quebec-sante urgences-historique --id 51222800 --by weekday-hour --json
  quebec-sante urgences-historique --region montreal --days 7 --table
  quebec-sante urgences-historique --search "sainte-justine" --by day --days 90 --json
`;

function profileLabel(row: UrgencesHistoriqueReport['facilities'][number]['profile'][number]): string {
  if (row.date !== undefined) return row.date;
  const hour = `${String(row.hour).padStart(2, '0')}h`;
  return row.weekdayName ? `${row.weekdayName.slice(0, 3)} ${hour}` : hour;
}

/** One line on what the window holds: snapshots against the hourly count, ranges, gaps. */
export function historiqueCoverageLine(report: UrgencesHistoriqueReport): string {
  const c = report.window.coverage;
  const gaps = c.gaps.length
    ? ` · gaps over 6 h: ${c.gaps.map((g) => `${g.from} → ${g.to} (${g.hours} h)`).join(', ')}`
    : ' · no gap over 6 h';
  return `coverage: ${report.window.snapshots} of ${c.expectedSnapshots} hourly snapshots in ${c.ranges.length} range(s)${gaps}`;
}

/** Render a history report as one block per facility. */
export function formatHistoriqueTable(report: UrgencesHistoriqueReport): string {
  const w = report.window;
  const head =
    `ER history · ${w.from} → ${w.to} (${w.days} days, ${w.snapshots} snapshots` +
    `${w.archiveStart && w.archiveStart > w.from ? `; archive starts ${w.archiveStart}` : ''}) · by ${report.groupBy}\n` +
    historiqueCoverageLine(report);
  if (report.facilities.length === 0) return `${head}\n\nNo facilities matched the filters.`;
  const blocks = report.facilities.map((f) => {
    const s = f.summary;
    const l = f.latest;
    const n = f.snapshots;
    const lines = [
      `${f.name} (${f.id}) — ${f.region}`,
      `  reporting in ${n.reporting} snapshot(s) · not reporting in ${n.notReporting} · absent from ${n.absent}`,
      `  ${s.samples} samples · occupancy avg ${fmtCell(s.occupancyPctMean, '%')} ` +
        `(min ${fmtCell(s.occupancyPctMin, '%')}, max ${fmtCell(s.occupancyPctMax, '%')}) · ` +
        `waiting avg ${fmtCell(s.waitingForCareMean)} · present avg ${fmtCell(s.totalPresentMean)}`,
    ];
    if (l) {
      lines.push(
        `  latest ${l.dataDate}: ${fmtCell(l.occupancyPct, '%')} vs typical ${fmtCell(l.typicalOccupancyPct, '%')} ` +
          `at this hour (${fmtDelta(l.deltaFromTypicalPct)}) · same weekday ${fmtCell(l.typicalOccupancyPctSameWeekday, '%')}`,
      );
    }
    if (f.profile.length > 0) {
      const rows = f.profile.map((r) => [
        profileLabel(r),
        String(r.samples),
        fmtCell(r.occupancyPctMean, '%'),
        fmtCell(r.occupancyPctMax, '%'),
        fmtCell(r.waitingForCareMean),
        fmtCell(r.totalPresentMean),
        fmtCell(r.over24hMean),
      ]);
      const grid = renderGrid([['SLOT', 'N', 'OCC AVG', 'OCC MAX', 'WAIT AVG', 'PRESENT AVG', '>24h AVG'], ...rows]);
      lines.push(grid.replace(/^/gm, '  '));
    }
    return lines.join('\n');
  });
  const meta = `source: ${report.source} · built ${report.generatedAt} · ${report.cached ? 'cached' : 'live'}`;
  return `${head}\n\n${blocks.join('\n\n')}\n\n${meta}`;
}

function resolveFormat(values: Record<string, unknown>): 'json' | 'table' {
  if (values.table === true) return 'table';
  if (values.json === true) return 'json';
  return process.stdout.isTTY ? 'table' : 'json';
}

function parseCli(args: string[]): { values: Record<string, unknown>; positionals: string[] } {
  return parseArgs({
    args,
    allowPositionals: true,
    options: {
      region: { type: 'string' },
      id: { type: 'string', multiple: true },
      search: { type: 'string' },
      rls: { type: 'string' },
      'available-only': { type: 'boolean' },
      baseline: { type: 'boolean' },
      'baseline-fixture': { type: 'string' },
      date: { type: 'string' },
      year: { type: 'string' },
      compare: { type: 'string' },
      level: { type: 'string' },
      history: { type: 'boolean' },
      specialty: { type: 'string' },
      period: { type: 'string' },
      periods: { type: 'string' },
      years: { type: 'string' },
      days: { type: 'string' },
      by: { type: 'string' },
      api: { type: 'string' },
      refresh: { type: 'boolean' },
      ttl: { type: 'string' },
      json: { type: 'boolean' },
      table: { type: 'boolean' },
      fixture: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  }) as { values: Record<string, unknown>; positionals: string[] };
}

function parseTtl(values: Record<string, unknown>, def: number): number | null {
  if (typeof values.ttl !== 'string') return def;
  const parsed = Number(values.ttl);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

async function runUrgences(values: Record<string, unknown>, positionals: string[]): Promise<number> {
  const HELP_URI = URGENCES_HELP;
  const sub = positionals[1];
  if (values.help === true || sub === '--help' || sub === '-h') {
    process.stdout.write(HELP_URI);
    return 0;
  }
  if (sub !== undefined) {
    process.stderr.write(`Unexpected argument to urgences: ${sub}\n\n${HELP_URI}`);
    return 2;
  }
  const ttlMinutes = parseTtl(values, 30);
  if (ttlMinutes === null) {
    process.stderr.write(`--ttl must be a positive number of minutes.\n`);
    return 2;
  }
  const { filters, cache } = buildFilters(values, ttlMinutes);
  try {
    const baselineFixture = typeof values['baseline-fixture'] === 'string' ? values['baseline-fixture'] : undefined;
    const report = await fetchUrgencesReport({
      filters,
      cache,
      fixture: typeof values.fixture === 'string' ? values.fixture : undefined,
      baseline: values.baseline === true || baselineFixture !== undefined ? { fixture: baselineFixture } : false,
    });
    const output = resolveFormat(values) === 'json' ? JSON.stringify(report, null, 2) : formatTable(report);
    process.stdout.write(`${output}\n`);
    return 0;
  } catch (err) {
    if (err instanceof FetchError) {
      process.stderr.write(`fetch error: ${err.message}\n`);
      return 1;
    }
    if (err instanceof ParseError) {
      process.stderr.write(`parse error: ${err.message}\n`);
      return 2;
    }
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 1;
  }
}

async function runCliniques(values: Record<string, unknown>, positionals: string[]): Promise<number> {
  const sub = positionals[1];
  if (values.help === true || sub === '--help' || sub === '-h') {
    process.stdout.write(CLINIQUES_HELP);
    return 0;
  }
  if (sub !== undefined) {
    process.stderr.write(`Unexpected argument to cliniques: ${sub}\n\n${CLINIQUES_HELP}`);
    return 2;
  }
  const ttlMinutes = parseTtl(values, 24 * 60);
  if (ttlMinutes === null) {
    process.stderr.write(`--ttl must be a positive number of minutes.\n`);
    return 2;
  }
  const filters: CliniquesFilters = {};
  if (typeof values.region === 'string') filters.region = values.region;
  if (typeof values.rls === 'string' && values.rls !== '') filters.rls = values.rls;
  if (typeof values.search === 'string' && values.search !== '') filters.search = values.search;
  if (typeof values.date === 'string') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(values.date)) {
      process.stderr.write(`--date must be a YYYY-MM-DD date (got "${values.date}").\n`);
      return 2;
    }
    // Reject impossible dates (e.g. 2026-99-99, 2026-02-30) that the regex
    // format check alone would accept. Round-trip through Date and compare.
    const d = new Date(`${values.date}T00:00:00Z`);
    const valid =
      !Number.isNaN(d.getTime()) &&
      d.toISOString().startsWith(values.date);
    if (!valid) {
      process.stderr.write(`--date is not a valid calendar date (got "${values.date}").\n`);
      return 2;
    }
    filters.date = values.date;
  }
  if (typeof values.days === 'string') {
    const days = Number(values.days);
    if (!/^\d+$/.test(values.days) || days < 1 || days > CLINIQUES_MAX_DAYS) {
      process.stderr.write(
        `--days must be a whole number of days between 1 and ${CLINIQUES_MAX_DAYS} (got "${values.days}").\n`,
      );
      return 2;
    }
    filters.days = days;
  }
  const cache = { ttlMinutes, refresh: values.refresh === true };
  try {
    const report = await fetchCliniquesReport({
      filters,
      cache,
      fixture: typeof values.fixture === 'string' ? values.fixture : undefined,
    });
    const output =
      resolveFormat(values) === 'json' ? JSON.stringify(report, null, 2) : formatCliniquesTable(report);
    process.stdout.write(`${output}\n`);
    return 0;
  } catch (err) {
    if (err instanceof FetchError) {
      process.stderr.write(`fetch error: ${err.message}\n`);
      return 1;
    }
    if (err instanceof ParseError) {
      process.stderr.write(`parse error: ${err.message}\n`);
      return 2;
    }
    if (err instanceof UsageError) {
      process.stderr.write(`${err.message}\n`);
      return 2;
    }
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 1;
  }
}

async function runUrgencesCumulatif(values: Record<string, unknown>, positionals: string[]): Promise<number> {
  const sub = positionals[1];
  if (values.help === true || sub === '--help' || sub === '-h') {
    process.stdout.write(CUMULATIF_HELP);
    return 0;
  }
  if (sub !== undefined) {
    process.stderr.write(`Unexpected argument to urgences-cumulatif: ${sub}\n\n${CUMULATIF_HELP}`);
    return 2;
  }
  const usage = (msg: string): number => {
    process.stderr.write(`${msg}\n`);
    return 2;
  };
  const ttlMinutes = parseTtl(values, CUMULATIF_DEFAULT_TTL);
  if (ttlMinutes === null) return usage(`--ttl must be a positive number of minutes.`);

  const filters: UrgencesCumulatifFilters = {};
  if (typeof values.region === 'string' && values.region.trim() !== '') filters.region = values.region;
  const ids = parseIdList(values.id as string | string[] | undefined);
  if (ids) filters.ids = ids;
  if (typeof values.search === 'string' && values.search !== '') filters.search = values.search;
  for (const flag of ['year', 'compare'] as const) {
    const v = values[flag];
    if (typeof v !== 'string') continue;
    const err = fiscalYearError(`--${flag}`, v);
    if (err) return usage(err);
    filters[flag] = v;
  }
  if (typeof values.level === 'string') {
    const levels = parseLevels(values.level);
    if (typeof levels === 'string') return usage(levels);
    filters.levels = levels;
  }
  if (values.history === true) filters.history = true;

  try {
    const report = await fetchUrgencesCumulatifReport({
      filters,
      cache: { ttlMinutes, refresh: values.refresh === true },
      fixture: typeof values.fixture === 'string' ? values.fixture : undefined,
    });
    const output =
      resolveFormat(values) === 'json' ? JSON.stringify(report, null, 2) : formatCumulatifTable(report);
    process.stdout.write(`${output}\n`);
    return 0;
  } catch (err) {
    if (err instanceof FetchError) {
      process.stderr.write(`fetch error: ${err.message}\n`);
      return 1;
    }
    if (err instanceof ParseError) {
      process.stderr.write(`parse error: ${err.message}\n`);
      return 2;
    }
    if (err instanceof UsageError) {
      process.stderr.write(`usage error: ${err.message}\n`);
      return 2;
    }
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 1;
  }
}

async function runChirurgies(values: Record<string, unknown>, positionals: string[]): Promise<number> {
  const sub = positionals[1];
  if (values.help === true || sub === '--help' || sub === '-h') {
    process.stdout.write(CHIRURGIES_HELP);
    return 0;
  }
  if (sub !== undefined) {
    process.stderr.write(`Unexpected argument to chirurgies: ${sub}\n\n${CHIRURGIES_HELP}`);
    return 2;
  }
  const ttlMinutes = parseTtl(values, CHIRURGIES_DEFAULT_TTL_MINUTES);
  if (ttlMinutes === null) {
    process.stderr.write(`--ttl must be a positive number of minutes.\n`);
    return 2;
  }
  const filters: ChirurgiesFilters = {};
  if (typeof values.region === 'string' && values.region !== '') filters.region = values.region;
  if (typeof values.specialty === 'string' && values.specialty !== '') filters.specialty = values.specialty;
  const toPeriod = (raw: string, flag: string): string | null => {
    const period = raw.trim().toUpperCase();
    const m = /^(\d{2})(\d{2})-P(\d{2})$/.exec(period);
    const valid = m !== null && (Number(m[1]) + 1) % 100 === Number(m[2]) && Number(m[3]) >= 1 && Number(m[3]) <= 13;
    if (valid) return period;
    process.stderr.write(`${flag} must be a fiscal period like "2627-P04" (P01-P13; got "${raw}").\n`);
    return null;
  };
  if (typeof values.period === 'string') {
    const period = toPeriod(values.period, '--period');
    if (period === null) return 2;
    filters.period = period;
  }
  const multi = typeof values.periods === 'string' || typeof values.years === 'string';
  if (multi) {
    if (typeof values.periods === 'string' && typeof values.years === 'string') {
      process.stderr.write(`Give either --periods or --years, not both.\n`);
      return 2;
    }
    if (typeof values.periods === 'string' && filters.period !== undefined) {
      process.stderr.write(`--periods lists every period to report; drop --period.\n`);
      return 2;
    }
    const mf: ChirurgiesMultiFilters = { region: filters.region, specialty: filters.specialty, period: filters.period };
    if (typeof values.periods === 'string') {
      const list = parseIdList(values.periods) ?? [];
      const codes = list.map((p) => toPeriod(p, '--periods'));
      if (codes.some((c) => c === null)) return 2;
      if (codes.length === 0 || codes.length > CHIRURGIES_MAX_PERIODS) {
        process.stderr.write(`--periods takes 1 to ${CHIRURGIES_MAX_PERIODS} periods (got ${codes.length}).\n`);
        return 2;
      }
      mf.periods = codes as string[];
    } else {
      const raw = values.years as string;
      const years = Number(raw);
      if (!/^\d+$/.test(raw) || years < 1 || years > CHIRURGIES_MAX_PERIODS) {
        process.stderr.write(`--years must be a whole number between 1 and ${CHIRURGIES_MAX_PERIODS} (got "${raw}").\n`);
        return 2;
      }
      mf.years = years;
    }
    try {
      const report = await fetchChirurgiesMultiReport({
        filters: mf,
        cache: { ttlMinutes, refresh: values.refresh === true },
        fixture: typeof values.fixture === 'string' ? values.fixture : undefined,
      });
      const output =
        resolveFormat(values) === 'json' ? JSON.stringify(report, null, 2) : formatChirurgiesMultiTable(report);
      process.stdout.write(`${output}\n`);
      return 0;
    } catch (err) {
      return chirurgiesError(err);
    }
  }
  try {
    const report = await fetchChirurgiesReport({
      filters,
      cache: { ttlMinutes, refresh: values.refresh === true },
      fixture: typeof values.fixture === 'string' ? values.fixture : undefined,
    });
    const output =
      resolveFormat(values) === 'json' ? JSON.stringify(report, null, 2) : formatChirurgiesTable(report);
    process.stdout.write(`${output}\n`);
    return 0;
  } catch (err) {
    return chirurgiesError(err);
  }
}

function chirurgiesError(err: unknown): number {
  if (err instanceof UsageError) {
    process.stderr.write(`usage error: ${err.message}\n`);
    return 2;
  }
  if (err instanceof FetchError) {
    process.stderr.write(`fetch error: ${err.message}\n`);
    return 1;
  }
  if (err instanceof ParseError) {
    process.stderr.write(`parse error: ${err.message}\n`);
    return 2;
  }
  process.stderr.write(`error: ${(err as Error).message}\n`);
  return 1;
}

async function runUrgencesHistorique(values: Record<string, unknown>, positionals: string[]): Promise<number> {
  const sub = positionals[1];
  if (values.help === true || sub === '--help' || sub === '-h') {
    process.stdout.write(HISTORIQUE_HELP);
    return 0;
  }
  if (sub !== undefined) {
    process.stderr.write(`Unexpected argument to urgences-historique: ${sub}\n\n${HISTORIQUE_HELP}`);
    return 2;
  }
  const ttlMinutes = parseTtl(values, HISTORY_DEFAULT_TTL_MINUTES);
  if (ttlMinutes === null) {
    process.stderr.write(`--ttl must be a positive number of minutes.\n`);
    return 2;
  }
  let days = HISTORY_DEFAULT_DAYS;
  if (typeof values.days === 'string') {
    days = Number(values.days);
    if (!/^\d+$/.test(values.days) || days < 1 || days > 3660) {
      process.stderr.write(`--days must be a whole number of days between 1 and 3660 (got "${values.days}").\n`);
      return 2;
    }
  }
  let groupBy: HistoryGroupBy = 'hour';
  if (typeof values.by === 'string') {
    if (!(HISTORY_GROUP_BY as readonly string[]).includes(values.by)) {
      process.stderr.write(`--by must be one of: ${HISTORY_GROUP_BY.join(', ')} (got "${values.by}").\n`);
      return 2;
    }
    groupBy = values.by as HistoryGroupBy;
  }
  const filters: UrgencesHistoriqueFilters = {};
  if (typeof values.region === 'string') filters.region = values.region;
  const ids = parseIdList(values.id as string | string[] | undefined);
  if (ids) filters.ids = ids;
  if (typeof values.search === 'string' && values.search !== '') filters.search = values.search;
  try {
    const report = await fetchUrgencesHistoriqueReport({
      filters,
      days,
      groupBy,
      api: typeof values.api === 'string' ? values.api : undefined,
      fixture: typeof values.fixture === 'string' ? values.fixture : undefined,
      cache: { ttlMinutes, refresh: values.refresh === true },
    });
    const output =
      resolveFormat(values) === 'json' ? JSON.stringify(report, null, 2) : formatHistoriqueTable(report);
    process.stdout.write(`${output}\n`);
    if (report.window.coverage.gaps.length > 0) {
      process.stderr.write(`note: the window has gaps with no archived snapshot; ${historiqueCoverageLine(report)}\n`);
    }
    return 0;
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`usage error: ${err.message}\n`);
      return 2;
    }
    if (err instanceof FetchError) {
      process.stderr.write(`fetch error: ${err.message}\n`);
      return 1;
    }
    if (err instanceof ParseError) {
      process.stderr.write(`parse error: ${err.message}\n`);
      return 2;
    }
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 1;
  }
}

function runRegions(values: Record<string, unknown>, positionals: string[]): number {
  const sub = positionals[1];
  if (values.help === true || sub === '--help' || sub === '-h') {
    process.stdout.write(REGIONS_HELP);
    return 0;
  }
  if (sub !== undefined) {
    process.stderr.write(`Unexpected argument to regions: ${sub}\n\n${REGIONS_HELP}`);
    return 2;
  }
  let regions: readonly RssRegion[] = REGIONS;
  if (typeof values.region === 'string') {
    const r = resolveRegion(values.region);
    if (!r) {
      process.stderr.write(
        `usage error: "${values.region}" does not name exactly one region. ` +
          `Run "quebec-sante regions --table" for the accepted spellings.\n`,
      );
      return 2;
    }
    regions = [r];
  }
  const output =
    resolveFormat(values) === 'json'
      ? JSON.stringify({ regions: regions.map(regionEntry) }, null, 2)
      : formatRegionsTable(regions);
  process.stdout.write(`${output}\n`);
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  let values: Record<string, unknown>;
  let positionals: string[];
  try {
    ({ values, positionals } = parseCli(argv));
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${HELP}`);
    return 2;
  }

  if (values.version === true) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  const command = positionals[0];
  if (values.help === true && command === undefined) {
    process.stdout.write(HELP);
    return 0;
  }
  if (command === undefined) {
    process.stdout.write(HELP);
    return 2;
  }
  if (command === 'urgences') return runUrgences(values, positionals);
  if (command === 'cliniques') return runCliniques(values, positionals);
  if (command === 'urgences-cumulatif') return runUrgencesCumulatif(values, positionals);
  if (command === 'chirurgies') return runChirurgies(values, positionals);
  if (command === 'regions') return runRegions(values, positionals);
  if (command === 'urgences-historique') return runUrgencesHistorique(values, positionals);
  process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
  return 2;
}

if (typeof require !== 'undefined' && require.main === module) {
  // Set exitCode rather than calling process.exit(): exit() drops stdout still
  // buffered for a pipe, truncating large --json output at 64 KiB.
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
