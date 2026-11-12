# MSSS archive job: setup and operations

The job snapshots MSSS open-data CSVs into [`archive/`](../archive/README.md)
and commits them straight to `main`. Anyone who clones the repo gets every
published version in git history.

- **Code:** [`scripts/archive-sources.sh`](../scripts/archive-sources.sh) (bash + git + curl; no Node).
- **Runs on a computer you control, from cron.** It doesn't run on GitHub
  Actions: MSSS answers GitHub's cloud runners with **HTTP 403** (seen on the
  first Actions run, 2026-11-04), while ordinary clients get the files. Don't
  try to get around that block. If a cloud runner is ever wanted, ask MSSS or
  Données Québec first.
- **On GitHub, nothing contacts MSSS:**
  - [`pages.yml`](../.github/workflows/pages.yml) rebuilds the static history
    API from the archive and deploys it to GitHub Pages whenever the computer
    pushes new data (see [History API](#history-api-github-pages)).
  - [`archive-freshness.yml`](../.github/workflows/archive-freshness.yml) fails,
    and so emails you, when the archive stops moving (see [Monitoring](#monitoring)).
  - [`ci.yml`](../.github/workflows/ci.yml) skips data-only pushes.
- **Sources:** `urgences` (hourly) and `urgences-cumulatif` (each fiscal period).
  `cliniques` and `chirurgies` aren't archived, because MSSS already publishes
  their full history in the file itself (and `cliniques` is ~136 MB, over
  GitHub's 100 MB file limit).

## What every run does

1. **Recovers the checkout.** It aborts a rebase left half-done, resets local
   changes, cleans `archive/` and returns to `main`. A killed or failed run
   never blocks the next one.
2. **Syncs.** It fetches `origin/main` and rebases any unpushed archive commits
   onto it (an earlier push may have failed). It drops them if they conflict,
   since this run fetches fresh data anyway.
3. **Downloads each source** with `curl` and checks it before keeping it:
   HTTP success, a minimum size, and the first bytes MSSS's file starts with.
   That rejects HTML error pages and truncated transfers. A source that fails
   is skipped, the others are still archived, and the run exits 1.
4. **Copies the bytes unchanged** into `archive/` and commits only files whose
   bytes changed. A run with no new data creates no commit. Commits never
   contain anything outside `archive/` (the script checks).
   [`.gitattributes`](../.gitattributes) marks `archive/**` as `-text`, so git
   never converts newlines. The files are CRLF, and urgences is Latin-1.
5. **Rebases onto the latest `origin/main`, then pushes** with a plain
   `git push`. It never force-pushes. If a human pushed in between, it
   re-fetches, rebases and retries (4 attempts with backoff). A push that still
   fails leaves the commit in the clone, the next run delivers it, and this run
   exits 1.

Exit codes: `0` ok (including "nothing changed") · `1` a source or the push
failed · `2` misconfigured (not a git checkout, clone not opted in, `git` or
`curl` missing).

The script hard-resets the checkout it runs in, so it refuses to run unless
that clone opted in with `git config msss-archive.dedicated true`. Don't run it
in your working copy.

## Setup

### On GitHub (once)

1. **Turn on GitHub Pages:** Settings → Pages → *Build and deployment* →
   Source: **GitHub Actions**.
2. **Create the job's credential, a deploy key with write access.** It's the
   minimum GitHub offers (write access to this one repository only), and unlike
   a personal access token it never expires, so the job keeps running with no
   human involved.
   1. On the computer that will run the job:
      `ssh-keygen -t ed25519 -N "" -C msss-archive -f ~/.ssh/msss_archive_key`
      (no passphrase: cron can't type one).
   2. Settings → Deploy keys → *Add deploy key*: paste
      `~/.ssh/msss_archive_key.pub` and tick **Allow write access**.

   The private key never leaves that computer (`chmod 600`). A fine-grained
   personal access token with *Contents: Read and write* on this repository
   only also works, but it expires and stops the job when it does.

### On the computer

Any always-on machine on a network MSSS accepts: a home connection works,
GitHub's cloud runners don't. A home server, a NAS or a Raspberry Pi is ideal;
a laptop that sleeps loses those hours.

**Install:** `bash`, `git` ≥ 2.28, `curl`, and `flock` (util-linux on Linux;
`brew install flock` on macOS; optional, but without it overlapping runs
aren't prevented). No Node needed.

**One-time setup** (a dedicated clone, which the job resets):

```bash
git clone git@github.com:Krystosterone/quebec-sante-cli.git ~/msss-archive
cd ~/msss-archive
git config core.sshCommand "ssh -i ~/.ssh/msss_archive_key -o IdentitiesOnly=yes"
git config msss-archive.dedicated true
bash scripts/archive-sources.sh     # first run: commits both CSVs, pushes
```

That first push triggers `pages.yml`, which publishes the history API at
`https://krystosterone.github.io/quebec-sante-cli/`.

**Schedule line** (`crontab -e`; the job logs in UTC, so cron's time zone
doesn't matter):

```cron
7,22,37,52 * * * * /usr/bin/env bash "$HOME/msss-archive/scripts/archive-sources.sh" >> "$HOME/msss-archive.log" 2>&1
```

That's every 15 minutes, off the top of the hour. MSSS publishes urgences once
an hour (around :45), and runs with no new data commit nothing, so the extra
tries only cost four small downloads an hour. A strictly hourly line
(`52 * * * *`) works too, but a run that fails then loses that hour.

The log grows by under 20 MB a year. Rotate it with `logrotate`, or truncate
it now and then.

Data commits are authored `msss-archive-bot <msss-archive-bot@noreply.invalid>`.
To change that, set `ARCHIVE_GIT_NAME` / `ARCHIVE_GIT_EMAIL` on the cron line.
Behind a proxy, `curl` and `git` honour `HTTPS_PROXY` themselves (the CLI's
`NODE_USE_ENV_PROXY=1` note doesn't apply; the job doesn't use Node).

### Branch protection

The job pushes directly to `main` with its deploy key. If you add a ruleset
that blocks direct pushes (e.g. "Require a pull request"), the push is
rejected. Each run then exits 1 and keeps its commit for later, nothing
breaks, and nothing reaches GitHub until it's fixed. Use a **ruleset**
(Settings → Rules → Rulesets) rather than a classic branch protection rule, and
add **Deploy keys** to its *Bypass list*. Classic branch protection has no way
to exempt a deploy key.

Pushes made with a deploy key trigger workflows. That's what makes `pages.yml`
deploy each new version. `ci.yml` ignores `archive/**`; give any new
push-triggered workflow the same `paths-ignore`, or it will run on every data
commit.

If the ruleset also **requires the `ci` checks**, the job's pushes aren't
affected (deploy keys bypass the ruleset). A PR that touches only `archive/`
would never get those checks, because CI skips it. None is expected: data only
arrives through the job's direct pushes.

### Living with an hourly bot on `main`

- **Direct pushes:** `main` moves up to every hour, so a direct push from your
  machine is often rejected as non-fast-forward. Run `git pull --rebase` and
  push again. Merging PRs isn't affected.
- **Log noise:** `git log -- . ':(exclude)archive/'` shows only code changes.
- **Clone size:** urgences adds about 27 MB of history a year (75 MB for the
  2023–2026 history, imported included);
  cumulatif about 1 MB. To clone the code without old data versions:
  `git clone --filter=blob:none …`.

## Monitoring

- **`archive-freshness.yml`** runs every 6 hours. It fails when no new urgences
  version has been archived for 6 hours, which means the computer is off or
  offline, its pushes are failing, or MSSS stopped publishing. GitHub emails a
  failed scheduled run to whoever last changed that workflow's schedule. Before
  the first archive commit it passes with a notice. You can run it by hand from
  the Actions tab.
- **The computer's log** (`~/msss-archive.log`) says why. `download failed` or
  `unexpected first bytes` mean MSSS was down or served an error page; the next
  run retries. `push attempt … failed` means a credential or branch-protection
  problem (see [Branch protection](#branch-protection)).
- **`pages.yml` runs** show up in the Actions tab after each data push.
- GitHub disables scheduled workflows in a public repo after 60 days without
  repository activity. The job's hourly commits keep it active; if the
  archive stopped for two months, re-enable `archive-freshness` from the
  Actions tab.

## History API (GitHub Pages)

`scripts/build-api.ts` reads every version of the urgences CSV from
`archive/`'s git history and writes a static site. It's never committed:
`pages.yml` uploads it as the Pages artifact.

```
index.html                       landing page
api/v1/index.json                months available, snapshot range, build commit
api/v1/urgences/<YYYY-MM>.json   every snapshot of the month, per facility
```

`quebec-sante urgences-historique` reads it (contract:
[`cli-urgences.md`](../.agents/skills/quebec-sante/references/cli-urgences.md#urgences-historique-history)).
A month is `complete` once a later month has data: the live archive no longer
adds to it. A backfill still can, so `urgences-historique` keeps a cached
complete month only while it matches the index entry (snapshot count, first,
last). `index.json` also lists every gap over 6 h (`datasets.urgences.gaps`);
see [Gaps](#gaps). `pages.yml` runs on pushes to `main` that change
`archive/urgences/` or the builder, and on manual runs. A failed deploy is
retried by the next data push, within the hour.

To build and query it locally:

```bash
npx tsx scripts/build-api.ts site
QUEBEC_SANTE_API_FIXTURE=site/api/v1 quebec-sante urgences-historique --table
```

Free-tier limits: a month of hourly snapshots is about 4 MB of JSON (served
gzipped). GitHub Pages' soft limits (1 GB site, 100 GB/month bandwidth) leave
years of headroom. With a custom Actions workflow, Pages' 10-builds-per-hour
limit doesn't apply.

## Gaps

The archive will always have gaps. The job runs on one computer, which gets
turned off, moved or forgotten (an infrastructure migration left one of
about 50 hours), and MSSS skips or delays publications. Nothing schedules
them, so nothing should hardcode them:

- The builder lists every gap over 6 h between two snapshots in `index.json`,
  and `urgences-historique` reports them (`archive.gaps`) along with the
  ranges and gaps of each window (`window.coverage`). The skill reads them
  from the output; it carries no gap dates.
- A gap means nothing was archived. The archive can't tell a missed fetch
  from an hour MSSS didn't publish: the job commits only when bytes change,
  and keeps no record of its runs in `archive/`. The computer's log says
  which, for its own runs.
- An ER that MSSS lists with blank figures, or leaves out of a snapshot, isn't
  a gap: the snapshot is archived and the facility's `snapshots` counts say
  so.
- `archive-freshness` fails while a gap is happening; that's the cue to
  restart the job. A gap that's over can only be filled by a backfill of
  MSSS's own bytes (see below), never by deriving or re-exporting data.

## Imported history

The live archive starts on 2026-11-03 (Québec time). The urgences versions from **2023-02-01 to
2025-11-01** (22,857 of them) come from
[jlomako/quebec-emergency-rooms](https://github.com/jlomako/quebec-emergency-rooms)
(MIT, © 2022 jlomako). Its GitHub Actions workflow ran `wget -N` on the same
MSSS URL every hour into `data/urgence_time.csv`, until MSSS started refusing
GitHub's runners.

- **Byte for byte.** Each version became one commit of
  `archive/urgences/Releve_horaire_urgences_7jours_nbpers.csv` with the
  captured blob unchanged (same git blob id as upstream). Two empty versions,
  failed downloads, were left out by the job's own checks (≥ 1000 bytes,
  starting `RSS,`).
- **Commits:** `archive: import urgences (<capture time, UTC>)`, author
  `actions-user` (the capturing workflow), committer `msss-archive-bot`, both
  dated at the capture time. The body names the upstream commit. A last
  commit, `archive: end of the imported urgences history`, puts the file back
  as the job had it, so the branch merges into `main` without a conflict.
- **Merge it with a merge commit** (not squash, not rebase). A squash would
  drop every imported version. The builder reads history with
  `git log --full-history`, so versions that reach `main` through a merge are
  included (`test/history.test.ts`).
- **Not imported:** the gap from 2025-11-01 to 2026-11-03. The only copies
  of MSSS's own bytes found for it are two Wayback Machine captures
  (2026-01-14 and 2026-02-09), not yet imported. The other copies are
  re-exports (Données Québec datastore dumps, derived tables), which
  `archive/` doesn't take.

## Adding a source

Add one line to `SOURCES` in `scripts/archive-sources.sh`: name, URL, path
under `archive/`, minimum size, and the hex of the file's first bytes. Then
add the file to the table in [`archive/README.md`](../archive/README.md).
