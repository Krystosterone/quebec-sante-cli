// The static history API (builder) and the urgences-historique command
// (aggregation, caching, CLI). Offline: synthetic snapshots derived from the
// real hourly fixture; HTTP only to a local server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildHistory, type ArchivedVersion } from '../src/core/history';
import { buildApiSite, URGENCES_ARCHIVE_PATH } from '../src/core/historyBuild';
import {
  buildHistoriqueReport,
  fetchUrgencesHistoriqueReport,
  shiftDays,
  type HistoryGroupBy,
} from '../src/tools/urgencesHistorique';
import { main } from '../src/cli';

// The saved fixture is UTF-8 text; MSSS serves Latin-1. Versions hold decoded
// text, and the git test below writes them as Latin-1 bytes, like the archive.
const FIXTURE = readFileSync('test/fixtures/urgences_nbpers.csv', 'utf8');
const FIXTURE_STAMP = '2026-08-23T15:45';
const SJ = '51222800'; // CHU Sainte-Justine: 16 functional stretchers in the fixture

/** The fixture re-stamped, with Sainte-Justine's occupied stretchers set to `occupied`. */
function version(stamp: string, occupied: number): ArchivedVersion {
  const csv = FIXTURE.split(FIXTURE_STAMP)
    .join(stamp)
    .replace(/(CHU SAINTE-JUSTINE,51222800,16,)17,/, `$1${occupied},`);
  return { ref: stamp, csv };
}

// Mon 08-31 15h: 50% · Mon 09-07 15h: 100% · Mon 09-07 16h: 150% (a corrected
// republish of 75%) · Tue 09-08 15h: 125%.
const VERSIONS: ArchivedVersion[] = [
  version('2026-08-31T15:45', 8),
  version('2026-09-07T15:45', 16),
  version('2026-09-07T16:45', 12),
  { ref: 'broken', csv: 'not,a,real\nfile,at,all\n' },
  version('2026-09-07T16:45', 24),
  version('2026-09-08T15:45', 20),
];
const BUILT = buildHistory(VERSIONS, { generatedAt: '2026-09-08T20:00:00.000Z', archiveCommit: 'abc' });

function report(groupBy: HistoryGroupBy, days = 28, filters = { ids: [SJ] }) {
  return buildHistoriqueReport(BUILT.index, BUILT.months, {
    days,
    groupBy,
    filters,
    source: 'test',
    fetchedAt: 'now',
    cached: false,
  });
}

test('buildHistory: months, completeness, dedupe, skipped versions', () => {
  const { index, months } = BUILT;
  assert.deepEqual(
    months.map((m) => [m.month, m.complete, m.snapshots]),
    [
      ['2026-08', true, ['2026-08-31T15:45']],
      ['2026-09', false, ['2026-09-07T15:45', '2026-09-07T16:45', '2026-09-08T15:45']],
    ],
  );
  const u = index.datasets.urgences;
  assert.equal(u.snapshots, 4);
  assert.equal(u.first, '2026-08-31T15:45');
  assert.equal(u.last, '2026-09-08T15:45');
  assert.equal(u.skippedVersions, 1);
  assert.deepEqual(u.months.map((m) => m.path), ['urgences/2026-08.json', 'urgences/2026-09.json']);
  const sj = months[1]!.facilities.find((f) => f.id === SJ)!;
  assert.equal(sj.name, 'CHU SAINTE-JUSTINE');
  assert.equal(sj.regionCode, '06');
  // [functional, occupied, >24h, >48h, present, waiting, dmsStretcher, dmsAmbulatory]
  assert.deepEqual(sj.values[1], [16, 24, 0, 0, 53, 26, 7.07, 4.06], 'later republish of 16:45 wins');
});

