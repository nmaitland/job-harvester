# Pipeline Reorder & Full Automation Plan

## Problem Statement

The current pipeline has two critical issues:

1. **Wrong execution order**: `03-prefilter` runs *before* `ai/step2-extract-from-gmail`, meaning jobs extracted from emails are never fetched or filtered.
2. **Manual intervention required**: The AI steps (`step2-extract-from-gmail` and `step4-score-survivors`) are not wired into the orchestrator — the user must run them manually between the `pre` and `post` phases.

### Current (broken) flow

```
npm run run
  └─ Pre phase:
       01-discover (Brave + LinkedIn + Gmail download)
       02-fetch-specs
       03-prefilter   ← WRONG: runs before email extraction
  [MANUAL GAP]
       ai/step2-extract-from-gmail  ← user must run this
       ai/step4-score-survivors     ← user must run this
  [MANUAL GAP]
  └─ Post phase (separate command):
       04-compile-results
       05-generate-pdfs
       06-summarize-run
       07-upload
```

---

## Target Architecture

Five sequential phases, all run automatically by `npm run run`:

```
npm run run
  └─ Phase 1 - discovery:
       01-discover (Brave + LinkedIn + Gmail download only)
  └─ Phase 2 - email-processing:
       ai/step2-extract-from-gmail (extract job URLs from downloaded emails → append to discovered-jobs.json)
  └─ Phase 3 - fetch-and-filter:
       02-fetch-specs (fetch specs for ALL discovered jobs, including email-extracted ones)
       03-prefilter   (deterministic filters: fetch_failed, already_applied, already_sent, junior_role)
  └─ Phase 4 - scoring:
       ai/step4-score-survivors (AI scores each pre-filter survivor → job-scores/*.json)
  └─ Phase 5 - output:
       04-compile-results
       05-generate-pdfs
       06-summarize-run
       07-upload
```

### Pipeline data flow

```
discovered-jobs.json
  ← written by: 01-discover
  ← appended by: ai/step2-extract-from-gmail
  → read by: 02-fetch-specs

fetched-specs.json
  ← written by: 02-fetch-specs
  → read by: 03-prefilter

pre-filter-survivors.json
  ← written by: 03-prefilter
  → read by: ai/step4-score-survivors, 04-compile-results

pre-filter-rejections.json
  ← written by: 03-prefilter
  → read by: 04-compile-results

job-scores/*.json
  ← written by: ai/step4-score-survivors
  → read by: 04-compile-results

compile-results.json + all-rejections.json
  ← written by: 04-compile-results
  → read by: 05-generate-pdfs, 06-summarize-run

pdfs/*.pdf
  ← written by: 05-generate-pdfs
  → read by: 07-upload

run-summary/*.txt
  ← written by: 06-summarize-run
  → read by: 07-upload
```

---

## File Renaming

The AI helper scripts move from `src/ai/` into the main numbered pipeline to reflect their new first-class status. Each file number matches its execution order:

| Old path | New path | Role |
|---|---|---|
| `src/01-discover.ts` | `src/01-discover.ts` | Phase 1 — discovery (unchanged) |
| `src/ai/step2-extract-from-gmail.ts` | `src/02-extract-from-emails.ts` | Phase 2 — email processing |
| `src/02-fetch-specs.ts` | `src/03-fetch-specs.ts` | Phase 3 — fetch specs |
| `src/03-prefilter.ts` | `src/04-prefilter.ts` | Phase 4 — pre-filter |
| `src/ai/step4-score-survivors.ts` | `src/05-score-survivors.ts` | Phase 5 — AI scoring |
| `src/04-compile-results.ts` | `src/06-compile-results.ts` | Phase 6 — compile |
| `src/05-generate-pdfs.ts` | `src/07-generate-pdfs.ts` | Phase 7 — PDFs |
| `src/06-summarize-run.ts` | `src/08-summarize-run.ts` | Phase 8 — summarise |
| `src/07-upload.ts` | `src/09-upload.ts` | Phase 9 — upload |

### Test file renames (mirror source)

