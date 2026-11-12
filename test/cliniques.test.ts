import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { buildCliniquesReport, fetchCliniquesReport, weekdayOf } from '../src/tools/cliniques';
import type { Clinic } from '../src/core/types';
import { main } from '../src/cli';

const FIXTURE = 'test/fixtures/rdvoffert_DOuv.csv';
const CACHE = {
  dir: '/tmp/msss-cliniques-test-cache-' + Date.now(),
  ttlMinutes: 24 * 60,
};

test('fetch from fixture yields a report on the latest date by default', async () => {
  const report = await fetchCliniquesReport({ fixture: FIXTURE, cache: CACHE });
  assert.equal(report.cached, false);
  assert.equal(report.dataDate, '2026-08-19'); // latest date present
  assert.ok(report.clinics.length > 1000);
  assert.equal(report.availableDates.length, 2);
});

test('second fetch within TTL is served from cache', async () => {
  await fetchCliniquesReport({ fixture: FIXTURE, cache: CACHE }); // prime
  const cached = await fetchCliniquesReport({ fixture: FIXTURE, cache: CACHE });
  assert.equal(cached.cached, true);
});

test('--date picks a specific day', async () => {
  const report = await fetchCliniquesReport({
    fixture: FIXTURE,
    cache: CACHE,
    filters: { date: '2026-08-18' },
  });
  assert.equal(report.dataDate, '2026-08-18');
  assert.ok(report.clinics.every((c) => c.date === '2026-08-18'));
});

test('a single date by default: window of 1 day, dates = [that date]', async () => {
  const report = await fetchCliniquesReport({ fixture: FIXTURE, cache: CACHE });
  assert.deepEqual(report.window, { from: '2026-08-19', to: '2026-08-19', days: 1, missingDates: [] });
  assert.deepEqual(report.dates, ['2026-08-19']);
});

test('--days covers several dates in one call, newest first, ending at --date', async () => {
  const one = await fetchCliniquesReport({ fixture: FIXTURE, cache: CACHE, filters: { rls: 'kamouraska', date: '2026-08-18' } });
  const two = await fetchCliniquesReport({ fixture: FIXTURE, cache: CACHE, filters: { rls: 'kamouraska', date: '2026-08-19' } });
  const both = await fetchCliniquesReport({ fixture: FIXTURE, cache: CACHE, filters: { rls: 'kamouraska', days: 7 } });
  const missingDates = ['2026-08-17', '2026-08-16', '2026-08-15', '2026-08-14', '2026-08-13'];
  assert.deepEqual(both.window, { from: '2026-08-13', to: '2026-08-19', days: 7, missingDates });
  assert.equal(both.dataDate, '2026-08-19');
  assert.deepEqual(both.dates, ['2026-08-19', '2026-08-18']); // only days the source has
  assert.equal(both.clinics.length, one.clinics.length + two.clinics.length);
  const order = both.clinics.map((c) => c.date);
  assert.deepEqual(order, [...order].sort().reverse());
  // The same rows as the single-day calls, in the same within-day order.
  assert.deepEqual(both.clinics.filter((c) => c.date === '2026-08-18'), one.clinics);
});

test('--days ending at an earlier --date excludes later dates', async () => {
  const r = await fetchCliniquesReport({ fixture: FIXTURE, cache: CACHE, filters: { date: '2026-08-18', days: 2 } });
  assert.deepEqual(r.window, { from: '2026-08-17', to: '2026-08-18', days: 2, missingDates: ['2026-08-17'] });
  assert.deepEqual(r.dates, ['2026-08-18']);
  assert.ok(r.clinics.every((c) => c.date === '2026-08-18'));
});

test('a days window crosses month and year ends', async () => {
  const r = await fetchCliniquesReport({ fixture: FIXTURE, cache: CACHE, filters: { date: '2026-03-01', days: 3 } });
  assert.deepEqual(r.window, { from: '2026-02-27', to: '2026-03-01', days: 3, missingDates: ['2026-03-01', '2026-02-28', '2026-02-27'] });
  assert.deepEqual(r.dates, []);
  assert.equal(r.clinics.length, 0);
  const y = await fetchCliniquesReport({ fixture: FIXTURE, cache: CACHE, filters: { date: '2026-01-01', days: 2 } });
  assert.equal(y.window.from, '2025-12-31');
});

