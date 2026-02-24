import * as fs from 'fs/promises';
import * as path from 'path';
import type { DiscoveredJob } from './types';
import { slugify } from './utils/slugify';
import * as logger from './utils/logger';
import { loadEnvFileIfProvided } from './utils/env-loader';
import {
  type ExtractedJobCandidate,
  normalizeHttpUrl,
} from './ai/validators';
import { extractJobCandidates } from './ai/extract-job-candidates';
import { resolveRequiredRunDirFromCli } from './utils/run-dir';

interface WebsiteSource {
  id: string;
  url: string;
  title: string;
  company: string;
}

interface WebsiteFetchResult {
  source: WebsiteSource;
  content: string;
}

interface ExtractionBatchResult {
  sourceId: string;
  candidates: ExtractedJobCandidate[];
}

interface DiscoveredDocument {
  document: Record<string, unknown>;
  jobs: DiscoveredJob[];
}

interface MergeResult {
  jobs: DiscoveredJob[];
  appended: number;
  duplicateUrls: number;
  invalidUrls: number;
}

interface WebsiteExtractionResult {
  pagesProcessed: number;
  candidatesExtracted: number;
  appended: number;
  duplicateUrls: number;
  invalidUrls: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function getDiscoveredJobsFile(runDir: string): string {
  return path.join(runDir, 'discovered-jobs.json');
}

function getStepLogFile(runDir: string): string {
  return path.join(runDir, 'extract-from-websites-log.json');
}

function getWebsiteBatchConcurrency(): number {
  const raw = process.env.OPENROUTER_WEBSITE_BATCH_CONCURRENCY;
  if (raw === undefined || raw.trim() === '') {
    return 3;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 3;
  }

  return parsed;
}

function getSearchHitsConcurrency(): number {
  const raw = process.env.SEARCH_HITS_CONCURRENCY;
  if (raw === undefined || raw.trim() === '') {
    return 3;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 3;
  }

  return parsed;
}

function getSearchHitsMaxPageChars(): number {
  const raw = process.env.SEARCH_HITS_MAX_PAGE_CHARS;
  if (raw === undefined || raw.trim() === '') {
    return 20000;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 20000;
  }

  return parsed;
}

function chunkArray<T>(items: T[], batchSize: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    chunks.push(items.slice(i, i + batchSize));
  }
  return chunks;
}

function toDiscoveredDocument(value: unknown): DiscoveredDocument {
  if (!isRecord(value)) {
    return { document: { jobs: [] }, jobs: [] };
  }

  const rawJobs = value.jobs;
  if (!Array.isArray(rawJobs)) {
    return { document: { ...value, jobs: [] }, jobs: [] };
  }

  const jobs: DiscoveredJob[] = [];
  for (const rawJob of rawJobs) {
    if (!isRecord(rawJob)) {
      continue;
    }

    const id = asString(rawJob.id);
    const company = asString(rawJob.company);
    const title = asString(rawJob.title);
    const url = asString(rawJob.url);
    const source = asString(rawJob.source);
    const discoveredAt = asString(rawJob.discoveredAt);

    if (id === '' || company === '' || title === '' || url === '' || discoveredAt === '') {
      continue;
    }

    if (source !== 'gmail' && source !== 'linkedin' && source !== 'brave' && source !== 'brave-extracted') {
      continue;
    }

    jobs.push({
      id,
      company,
      title,
      url,
      source,
      discoveredAt,
    });
  }

  return {
    document: { ...value, jobs },
    jobs,
  };
}

async function readDiscoveredDocument(filePath: string): Promise<DiscoveredDocument> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    return toDiscoveredDocument(parsed);
  } catch {
    return {
      document: { jobs: [] },
      jobs: [],
    };
  }
}

function buildJobId(basePrefix: string, existingIds: Set<string>): string {
  for (let seq = 1; seq <= 100000; seq++) {
    const candidate = `${basePrefix}-${seq}`;
    if (!existingIds.has(candidate)) {
      return candidate;
    }
  }

  throw new Error(`Unable to generate unique Brave extracted job id for prefix ${basePrefix}`);
}

function stripHtmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchWebsiteContent(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'job-harvester/1.0 (+https://github.com/nmaitland/job-harvester)',
      'Accept': 'text/html,application/xhtml+xml',
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const rawBody = await response.text();
  const bodyText = stripHtmlToText(rawBody);
  return bodyText.slice(0, getSearchHitsMaxPageChars());
}

function getBraveSources(jobs: DiscoveredJob[]): WebsiteSource[] {
  return jobs
    .filter(job => job.source === 'brave')
    .map(job => ({
      id: job.id,
      url: job.url,
      title: job.title,
      company: job.company,
    }));
}