test('buildHistory keeps the unpadded morning stamps MSSS publishes (T8:45)', () => {
  const morning = version('2026-09-08T8:45', 8);
  morning.csv = morning.csv.split('15:00:00,2026-09-08T8:45').join('8:00:00,2026-09-08T8:45');
  const { index, months } = buildHistory([version('2026-09-07T15:45', 16), morning], {
    generatedAt: 'x',
    archiveCommit: 'abc',
  });
  assert.equal(index.datasets.urgences.skippedVersions, 0);
  assert.deepEqual(months[0]!.snapshots, ['2026-09-07T15:45', '2026-09-08T08:45']);
});

test('shiftDays works on the naive local timestamp', () => {
  assert.equal(shiftDays('2026-09-08T15:45', -28), '2026-08-11T15:45');
  assert.equal(shiftDays('2026-03-01T00:15', -1), '2026-02-28T00:15');
});

test('by hour: means per hour; latest vs typical', () => {
  const r = report('hour');
  assert.equal(r.window.to, '2026-09-08T15:45');
  assert.equal(r.window.from, '2026-08-11T15:45');
  assert.equal(r.window.snapshots, 4);
  const f = r.facilities[0]!;
  assert.equal(r.facilities.length, 1);
  assert.equal(f.summary.samples, 4);
  assert.equal(f.summary.occupancyPctMean, 106.3); // (50+100+150+125)/4
  assert.equal(f.summary.occupancyPctMin, 50);
  assert.equal(f.summary.occupancyPctMax, 150);
  assert.deepEqual(
    f.profile.map((p) => [p.hour, p.samples, p.occupancyPctMean]),
    [
      [15, 3, 91.7],
      [16, 1, 150],
    ],
  );
  assert.deepEqual(f.latest, {
    dataDate: '2026-09-08T15:45',
    occupancyPct: 125,
    waitingForCare: 26,
    totalPresent: 53,
    typicalOccupancyPct: 75, // other 15h samples: 50, 100
    typicalOccupancyPctSameWeekday: null, // no other Tuesday 15h
    deltaFromTypicalPct: 50,
  });
});

test('by weekday-hour and by day', () => {
  const wh = report('weekday-hour').facilities[0]!.profile;
  assert.deepEqual(
    wh.map((p) => [p.weekdayName, p.hour, p.occupancyPctMean]),
    [
      ['Monday', 15, 75],
      ['Monday', 16, 150],
      ['Tuesday', 15, 125],
    ],
  );
  const day = report('day').facilities[0]!.profile;
  assert.deepEqual(
    day.map((p) => [p.date, p.samples, p.occupancyPctMean]),
    [
      ['2026-08-31', 1, 50],
      ['2026-09-07', 2, 125],
      ['2026-09-08', 1, 125],
    ],
  );
});

test('window is anchored on the latest snapshot and excludes its lower bound', () => {
  const r = report('hour', 1);
  assert.equal(r.window.from, '2026-09-07T15:45');
  assert.equal(r.window.snapshots, 2);
  assert.equal(r.facilities[0]!.summary.samples, 2);
});

