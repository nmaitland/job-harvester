# Job Harvester

Job searching is tedious. You check the same sites every day, skim dozens of irrelevant postings, copy-paste job specs into documents, and lose track of what you've already seen. Job Harvester automates all of that.

It's a TypeScript pipeline that runs on your machine and does the repetitive work for you: it searches multiple job sources, pulls down the full job descriptions, filters out the noise (roles you've already applied to, junior positions, failed fetches), scores what's left against your CV using an LLM, and produces a neat set of PDFs and summaries — ready for you to review and act on.

**Why use it?**

- **Save hours per week** — Instead of manually checking Brave, LinkedIn, and email alerts, run one command and get a curated shortlist.
- **Never re-read the same job twice** — Cross-run deduplication tracks every URL you've already processed.
- **AI-powered relevance scoring** — Jobs are scored against your own CV keywords, so you see the best matches first.
- **Everything in one place** — PDFs and summaries are uploaded to OneDrive and/or Google Drive, organised by run date.
- **Fully configurable** — Pick which discovery sources to enable, tune concurrency, set your own scoring model, or run individual stages in isolation.

## How It Works

The pipeline runs 10 stages in sequence, each producing JSON that feeds the next:

1. **Discover** — Searches Brave API, scrapes LinkedIn (Playwright), and downloads Gmail job alerts
2. **Extract from Websites** — Fetches Brave result pages and extracts job links via OpenRouter (LLM)
3. **Extract from Emails** — Extracts job URLs from downloaded email content via OpenRouter
4. **Fetch Specs** — Retrieves full job descriptions using Brightdata API and Playwright
5. **Pre-filter** — Applies deterministic filters: `fetch_failed`, `already_applied`, `already_sent`, `junior_role`
6. **Score Survivors** — Scores remaining jobs via OpenRouter against your CV keywords
7. **Compile Results** — Merges AI scores with pre-filter results and applies thresholds
8. **Generate PDFs** — Renders job specs as A4 PDFs via Playwright
9. **Summarize Run** — Builds human-readable summary files (AI narrative with deterministic fallback)
10. **Upload** — Uploads PDFs and summaries to OneDrive and Google Drive

An orchestrator (`run-job-search.ts`) coordinates all stages, creating a timestamped run directory for each execution.

## Prerequisites

- **Node.js** 20+
- **npm**
- **Playwright browsers**: `npx playwright install chromium`
- **API keys** for the services you want to use (see Configuration)

## Quick Start

```bash
# Install dependencies
npm install

# Install Playwright browser
npx playwright install chromium

# Copy and fill in your configuration
cp .env.example .env

# Build
npm run build

# Run the full pipeline
npm run run -- --env-file .env
```

## Configuration

Copy `.env.example` to `.env` and fill in the values you need. All discovery sources and upload targets are optional — the pipeline skips any stage whose credentials are missing.

### Required

| Variable | Purpose |
|----------|---------|
| `JOB_HARVESTER_ROOT_WORK_DIR` | Root directory for run folders (e.g. `./data`) |
| `OPENROUTER_API_KEY` | OpenRouter API key for AI extraction and scoring |
| `OPENROUTER_MODEL` | Model to use (e.g. `anthropic/claude-sonnet-4`) |

### Discovery Sources (all optional)

| Variable | Purpose |
|----------|---------|
| `BRAVE_API_KEY` | Brave Search API key |
| `BRAVE_QUERIES` | Comma-separated search queries |
| `LINKEDIN_USERNAME` / `LINKEDIN_PASSWORD` | LinkedIn credentials for scraping |
| `LINKEDIN_SEARCH_TERMS` / `LINKEDIN_LOCATIONS` | Comma-separated search terms and locations |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | Google service account JSON for Gmail access |
| `GOOGLE_GMAIL_IMPERSONATED_USER` | Gmail user to impersonate via domain-wide delegation |

### Upload Targets (all optional)