test('days outside 1..31 is a usage error', async () => {
  for (const days of [0, 32, 1.5]) {
    await assert.rejects(
      fetchCliniquesReport({ fixture: FIXTURE, cache: CACHE, filters: { days } }),
      (err: Error) => err.name === 'UsageError',
    );
  }
});

test('each row carries its ISO weekday and name, right after its date', async () => {
  assert.deepEqual(weekdayOf('2026-10-22'), { weekday: 4, weekdayName: 'Thursday' });
  assert.deepEqual(weekdayOf('2026-10-25'), { weekday: 7, weekdayName: 'Sunday' });
  assert.deepEqual(weekdayOf('2026-10-26'), { weekday: 1, weekdayName: 'Monday' });
  const r = await fetchCliniquesReport({ fixture: FIXTURE, cache: CACHE, filters: { rls: 'kamouraska', days: 2 } });
  for (const c of r.clinics) {
    assert.deepEqual({ weekday: c.weekday, weekdayName: c.weekdayName }, weekdayOf(c.date));
    assert.deepEqual(Object.keys(c).slice(0, 3), ['date', 'weekday', 'weekdayName']);
  }
});

const row = (date: string, name: string, professionGroup: string, slots: Partial<Clinic['slots']>, rlsCode = '0642'): Clinic => {
  const full = { '6h_9h': null, '9h_12h': null, '12h_15h': null, '15h_18h': null, '18h_21h': null, '21h_6h': null, ...slots };
  return {
    date,
    regionCode: '064',
    regionName: 'RTS du Nord',
    rssCode: '06',
    rlsCode,
    rlsName: rlsCode === '0642' ? 'RLS A' : 'RLS B',
    name,
    professionGroup,
    slots: full,
    totalOffered: Object.values(full).reduce((n: number, v) => n + (v ?? 0), 0),
  };
};

test('summary: per clinic × group and per group, over the window', () => {
  const dates = ['2026-10-28', '2026-10-27', '2026-10-26'];
  const rows = [
    row('2026-10-28', 'Zeta', 'Médecin', { '9h_12h': 5, '18h_21h': 2 }),
    row('2026-10-27', 'Zeta', 'Médecin', { '9h_12h': 3, '18h_21h': 1 }),
    row('2026-10-26', 'Zeta', 'Médecin', { '9h_12h': 4 }),
    row('2026-10-28', 'Zeta', 'Infirmière', { '6h_9h': 1 }),
    row('2026-10-28', 'Alpha', 'Médecin', { '18h_21h': 7 }),
    row('2026-10-26', 'Alpha', 'Médecin', { '18h_21h': 1, '21h_6h': 2 }),
    row('2026-10-27', 'Alpha', 'Médecin', {}), // a row with no offers
    row('2026-10-28', 'Alpha', 'Médecin', { '9h_12h': 9 }, '0643'), // same name, another RLS
  ];
  const r = buildCliniquesReport(rows, dates, { days: 3 }, { cached: false, cacheAgeMinutes: 0 });
  const s = r.summary;
  assert.equal(s.clinicsWithOffers, 3); // Alpha (RLS A), Alpha (RLS B), Zeta
  // Alphabetical (name, group, RLS), not ranked by volume.
  assert.deepEqual(
    s.byClinic.map((c) => `${c.name}/${c.professionGroup}/${c.rlsCode}`),
    ['Alpha/Médecin/0642', 'Alpha/Médecin/0643', 'Zeta/Infirmière/0642', 'Zeta/Médecin/0642'],
  );
  const zeta = s.byClinic.find((c) => c.name === 'Zeta' && c.professionGroup === 'Médecin')!;
  assert.equal(zeta.daysWithOffers, 3);
  assert.deepEqual(zeta.datesWithOffers, dates);
  assert.equal(zeta.totalOffered, 15);
  assert.deepEqual(zeta.bands['9h_12h'], { offered: 12, daysWithOffers: 3 });
  assert.deepEqual(zeta.bands['18h_21h'], { offered: 3, daysWithOffers: 2 });
  assert.deepEqual(zeta.bands['21h_6h'], { offered: 0, daysWithOffers: 0 });
  const alpha = s.byClinic.find((c) => c.name === 'Alpha' && c.rlsCode === '0642')!;
  assert.equal(alpha.daysWithOffers, 2); // the empty 2026-10-27 row isn't a day with offers
  assert.deepEqual(alpha.datesWithOffers, ['2026-10-28', '2026-10-26']);
  const med = s.byProfessionGroup.find((g) => g.professionGroup === 'Médecin')!;
  assert.deepEqual(s.byProfessionGroup.map((g) => g.professionGroup), ['Infirmière', 'Médecin']);
  assert.equal(med.clinicsWithOffers, 3);
  assert.equal(med.clinicsWithOffersEveryDay, 1); // Zeta
  assert.equal(med.totalOffered, 15 + 10 + 9);
  assert.deepEqual(med.bands['18h_21h'], { offered: 11, clinicsWithOffers: 2, clinicsWithOffersEveryDay: 0 });
  assert.deepEqual(med.bands['9h_12h'], { offered: 21, clinicsWithOffers: 2, clinicsWithOffersEveryDay: 1 });
  assert.equal(r.clinics.reduce((n, c) => n + c.totalOffered, 0), s.byProfessionGroup.reduce((n, g) => n + g.totalOffered, 0));
});

