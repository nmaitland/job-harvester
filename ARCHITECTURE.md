# Architecture

## Pipeline Data Flow

Each stage reads JSON from the previous stage and writes JSON for the next. All artifacts live under a timestamped run directory (`run-YYYY-MM-DD-HH-mm-ss`).

```
discover → extract-from-websites → extract-from-emails → fetch-specs → prefilter → score-survivors → compile-results → generate-pdfs → summarize-run → upload
```

### File Ownership

| File | Written By | Read By |
|------|-----------|---------|
| `discovered-jobs.json` | discover (appended by extract-from-websites, extract-from-emails) | fetch-specs |
| `extract-from-websites-log.json` | extract-from-websites | — |
| `fetched-specs.json` | fetch-specs | prefilter |
| `pre-filter-survivors.json` | prefilter | score-survivors, compile-results |
| `pre-filter-rejections.json` | prefilter | compile-results |
| `job-scores/*.json` | score-survivors | compile-results |
| `compile-results.json` | compile-results | generate-pdfs |
| `all-rejections.json` | compile-results | — |
| `pdfs/*.pdf` | generate-pdfs | upload |
| `run-summary/*.txt` | summarize-run | upload |

## Type System

All shared types are in `src/types.ts`. Key interfaces follow the pipeline flow:

- `DiscoveredJob` — URL, company, title, source, timestamp
- `JobSpec` — Adds `specText`, `fetchStatus`, `fetchError`
- `FilterVerdict` — Pass/fail with `RejectionReason` (`fetch_failed | already_applied | already_sent | junior_role`)
- `JobScore` — Numeric score + reasoning text
- `CompiledJob` — Merged score + filter result with final status
- `PDFResult` — Generated PDF path
- `UploadResult` — OneDrive/Google Drive URLs

Each stage also has an `*Output` wrapper type with stats.

## Key Modules

### Pipeline Stages (`src/*.ts`)

Each stage script exports a `main()` function and supports CLI args (`--run-dir`, `--env-file`). The orchestrator (`run-job-search.ts`) calls each stage's main function in sequence.

### AI Layer (`src/ai/`)

- `openrouter-client.ts` — HTTP client for OpenRouter with configurable temperature, max tokens, timeout, and retries
- `extract-job-candidates.ts` — Prompts for extracting job URLs from web pages and emails
- `validators.ts` — Input/output validation and URL normalization for AI responses

### Utilities (`src/utils/`)

- `logger.ts` — Timestamped console output with levels (DEBUG, INFO, WARN, ERROR)
- `secrets.ts` — Pluggable secret provider (env vars by default, 1Password adapter available)
- `http.ts` — `retry()` with exponential backoff, `withTimeout()` wrapper
- `run-dir.ts` — Run directory format validation and timestamp parsing
- `env-loader.ts` — `.env` file parser; file values override `process.env`
- `processed-urls.ts` — Cross-run URL deduplication registry
- `slugify.ts` — Company/title string normalization for filenames

## Orchestrator Phases

The orchestrator groups stages into phases for partial reruns:

| Phase | Stages |
|-------|--------|
| `discovery` | discover |
| `email-processing` | extract-from-websites, extract-from-emails |
| `fetch-and-filter` | fetch-specs, prefilter |
| `scoring` | score-survivors |
| `output` | compile-results, generate-pdfs, summarize-run, upload |

## Pre-filter Logic

Deterministic filters applied in order:
1. **fetch_failed** — Job spec fetch returned an error
2. **already_applied** — Company name matches `applied-companies.txt` (case-insensitive, normalized)
3. **already_sent** — Job URL was uploaded in a previous run
4. **junior_role** — Title contains junior-level keywords (20+ patterns: junior, entry-level, intern, 0-2 years, etc.)