export function mergeWebsiteCandidatesIntoDiscovered(
  existingJobs: DiscoveredJob[],
  candidates: ExtractedJobCandidate[],
  discoveredAt: string
): MergeResult {
  const mergedJobs = [...existingJobs];
  const existingUrls = new Set<string>();
  const existingIds = new Set<string>();

  for (const job of existingJobs) {
    existingIds.add(job.id);
    const normalized = normalizeHttpUrl(job.url);
    if (normalized !== null) {
      existingUrls.add(normalized);
    }
  }

  let appended = 0;
  let duplicateUrls = 0;
  let invalidUrls = 0;
  const day = discoveredAt.slice(0, 10);

  for (const candidate of candidates) {
    const normalizedUrl = normalizeHttpUrl(candidate.url);
    if (normalizedUrl === null) {
      invalidUrls++;
      continue;
    }

    if (existingUrls.has(normalizedUrl)) {
      duplicateUrls++;
      continue;
    }

    const company = candidate.company.trim() !== '' ? candidate.company.trim() : 'Unknown';
    const title = candidate.title.trim() !== '' ? candidate.title.trim() : 'Unknown role';
    const idPrefix = `brave-extracted-${day}-${slugify(company)}`;
    const id = buildJobId(idPrefix, existingIds);

    mergedJobs.push({
      id,
      company,
      title,
      url: normalizedUrl,
      source: 'brave-extracted',
      discoveredAt,
    });

    existingIds.add(id);
    existingUrls.add(normalizedUrl);
    appended++;
  }

  return {
    jobs: mergedJobs,
    appended,
    duplicateUrls,
    invalidUrls,
  };
}

export async function runWebsiteExtraction(runDir: string): Promise<WebsiteExtractionResult> {
  const discoveredFile = getDiscoveredJobsFile(runDir);
  const discovered = await readDiscoveredDocument(discoveredFile);
  const sources = getBraveSources(discovered.jobs);

  const fetchBatches = chunkArray(sources, getSearchHitsConcurrency());
  const fetched: WebsiteFetchResult[] = [];

  for (const [batchIndex, batch] of fetchBatches.entries()) {
    logger.info(`Fetching website batch ${batchIndex + 1}/${fetchBatches.length} (${batch.length} page(s))`);

    const batchPromises = batch.map(async (source): Promise<WebsiteFetchResult | null> => {
      try {
        const content = await fetchWebsiteContent(source.url);
        if (content === '') {
          return null;
        }
        return { source, content };
      } catch (error) {
        logger.warn(
          `Website fetch failed for ${source.url}: ${error instanceof Error ? error.message : String(error)}`
        );
        return null;
      }
    });

    const settled = await Promise.all(batchPromises);
    for (const item of settled) {
      if (item !== null) {
        fetched.push(item);
      }
    }
  }

  const extractionBatches = chunkArray(fetched, getWebsiteBatchConcurrency());
  const allCandidates: ExtractedJobCandidate[] = [];

  for (const [batchIndex, batch] of extractionBatches.entries()) {
    logger.info(`Extracting website batch ${batchIndex + 1}/${extractionBatches.length} (${batch.length} page(s))`);

    const extractionPromises: Array<Promise<ExtractionBatchResult>> = batch.map(async (item) => {
      try {
        const candidates = await extractJobCandidates(item.content, {
          type: 'webpage',
          hint: [
            `Source ID: ${item.source.id}`,
            `Source URL: ${item.source.url}`,
            `Source Title: ${item.source.title}`,
          ].join('\n'),
        });

        logger.info(`  Extracted ${candidates.length} candidate URL(s) from ${item.source.url}`);
        return {
          sourceId: item.source.id,
          candidates,
        };
      } catch (error) {
        logger.warn(
          `Website extraction failed for ${item.source.url}: ${error instanceof Error ? error.message : String(error)}`
        );
        return {
          sourceId: item.source.id,
          candidates: [],
        };
      }
    });

    const settled = await Promise.all(extractionPromises);
    for (const result of settled) {
      if (result.candidates.length > 0) {
        allCandidates.push(...result.candidates);
      }
    }
  }

  const discoveredAt = new Date().toISOString();
  const merged = mergeWebsiteCandidatesIntoDiscovered(discovered.jobs, allCandidates, discoveredAt);
  const nextDocument: Record<string, unknown> = {
    ...discovered.document,
    jobs: merged.jobs,
  };

  await fs.writeFile(discoveredFile, JSON.stringify(nextDocument, null, 2), 'utf-8');

  const result: WebsiteExtractionResult = {
    pagesProcessed: fetched.length,
    candidatesExtracted: allCandidates.length,
    appended: merged.appended,
    duplicateUrls: merged.duplicateUrls,
    invalidUrls: merged.invalidUrls,
  };

  await fs.writeFile(
    getStepLogFile(runDir),
    JSON.stringify(
      {
        timestamp: discoveredAt,
        runDir,
        discoveredFile,
        ...result,
      },
      null,
      2
    ),
    'utf-8'
  );

  return result;
}

export async function main(runDirArg?: string): Promise<void> {
  const argv = process.argv.slice(2);
  await loadEnvFileIfProvided(argv);
  const runDir = runDirArg ?? await resolveRequiredRunDirFromCli(argv);

  logger.info('Starting website extraction from Brave-discovered pages');
  const result = await runWebsiteExtraction(runDir);
  logger.success('Website extraction complete');
  logger.info(`  Pages processed: ${result.pagesProcessed}`);
  logger.info(`  Candidates extracted: ${result.candidatesExtracted}`);
  logger.info(`  Appended: ${result.appended}`);
  logger.info(`  Duplicates skipped: ${result.duplicateUrls}`);
  logger.info(`  Invalid URLs skipped: ${result.invalidUrls}`);
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    logger.error(`Website extraction failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}

