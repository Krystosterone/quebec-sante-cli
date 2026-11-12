import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import {
  fetchChirurgiesReport,
  fetchChirurgiesMultiReport,
  buildChirurgiesMultiReport,
  buildChirurgiesReport,
  periodsBetween,
  previousFiscalPeriod,
  selectPeriods,
  samePeriodYearsBack,
  decodePeriod,
  resolveSpecialties,
} from '../src/tools/chirurgies';
import { parseChirurgies } from '../src/core/parseChirurgies';
import { main } from '../src/cli';

const FIXTURE = 'test/fixtures/Chirurgie_ListeAttente.csv';
const freshCache = () => ({ dir: mkdtempSync(join(tmpdir(), 'msss-chirurgies-test-')) });
const report = (filters = {}) => fetchChirurgiesReport({ fixture: FIXTURE, cache: freshCache(), filters });

test('defaults to the latest period, with previous period and decoded fiscal year', async () => {
  const r = await report();
  assert.equal(r.cached, false);
  assert.equal(r.dataDate, '2627-P04');
  assert.deepEqual(r.period, { code: '2627-P04', fiscalYear: '2026-2027', number: 4 });
  assert.equal(r.previousPeriod, '2627-P03');
  assert.equal(r.availablePeriods.length, 4);
  assert.equal(r.regions.length, 15);
  assert.ok(r.source.endsWith('Chirurgie_ListeAttente.csv'));
});

test('regions absent from the period are reported, not silently dropped', async () => {
  assert.deepEqual((await report()).missingRegions, ['RSS04']);
  const p01 = await report({ period: '2627-P01' });
  assert.deepEqual(p01.missingRegions, []);
  assert.equal(p01.previousPeriod, null); // oldest period in the fixture
});

test('Montréal totals, derived percentages and period-over-period delta', async () => {
  const [mtl] = (await report({ region: 'montreal' })).regions;
  assert.ok(mtl);
  assert.equal(mtl.code, 'RSS06');
  assert.equal(mtl.name, 'Montréal');
  assert.deepEqual(mtl.overall.waiting, { under6m: 28454, from6to12m: 6455, over12m: 822 });
  assert.equal(mtl.overall.total, 35731);
  assert.equal(mtl.overall.over6m, 7277);
  assert.equal(mtl.overall.pctOver6m, 20);
  assert.equal(mtl.previousPeriodTotal, 34971);
  assert.equal(mtl.deltaFromPreviousPeriod, 760);
  const ortho = mtl.specialties.find((s) => s.key === 'chirurgie_orthopedique')!;
  assert.deepEqual(ortho.waiting, { under6m: 4374, from6to12m: 1665, over12m: 226 });
  assert.equal(ortho.total, 6265);
  assert.equal(ortho.pctOver6m, 30);
  assert.equal(ortho.pctOver12m, 4);
});

test('province is the derived sum over present regions and ignores --region', async () => {
  const all = await report();
  const one = await report({ region: 'laval' });
  assert.equal(all.province.code, null);
  assert.equal(all.province.overall.total, 126209);
  assert.equal(all.province.overall.total, all.regions.reduce((s, r) => s + r.overall.total, 0));
  assert.equal(one.province.overall.total, 126209);
  assert.equal(all.province.deltaFromPreviousPeriod, 3387); // P03 has the same region set
});

test('province delta is null when the previous period covers a different region set', async () => {
  const p02 = await report({ period: '2627-P02' });
  assert.equal(p02.previousPeriod, '2627-P01'); // P01 still had RSS04
  assert.equal(p02.province.deltaFromPreviousPeriod, null);
  assert.ok(p02.regions.every((r) => r.deltaFromPreviousPeriod !== null));
});

test('each specialty carries its own delta from the previous period', async () => {
  const [mtl] = (await report({ region: 'montreal' })).regions;
  const [prev] = (await report({ region: 'montreal', period: '2627-P03' })).regions;
  for (const s of mtl!.specialties) {
    const before = prev!.specialties.find((p) => p.key === s.key)!;
    assert.equal(s.previousPeriodTotal, before.total, s.key);
    assert.equal(s.deltaFromPreviousPeriod, s.total - before.total, s.key);
  }
  const ortho = mtl!.specialties.find((s) => s.key === 'chirurgie_orthopedique')!;
  assert.equal(ortho.deltaFromPreviousPeriod, 213);
  // The region-level delta is still the all-specialty one, and overall repeats it.
  assert.equal(mtl!.deltaFromPreviousPeriod, 760);
  assert.equal(mtl!.overall.previousPeriodTotal, mtl!.previousPeriodTotal);
  assert.equal(mtl!.overall.deltaFromPreviousPeriod, 760);
  assert.equal(mtl!.specialties.reduce((n, s) => n + s.deltaFromPreviousPeriod!, 0), 760);
  // With --specialty, the specialty keeps its delta and the region's stays all-specialty.
  const [narrow] = (await report({ region: 'montreal', specialty: 'ortho' })).regions;
  assert.equal(narrow!.specialties[0]!.deltaFromPreviousPeriod, 213);
  assert.equal(narrow!.deltaFromPreviousPeriod, 760);
});

