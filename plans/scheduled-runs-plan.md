# Scheduled Runs Plan

Status: **implemented, not yet deployed.** Target is a Render cron job, not GitHub Actions.

## Problem Statement

The pipeline runs on demand from a developer machine. The goal is an unattended run
once each weekday morning, producing the usual PDFs and summaries in Google Drive
without anyone starting it.

Three things stand between the current design and that goal:

1. **No cross-run state.** `processed-urls.json` lives in the management data directory
   on the machine that ran the pipeline. Any ephemeral runner starts with an empty
   registry, so `already_sent` never matches and every previously seen job is fetched,
   scored and re-uploaded on every run.
2. **Operator-managed inputs are gitignored.** `cv-keywords.md` and
   `applied-companies.txt` exist only locally. Scoring cannot run without the former.
3. **OneDrive cannot be automated.** `ONEDRIVE_ACCESS_TOKEN` is a ~1 hour access token
   with no refresh flow in the codebase, so it is always expired by the time a daily
   schedule fires.

## Findings

Recorded because each one changed the design, and each is easy to re-derive wrongly.

### The pipeline does not send email

Gmail is a discovery *source* (`discover.ts:541`, scope `gmail.modify`), reading job
alert emails. There is no mail-sending code anywhere in `src/`. Output reaches the
operator as PDFs and summary files in cloud storage, nothing else. Any "notify me"
requirement is unbuilt work, not configuration.

### Anthropic-hosted cloud sessions cannot run this pipeline

A Claude cloud container routes egress through a policy proxy that returns 403 on
CONNECT for every external service this pipeline needs: `openrouter.ai`,
`api.search.brave.com`, `api.brightdata.com`, `googleapis.com`,
`graph.microsoft.com`, `linkedin.com`. Only `github.com` and package registries are
reachable. The pipeline builds and unit-tests there but cannot execute a real run.
This rules out "have Claude run it on a schedule" and is why the work targets Render
instead.

### This needs its own Render service

A Render service maps one-to-one onto a repository, a runtime and a start command, so an
existing service built from a different repository cannot also run this pipeline. The
Render-native way to schedule it is a dedicated **cron job** service, which is what
`render.yaml.example` describes. Multiple services can share one workspace without
interfering, provided no two of them are managed by the same Blueprint.

### Render cron jobs cannot mount a persistent disk

"Cron jobs can't provision or access a persistent disk." Which is why the Drive-backed
registry is required on Render just as much as on a GitHub runner. `drive-sync.ts` is
platform-independent and needs no change.

Cron jobs are billed on active running time, prorated by the second, with a $1/month
minimum per cron service. At roughly 20 min × 22 weekdays the floor is what you pay.

### LinkedIn is two mechanisms, not one

- **Discovery** (`discover.ts:396`) does a real Playwright login against
  `linkedin.com` using `launchPersistentContext(LINKEDIN_PROFILE_DIR)`. On an
  ephemeral runner the profile directory is empty every time, so every run is a fresh
  headless login from a new datacenter IP — the reliable way to trigger a checkpoint
  challenge. It degrades gracefully: login failure logs and returns `[]`.
- **Spec fetching** (`fetch-specs.ts:69`, `routeByUrl`) sends any `linkedin.com` URL to
  the Brightdata LinkedIn dataset. No browser, no login, no IP sensitivity.

Consequence: disabling LinkedIn *discovery* does not lose LinkedIn *jobs*. Brave
results and Gmail-extracted URLs on `linkedin.com` are tagged `source: 'linkedin'`
(`discover.ts:329`) and still route to Brightdata. The dedicated search-term sweep is
what is lost.

### The `drive.file` scope constrains where state can live

`upload.ts` authenticates with `https://www.googleapis.com/auth/drive.file`, which
grants access only to files **the application itself created**. This is why the two
categories of file are handled differently:

- `processed-urls.json` is created and maintained by the pipeline → `drive.file` is
  sufficient, and Drive is a good home for it.
