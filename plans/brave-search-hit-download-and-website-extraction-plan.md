# Plan: Brave Website Extraction + File Renaming + CI Gate

## Problem

Brave search returns URLs that are often job-board listing pages (e.g. `jobs.ch`, `indeed.com`, aggregator blogs) rather than individual job postings. The current pipeline passes these directly to `fetch-specs.ts`, which tries to fetch a job spec from a page that actually contains *many* jobs or no job at all.

Real-world evidence from `temp/run-2026-02-24-12-31-49/discovered-jobs.json`:
- `scholaridea.com/...eth-zurich...132-phd-postdoc...` — aggregator listing
- `designrush.com/agency/web-development-companies/ch` — agency directory
- `en.wikipedia.org/wiki/Zurich_Insurance_Group` — Wikipedia
- `tracxn.com/d/companies/elizepartners/...` — company profile

## Solution

1. Add a new `extract-from-websites.ts` step that fetches each Brave result page and uses AI to extract individual job candidates — the same AI extractor used for emails
2. Remove numeric prefixes from all source filenames (order of execution is defined in the orchestrator and README, not filenames)
3. Add a CI gate at the end of implementation: lint + type-check + test + commit + push + monitor GitHub Actions

---

## Part 1 — File Renaming

Every numbered source file gets its number prefix stripped. The mapping:

| Old name | New name |
|---|---|
| `src/01-discover.ts` | `src/discover.ts` |
| `src/02-extract-from-emails.ts` | `src/extract-from-emails.ts` |
| `src/03-fetch-specs.ts` | `src/fetch-specs.ts` |
| `src/04-prefilter.ts` | `src/prefilter.ts` |
| `src/05-score-survivors.ts` | `src/score-survivors.ts` |
| `src/06-compile-results.ts` | `src/compile-results.ts` |
| `src/07-generate-pdfs.ts` | `src/generate-pdfs.ts` |
| `src/08-summarize-run.ts` | `src/summarize-run.ts` |
| `src/09-upload.ts` | `src/upload.ts` |
| `src/__tests__/01-discover.test.ts` | `src/__tests__/discover.test.ts` |
| `src/__tests__/02-extract-from-emails.test.ts` | `src/__tests__/extract-from-emails.test.ts` |
| `src/__tests__/03-fetch-specs.test.ts` | `src/__tests__/fetch-specs.test.ts` |
| `src/__tests__/04-prefilter.test.ts` | `src/__tests__/prefilter.test.ts` |
| `src/__tests__/05-score-survivors.test.ts` | `src/__tests__/score-survivors.test.ts` |
| `src/__tests__/06-compile-results.test.ts` | `src/__tests__/compile-results.test.ts` |
| `src/__tests__/07-generate-pdfs.test.ts` | `src/__tests__/generate-pdfs.test.ts` |
| `src/__tests__/08-summarize-run.test.ts` | `src/__tests__/summarize-run.test.ts` |
| `src/__tests__/09-upload.test.ts` | `src/__tests__/upload.test.ts` |

All `import` statements in `src/run-job-search.ts` and any cross-references updated accordingly.
`package.json` script values updated to point to renamed `dist/` files (e.g. `dist/01-discover.js` → `dist/discover.js`).

---

## Part 2 — New Shared Extractor: `src/ai/extract-job-candidates.ts`

Extracts the common AI call from `extract-from-emails.ts` into a reusable function:

```ts
export async function extractJobCandidates(
  content: string,
  context: { type: 'email' | 'webpage'; hint?: string }
): Promise<ExtractedJobCandidate[]>
```

The prompt framing line differs by context type:
- `email`: `"Extract job links from this email."`
- `webpage`: `"Extract job links from this web page."`

Everything else — JSON shape, rules, system prompt, validator call — is identical.

`extract-from-emails.ts` is refactored to call this shared function.
`extract-from-websites.ts` also calls it.

---

## Part 3 — New File: `src/extract-from-websites.ts`

**Purpose:** For every `source: 'brave'` job in `discovered-jobs.json`, fetch the page text and run AI extraction. Merge results back into `discovered-jobs.json`.

**Flow:**

```
Read discovered-jobs.json
  → filter source === 'brave'
  → for each: fetch page (plain text, truncated)
  → call extractJobCandidates(pageText, { type: 'webpage' })
  → merge candidates into discovered-jobs.json (same dedup logic as extract-from-emails)
  → write extract-from-websites-log.json
```

**Source value for merged jobs:** `'brave-extracted'`

**Why AI instead of heuristics:**
- A URL like `jobs.ch/job/12345` is a single job on a job board; `jobs.ch/search?q=cto` is a listing — you can't tell from the URL
- Aggregator sites also have individual job pages
- AI handles both cases naturally: returns one candidate for a single-job page, many for a listing, zero for irrelevant pages