test('specialty deltas are null where the period-level delta is', async () => {
  const oldest = await report({ period: '2627-P01' });
  assert.ok(oldest.regions.every((r) => r.specialties.every((s) => s.previousPeriodTotal === null && s.deltaFromPreviousPeriod === null)));
  const p02 = await report({ period: '2627-P02' });
  assert.ok(p02.province.specialties.every((s) => s.deltaFromPreviousPeriod === null)); // different region set
  // Nord-du-Québec published no urology in P01 or P02: not comparable, not a change of 0.
  const unpublished = p02.regions.flatMap((r) =>
    r.specialties.filter((s) => s.deltaFromPreviousPeriod === null).map((s) => `${r.code}/${s.key}`),
  );
  assert.deepEqual(unpublished, ['RSS10/urologie']);
  const uro = p02.regions.find((r) => r.code === 'RSS10')!.specialties.find((s) => s.key === 'urologie')!;
  assert.deepEqual(uro.waiting, { under6m: null, from6to12m: null, over12m: null });
  assert.equal(uro.previousPeriodTotal, null);
});

test('a band row absent from the source yields null, and totals treat it as 0', async () => {
  const [cn] = (await report({ period: '2627-P02', region: 'RSS09' })).regions;
  assert.equal(cn!.name, 'Côte-Nord');
  assert.equal(cn!.overall.waiting.over12m, null);
  assert.equal(cn!.overall.total, (cn!.overall.waiting.under6m ?? 0) + (cn!.overall.waiting.from6to12m ?? 0));
});

test('region filter accepts names (accent-insensitive), slugs and RSS codes', async () => {
  for (const q of ['Côte-Nord', 'cote-nord', 'RSS09', '09', '9', 'rss 9']) {
    const r = await report({ region: q });
    assert.deepEqual(r.regions.map((x) => x.code), ['RSS09'], q);
  }
  assert.equal((await report({ region: 'nowhere' })).regions.length, 0);
});

test('specialty filter narrows specialties everywhere; unknown specialty is a usage error', async () => {
  const r = await report({ specialty: 'ortho' });
  assert.ok(r.regions.every((x) => x.specialties.length === 1));
  assert.equal(r.province.specialties[0]!.total, 29359);
  assert.deepEqual(resolveSpecialties('gynécologie'), ['obstetrique_gynecologie']);
  // Substring semantics: the four "Chirurgie …" + Neurochirurgie + "ORL / chirurgie …".
  assert.equal(resolveSpecialties('chirurgie').length, 6);
  assert.throws(() => resolveSpecialties('cardio'), /unknown specialty/);
});

test('unknown period is a usage error naming the available ones', async () => {
  await assert.rejects(report({ period: '2526-P01' }), /not in the source.*2627-P04/);
});

test('decodePeriod handles fiscal-year pairs', () => {
  assert.deepEqual(decodePeriod('1920-P12'), { code: '1920-P12', fiscalYear: '2019-2020', number: 12 });
});

test('second fetch within TTL is served from cache', async () => {
  const cache = freshCache();
  await fetchChirurgiesReport({ fixture: FIXTURE, cache });
  const again = await fetchChirurgiesReport({ fixture: FIXTURE, cache });
  assert.equal(again.cached, true);
  assert.equal(again.dataDate, '2627-P04');
});

test('a corrupt cache file degrades to a fresh load', async () => {
  const cache = freshCache();
  writeFileSync(join(cache.dir, 'chirurgies-waitlist.json'), '{"rows": 3');
  const r = await fetchChirurgiesReport({ fixture: FIXTURE, cache });
  assert.equal(r.cached, false);
  assert.equal(r.regions.length, 15);
});

