# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commit Rules

Do not add "Co-Authored-By" trailers to commit messages.

## Project Overview

Job Harvester is a TypeScript pipeline for automated job search. It discovers jobs from multiple sources (Brave Search, LinkedIn, Gmail), fetches specs, filters, scores with AI, generates PDFs, and uploads to cloud storage. The pipeline has 10 sequential stages orchestrated by `run-job-search.ts`.

## Build & Development Commands

```bash
npm run build              # Compile TypeScript to dist/
npm run validate           # Type check + lint + test (run before committing)
npm run check-types        # tsc --noEmit
npm run lint               # ESLint
npm run lint:fix           # ESLint with auto-fix
npm test                   # Jest (all tests)
npx jest src/__tests__/prefilter.test.ts   # Run a single test file
npm run test:watch         # Watch mode
npm run test:coverage      # With coverage report
npm run test:ci            # CI mode (4GB heap, sequential)
```

Development uses `ts-node` directly via `dev:` script variants:
```bash
npm run dev:run -- --env-file .env.dev                                    # Full pipeline
npm run dev:discover -- --run-dir ./data/run-YYYY-MM-DD-HH-mm-ss --env-file .env.dev
```

## Pipeline Architecture

10 stages execute in order, each reading the previous stage's JSON output:

1. **discover** - Brave API search, LinkedIn scraping (Playwright), Gmail download
2. **extract-from-websites** - Fetches Brave result pages, extracts job links via OpenRouter
3. **extract-from-emails** - Extracts job URLs from downloaded emails via OpenRouter
4. **fetch-specs** - Fetches full job specs via Brightdata API and Playwright
5. **prefilter** - Deterministic filters: `fetch_failed`, `already_applied`, `already_sent`, `junior_role`
6. **score-survivors** - AI scoring via OpenRouter against CV keywords
7. **compile-results** - Merges AI scores with pre-filter results
8. **generate-pdfs** - Renders job specs as A4 PDFs via Playwright
9. **summarize-run** - AI narrative summary with deterministic fallback
10. **upload** - Uploads to OneDrive and Google Drive archive folders

The orchestrator (`run-job-search.ts`) creates timestamped run directories (`run-YYYY-MM-DD-HH-mm-ss`) under `JOB_HARVESTER_ROOT_WORK_DIR` and supports partial phase reruns: `--phase discovery|email-processing|fetch-and-filter|scoring|output`.

## Key Data Flow

Each stage writes JSON consumed by downstream stages. All per-run artifacts live under the run directory:

- `discovered-jobs.json` → `fetched-specs.json` → `pre-filter-survivors.json` / `pre-filter-rejections.json` → `job-scores/*.json` → `compile-results.json` → `pdfs/*.pdf` → `run-summary/*.txt`

Cross-run deduplication uses `job-search-processed.json` in the management data directory.

## Code Conventions

### TypeScript Strictness
- Full strict mode with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`
- `@typescript-eslint/no-explicit-any`: error (relaxed in tests)
- `@typescript-eslint/explicit-function-return-type`: error (relaxed in tests)
- `@typescript-eslint/strict-boolean-expressions`: error — no implicit truthiness checks
- Prefer `??` over `||` and optional chaining over manual checks (enforced by ESLint)
- Unused function args must be prefixed with `_`

### CLI Pattern
All scripts accept `--run-dir <path>` and `--env-file <path>`. Arguments are parsed via a `parseArgs()` pattern. The env-file values override `process.env`.

### Testing
- Tests in `src/__tests__/`, one test file per pipeline stage
- Mock `fs/promises` to prevent real file I/O: `jest.mock('fs/promises')`
- External APIs (Gmail, Brightdata, OpenRouter, OneDrive) are mocked per test file
- ESLint rules for `any`, return types, and unsafe operations are relaxed in test files

## Key Source Files

- `src/types.ts` - All shared interfaces (`DiscoveredJob`, `JobSpec`, `FilterVerdict`, `CompiledJob`, `PDFResult`, etc.)
- `src/config.ts` - Constants and configuration
- `src/ai/openrouter-client.ts` - OpenRouter API client with retry/timeout
- `src/utils/logger.ts` - Structured timestamped logging
- `src/utils/secrets.ts` - Pluggable secret providers (env vars, 1Password)
- `src/utils/http.ts` - `retry()` with exponential backoff, `withTimeout()`
- `src/utils/processed-urls.ts` - Cross-run URL deduplication registry
- `src/utils/run-dir.ts` - Run directory format validation and parsing

## External Services

- **OpenRouter** - AI extraction and scoring (configurable model, batch concurrency)
- **Brightdata** - Job page fetching proxy
- **Google Workspace** - Gmail reading and Drive uploads (service account with domain-wide delegation)
- **Microsoft Graph** - OneDrive uploads
- **Brave Search API** - Web job discovery
- **Playwright** - LinkedIn scraping, page fetching fallback, PDF generation
