# quebec-sante-cli

Deterministic, cache-aware CLI that reads Québec health-services data directly
from canonical MSSS open-data CSVs (a plain HTTPS fetch + CSV parse — no
browser, no HTML scraping), plus agent skills on top that own the
human-facing recommendations. Ships four data tools plus `regions` (the shared
RSS region registry behind every `--region`; `src/core/regions.ts`): `urgences` (hourly ER occupancy,
Latin-1 CSV), `cliniques` (clinic appointments offered per past day, published weekly, UTF-8/BOM
CSV), `urgences-cumulatif` (fiscal-year-to-date ER indicators and
year-over-year trends, UTF-8/BOM CSV updated each fiscal period) and
`chirurgies` (surgical waitlist per fiscal period, UTF-8/BOM CSV), plus
`urgences-historique` (ER occupancy history by hour / weekday+hour / day, read
from the static history API that the archive job deploys to GitHub Pages). History: formerly served by `index-sante-cli` (which scraped the
republisher indexsante.ca).

## Run

```bash
npm install
npm run build          # compiles src/ -> dist/
npm link               # put `quebec-sante` on PATH (agents + you); undo: npm unlink -g quebec-sante-cli
quebec-sante urgences --region montreal --json
quebec-sante cliniques --region montreal --json
quebec-sante urgences-cumulatif --region montreal --json
quebec-sante chirurgies --region montreal --json
quebec-sante urgences --region 06 --baseline --json   # live ER joined with fiscal-year-to-date values
quebec-sante regions --json                           # region codes/aliases accepted by --region
quebec-sante urgences-historique --region 06 --by weekday-hour --json  # history from the archived snapshots
```

During development, skip the build and run TypeScript directly:
`npm run dev -- urgences --region montreal`,
`npm run dev -- cliniques --region montreal`,
`npm run dev -- urgences-cumulatif --region montreal`,
`npm run dev -- chirurgies --region montreal`, or
`npm run dev -- urgences-historique --region montreal`.

## Test

```bash
npm test               # deterministic suite against test/fixtures/*.csv
RUN_LIVE=1 npm test    # also runs the opt-in live network smoke tests (all four tools)
QUEBEC_SANTE_FIXTURE=test/fixtures/urgences_nbpers.csv quebec-sante urgences --json  # offline urgences
QUEBEC_SANTE_FIXTURE=test/fixtures/rdvoffert_DOuv.csv quebec-sante cliniques --json   # offline cliniques
QUEBEC_SANTE_FIXTURE=test/fixtures/Donnees_cumulatives_Urgence.csv quebec-sante urgences-cumulatif --json  # offline cumulatif
QUEBEC_SANTE_FIXTURE=test/fixtures/Chirurgie_ListeAttente.csv quebec-sante chirurgies --json  # offline chirurgies
QUEBEC_SANTE_FIXTURE=test/fixtures/urgences_nbpers.csv QUEBEC_SANTE_BASELINE_FIXTURE=test/fixtures/Donnees_cumulatives_Urgence.csv quebec-sante urgences --baseline --json  # offline --baseline
npx tsx scripts/build-api.ts site && QUEBEC_SANTE_API_FIXTURE=site/api/v1 quebec-sante urgences-historique --json  # offline history, from this clone's archive/
```

Skill or answer-standard changes: `npm test` includes `test/skills.test.ts`
(one skill, `.agents/skills/quebec-sante`, whose `SKILL.md` links every module
and CLI reference; one `answer-standard.md`; and the unsafe rules removed in
M0 must not come back) and `test/eval.test.ts`
(the recorded benchmark answers in `eval/`, graded against a pinned snapshot;
`npx tsx eval/grade.ts` prints the full report). See `eval/README.md`.

Node's built-in `fetch` ignores `HTTPS_PROXY`; behind a proxy run live fetches
with `NODE_USE_ENV_PROXY=1` (Node ≥ 22.21).

To force a live fetch past the cache, add `--refresh` to any command (e.g.
`quebec-sante urgences-cumulatif --refresh`).

## CI

`.github/workflows/ci.yml` runs on every pull request and every code push to
`main` (changes only under `archive/` are skipped):

- `test`: `npm ci`, `npm run build` (type-check) and `npm test` on Node 18, 20,
  22 and 24, since `package.json` declares `node >= 18`.
- `lint`: `shellcheck` on the shell scripts and `actionlint` on the
  workflows.

Run the same checks locally before pushing. The lint tools install with
`pip install shellcheck-py actionlint-py`. Keep CI offline: live tests stay
behind `RUN_LIVE=1`. Actions is free only while the repo is public.

## Env

See `.env.example`. Slots: `QUEBEC_SANTE_CACHE_DIR` (default
`~/.cache/quebec-sante`); `QUEBEC_SANTE_BASELINE_FIXTURE` (local cumulative
CSV for `urgences --baseline`, offline runs only); `QUEBEC_SANTE_API_URL`
(history API base for `urgences-historique`); `QUEBEC_SANTE_API_FIXTURE` (local
API directory, offline runs). No secrets.

## Scheduled job / databases

One scheduled job, no databases. `scripts/archive-sources.sh` runs from cron
every 15 minutes on a maintainer's computer, **not** on GitHub Actions (MSSS
answers GitHub's runners with HTTP 403; don't try to get around that). It
downloads the `urgences` and `urgences-cumulatif` CSVs, stores them byte for
byte in `archive/`, and commits and pushes to `main` (deploy key) only when
bytes change. It rebases before pushing and never force-pushes.

On GitHub, nothing fetches from MSSS:

- `.github/workflows/pages.yml` builds the static history API from `archive/`'s
  git history (`scripts/build-api.ts`) and deploys it to GitHub Pages on each
  push that changes `archive/urgences/` or the builder. The API is never
  committed.
- `.github/workflows/archive-freshness.yml` fails every 6 hours while no new
  version has arrived for 6 hours.

Setup and credentials: `docs/archive-job.md`. Consequences for agents:

- `main` moves up to every hour. Before pushing to `main`, `git pull --rebase`.
- Never edit, re-encode or reformat files under `archive/`. They must stay
  byte-identical to what MSSS served (`.gitattributes` keeps git from
  converting newlines). Don't add derived data there.
- Code changes never go in `archive/`; data commits never touch anything else.
- `git log -- . ':(exclude)archive/'` shows history without the data commits.
- Gaps are permanent: the archive misses hours or days whenever the job
  stops, and MSSS skips publications. Report them in the output contract
  (`urgences-historique` `window.coverage` / `archive.gaps`, `cliniques`
  `window.missingDates`, `chirurgies` `missingPeriods` / `notInSource`); never
  hardcode gap dates in the skill or docs.
- Test the job offline with `node --import tsx --test test/archive.test.ts`;
  the history API and command with `test/history.test.ts`. Build the API
  locally with `npx tsx scripts/build-api.ts site` (output is gitignored).
  Don't run the script in a working copy: it resets the clone it runs in, and
  refuses to unless `git config msss-archive.dedicated true`.

## Docs

- `README.md` is the front door, agents first: skill routing, how to call the
  CLI, a one-line-per-command overview, links. Don't put option tables, output
  contracts or internals there. Options belong in each command's `--help`
  (`src/cli.ts`), output contracts in the skill's
  `references/cli-<command>.md`, archive/API operations in
  `docs/archive-job.md`, and anything the code already says, nowhere.
- No changelog and no versioning policy: the git history is the record of
  changes.