**Configuration:**
- `SEARCH_HITS_CONCURRENCY` — parallel page fetches (default: 3)
- `SEARCH_HITS_MAX_PAGE_CHARS` — page text truncation (default: 20000)
- `OPENROUTER_WEBSITE_BATCH_CONCURRENCY` — parallel AI calls (default: 3)

**Output:** `extract-from-websites-log.json`

```ts
{
  timestamp: string;
  runDir: string;
  discoveredFile: string;
  pagesProcessed: number;
  candidatesExtracted: number;
  appended: number;
  duplicateUrls: number;
  invalidUrls: number;
}
```

**Test file:** `src/__tests__/extract-from-websites.test.ts`
- Filters only `source: 'brave'` entries
- AI prompt construction (webpage context)
- Candidate merging (dedup by URL, invalid URL handling)
- Log file written correctly
- Error handling when fetch fails

---

## Part 4 — Type Changes: `src/types.ts`

```ts
// Add 'brave-extracted' to DiscoveredJob.source
export interface DiscoveredJob {
  source: 'gmail' | 'linkedin' | 'brave' | 'brave-extracted';
  // ... rest unchanged
}
```

`'brave'` = direct Brave search hit (single job page, passed straight to fetch-specs)
`'brave-extracted'` = job extracted by AI from a Brave result page (listing or aggregator)

---

## Part 5 — Orchestrator: `src/run-job-search.ts`

**Phase grouping:**

| Phase | Steps (new names) |
|---|---|
| `discovery` | `discover` |
| `email-processing` | `extract-from-websites` → `extract-from-emails` |
| `fetch-and-filter` | `fetch-specs` → `prefilter` |
| `scoring` | `score-survivors` |
| `output` | `compile-results` → `generate-pdfs` → `summarize-run` → `upload` |

`extract-from-websites` runs before `extract-from-emails` — both append to `discovered-jobs.json`.

**`runScript` switch cases** updated to use new names (no numbers).

**Run manifest** additions:
```ts
'extract-from-websites-log.json': {
  owner: 'extract-from-websites.ts',
  aiMayRead: true,
  aiMayWrite: false,
  description: 'Log of jobs extracted from Brave search result pages via AI',
},
```

---

## Part 6 — `package.json` changes

New scripts added:
```json
"extract-from-websites": "node dist/extract-from-websites.js",
"dev:extract-from-websites": "ts-node src/extract-from-websites.ts"
```

Existing script values updated to point to renamed `dist/` files:
- `"discover": "node dist/discover.js"` (was `dist/01-discover.js`)
- `"extract-from-emails": "node dist/extract-from-emails.js"` (was `dist/02-extract-from-emails.js`)
- etc. for all 9 steps

---

## Part 7 — README updates

- Architecture list updated: new step inserted, new filenames used throughout
- File ownership table: `extract-from-websites.ts` appends to `discovered-jobs.json`
- Project structure tree: updated filenames
- Usage examples: script names unchanged, file references updated
- Configuration section: add `OPENROUTER_WEBSITE_BATCH_CONCURRENCY`, `SEARCH_HITS_CONCURRENCY`, `SEARCH_HITS_MAX_PAGE_CHARS`; rename `OPENROUTER_EMAIL_BATCH_CONCURRENCY` → `OPENROUTER_EMAIL_BATCH_CONCURRENCY` and `OPENROUTER_SCORING_BATCH_CONCURRENCY` → `OPENROUTER_SCORING_BATCH_CONCURRENCY`

---

## Part 8 — CI Gate (final implementation step)

After all code changes are made and passing locally:

1. `npm run check-types` — must pass clean
2. `npm run lint` — must pass clean
3. `npm test` — all tests must pass
4. `git add -A && git commit -m "feat: add extract-from-websites step; remove numbered file prefixes"`
5. `git push`
6. Monitor GitHub Actions `CI` workflow (`.github/workflows/ci.yml`) — wait for `quality` job: type-check → lint → test

---

## Complete File Change Summary

| Action | Files |
|---|---|
| **Rename** (×18) | All `src/NN-*.ts` and `src/__tests__/NN-*.test.ts` → strip number prefix |
| **New** | `src/extract-from-websites.ts` |
| **New** | `src/ai/extract-job-candidates.ts` |
| **New** | `src/__tests__/extract-from-websites.test.ts` |
| **Modify** | `src/types.ts` — add `'brave-extracted'` source |
| **Modify** | `src/extract-from-emails.ts` — refactor to use shared extractor |
| **Modify** | `src/run-job-search.ts` — new imports, new script cases, updated phase functions, manifest |
| **Modify** | `package.json` — new scripts, updated dist paths |
| **Modify** | `README.md` — updated architecture, file ownership, project structure, config docs |