| Old test | New test |
|---|---|
| `src/__tests__/ai-step2-extract-from-gmail.test.ts` | `src/__tests__/02-extract-from-emails.test.ts` |
| `src/__tests__/02-fetch-specs.test.ts` | `src/__tests__/03-fetch-specs.test.ts` |
| `src/__tests__/03-prefilter.test.ts` | `src/__tests__/04-prefilter.test.ts` |
| `src/__tests__/ai-step4-score-survivors.test.ts` | `src/__tests__/05-score-survivors.test.ts` |
| `src/__tests__/04-compile-results.test.ts` | `src/__tests__/06-compile-results.test.ts` |
| `src/__tests__/05-generate-pdfs.test.ts` | `src/__tests__/07-generate-pdfs.test.ts` |
| `src/__tests__/06-summarize-run.test.ts` | `src/__tests__/08-summarize-run.test.ts` |
| `src/__tests__/07-upload.test.ts` | `src/__tests__/09-upload.test.ts` |

---

## Orchestrator Changes (`src/run-job-search.ts`)

### Phase type

```typescript
// Old
type Phase = 'pre' | 'post' | 'all';

// New — no phases needed; single fully-automated run
// Keep --phase for optional partial re-runs (advanced use)
type Phase = 'all' | 'discovery' | 'email-processing' | 'fetch-and-filter' | 'scoring' | 'output';
```

Default behaviour when `npm run run` is called with no `--phase` flag: runs **all** phases in sequence.

### `parseArgs` changes

- Default phase: `'all'` (was `'pre'`)
- `--run-dir` is **optional** for `all` (creates a new run dir automatically)
- `--run-dir` is **required** for partial phases (`discovery`, `email-processing`, `fetch-and-filter`, `scoring`, `output`) to resume a specific run
- Remove the old `pre`/`post` phase names (or keep as deprecated aliases that map to the new names)

### New `runScript` switch cases

```typescript
case '01-discover':           await discoverMain(runDir); break;
case '02-extract-from-emails': await extractFromEmailsMain(runDir); break;
case '03-fetch-specs':        await fetchSpecsMain(runDir); break;
case '04-prefilter':          await prefilterMain(runDir); break;
case '05-score-survivors':    await scoreSurvivorsMain(runDir); break;
case '06-compile-results':    await compileResultsMain(runDir); break;
case '07-generate-pdfs':      await generatePdfsMain(runDir); break;
case '08-summarize-run':      await summarizeRunMain(runDir); break;
case '09-upload':             await uploadMain(runDir); break;
```

### New phase runner functions

```typescript
async function runDiscoveryPhase(runDir, dryRun)       // 01-discover
async function runEmailProcessingPhase(runDir, dryRun) // 02-extract-from-emails
async function runFetchAndFilterPhase(runDir, dryRun)  // 03-fetch-specs + 04-prefilter
async function runScoringPhase(runDir, dryRun)         // 05-score-survivors
async function runOutputPhase(runDir, dryRun)          // 06-compile + 07-pdfs + 08-summarize + 09-upload

async function runAllPhases(runDir, dryRun) {
  await runDiscoveryPhase(runDir, dryRun);
  await runEmailProcessingPhase(runDir, dryRun);
  await runFetchAndFilterPhase(runDir, dryRun);
  await runScoringPhase(runDir, dryRun);
  await runOutputPhase(runDir, dryRun);
}
```

### Remove `validatePostPhase`

The old `validatePostPhase` checked for `pre-filter-survivors.json` and `job-scores/` before running the post phase. This is no longer needed because the orchestrator runs all phases in sequence and each phase naturally produces the inputs for the next. Replace with lightweight prerequisite checks inside each phase runner (e.g. `runScoringPhase` checks `pre-filter-survivors.json` exists before calling the scorer).

### Updated run manifest `files` table

Update `owner` fields to use new file names:

