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

# Gmail API
GMAIL_CLIENT_ID=your_client_id
GMAIL_CLIENT_SECRET=your_client_secret
GMAIL_REFRESH_TOKEN=your_refresh_token

# OneDrive
ONEDRIVE_CLIENT_ID=your_client_id
ONEDRIVE_CLIENT_SECRET=your_client_secret
ONEDRIVE_REFRESH_TOKEN=your_refresh_token

# Google Drive
GOOGLE_DRIVE_CLIENT_ID=your_client_id
GOOGLE_DRIVE_CLIENT_SECRET=your_client_secret
GOOGLE_DRIVE_REFRESH_TOKEN=your_refresh_token
```

## Usage

### Run Individual Scripts

```bash
npm run discover        # Run discovery phase
npm run fetch-specs     # Fetch job specifications
npm run prefilter       # Run pre-filter
npm run compile         # Compile results
npm run generate-pdfs   # Generate PDFs
npm run upload          # Upload to cloud storage
```

### Run Full Pipeline

```bash
npm run run             # Run full pipeline
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