| Variable | Purpose |
|----------|---------|
| `ONEDRIVE_ACCESS_TOKEN` | Microsoft Graph access token for OneDrive uploads |
| `GOOGLE_DRIVE_IMPERSONATED_USER` | Drive user to impersonate |
| `GOOGLE_DRIVE_FOLDER_ID` | Target folder in Google Drive |

### Tuning

| Variable | Default | Purpose |
|----------|---------|---------|
| `OPENROUTER_WEBSITE_BATCH_CONCURRENCY` | `3` | Parallel website extraction calls |
| `OPENROUTER_EMAIL_BATCH_CONCURRENCY` | `3` | Parallel email extraction calls |
| `OPENROUTER_SCORING_BATCH_CONCURRENCY` | `3` | Parallel scoring calls |
| `SEARCH_HITS_CONCURRENCY` | `3` | Parallel page fetches for website extraction |
| `OPENROUTER_TIMEOUT_MS` | `90000` | AI call timeout |
| `OPENROUTER_MAX_RETRIES` | `2` | AI call retry count |

### Operator-Managed Files

Set `JOB_HARVESTER_MANAGEMENT_DATA_DIR` (defaults to project root) to control where these files live:

- `applied-companies.txt` — Companies you've already applied to (one per line), used by pre-filter
- `cv-keywords.md` — Your CV keywords/summary, used by the AI scorer (required for scoring stage)
- `job-search-processed.json` — Cross-run URL deduplication registry (auto-managed)

### Google Workspace Setup

1. Create a Google Cloud service account and enable Gmail API + Drive API
2. Enable Domain-Wide Delegation on the service account
3. In Google Workspace Admin Console, authorize the service account client ID with scopes:
   - `https://www.googleapis.com/auth/gmail.modify`
   - `https://www.googleapis.com/auth/drive.file`
4. Set `GOOGLE_GMAIL_IMPERSONATED_USER` and `GOOGLE_DRIVE_IMPERSONATED_USER` to delegated users in your domain

## Usage

### Full Pipeline

```bash
# Build and run
npm run build
npm run run -- --env-file .env

# Or use ts-node for development
npm run dev:run -- --env-file .env
```

### Individual Stages

Each stage can run independently with `--run-dir` pointing to an existing run folder:

```bash
npm run dev:discover -- --run-dir ./data/run-2026-03-05-10-00-00 --env-file .env
npm run dev:fetch-specs -- --run-dir ./data/run-2026-03-05-10-00-00 --env-file .env
npm run dev:prefilter -- --run-dir ./data/run-2026-03-05-10-00-00 --env-file .env
```

### Partial Phase Reruns

The orchestrator supports rerunning specific phases on an existing run directory:

```bash
npm run dev:run -- --phase discovery --run-dir ./data/run-2026-03-05-10-00-00 --env-file .env
npm run dev:run -- --phase email-processing --run-dir ./data/run-2026-03-05-10-00-00 --env-file .env
npm run dev:run -- --phase fetch-and-filter --run-dir ./data/run-2026-03-05-10-00-00 --env-file .env
npm run dev:run -- --phase scoring --run-dir ./data/run-2026-03-05-10-00-00 --env-file .env
npm run dev:run -- --phase output --run-dir ./data/run-2026-03-05-10-00-00 --env-file .env
```

### Run Output

Each run creates a timestamped directory (e.g. `./data/run-2026-03-05-10-00-00/`) containing:

- `discovered-jobs.json` — All discovered job postings
- `fetched-specs.json` — Full job specifications
- `pre-filter-survivors.json` / `pre-filter-rejections.json` — Filter results
- `job-scores/*.json` — Individual AI scoring verdicts
- `compile-results.json` / `all-rejections.json` — Final compiled results
- `pdfs/*.pdf` — Generated PDF specs (named `YYYY-MM-DD-S{score}-{company}-advert.pdf`)
- `run-summary/summary-log.txt` — Brief run log
- `run-summary/review-jobs.txt` — Jobs worth reviewing with scores

Cloud uploads are grouped under `archive-<run-timestamp>` folders in both OneDrive and Google Drive.

## License

MIT
