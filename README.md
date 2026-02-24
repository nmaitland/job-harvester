# Job Harvester

A TypeScript pipeline for automated job search. Discovers jobs from multiple sources, fetches job specifications, filters, scores, generates PDFs, and uploads to cloud storage.

## Architecture

The pipeline consists of 7 standalone scripts that can be run independently or orchestrated together:

1. **01-discover.ts** - Discovers jobs from Gmail, LinkedIn, and Brave Search
2. **02-fetch-specs.ts** - Fetches full job specifications using Brightdata API and Playwright
3. **03-prefilter.ts** - Applies deterministic filters (fetch_failed, already_applied, already_sent, junior_role)
4. **04-compile-results.ts** - Merges AI scores with pre-filter results, applies thresholds
5. **05-generate-pdfs.ts** - Generates PDFs from job specifications using Playwright
6. **07-summarize-run.ts** - Builds human-readable run summary files (AI narrative with deterministic fallback)
7. **06-upload.ts** - Uploads PDFs and summary artifacts to OneDrive and Google Drive archive folders

AI helper scripts for manual AI handoff steps:

- `src/ai/step2-extract-from-gmail.ts` - Reads `RUN_DIR/emails/gmail/index.json` (or fallback `RUN_DIR/emails/index.json`), extracts job URLs via OpenRouter, appends deduplicated Gmail jobs into `RUN_DIR/discovered-jobs.json`
- `src/ai/step4-score-survivors.ts` - Scores `RUN_DIR/pre-filter-survivors.json` against `jobs/cv-keywords.md` via OpenRouter and writes one verdict JSON per survivor into `RUN_DIR/job-scores`

## File Ownership

| File | Written By | Read By |
|------|-----------|---------|
| `discovered-jobs.json` | 01-discover.ts | 02-fetch-specs.ts |
| `fetched-specs.json` | 02-fetch-specs.ts | 03-prefilter.ts |
| `pre-filter-survivors.json` | 03-prefilter.ts | 04-compile-results.ts, AI |
| `pre-filter-rejections.json` | 03-prefilter.ts | 04-compile-results.ts |
| `job-scores/*.json` | AI | 04-compile-results.ts |
| `compile-results.json` | 04-compile-results.ts | 05-generate-pdfs.ts |
| `all-rejections.json` | 04-compile-results.ts | - |
| `pdfs/*.pdf` | 05-generate-pdfs.ts | 06-upload.ts |
| `run-summary/*.txt` | 07-summarize-run.ts | 06-upload.ts |

## Installation

```bash
npm install
```

## Configuration

Create a `.env` file with:

```env
# Brightdata API
BRIGHTDATA_API_KEY=your_api_key

# Gmail + Google Drive (service account with domain-wide delegation)
GOOGLE_SERVICE_ACCOUNT_KEY={"type":"service_account","project_id":"...","private_key_id":"...","private_key":"-----BEGIN PRIVATE KEY-----\\n...\\n-----END PRIVATE KEY-----\\n","client_email":"...","client_id":"..."}
GOOGLE_GMAIL_IMPERSONATED_USER=mailbox-user@your-domain.com
GOOGLE_DRIVE_IMPERSONATED_USER=drive-user@your-domain.com

# OneDrive (06-upload.ts expects an access token)
ONEDRIVE_ACCESS_TOKEN=your_access_token

# OpenRouter (AI Step 1 + AI Step 2 helper scripts)
OPENROUTER_API_KEY=your_openrouter_api_key
OPENROUTER_MODEL=your/model-path
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_HTTP_REFERER=
OPENROUTER_TITLE=job-harvester
OPENROUTER_TIMEOUT_MS=90000
OPENROUTER_MAX_RETRIES=2
OPENROUTER_STEP2_BATCH_CONCURRENCY=3
OPENROUTER_STEP4_BATCH_CONCURRENCY=3

# Google Drive target
GOOGLE_DRIVE_FOLDER_ID=your_folder_id

# Optional output directories
# Required output directory
JOB_HARVESTER_WORK_DIR=./data
JOB_HARVESTER_MANAGEMENT_DATA_DIR=.
```

