# Job Harvester

A TypeScript pipeline for automated job search. Discovers jobs from multiple sources, fetches job specifications, filters, scores, generates PDFs, and uploads to cloud storage.

## Architecture

The pipeline consists of 6 standalone scripts that can be run independently or orchestrated together:

1. **01-discover.ts** - Discovers jobs from Gmail, LinkedIn, and Brave Search
2. **02-fetch-specs.ts** - Fetches full job specifications using Brightdata API and Playwright
3. **03-prefilter.ts** - Applies deterministic filters (fetch_failed, already_applied, already_sent, junior_role)
4. **04-compile-results.ts** - Merges AI scores with pre-filter results, applies thresholds
5. **05-generate-pdfs.ts** - Generates PDFs from job specifications using Playwright
6. **06-upload.ts** - Uploads PDFs to OneDrive and Google Drive

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

# Google Drive target
GOOGLE_DRIVE_FOLDER_ID=your_folder_id
```

Notes:

- Gmail discovery in [`main()`](src/01-discover.ts:549) is skipped when [`GOOGLE_SERVICE_ACCOUNT_KEY`](README.md) or [`GOOGLE_GMAIL_IMPERSONATED_USER`](README.md) is unset/empty.
- OneDrive upload in [`main()`](src/06-upload.ts:236) is skipped when [`ONEDRIVE_ACCESS_TOKEN`](README.md) is unset/empty.
- Google Drive upload in [`uploadPdfsToGoogleDrive()`](src/06-upload.ts:143) is skipped when [`GOOGLE_SERVICE_ACCOUNT_KEY`](README.md), [`GOOGLE_DRIVE_IMPERSONATED_USER`](README.md), or [`GOOGLE_DRIVE_FOLDER_ID`](README.md) is unset/empty.
- Gmail read-state behavior is controlled by [`GMAIL_MARK_AS_READ`](README.md) (`true` by default).

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
npm run upload          # Upload to cloud storage
```

Each script supports `--env-file` (file values override existing process env):

```bash
npm run dev:discover -- --env-file .env.dev
npm run dev:fetch-specs -- --env-file .env.dev
npm run dev:prefilter -- --env-file .env.dev
npm run dev:compile -- --env-file .env.dev
npm run dev:generate-pdfs -- --env-file .env.dev
npm run dev:upload -- --env-file .env.dev
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