test('summary follows the filters and the window', async () => {
  const r = await fetchCliniquesReport({ fixture: FIXTURE, cache: CACHE, filters: { rls: 'kamouraska', days: 7 } });
  assert.equal(r.summary.clinicsWithOffers, new Set(r.clinics.map((c) => c.name)).size);
  for (const c of r.summary.byClinic) {
    const mine = r.clinics.filter((x) => x.name === c.name && x.professionGroup === c.professionGroup);
    assert.equal(c.totalOffered, mine.reduce((n, x) => n + x.totalOffered, 0));
    assert.ok(c.daysWithOffers <= r.dates.length);
  }
  const empty = await fetchCliniquesReport({ fixture: FIXTURE, cache: CACHE, filters: { date: '2026-03-01', days: 3 } });
  assert.deepEqual(empty.summary, { clinicsWithOffers: 0, byProfessionGroup: [], byClinic: [] });
});

test('a date MSSS skipped is named in window.missingDates; "every day" means every date in dates', () => {
  // The source has 10-28 and 10-26 but no row at all for 10-27.
  const dates = ['2026-10-28', '2026-10-26'];
  const clinics = [row('2026-10-28', 'A', 'Médecin', { '9h_12h': 2 }), row('2026-10-26', 'A', 'Médecin', { '9h_12h': 1 })];
  const r = buildCliniquesReport(clinics, dates, { days: 3 }, { cached: false, cacheAgeMinutes: 0 });
  assert.deepEqual(r.window, { from: '2026-10-26', to: '2026-10-28', days: 3, missingDates: ['2026-10-27'] });
  assert.deepEqual(r.dates, dates);
  assert.equal(r.summary.byClinic[0]!.daysWithOffers, 2);
  assert.equal(r.summary.byProfessionGroup[0]!.clinicsWithOffersEveryDay, 1, 'every published date, not every window day');
});

test('availableDates keeps the newest 31 dates; availableRange spans the source', () => {
  const dates = Array.from({ length: 40 }, (_, i) => new Date(Date.UTC(2026, 9, 28 - i)).toISOString().slice(0, 10));
  const r = buildCliniquesReport([], dates, {}, { cached: false, cacheAgeMinutes: 0 });
  assert.equal(r.availableDates.length, 31);
  assert.deepEqual(r.availableDates, dates.slice(0, 31));
  assert.deepEqual(r.availableRange, { from: dates[39], to: '2026-10-28', count: 40 });
});

test('region filter is accent-insensitive', async () => {
  const report = await fetchCliniquesReport({
    fixture: FIXTURE,
    cache: CACHE,
    filters: { region: 'bas-saint-laurent' },
  });
  assert.ok(report.clinics.length > 0);
  assert.ok(report.clinics.every((c) => c.regionName.includes('Bas-Saint-Laurent')));
});

test('search filters by clinic name substring, accent-insensitive', async () => {
  const report = await fetchCliniquesReport({
    fixture: FIXTURE,
    cache: CACHE,
    filters: { search: 'pocatiere' }, // accent-insensitive match on "La Pocatière"
  });
  assert.ok(report.clinics.length > 0);
  assert.ok(report.clinics.every((c) => c.name.toLowerCase().includes('pocatière')));
});

test('rls filter narrows to a local service network, accent-insensitive', async () => {
  const report = await fetchCliniquesReport({
    fixture: FIXTURE,
    cache: CACHE,
    filters: { rls: 'kamouraska' },
  });
  assert.ok(report.clinics.length > 0);
  assert.ok(report.clinics.every((c) => c.rlsName.toLowerCase().includes('kamouraska')));
});