```
discovered-jobs.json       → owner: '01-discover.ts' (appended by 02-extract-from-emails.ts)
fetched-specs.json         → owner: '03-fetch-specs.ts'
pre-filter-survivors.json  → owner: '04-prefilter.ts'
pre-filter-rejections.json → owner: '04-prefilter.ts'
job-scores/*.json          → owner: '05-score-survivors.ts'
compile-results.json       → owner: '06-compile-results.ts'
all-rejections.json        → owner: '06-compile-results.ts'
pdfs/*.pdf                 → owner: '07-generate-pdfs.ts'
run-summary/*.txt          → owner: '08-summarize-run.ts'
upload-results.json        → owner: '09-upload.ts'
```

---

## `package.json` Script Changes

### Remove

```json
"ai:step2": "node dist/ai/step2-extract-from-gmail.js",
"ai:step4": "node dist/ai/step4-score-survivors.js",
"dev:ai-step2": "ts-node src/ai/step2-extract-from-gmail.ts",
"dev:ai-step4": "ts-node src/ai/step4-score-survivors.ts",
"fetch-specs": "node dist/02-fetch-specs.js",
"prefilter": "node dist/03-prefilter.js",
"compile": "node dist/04-compile-results.js",
"generate-pdfs": "node dist/05-generate-pdfs.js",
"summarize": "node dist/06-summarize-run.js",
"upload": "node dist/07-upload.js",
"dev:fetch-specs": "ts-node src/02-fetch-specs.ts",
"dev:prefilter": "ts-node src/03-prefilter.ts",
"dev:compile": "ts-node src/04-compile-results.ts",
"dev:compile-results": "ts-node src/04-compile-results.ts",
"dev:generate-pdfs": "ts-node src/05-generate-pdfs.ts",
"dev:upload": "ts-node src/07-upload.ts",
"dev:summarize": "ts-node src/06-summarize-run.ts"
```

### Add

```json
"extract-from-emails": "node dist/02-extract-from-emails.js",
"fetch-specs": "node dist/03-fetch-specs.js",
"prefilter": "node dist/04-prefilter.js",
"score-survivors": "node dist/05-score-survivors.js",
"compile": "node dist/06-compile-results.js",
"generate-pdfs": "node dist/07-generate-pdfs.js",
"summarize": "node dist/08-summarize-run.js",
"upload": "node dist/09-upload.js",
"dev:extract-from-emails": "ts-node src/02-extract-from-emails.ts",
"dev:fetch-specs": "ts-node src/03-fetch-specs.ts",
"dev:prefilter": "ts-node src/04-prefilter.ts",
"dev:score-survivors": "ts-node src/05-score-survivors.ts",
"dev:compile": "ts-node src/06-compile-results.ts",
"dev:generate-pdfs": "ts-node src/07-generate-pdfs.ts",
"dev:summarize": "ts-node src/08-summarize-run.ts",
"dev:upload": "ts-node src/09-upload.ts"
```

---

## Internal Reference Updates

Each renamed source file contains internal references (log messages, comments, function names) that reference the old step numbers. These must be updated:

- `step2-extract-from-gmail.ts` → update log messages from "AI Step 1" to "Phase 2: extract from emails"
- `step4-score-survivors.ts` → update log messages from "AI Step 2" to "Phase 5: score survivors"
- Log file names inside the scripts:
  - `ai-step2-log.json` → `02-extract-from-emails-log.json`
  - `ai-step4-log.json` → `05-score-survivors-log.json`