test('coverage: three ranges, the gaps between them, and the leading gap before the first snapshot', () => {
  const r = report('hour');
  assert.deepEqual(r.window.coverage, {
    expectedSnapshots: 28 * 24,
    ranges: [
      { from: '2026-08-31T15:45', to: '2026-08-31T15:45', snapshots: 1 },
      { from: '2026-09-07T15:45', to: '2026-09-07T16:45', snapshots: 2 },
      { from: '2026-09-08T15:45', to: '2026-09-08T15:45', snapshots: 1 },
    ],
    gaps: [
      { from: '2026-08-11T15:45', to: '2026-08-31T15:45', hours: 480 }, // window.from → first snapshot
      { from: '2026-08-31T15:45', to: '2026-09-07T15:45', hours: 168 },
      { from: '2026-09-07T16:45', to: '2026-09-08T15:45', hours: 23 },
    ],
  });
  // The archive-wide gaps come from the index, whatever the window.
  assert.deepEqual(BUILT.index.datasets.urgences.gaps, r.window.coverage.gaps.slice(1));
  assert.deepEqual(report('hour', 1).archive, {
    first: '2026-08-31T15:45',
    last: '2026-09-08T15:45',
    snapshots: 4,
    gaps: r.window.coverage.gaps.slice(1),
  });
  // A window inside one range has none; a gap up to 6 h isn't one.
  const short = buildHistory([version('2026-09-08T08:45', 8), version('2026-09-08T14:45', 8)], { generatedAt: 'x' });
  assert.deepEqual(short.index.datasets.urgences.gaps, []);
  const s = buildHistoriqueReport(short.index, short.months, {
    days: 1, groupBy: 'hour', filters: { ids: [SJ] }, source: 't', fetchedAt: 'now', cached: false,
  });
  assert.equal(s.window.coverage.ranges.length, 1);
  assert.deepEqual(s.window.coverage.gaps, [{ from: '2026-09-07T14:45', to: '2026-09-08T08:45', hours: 18 }]);
});

test('an API built before gaps existed still reads, with archive.gaps null', () => {
  const { gaps: _g, ...old } = BUILT.index.datasets.urgences;
  const index = { ...BUILT.index, datasets: { urgences: old } };
  const r = buildHistoriqueReport(index, BUILT.months, {
    days: 28, groupBy: 'hour', filters: { ids: [SJ] }, source: 't', fetchedAt: 'now', cached: false,
  });
  assert.equal(r.archive.gaps, null);
  assert.equal(r.window.coverage.ranges.length, 3);
});

test('per facility: reporting, not reporting (blank stretcher figures) and absent from the file', () => {
  const blank = version('2026-09-08T16:45', 0);
  blank.csv = blank.csv.replace(/(CHU SAINTE-JUSTINE,51222800,)16,0,0,0,/, '$1,,,,');
  const gone = version('2026-09-08T17:45', 0);
  gone.csv = gone.csv.split(/\r?\n/).filter((l) => !l.includes(',51222800,')).join('\r\n');
  const built = buildHistory([...VERSIONS, blank, gone], { generatedAt: 'x' });
  const r = buildHistoriqueReport(built.index, built.months, {
    days: 28, groupBy: 'hour', filters: { ids: [SJ] }, source: 't', fetchedAt: 'now', cached: false,
  });
  assert.equal(r.window.snapshots, 6);
  const f = r.facilities[0]!;
  assert.deepEqual(f.snapshots, { reporting: 4, notReporting: 1, absent: 1 });
  assert.equal(f.summary.samples, 5, 'samples counts snapshots the facility is listed in');
});

test('filters: region code, search, ids', () => {
  const mtl = report('hour', 28, { region: '06' } as never);
  assert.ok(mtl.facilities.length > 5);
  assert.ok(mtl.facilities.every((f) => f.regionCode === '06'));
  const s = report('hour', 28, { search: 'sainte-justine' } as never);
  assert.deepEqual(s.facilities.map((f) => f.id), [SJ]);
});

function writeApi(dir: string): void {
  mkdirSync(join(dir, 'urgences'), { recursive: true });
  writeFileSync(join(dir, 'index.json'), JSON.stringify(BUILT.index));
  for (const m of BUILT.months) writeFileSync(join(dir, 'urgences', `${m.month}.json`), JSON.stringify(m));
}