test('CLI: exit codes for chirurgies', async () => {
  const quiet = async (args: string[]) => {
    const write = process.stdout.write.bind(process.stdout);
    const errWrite = process.stderr.write.bind(process.stderr);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      return await main(args);
    } finally {
      process.stdout.write = write;
      process.stderr.write = errWrite;
    }
  };
  process.env.QUEBEC_SANTE_CACHE_DIR = freshCache().dir;
  const base = ['chirurgies', '--fixture', FIXTURE, '--json'];
  assert.equal(await quiet([...base, '--region', 'montreal']), 0);
  assert.equal(await quiet([...base, '--table']), 0);
  assert.equal(await quiet([...base, '--period', '2627-P03']), 0);
  assert.equal(await quiet([...base, '--period', '2627-P14']), 2); // no P14
  assert.equal(await quiet([...base, '--period', '2628-P01']), 2); // not a fiscal-year pair
  assert.equal(await quiet([...base, '--period', '2526-P01']), 2); // well-formed but absent
  assert.equal(await quiet([...base, '--specialty', 'cardio']), 2);
  assert.equal(await quiet([...base, '--ttl', '0']), 2);
  assert.equal(await quiet(['chirurgies', 'extra']), 2);
  assert.equal(await quiet(['chirurgies', '--help']), 0);
  delete process.env.QUEBEC_SANTE_CACHE_DIR;
});

test('--periods reports each period, in the order given, like a single-period call', async () => {
  const cache = freshCache();
  const multi = await fetchChirurgiesMultiReport({
    fixture: FIXTURE,
    cache,
    filters: { region: 'montreal', specialty: 'ortho', periods: ['2627-P04', '2627-P01', '2627-P04'] },
  });
  assert.deepEqual(multi.periods, ['2627-P04', '2627-P01']); // duplicates dropped
  assert.deepEqual(multi.notInSource, []);
  assert.equal(multi.availablePeriods.length, 4);
  assert.equal(multi.reports.length, 2);
  for (const r of multi.reports) {
    const single = await fetchChirurgiesReport({
      fixture: FIXTURE,
      cache,
      filters: { region: 'montreal', specialty: 'ortho', period: r.dataDate },
    });
    const { source, fetchedAt, cached, cacheAgeMinutes, availablePeriods, ...rest } = single;
    assert.deepEqual(r, rest);
    assert.equal('source' in r, false);
  }
});

test('--periods: a period the source lacks is listed in notInSource; none present is a usage error', async () => {
  const r = await fetchChirurgiesMultiReport({ fixture: FIXTURE, cache: freshCache(), filters: { periods: ['2627-P04', '2526-P04', '2627-P02'] } });
  assert.deepEqual(r.periods, ['2627-P04', '2627-P02']);
  assert.deepEqual(r.notInSource, ['2526-P04']);
  assert.deepEqual(r.reports.map((x) => x.dataDate), ['2627-P04', '2627-P02']);
  await assert.rejects(
    fetchChirurgiesMultiReport({ fixture: FIXTURE, cache: freshCache(), filters: { periods: ['2526-P04', '2526-P03'] } }),
    /period 2526-P04 is not in the source/,
  );
});

test('previousFiscalPeriod and periodsBetween step fiscal periods, P01 back to P13', () => {
  assert.equal(previousFiscalPeriod('2627-P04'), '2627-P03');
  assert.equal(previousFiscalPeriod('2627-P01'), '2526-P13');
  assert.equal(previousFiscalPeriod('nope'), null);
  assert.deepEqual(periodsBetween('2627-P04', '2627-P03'), []);
  assert.deepEqual(periodsBetween('2627-P02', '2526-P12'), ['2627-P01', '2526-P13']);
  assert.deepEqual(periodsBetween('2627-P04', null), []);
});

test('a period MSSS skipped: missingPeriods names it and the delta compares with the last published one', () => {
  // Drop 2627-P03 from the source, as if MSSS had never published it.
  const { rows, periods } = parseChirurgies(readFileSync(FIXTURE, 'utf8'));
  const kept = rows.filter((r) => r.period !== '2627-P03');
  const avail = periods.filter((p) => p !== '2627-P03');
  const meta = { cached: false, cacheAgeMinutes: 0 };
  const gap = buildChirurgiesReport(kept, avail, { period: '2627-P04' }, meta);
  assert.equal(gap.previousPeriod, '2627-P02');
  assert.deepEqual(gap.missingPeriods, ['2627-P03']);
  // P03's report compares with P02 too: same previous total, so the delta spans P02 → P04.
  const p03 = buildChirurgiesReport(rows, periods, { period: '2627-P03' }, meta);
  const mtl = (r: typeof gap) => r.regions.find((x) => x.code === 'RSS06')!;
  assert.equal(mtl(gap).previousPeriodTotal, mtl(p03).previousPeriodTotal);
  assert.deepEqual(buildChirurgiesReport(rows, periods, { period: '2627-P04' }, meta).missingPeriods, []);
});