- `cv-keywords.md` and `applied-companies.txt` are authored by the operator → a
  service account with `drive.file` cannot see them, even in the same folder. Putting
  them in Drive would require widening the delegated scope in the Workspace admin
  console. They go in CI secrets instead, which needs no scope change.

## Implemented

### `src/utils/drive-sync.ts` (new)

Persists the dedup registry in the Drive folder already used for run output.

| Export | Behaviour |
|---|---|
| `resolveDriveSyncConfig()` | Returns config, or `null` if any of the three Drive env vars is unset/empty. `null` means "skip syncing", which is the normal local case. |
| `createDriveClient(config)` | JWT auth reusing the `upload.ts` pattern, including `\\n` private-key normalisation. |
| `findRegistryFileId(drive, folderId)` | Looks up `processed-urls.json` in the folder; `undefined` on first run. |
| `pullProcessedUrls(dir, config)` | Downloads into the management data directory. |
| `pushProcessedUrls(dir, config)` | Updates in place when present, creates otherwise. |

Every operation is best-effort — errors are logged and returned as `false`, never
thrown. A Drive outage costs deduplication for one run; it does not fail the run.

### `src/run-job-search.ts` (modified)

`syncStateFromDrive()` at the start of the discovery phase, `syncStateToDrive()` at the
end of the output phase. Both no-op when Drive is unconfigured or `--dry-run` is set.
Placing them in the phase functions rather than `runAllPhases()` means partial reruns
(`--phase discovery`, `--phase output`) sync correctly too.

Note `resolveManagementDataDirFromEnv()` reads `process.env` at call time rather than
using `MANAGEMENT_DATA_DIR` from `config.ts` directly, because that constant is
evaluated at import time — before `--env-file` values are loaded. It falls back to that
constant, matching the six other copies of this helper in `src/`; falling back to
`process.cwd()` instead would sync a different file than `prefilter.ts` reads.

### `Dockerfile` and `.dockerignore` (new)