test('fixture dir + CLI JSON and table output', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'msss-api-'));
  writeApi(dir);
  const r = await fetchUrgencesHistoriqueReport({ fixture: dir, filters: { ids: [SJ] }, groupBy: 'day' });
  assert.equal(r.facilities[0]!.profile.length, 3);

  const out: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  const errOrig = process.stderr.write.bind(process.stderr);
  (process.stdout as { write: unknown }).write = (chunk: string) => (out.push(String(chunk)), true);
  (process.stderr as { write: unknown }).write = () => true; // the gap note (tested below)
  try {
    assert.equal(await main(['urgences-historique', '--fixture', dir, '--id', SJ, '--json']), 0);
    assert.equal(await main(['urgences-historique', '--fixture', dir, '--id', SJ, '--by', 'weekday-hour', '--table']), 0);
  } finally {
    (process.stdout as { write: unknown }).write = orig;
    (process.stderr as { write: unknown }).write = errOrig;
  }
  const json = JSON.parse(out[0]!);
  assert.equal(json.groupBy, 'hour');
  assert.equal(json.facilities[0].id, SJ);
  assert.equal(json.window.coverage.ranges.length, 3);
  assert.equal(json.archive.gaps.length, 2);
  assert.match(out[1]!, /CHU SAINTE-JUSTINE \(51222800\)/);
  assert.match(out[1]!, /Tue 15h/);
  assert.match(out[1]!, /^coverage: 4 of 672 hourly snapshots in 3 range\(s\) · gaps over 6 h: 2026-08-11T15:45 → 2026-08-31T15:45 \(480 h\)/m);
  assert.match(out[1]!, /reporting in 4 snapshot\(s\) · not reporting in 0 · absent from 0/);
});

test('CLI: a window with a gap writes a note on stderr', () => {
  const dir = mkdtempSync(join(tmpdir(), 'msss-api-'));
  writeApi(dir);
  const r = spawnSync('node', ['--import', 'tsx', 'src/cli.ts', 'urgences-historique', '--fixture', dir, '--id', SJ, '--json'], {
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /^note: the window has gaps with no archived snapshot; coverage: 4 of 672/m);
  assert.equal(JSON.parse(r.stdout).window.coverage.gaps.length, 3);
});

test('CLI rejects bad --by and --days with exit 2', async () => {
  const errOrig = process.stderr.write.bind(process.stderr);
  (process.stderr as { write: unknown }).write = () => true;
  try {
    assert.equal(await main(['urgences-historique', '--by', 'fortnight']), 2);
    assert.equal(await main(['urgences-historique', '--days', '0']), 2);
    assert.equal(await main(['urgences-historique', '--days', '2.5']), 2);
  } finally {
    (process.stderr as { write: unknown }).write = errOrig;
  }
});

test('HTTP: caches documents; --refresh re-fetches only the index and the current month', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'msss-api-'));
  writeApi(dir);
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url!);
    const file = join(dir, req.url!.replace(/^\/api\/v1\//, ''));
    if (!existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(readFileSync(file));
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  const cacheDir = mkdtempSync(join(tmpdir(), 'msss-api-cache-'));
  try {
    const first = await fetchUrgencesHistoriqueReport({ api, cache: { dir: cacheDir } });
    assert.equal(first.cached, false);
    assert.deepEqual(hits, ['/api/v1/index.json', '/api/v1/urgences/2026-08.json', '/api/v1/urgences/2026-09.json']);

    hits.length = 0;
    const second = await fetchUrgencesHistoriqueReport({ api, cache: { dir: cacheDir } });
    assert.equal(second.cached, true);
    assert.deepEqual(hits, []);

    await fetchUrgencesHistoriqueReport({ api, cache: { dir: cacheDir, refresh: true } });
    assert.deepEqual(hits, ['/api/v1/index.json', '/api/v1/urgences/2026-09.json']);

    // A backfill lands a snapshot in the complete month: the index no longer
    // matches the cached copy, so it is fetched again.
    const backfilled = buildHistory([version('2026-08-30T15:45', 4), ...VERSIONS], { generatedAt: 'later', archiveCommit: 'def' });
    writeFileSync(join(dir, 'index.json'), JSON.stringify(backfilled.index));
    writeFileSync(join(dir, 'urgences', '2026-08.json'), JSON.stringify(backfilled.months[0]));
    hits.length = 0;
    const after = await fetchUrgencesHistoriqueReport({ api, cache: { dir: cacheDir, refresh: true } });
    assert.deepEqual(hits, ['/api/v1/index.json', '/api/v1/urgences/2026-08.json', '/api/v1/urgences/2026-09.json']);
    assert.equal(after.window.snapshots, 5);

    await assert.rejects(
      fetchUrgencesHistoriqueReport({ api: `${api}/missing`, cache: { dir: cacheDir } }),
      /HTTP 404 .*no history API there yet/,
    );
  } finally {
    server.close();
  }
});

const hasGit = spawnSync('git', ['--version']).status === 0;

test('buildApiSite reads every archived version from git history', { skip: !hasGit }, () => {
  const repo = mkdtempSync(join(tmpdir(), 'msss-api-repo-'));
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.test',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.test',
  };
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd: repo, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  git('init', '-q', '-b', 'main');
  mkdirSync(join(repo, 'archive/urgences'), { recursive: true });
  const target = join(repo, URGENCES_ARCHIVE_PATH);
  for (const v of VERSIONS.filter((v) => v.ref !== 'broken')) {
    writeFileSync(target, Buffer.from(v.csv, 'latin1'));
    git('add', '-A');
    git('commit', '-q', '-m', v.ref);
  }
  writeFileSync(join(repo, 'code.ts'), '');
  git('add', 'code.ts');
  git('commit', '-q', '-m', 'unrelated code commit');

  const out = join(repo, 'site');
  const index = buildApiSite(repo, out, { generatedAt: 'fixed' });
  assert.equal(index.datasets.urgences.snapshots, 4);
  assert.equal(index.datasets.urgences.skippedVersions, 0);
  const sept = JSON.parse(readFileSync(join(out, 'api/v1/urgences/2026-09.json'), 'utf8'));
  assert.deepEqual(sept, BUILT.months[1]);
  assert.ok(existsSync(join(out, 'index.html')));
  // Accented names survive: the archive's Latin-1 bytes are decoded as Latin-1.
  assert.ok(sept.facilities.some((f: { region: string }) => f.region === 'Montréal'));
});