test('CLI: cliniques --fixture --json emits parseable output with correct shape', async () => {
  const { stdout } = await runCli(['cliniques', '--region', 'bas-saint-laurent', '--fixture', FIXTURE, '--json']);
  const report = JSON.parse(stdout);
  assert.equal(report.source.includes('rdvoffert_DOuv'), true);
  assert.equal(report.dataDate, '2026-08-19');
  assert.ok(report.clinics.length > 0);
  assert.ok(report.clinics.every((c) => c.regionName.includes('Bas-Saint-Laurent')));
  assert.ok('totalOffered' in report.clinics[0]);
});

test('CLI: unknown command exits 2', async () => {
  const code = await main(['nope']);
  assert.equal(code, 2);
});

test('CLI: cliniques --ttl abc exits 2 usage', async () => {
  const code = await main(['cliniques', '--ttl', 'abc', '--fixture', FIXTURE]);
  assert.equal(code, 2);
});

test('CLI: cliniques rejects a malformed --date with exit 2', async () => {
  const code = await main(['cliniques', '--date', '2026-99-99', '--fixture', FIXTURE]);
  assert.equal(code, 2);
});

test('CLI: cliniques rejects an impossible calendar date with exit 2', async () => {
  const code = await main(['cliniques', '--date', '2026-02-30', '--fixture', FIXTURE]);
  assert.equal(code, 2);
});

test('CLI: cliniques accepts a well-formed present date', async () => {
  const code = await main(['cliniques', '--date', '2026-08-19', '--region', 'bas-saint-laurent', '--fixture', FIXTURE, '--json']);
  assert.equal(code, 0);
});

test('CLI: cliniques --days validates and returns the window', async () => {
  for (const bad of ['0', '32', 'abc', '2.5']) {
    assert.equal(await main(['cliniques', '--days', bad, '--fixture', FIXTURE]), 2, bad);
  }
  const { stdout, code } = await runCli(['cliniques', '--rls', 'kamouraska', '--days', '7', '--fixture', FIXTURE, '--json']);
  assert.equal(code, 0);
  const report = JSON.parse(stdout);
  assert.deepEqual(report.window.missingDates, ['2026-08-17', '2026-08-16', '2026-08-15', '2026-08-14', '2026-08-13']);
  assert.deepEqual(report.dates, ['2026-08-19', '2026-08-18']);
});

test('CLI: a multi-day table shows a DATE column', async () => {
  const { stdout, code } = await runCli(['cliniques', '--rls', 'kamouraska', '--days', '2', '--fixture', FIXTURE, '--table']);
  assert.equal(code, 0);
  assert.match(stdout, /^DATE\s+TOTAL/m);
  assert.match(stdout, /2026-08-18 → 2026-08-19 \(2 days, 2 with data\)/);
  assert.match(stdout, /^Summary over 2 date\(s\) with data/m);
  assert.match(stdout, /^available dates: 2026-08-18 → 2026-08-19 \(2 dates\)$/m);
  const wider = await runCli(['cliniques', '--rls', 'kamouraska', '--days', '3', '--fixture', FIXTURE, '--table']);
  assert.match(wider.stdout, /^not in the source: 2026-08-17$/m);
});

test('CLI: --version of the binary includes both commands in help', async () => {
  const { stdout } = await runCli(['--help']);
  assert.ok(stdout.includes('cliniques'));
  assert.ok(stdout.includes('urgences'));
});

/** Run the real CLI as a subprocess and capture stdout/stderr. */
function runCli(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const p: ChildProcess = spawn('node', ['--import', 'tsx', 'src/cli.ts', ...args], {
      cwd: process.cwd(),
      // Isolated cache: a developer's real cache (live data) must not leak into fixture runs.
      env: { ...process.env, QUEBEC_SANTE_CACHE_DIR: `/tmp/msss-cliniques-cli-test-${process.pid}-${Date.now()}` },
    });
    let stdout = '';
    let stderr = '';
    p.stdout!.on('data', (d: Buffer) => (stdout += d.toString()));
    p.stderr!.on('data', (d: Buffer) => (stderr += d.toString()));
    p.on('close', (code: number) => resolve({ stdout, stderr, code }));
  });
}
