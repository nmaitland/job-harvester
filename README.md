# Job Harvester

A TypeScript pipeline for automated job search. Discovers jobs from multiple sources, fetches job specifications, filters, scores, generates PDFs, and uploads to cloud storage.

## Architecture

The pipeline consists of standalone scripts that can be run independently or orchestrated together:

1. **discover.ts** - Discovery from web and inbox sources (Brave, LinkedIn, Gmail download)
2. **extract-from-websites.ts** - Fetches Brave-discovered pages and extracts job links via OpenRouter
3. **extract-from-emails.ts** - Email processing via OpenRouter to extract additional job URLs from downloaded email content
4. **fetch-specs.ts** - Fetches full job specifications using Brightdata API and Playwright
5. **prefilter.ts** - Applies deterministic filters (fetch_failed, already_applied, already_sent, junior_role)
6. **score-survivors.ts** - Scores pre-filter survivors via OpenRouter and writes verdict JSON files
7. **compile-results.ts** - Merges AI scores with pre-filter results, applies thresholds
8. **generate-pdfs.ts** - Generates PDFs from job specifications using Playwright
9. **summarize-run.ts** - Builds human-readable run summary files (AI narrative with deterministic fallback)
10. **upload.ts** - Uploads PDFs and summary artifacts to OneDrive and Google Drive archive folders

## File Ownership

| File | Written By | Read By |
|------|-----------|---------|
| `discovered-jobs.json` | discover.ts (appended by extract-from-websites.ts and extract-from-emails.ts) | fetch-specs.ts |
| `extract-from-websites-log.json` | extract-from-websites.ts | - |
| `fetched-specs.json` | fetch-specs.ts | prefilter.ts |
| `pre-filter-survivors.json` | prefilter.ts | score-survivors.ts, compile-results.ts |
| `pre-filter-rejections.json` | prefilter.ts | compile-results.ts |
| `job-scores/*.json` | score-survivors.ts | compile-results.ts |
| `compile-results.json` | compile-results.ts | generate-pdfs.ts |
| `all-rejections.json` | compile-results.ts | - |
| `pdfs/*.pdf` | generate-pdfs.ts | upload.ts |
| `run-summary/*.txt` | summarize-run.ts | upload.ts |

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

# OneDrive (upload.ts expects an access token)
ONEDRIVE_ACCESS_TOKEN=your_access_token

# OpenRouter (extract-from-websites + extract-from-emails + score-survivors)
OPENROUTER_API_KEY=your_openrouter_api_key
OPENROUTER_MODEL=your/model-path
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_HTTP_REFERER=
OPENROUTER_TITLE=job-harvester
OPENROUTER_TIMEOUT_MS=90000
OPENROUTER_MAX_RETRIES=2
OPENROUTER_WEBSITE_BATCH_CONCURRENCY=3
OPENROUTER_EMAIL_BATCH_CONCURRENCY=3
OPENROUTER_SCORING_BATCH_CONCURRENCY=3

# Website extraction fetch tuning
SEARCH_HITS_CONCURRENCY=3
SEARCH_HITS_MAX_PAGE_CHARS=20000

# Google Drive target
GOOGLE_DRIVE_FOLDER_ID=your_folder_id