Notes:

- Gmail discovery in [`main()`](src/01-discover.ts:549) is skipped when [`GOOGLE_SERVICE_ACCOUNT_KEY`](README.md) or [`GOOGLE_GMAIL_IMPERSONATED_USER`](README.md) is unset/empty.
- OneDrive upload in [`main()`](src/06-upload.ts:236) is skipped when [`ONEDRIVE_ACCESS_TOKEN`](README.md) is unset/empty.
- Google Drive upload in [`uploadPdfsToGoogleDrive()`](src/06-upload.ts:143) is skipped when [`GOOGLE_SERVICE_ACCOUNT_KEY`](README.md), [`GOOGLE_DRIVE_IMPERSONATED_USER`](README.md), or [`GOOGLE_DRIVE_FOLDER_ID`](README.md) is unset/empty.
- Gmail read-state behavior is controlled by [`GMAIL_MARK_AS_READ`](README.md) (`true` by default).
- [`JOB_HARVESTER_WORK_DIR`](README.md) is required and controls pipeline outputs (`discovered-jobs.json`, `fetched-specs.json`, `specs/`, `pdfs/`, etc.).
- [`JOB_HARVESTER_MANAGEMENT_DATA_DIR`](README.md) controls operator-managed files (`applied-companies.txt`, `cv-keywords.md`, `job-search-processed.json`).
- OpenRouter scripts require [`OPENROUTER_API_KEY`](README.md) and [`OPENROUTER_MODEL`](README.md).
- Parallel batch size for AI calls is controlled by [`OPENROUTER_STEP2_BATCH_CONCURRENCY`](README.md) and [`OPENROUTER_STEP4_BATCH_CONCURRENCY`](README.md).
- AI Step 2 scoring script fails fast if [`jobs/cv-keywords.md`](jobs/cv-keywords.md) is missing under [`JOB_HARVESTER_MANAGEMENT_DATA_DIR`](README.md).
- Run summary output files are written to `RUN_DIR/run-summary/summary-log.txt` and `RUN_DIR/run-summary/review-jobs.txt`.
- Cloud uploads are grouped by run using `archive-<run-timestamp>` folder names in both OneDrive and Google Drive.

## Usage

### Service-account setup (Google Workspace Admin)

1. Create a Google Cloud service account and enable Gmail API + Drive API.
2. Enable Domain-Wide Delegation on the service account.
3. In Google Workspace Admin Console, authorize the service account client ID with these scopes:
   - `https://www.googleapis.com/auth/gmail.modify`
   - `https://www.googleapis.com/auth/drive.file`
4. Set [`GOOGLE_GMAIL_IMPERSONATED_USER`](README.md) and [`GOOGLE_DRIVE_IMPERSONATED_USER`](README.md) to delegated users in your Workspace domain.

### Run Individual Scripts

```bash
npm run discover        # Run discovery phase
npm run fetch-specs     # Fetch job specifications
npm run prefilter       # Run pre-filter
npm run compile         # Compile results
npm run generate-pdfs   # Generate PDFs
npm run summarize       # Build human-readable run summary files
npm run upload          # Upload to cloud storage
npm run ai:step2        # AI Step 1: extract jobs from Gmail index
npm run ai:step4        # AI Step 2: score pre-filter survivors
```

Each script supports `--env-file` (file values override existing process env):

```bash
npm run dev:discover -- --env-file .env.dev
npm run dev:fetch-specs -- --env-file .env.dev
npm run dev:prefilter -- --env-file .env.dev
npm run dev:compile -- --env-file .env.dev
npm run dev:generate-pdfs -- --env-file .env.dev
npm run dev:summarize -- --run-dir ./data/run-YYYY-MM-DD-HH-MM-SS --env-file .env.dev
npm run dev:upload -- --env-file .env.dev
npm run dev:ai-step2 -- --run-dir ./data/run-YYYY-MM-DD-HH-MM-SS --env-file .env.dev
npm run dev:ai-step4 -- --run-dir ./data/run-YYYY-MM-DD-HH-MM-SS --env-file .env.dev
```