test('buildApiSite reads versions that reached main through a merge', { skip: !hasGit }, () => {
  const repo = mkdtempSync(join(tmpdir(), 'msss-api-merge-'));
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.test',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.test',
  };
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd: repo, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  const target = join(repo, URGENCES_ARCHIVE_PATH);
  const commit = (v: ArchivedVersion) => {
    writeFileSync(target, Buffer.from(v.csv, 'latin1'));
    git('add', '-A');
    git('commit', '-q', '-m', v.ref);
  };
  git('init', '-q', '-b', 'main');
  mkdirSync(join(repo, 'archive/urgences'), { recursive: true });
  const base = version('2026-09-07T15:45', 16);
  commit(base);
  // An import branch: older versions, then the file put back as it was, so the
  // merge is clean and its result matches main (what hides the branch from a
  // plain `git log -- path`).
  git('checkout', '-q', '-b', 'import');
  commit(version('2026-08-30T15:45', 4));
  commit(version('2026-08-31T15:45', 8));
  commit({ ...base, ref: 'restore' });
  git('checkout', '-q', 'main');
  commit(version('2026-09-08T15:45', 20));
  git('merge', '-q', '--no-ff', 'import', '-m', 'merge import');

  const index = buildApiSite(repo, join(repo, 'site'), { generatedAt: 'fixed' });
  const u = index.datasets.urgences;
  assert.equal(u.snapshots, 4);
  assert.equal(u.skippedVersions, 0);
  assert.equal(u.first, '2026-08-30T15:45');
  assert.equal(u.last, '2026-09-08T15:45');
  assert.deepEqual(
    u.months.map((m) => [m.month, m.snapshots]),
    [
      ['2026-08', 2],
      ['2026-09', 2],
    ],
  );
});