Based on `mcr.microsoft.com/playwright:v1.58.2-noble`, which ships Chromium and its
system libraries. Render's native Node runtime cannot run `playwright install
--with-deps` — that wants apt and root, which the native build step does not provide.
The tag must track the `playwright` version in `package-lock.json`; a mismatch means the
bundled browser does not match the client and launches fail.

Chromium is not optional: `generate-pdfs.ts` renders every PDF through it.

### `render.yaml.example` (new)

A reference template for one cron job service: `0 5 * * 1-5`. The schedule is in UTC, so
adjust the hour for your own timezone, and note that a local clock change shifts it by an
hour unless you edit the expression. `LINKEDIN_*` and `ONEDRIVE_ACCESS_TOKEN` deliberately
unset; both stages self-skip.

**The service is created by hand in the dashboard, not by a Blueprint sync.** The file
is named `render.yaml.example` rather than `render.yaml` precisely so Render does not
auto-detect it; nothing in this repository can alter the Render account on its own.

That is a deliberate choice about blast radius. In a live Blueprint the `name` field is
a targeting key, not a label — "If you add the name of an existing service to your
Blueprint file, Render attempts to apply the Blueprint's configuration to that existing
service." A repo that can silently adopt and reconfigure an existing service is a bigger
lever than this one cron job justifies, especially in a workspace shared with unrelated
services. The template keeps the configuration reviewable in version control without
granting it that reach.

`cv-keywords.md` and `applied-companies.txt` are attached as Render **Secret Files**.
They mount read-only at `/etc/secrets`, so the start command copies them into the
writable management data directory before starting the pipeline. `cp` failing on a
missing file fails the run, which is the wanted behaviour — scoring cannot work without
the keywords.

### Verification

`npm run validate` passes — 16 suites, 192 tests, 15 of them new in
`src/__tests__/drive-sync.test.ts` covering config resolution, folder-scoped lookup,
create-vs-update, and error swallowing on both paths.

**Not verified against live Google Drive, and the Docker image has not been built.** The
egress block above made both impossible in the environment where this was written. The
first deploy is the first true test.

## Why Render and not GitHub Actions

This repository is public, and **Actions run logs and artifacts on a public repo are
world-readable**. The pipeline logs company names and job titles
(`score-survivors.ts:272`, `fetch-specs.ts:620`, `compile-results.ts:156`,
`generate-pdfs.ts:223`) and job URLs on fetch errors (`fetch-specs.ts:377`). Running it
on Actions would publish the job search itself, and dropping the artifact upload would
not fix the logs.

Render logs are private to the account, so the repository can stay public with no log
scrubbing and no visibility change. Cost is per-second of run time on a starter
instance; roughly 20 min × 22 weekdays is a few hours a month.

Still worth deciding separately: that logging verbosity is fairly free with URLs and
company names. Private logs make it tolerable rather than correct.

## Configuration required before first run

Set by hand on the Render cron job. These are the entries marked `sync: false` in
`render.yaml.example`.

| Environment variable | Notes |
|---|---|
| `OPENROUTER_API_KEY` | |
| `OPENROUTER_MODEL` | Required — `openrouter-client.ts:47` throws when unset |
| `BRAVE_API_KEY` | |
| `BRAVE_QUERIES` | |
| `BRIGHTDATA_API_KEY` | |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | Full JSON key object, single line |
| `GOOGLE_GMAIL_IMPERSONATED_USER` | |
| `GMAIL_LABEL` | |
| `GOOGLE_DRIVE_IMPERSONATED_USER` | |
| `GOOGLE_DRIVE_FOLDER_ID` | Also where `processed-urls.json` will live |

Render **Secret Files**, attached in the dashboard:

| Secret file | Source |
|---|---|
| `cv-keywords.md` | Contents of the local file |
| `applied-companies.txt` | Contents of the local file |

## Next steps

1. Merge this change set to `main`.
2. In the Render dashboard: **New → Cron Job**, pointed at `nmaitland/job-harvester`,
   branch `main`. Choose the Docker runtime with `./Dockerfile`, region Oregon, the
   `starter` compute plan, and schedule `0 5 * * 1-5`. Copy the start command and the
   environment variables from `render.yaml.example`.
3. Attach `cv-keywords.md` and `applied-companies.txt` as Secret Files on that service.
4. Trigger a manual run. Expect first-run friction: Drive folder permissions for the
   impersonated user, and the Gmail label query matching nothing if `GMAIL_LABEL` is
   wrong. The Docker build is also unproven, and Hobby builds on smaller machines —
   watch it.
5. Confirm `processed-urls.json` appears in the Drive folder, then check the second run
   picks it up — the log line reads `Pulled processed-urls.json from Drive (N bytes)`.
6. Only then rely on the schedule.

## Deferred

- **LinkedIn discovery on a schedule.** Would need the `linkedin-profile` directory
  cached between runs so the session cookie survives. Worth doing only if
  LinkedIn-sourced volume proves thin without it.
- **OneDrive.** Needs a refresh-token flow before it can work unattended. Google Drive
  covers the requirement in the meantime.
- **Run notifications.** Nothing tells the operator a run finished. Render can email on
  failure; success currently requires looking in Drive.
- **Secret provider consistency.** `resolveDriveSyncConfig()` reads `process.env`
  directly, while `upload.ts` reads the same three names through `getSecrets()`
  (`utils/secrets.ts`). Identical today, since the default provider is env-backed; it
  would diverge silently if a 1Password provider were ever selected.
- **Concurrency.** The Actions design used a concurrency group to stop two runs racing
  on the Drive registry. Render gives this for free: when a scheduled run comes due while
  the previous one is still active, it *delays* the new run until the active one
  finishes rather than running both. A manual run started alongside a scheduled one is
  still not guarded.