# Required orchestrator root output directory
JOB_HARVESTER_ROOT_WORK_DIR=./data
JOB_HARVESTER_MANAGEMENT_DATA_DIR=.
```

Notes:

- Gmail discovery in [`main()`](src/discover.ts) is skipped when [`GOOGLE_SERVICE_ACCOUNT_KEY`](README.md) or [`GOOGLE_GMAIL_IMPERSONATED_USER`](README.md) is unset/empty.
- OneDrive upload in [`main()`](src/upload.ts) is skipped when [`ONEDRIVE_ACCESS_TOKEN`](README.md) is unset/empty.
- Google Drive upload in [`uploadPdfsToGoogleDrive()`](src/upload.ts) is skipped when [`GOOGLE_SERVICE_ACCOUNT_KEY`](README.md), [`GOOGLE_DRIVE_IMPERSONATED_USER`](README.md), or [`GOOGLE_DRIVE_FOLDER_ID`](README.md) is unset/empty.
- Gmail read-state behavior is controlled by [`GMAIL_MARK_AS_READ`](README.md) (`true` by default).
- [`JOB_HARVESTER_ROOT_WORK_DIR`](README.md) is required by the orchestrator and is used to create unique run folders (`run-YYYY-MM-DD-HH-mm-ss`).
- Standalone stage scripts never use root env fallback for run outputs; they require [`--run-dir`](README.md).
- [`JOB_HARVESTER_MANAGEMENT_DATA_DIR`](README.md) controls operator-managed files (`applied-companies.txt`, `cv-keywords.md`, `job-search-processed.json`).
- OpenRouter scripts require [`OPENROUTER_API_KEY`](README.md) and [`OPENROUTER_MODEL`](README.md).
- Parallel batch size for AI calls is controlled by [`OPENROUTER_EMAIL_BATCH_CONCURRENCY`](README.md) and [`OPENROUTER_SCORING_BATCH_CONCURRENCY`](README.md).
- `score-survivors.ts` fails fast if [`jobs/cv-keywords.md`](jobs/cv-keywords.md) is missing under [`JOB_HARVESTER_MANAGEMENT_DATA_DIR`](README.md).
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

All standalone stage scripts require [`--run-dir`](README.md) pointing to an existing `run-YYYY-MM-DD-HH-mm-ss` folder.

```bash
npm run discover        # Run discovery phase
npm run extract-from-websites # Extract jobs from Brave result pages
npm run extract-from-emails # Extract extra jobs from downloaded emails
npm run fetch-specs     # Fetch job specifications
npm run prefilter       # Run pre-filter
npm run score-survivors # Score survivors with AI
npm run compile         # Compile results
npm run generate-pdfs   # Generate PDFs
npm run summarize       # Build human-readable run summary files
npm run upload          # Upload to cloud storage
```

Each script supports `--env-file` (file values override existing process env):

```bash
npm run dev:discover -- --env-file .env.dev
npm run dev:extract-from-websites -- --run-dir ./data/run-YYYY-MM-DD-HH-mm-ss --env-file .env.dev
npm run dev:extract-from-emails -- --run-dir ./data/run-YYYY-MM-DD-HH-mm-ss --env-file .env.dev
npm run dev:fetch-specs -- --env-file .env.dev
npm run dev:prefilter -- --env-file .env.dev
npm run dev:score-survivors -- --run-dir ./data/run-YYYY-MM-DD-HH-mm-ss --env-file .env.dev
npm run dev:compile -- --env-file .env.dev
npm run dev:generate-pdfs -- --env-file .env.dev
npm run dev:summarize -- --run-dir ./data/run-YYYY-MM-DD-HH-mm-ss --env-file .env.dev
npm run dev:upload -- --run-dir ./data/run-YYYY-MM-DD-HH-mm-ss --env-file .env.dev
```

Example with explicit run dir:

```bash
npm run dev:discover -- --run-dir ./data/run-YYYY-MM-DD-HH-mm-ss --env-file .env.dev
npm run dev:extract-from-websites -- --run-dir ./data/run-YYYY-MM-DD-HH-mm-ss --env-file .env.dev
npm run dev:extract-from-emails -- --run-dir ./data/run-YYYY-MM-DD-HH-mm-ss --env-file .env.dev
npm run dev:fetch-specs -- --run-dir ./data/run-YYYY-MM-DD-HH-mm-ss --env-file .env.dev
npm run dev:prefilter -- --run-dir ./data/run-YYYY-MM-DD-HH-mm-ss --env-file .env.dev
npm run dev:score-survivors -- --run-dir ./data/run-YYYY-MM-DD-HH-mm-ss --env-file .env.dev
npm run dev:compile -- --run-dir ./data/run-YYYY-MM-DD-HH-mm-ss --env-file .env.dev
npm run dev:generate-pdfs -- --run-dir ./data/run-YYYY-MM-DD-HH-mm-ss --env-file .env.dev
npm run dev:summarize -- --run-dir ./data/run-YYYY-MM-DD-HH-mm-ss --env-file .env.dev
npm run dev:upload -- --run-dir ./data/run-YYYY-MM-DD-HH-mm-ss --env-file .env.dev
```

### Fully automated orchestrator flow (no manual AI handoff)

```bash
# Default: creates a new run directory and executes every stage end-to-end
npm run run -- --env-file .env.dev

# Optional partial phase reruns for an existing run directory
npm run dev:run -- --phase discovery --run-dir ./data/run-YYYY-MM-DD-HH-mm-ss --env-file .env.dev
npm run dev:run -- --phase email-processing --run-dir ./data/run-YYYY-MM-DD-HH-mm-ss --env-file .env.dev
npm run dev:run -- --phase fetch-and-filter --run-dir ./data/run-YYYY-MM-DD-HH-mm-ss --env-file .env.dev
npm run dev:run -- --phase scoring --run-dir ./data/run-YYYY-MM-DD-HH-mm-ss --env-file .env.dev
npm run dev:run -- --phase output --run-dir ./data/run-YYYY-MM-DD-HH-mm-ss --env-file .env.dev
```

`--phase output` runs in this order:

1. compile results
2. generate PDFs (filename format: `YYYY-MM-DD-S{score}-{company}-advert.pdf`)
3. summarize run into `run-summary/summary-log.txt` and `run-summary/review-jobs.txt`
4. upload PDFs + summary artifacts to cloud archive folders

Cloud upload structure per run:

- OneDrive path: `JobSpecs/archive-<run-timestamp>/...`
- Google Drive: created subfolder `archive-<run-timestamp>` under `GOOGLE_DRIVE_FOLDER_ID`

### Run summary process (`summarize-run.ts`)

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
npm run dev:summarize -- --run-dir ./data/run-YYYY-MM-DD-HH-mm-ss --env-file .env.dev
```

### Run Full Pipeline

```bash
npm run run             # Run full pipeline
```

Orchestrator also supports `--env-file`:

```bash
npm run dev:run -- --env-file .env.dev
npm run dev:run -- --phase output --run-dir ./data/run-YYYY-MM-DD-HH-mm-ss --env-file .env.dev
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
│   ├── discover.ts             # Discovery script
│   ├── extract-from-websites.ts # Website extraction
│   ├── extract-from-emails.ts  # Email processing
│   ├── fetch-specs.ts          # Fetch job specs
│   ├── prefilter.ts            # Pre-filter script
│   ├── score-survivors.ts      # AI scoring
│   ├── compile-results.ts      # Compile results
│   ├── generate-pdfs.ts        # PDF generation
│   ├── summarize-run.ts        # Run summary generation
│   ├── upload.ts               # Upload script
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
