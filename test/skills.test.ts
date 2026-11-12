// The agent skill: one entry point, one answer standard, every module and CLI
// reference reachable, and none of the unsafe rules the M0 audit removed
// (docs/m0-benchmark.md). Offline, reads files only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

const ROOT = '.agents/skills';
const SKILL = join(ROOT, 'quebec-sante');
const REFS = join(SKILL, 'references');
const read = (...p: string[]): string => readFileSync(join(SKILL, ...p), 'utf8');

const MODULES = ['urgences', 'urgences-children', 'urgences-cumulatif', 'cliniques', 'chirurgies'];
const CLI_REFS = ['cli-urgences', 'cli-urgences-cumulatif', 'cli-cliniques', 'cli-chirurgies'];

/** Relative links to local Markdown files: `[text](path.md)`. */
const localLinks = (text: string): string[] =>
  [...text.matchAll(/\]\(([^)#\s]+\.md)(#[^)]*)?\)/g)].map((m) => m[1]).filter((p) => !/^[a-z]+:/.test(p));

test('there is one skill, quebec-sante, with valid frontmatter', () => {
  const skills = readdirSync(ROOT).filter((d) => existsSync(join(ROOT, d, 'SKILL.md')));
  assert.deepEqual(skills, ['quebec-sante']);
  const body = read('SKILL.md');
  const fm = body.match(/^---\nname: quebec-sante\ndescription: (.+)\n/);
  assert.ok(fm, 'frontmatter: name, then description');
  assert.ok(fm[1].length <= 1024, `description is ${fm[1].length} chars; the Agent Skills limit is 1024`);
});

test('the skill holds exactly the expected modules and CLI references', () => {
  const files = readdirSync(REFS).sort();
  assert.deepEqual(files, ['answer-standard', ...MODULES, ...CLI_REFS].map((f) => `${f}.md`).sort());
});

test('SKILL.md routes to the answer standard, every module and every CLI reference', () => {
  const body = read('SKILL.md');
  for (const f of ['answer-standard', ...MODULES, ...CLI_REFS]) {
    assert.ok(body.includes(`(references/${f}.md)`), `SKILL.md links references/${f}.md`);
  }
});

test('every module applies the answer standard, and every local link resolves', () => {
  for (const m of MODULES) {
    assert.ok(read('references', `${m}.md`).includes('(answer-standard.md)'), `${m}.md links the answer standard`);
  }
  for (const f of ['SKILL.md', ...readdirSync(REFS).map((r) => join('references', r))]) {
    for (const link of localLinks(read(f))) {
      const target = join(SKILL, dirname(f), link);
      assert.ok(existsSync(target), `${f}: link ${link} resolves`);
    }
  }
});

test('the answer standard exists once and keeps its rules', () => {
  const copies: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(dir, e.name));
      else if (e.name === 'answer-standard.md') copies.push(join(dir, e.name));
    }
  };
  walk(ROOT);
  assert.deepEqual(copies, [join(REFS, 'answer-standard.md')]);
  const standard = read('references', 'answer-standard.md');
  for (const code of ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7']) {
    assert.ok(standard.includes(`| ${code} |`), `answer standard lists ${code}`);
  }
  for (const must of ['911', 'Info-Santé 811', 'not a wait time', 'weekly', 'quebec.ca/SituationUrgences']) {
    assert.ok(standard.includes(must), `answer standard says "${must}"`);
  }
});

// Rules and phrasings the M0 audit removed. A skill file that brings one back
// should fail here before it reaches an answer. (The answer standard names
// some of them only to forbid them, so it isn't scanned.)
const BANNED: Array<[RegExp, string]> = [
  [/rank sainte-justine/i, 'hardcoded pediatric ranking'],
  [/hardcoded (pediatric )?ranking/i, 'hardcoded ranking'],
  [/quieter choice|calmest choice/i, 'recommendation template'],
  [/skip the ER/i, 'clinic openings as a reason to skip the ER'],
  [/the ER is the right choice/i, 'no clinic openings as a reason for the ER'],
  [/has capacity today|capacity today/i, 'past clinic offers as current capacity'],
  [/shortest (non-priority )?wait/i, 'occupancy as a wait time'],
  [/better odds of being seen/i, 'offer counts as personal odds'],
  [/lower `?occupancyPct`? = quieter = better/i, 'occupancy as "better"'],
  [/best time to go/i, 'history as advice on when to go'],
  [/clinic data is \*\*daily\*\*|updates daily/i, 'wrong clinic cadence (it is weekly)'],
];

test('no skill file contains a rule the M0 audit removed', () => {
  const files = ['SKILL.md', ...[...MODULES, ...CLI_REFS].map((f) => join('references', `${f}.md`))];
  for (const f of files) {
    const text = read(f);
    for (const [re, why] of BANNED) {
      assert.ok(!re.test(text), `${f}: ${why} (${re})`);
    }
  }
});

// Gaps come and go (the archive job stops, MSSS skips a publication), so the
// rules read coverage from the CLI output and carry no dates of their own.
// Example answers (`>` lines) may show one.
test('the entry point, the answer standard and the modules hardcode no dates', () => {
  const files = ['SKILL.md', 'references/answer-standard.md', ...MODULES.map((m) => join('references', `${m}.md`))];
  for (const f of files) {
    read(f)
      .split('\n')
      .forEach((line, i) => {
        if (line.trimStart().startsWith('>')) return;
        assert.ok(!/\b20\d\d-\d\d-\d\d\b/.test(line), `${f}:${i + 1} hardcodes a date: ${line.trim()}`);
      });
  }
});

test('the entry point and the ER modules put the emergency step and the triage caveat up front', () => {
  for (const f of ['SKILL.md', 'references/urgences.md', 'references/urgences-children.md']) {
    const body = read(f);
    assert.match(body, /911/, `${f}: 911`);
    assert.match(body, /triage/i, `${f}: triage`);
  }
  const entry = read('SKILL.md');
  assert.match(entry, /never predicts a personal wait time/i, 'SKILL.md description: no wait prediction');
  assert.match(entry, /never decides between a clinic and the ER/i, 'SKILL.md: no clinic/ER routing');
  const clinics = read('references', 'cliniques.md');
  assert.match(clinics, /weekly/i, 'cliniques: says the file is weekly');
  assert.match(clinics, /never decides between a clinic and the ER/i, 'cliniques: no ER routing');
});