- `getSurvivorsFile` in `step4-score-survivors.ts` reads `pre-filter-survivors.json` — keep filename unchanged (it's a data file, not a source file)

---

## Test Changes

### `run-job-search.test.ts`

- Update `parseArgs` tests: default phase is now `'all'` (not `'pre'`)
- Remove tests for `--phase pre` requiring no `--run-dir` (pre no longer exists)
- Add tests for new phase names: `discovery`, `email-processing`, `fetch-and-filter`, `scoring`, `output`
- Update `validatePostPhase` tests → rename/replace with tests for the new per-phase prerequisite checks
- Update `writeRunManifest` tests: owner fields now reference new file names (e.g. `'03-fetch-specs.ts'` not `'02-fetch-specs.ts'`)

### `pipeline-e2e.test.ts`

- Update any references to old script names in the pipeline sequence
- Ensure the e2e test exercises the new stage order

### `02-extract-from-emails.test.ts` (renamed from `ai-step2-extract-from-gmail.test.ts`)

- Update import paths from `../ai/step2-extract-from-gmail` to `../extract-from-emails`
- Update log file name assertions: `ai-step2-log.json` → `02-extract-from-emails-log.json`

### `04-score-survivors.test.ts` (renamed from `ai-step4-score-survivors.test.ts`)

- Update import paths from `../ai/step4-score-survivors` to `../04-score-survivors`
- Update log file name assertions: `ai-step4-log.json` → `04-score-survivors-log.json`

### `ai-validators.test.ts`

- Keep as-is (validators live in `src/ai/validators.ts` which is a shared utility, not a pipeline stage — no rename needed)

---

## README Changes

### Architecture section

Replace the current 7-script list + "AI helper scripts" note with the new 8-script numbered pipeline:

```
1. 01-discover.ts          — Phase 1: discover jobs (Brave, LinkedIn, Gmail download)
2. 02-extract-from-emails.ts — Phase 2: extract job URLs from downloaded emails via AI
3. 03-fetch-specs.ts       — Phase 3a: fetch full job specifications
4. 04-prefilter.ts         — Phase 3b: deterministic pre-filter
5. 04-score-survivors.ts   — Phase 4: AI scoring of pre-filter survivors
6. 05-compile-results.ts   — Phase 5a: merge scores, apply thresholds
7. 06-generate-pdfs.ts     — Phase 5b: generate PDFs for PASS/REVIEW jobs
8. 07-summarize-run.ts     — Phase 5c: build human-readable run summary
9. 08-upload.ts            — Phase 5d: upload to OneDrive and Google Drive
```

### Usage section

Replace the "AI handoff sequence for pre/post orchestrator phases" section with:

```bash
# Run the full automated pipeline (no manual steps required)
npm run run -- --env-file .env

# Run individual phases for debugging/re-runs
npm run dev:discover -- --run-dir ./data/run-YYYY-MM-DD-HH-mm-ss --env-file .env.dev
npm run dev:extract-from-emails -- --run-dir ./data/run-YYYY-MM-DD-HH-mm-ss --env-file .env.dev
npm run dev:fetch-specs -- --run-dir ./data/run-YYYY-MM-DD-HH-mm-ss --env-file .env.dev
npm run dev:prefilter -- --run-dir ./data/run-YYYY-MM-DD-HH-mm-ss --env-file .env.dev
npm run dev:score-survivors -- --run-dir ./data/run-YYYY-MM-DD-HH-mm-ss --env-file .env.dev
npm run dev:compile -- --run-dir ./data/run-YYYY-MM-DD-HH-mm-ss --env-file .env.dev
npm run dev:generate-pdfs -- --run-dir ./data/run-YYYY-MM-DD-HH-mm-ss --env-file .env.dev
npm run dev:summarize -- --run-dir ./data/run-YYYY-MM-DD-HH-mm-ss --env-file .env.dev
npm run dev:upload -- --run-dir ./data/run-YYYY-MM-DD-HH-mm-ss --env-file .env.dev
```

### File ownership table

Update to reflect new file names.

### Project structure tree

Update to show new file names.

---

## TESTING.md Changes

Update the "Each script has a corresponding test file" list to use new names.

---

## Implementation Order

Execute in this order to avoid broken intermediate states:

1. Rename source files (git mv)
2. Rename test files (git mv)
3. Update imports inside renamed source files
4. Update imports inside renamed test files
5. Update internal log messages and log file name constants in renamed source files
6. Rewrite `run-job-search.ts` orchestrator (new phases, new imports, new switch cases)
7. Update `run-job-search.test.ts`
8. Update `pipeline-e2e.test.ts`
9. Update `package.json` scripts
10. Update `README.md`
11. Update `TESTING.md`
12. Run `npm test` to verify all tests pass
13. Run `npm run build` to verify TypeScript compiles cleanly