test('samePeriodYearsBack steps fiscal years, across the century', () => {
  assert.equal(samePeriodYearsBack('2627-P04', 0), '2627-P04');
  assert.equal(samePeriodYearsBack('2627-P04', 2), '2425-P04');
  assert.equal(samePeriodYearsBack('0001-P13', 1), '9900-P13');
});

test('--years takes the same period from earlier fiscal years, newest first', () => {
  const avail = ['2627-P04', '2627-P03', '2526-P04', '2526-P03', '2425-P04'];
  assert.deepEqual(selectPeriods(avail, { years: 3 }), { codes: ['2627-P04', '2526-P04', '2425-P04'], notInSource: [] });
  assert.deepEqual(selectPeriods(avail, { years: 3, period: '2627-P03' }), {
    codes: ['2627-P03', '2526-P03'],
    notInSource: ['2425-P03'],
  });
  assert.deepEqual(selectPeriods(avail, { years: 1 }), { codes: ['2627-P04'], notInSource: [] });
  assert.throws(() => selectPeriods(avail, { years: 0 }), /years must be/);
  assert.throws(() => selectPeriods(avail, { years: 2, periods: ['2627-P04'] }), /not both/);
});

test('--years on rows spanning fiscal years builds one report per year', async () => {
  // The fixture holds one fiscal year; relabel 2627-P01 as last year's P04 to get a second year.
  const { rows, periods } = parseChirurgies(readFileSync(FIXTURE, 'utf8'));
  const lastYear = rows.filter((r) => r.period === '2627-P01').map((r) => ({ ...r, period: '2526-P04' }));
  const multi = buildChirurgiesMultiReport([...rows, ...lastYear], [...periods, '2526-P04'], { years: 3 }, { cached: false, cacheAgeMinutes: 0 });
  assert.deepEqual(multi.periods, ['2627-P04', '2526-P04']);
  assert.deepEqual(multi.notInSource, ['2425-P04']);
  assert.deepEqual(multi.reports.map((r) => r.missingRegions), [['RSS04'], []]);
  assert.equal(multi.reports[1]!.previousPeriod, null);
});

test('CLI: chirurgies --periods / --years', () => {
  // A subprocess: the test runner itself writes to this process's stdout.
  const env = { ...process.env, QUEBEC_SANTE_CACHE_DIR: freshCache().dir };
  const cli = (args: string[]) => {
    const r = spawnSync('node', ['--import', 'tsx', 'src/cli.ts', 'chirurgies', '--fixture', FIXTURE, ...args], {
      encoding: 'utf8',
      env,
    });
    return { code: r.status, out: r.stdout };
  };
  const ok = cli(['--json', '--region', 'montreal', '--periods', '2627-p04, 2627-P02']);
  assert.equal(ok.code, 0);
  const report = JSON.parse(ok.out);
  assert.deepEqual(report.periods, ['2627-P04', '2627-P02']);
  assert.equal(report.reports[1].regions[0].code, 'RSS06');
  const years = JSON.parse(cli(['--json', '--years', '2']).out);
  assert.deepEqual(years.periods, ['2627-P04']);
  assert.deepEqual(years.notInSource, ['2526-P04']);
  const table = cli(['--table', '--periods', '2627-P04,2627-P03']);
  assert.equal(table.code, 0);
  assert.match(table.out, /== 2627-P04 \(fiscal 2026-2027, P4\) ==/);
  assert.match(table.out, /== 2627-P03 /);
  for (const bad of [
    ['--periods', '2627-P04,2627-P99'],
    ['--periods', ','],
    ['--periods', '2627-P04', '--years', '2'],
    ['--periods', '2627-P04', '--period', '2627-P03'],
    ['--years', '0'],
    ['--years', '14'],
    ['--years', 'x'],
    ['--periods', '2526-P04,2526-P03'], // well-formed, none in the source
  ]) {
    assert.equal(cli(['--json', ...bad]).code, 2, bad.join(' '));
  }
});