### AI handoff sequence for pre/post orchestrator phases

```bash
# 1) Run pre phase to generate run dir inputs
npm run dev:run -- --phase pre --env-file .env.dev

# 2) AI Step 1 - extract additional jobs from Gmail index into discovered-jobs.json
npm run dev:ai-step2 -- --run-dir ./data/run-YYYY-MM-DD-HH-MM-SS --env-file .env.dev

# 3) Continue deterministic pipeline stages if needed
npm run dev:fetch-specs -- --env-file .env.dev
npm run dev:prefilter -- --env-file .env.dev

# 4) AI Step 2 - score survivors and write job-scores/*.json
npm run dev:ai-step4 -- --run-dir ./data/run-YYYY-MM-DD-HH-MM-SS --env-file .env.dev

# 5) Complete post phase
npm run dev:run -- --phase post --run-dir ./data/run-YYYY-MM-DD-HH-MM-SS --env-file .env.dev
```

Post phase now runs in this order:

1. compile results
2. generate PDFs (filename format: `YYYY-MM-DD-S{score}-{company}-advert.pdf`)
3. summarize run into `run-summary/summary-log.txt` and `run-summary/review-jobs.txt`
4. upload PDFs + summary artifacts to cloud archive folders

Cloud upload structure per run:

- OneDrive path: `JobSpecs/archive-<run-timestamp>/...`
- Google Drive: created subfolder `archive-<run-timestamp>` under `GOOGLE_DRIVE_FOLDER_ID`

### Run summary process (`07-summarize-run.ts`)

The summary step reads run artifacts and produces two human-readable text files:

- `run-summary/summary-log.txt` (brief run log)
- `run-summary/review-jobs.txt` (detailed list of jobs worth reviewing: score, company, title, link)

Input sources include:

- `discovered-jobs.json`
- `fetched-specs.json`
- `pre-filter-survivors.json`
- `pre-filter-rejections.json`
- `compile-results.json`
- `pdfs/pdf-results.json`

Narrative generation behavior:

- If OpenRouter is configured, the step requests concise natural-language narrative.
- If OpenRouter is unavailable or response parsing fails, deterministic text templates are used.

Manual run example:

```bash
npm run dev:summarize -- --run-dir ./data/run-YYYY-MM-DD-HH-MM-SS --env-file .env.dev
```

### Run Full Pipeline

```bash
npm run run             # Run full pipeline
```

Orchestrator also supports `--env-file`:

```bash
npm run dev:run -- --phase pre --env-file .env.dev
npm run dev:run -- --phase post --run-dir ./data/run-YYYY-MM-DD-HH-MM-SS --env-file .env.dev
```

## Testing

```bash
npm test                # Run all tests
npm run test:watch      # Run tests in watch mode
npm run test:coverage   # Run tests with coverage
```

## Linting

```bash
npm run lint            # Run ESLint
npm run lint:fix        # Fix ESLint issues
```

## Type Checking

```bash
npx tsc --noEmit        # Type check without emitting
```

## Project Structure

```
job-harvester/
├── src/
│   ├── 01-discover.ts          # Discovery script
│   ├── 02-fetch-specs.ts       # Fetch job specs
│   ├── 03-prefilter.ts         # Pre-filter script
│   ├── 04-compile-results.ts   # Compile results
│   ├── 05-generate-pdfs.ts     # PDF generation
│   ├── 07-summarize-run.ts     # Run summary generation
│   ├── 06-upload.ts            # Upload script
│   ├── run-job-search.ts       # Orchestrator
│   ├── types.ts                # Shared TypeScript types
│   ├── config.ts               # Configuration constants
│   ├── utils/
│   │   ├── logger.ts           # Logging utility
│   │   └── slugify.ts          # Slugify utility
│   └── __tests__/              # Test files
├── package.json
├── tsconfig.json
├── jest.config.ts
├── .eslintrc.js
└── README.md
```

## License

MIT
