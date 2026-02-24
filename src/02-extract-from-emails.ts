import * as fs from 'fs/promises';
import * as path from 'path';
import type { DiscoveredJob } from './types';
import { slugify } from './utils/slugify';
import * as logger from './utils/logger';
import { loadEnvFileIfProvided } from './utils/env-loader';
import { requestOpenRouterChat } from './ai/openrouter-client';
import {
  type ExtractedJobCandidate,
  normalizeHttpUrl,
  parseExtractedCandidates,
} from './ai/validators';
import { resolveRequiredRunDirFromCli } from './utils/run-dir';

interface GmailEmail {
  id: string;
  subject: string;
  from: string;
  bodyText: string;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function getPrimaryGmailIndexFile(runDir: string): string {
  return path.join(runDir, 'emails', 'gmail', 'index.json');
}

function getFallbackGmailIndexFile(runDir: string): string {
  return path.join(runDir, 'emails', 'index.json');
}

function getDiscoveredJobsFile(runDir: string): string {
  return path.join(runDir, 'discovered-jobs.json');
}

function getStepLogFile(runDir: string): string {
  return path.join(runDir, '02-extract-from-emails-log.json');
}

async function chooseGmailIndexFile(runDir: string): Promise<string> {
  const primary = getPrimaryGmailIndexFile(runDir);
  try {
    await fs.access(primary);
    return primary;
  } catch {
    const fallback = getFallbackGmailIndexFile(runDir);
    await fs.access(fallback);
    return fallback;
  }
}

async function tryReadBodyFromFile(filePath: string, runDir: string): Promise<string> {
  const attempts = [
    filePath,
    path.join(runDir, filePath),
    path.join(runDir, 'emails', filePath),
  ];

  for (const attemptPath of attempts) {
    try {
      const content = await fs.readFile(attemptPath, 'utf-8');
      if (content.trim() !== '') {
        return content;
      }
    } catch {
      // Try next path.
    }
  }

  return '';
}

function parseModernGmailIndex(value: unknown): GmailEmail[] {
  if (!isRecord(value)) {
    return [];
  }

  const rawEmails = value.emails;
  if (!Array.isArray(rawEmails)) {
    return [];
  }

  const output: GmailEmail[] = [];
  for (const rawEntry of rawEmails) {
    if (!isRecord(rawEntry)) {
      continue;
    }

    const id = asString(rawEntry.id);
    const subject = asString(rawEntry.subject);
    const from = asString(rawEntry.from);
    const bodyText = asString(rawEntry.bodyText);
    if (id === '' || bodyText === '') {
      continue;
    }

    output.push({ id, subject, from, bodyText });
  }

  return output;
}

async function parseFallbackGmailIndex(value: unknown, runDir: string): Promise<GmailEmail[]> {
  if (!Array.isArray(value)) {
    return [];
  }

  const output: GmailEmail[] = [];
  for (const rawEntry of value) {
    if (!isRecord(rawEntry)) {
      continue;
    }

    const id = asString(rawEntry.id);
    if (id === '') {
      continue;
    }

    let bodyText = asString(rawEntry.bodyText);
    if (bodyText === '') {
      const filePath = asString(rawEntry.filePath);
      if (filePath !== '') {
        bodyText = await tryReadBodyFromFile(filePath, runDir);
      }
    }

    if (bodyText === '') {
      continue;
    }

    output.push({
      id,
      subject: asString(rawEntry.subject),
      from: asString(rawEntry.from),
      bodyText,
    });
  }

  return output;
}

export async function loadGmailEmails(runDir: string): Promise<{ emails: GmailEmail[]; indexFile: string }> {
  const indexFile = await chooseGmailIndexFile(runDir);
  const raw = await fs.readFile(indexFile, 'utf-8');
  const parsed = JSON.parse(raw) as unknown;

  const modern = parseModernGmailIndex(parsed);
  if (modern.length > 0) {
    return { emails: modern, indexFile };
  }

  const fallback = await parseFallbackGmailIndex(parsed, runDir);
  return { emails: fallback, indexFile };
}

function buildExtractionPrompt(email: GmailEmail): string {
  const maxBodyChars = 12000;
  const body = email.bodyText.slice(0, maxBodyChars);

  return [
    'Extract job links from this email.',
    'Return JSON only, no markdown, with shape:',
    '{"candidates":[{"company":"...","title":"...","url":"https://..."}]}',
    'Rules:',
    '- Include only concrete job posting URLs, not unsubscribe or tracking links',
    '- Exclude generic company links without a specific role',
    '- If title is unclear, return "Unknown role"',
    '',
    `Email ID: ${email.id}`,
    `From: ${email.from}`,
    `Subject: ${email.subject}`,
    '',
    body,
  ].join('\n');
}

async function extractCandidatesFromEmail(email: GmailEmail): Promise<ExtractedJobCandidate[]> {
  const content = await requestOpenRouterChat([
    {
      role: 'system',
      content: 'You extract structured job posting links from email text and return strict JSON only.',
    },
    {
      role: 'user',
      content: buildExtractionPrompt(email),
    },
  ]);

  return parseExtractedCandidates(content);
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

    if (source !== 'gmail' && source !== 'linkedin' && source !== 'brave') {
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

  throw new Error(`Unable to generate unique Gmail job id for prefix ${basePrefix}`);
}

export function mergeCandidatesIntoDiscovered(
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
    const idPrefix = `gmail-${day}-${slugify(company)}`;
    const id = buildJobId(idPrefix, existingIds);

    mergedJobs.push({
      id,
      company,
      title,
      url: normalizedUrl,
      source: 'gmail',
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

interface Step2Result {
  indexFile: string;
  emailsProcessed: number;
  candidatesExtracted: number;
  appended: number;
  duplicateUrls: number;
  invalidUrls: number;
}

interface ExtractionBatchResult {
  emailId: string;
  candidates: ExtractedJobCandidate[];
}

function getStep2BatchConcurrency(): number {
  const raw = process.env.OPENROUTER_STEP2_BATCH_CONCURRENCY;
  if (raw === undefined || raw.trim() === '') {
    return 3;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 3;
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

export async function runStep2(runDir: string): Promise<Step2Result> {
  const { emails, indexFile } = await loadGmailEmails(runDir);
  const discoveredFile = getDiscoveredJobsFile(runDir);
  const batchConcurrency = getStep2BatchConcurrency();

  const allCandidates: ExtractedJobCandidate[] = [];
  const batches = chunkArray(emails, batchConcurrency);

  for (const [batchIndex, batch] of batches.entries()) {
    logger.info(`Processing email batch ${batchIndex + 1}/${batches.length} (${batch.length} email(s))`);

    const batchPromises: Array<Promise<ExtractionBatchResult>> = batch.map(async (email, itemIndex) => {
      const absoluteIndex = batchIndex * batchConcurrency + itemIndex + 1;
      logger.info(
        `Processing email ${absoluteIndex}/${emails.length}: id=${email.id}, subject=${email.subject}, from=${email.from}`
      );

      try {
        const extracted = await extractCandidatesFromEmail(email);
        logger.info(`  Extracted ${extracted.length} candidate URL(s) from email ${email.id}`);
        return { emailId: email.id, candidates: extracted };
      } catch (error) {
        logger.warn(
          `AI extraction failed for email ${email.id}: ${error instanceof Error ? error.message : String(error)}`
        );
        return { emailId: email.id, candidates: [] };
      }
    });

    const settled = await Promise.all(batchPromises);
    for (const result of settled) {
      if (result.candidates.length > 0) {
        allCandidates.push(...result.candidates);
      }
    }
  }

  const discovered = await readDiscoveredDocument(discoveredFile);
  const discoveredAt = new Date().toISOString();
  const merged = mergeCandidatesIntoDiscovered(discovered.jobs, allCandidates, discoveredAt);

  const nextDocument: Record<string, unknown> = {
    ...discovered.document,
    jobs: merged.jobs,
  };

  await fs.writeFile(discoveredFile, JSON.stringify(nextDocument, null, 2), 'utf-8');

  const result: Step2Result = {
    indexFile,
    emailsProcessed: emails.length,
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

  logger.info('Starting Phase 2: extract jobs from Gmail index');
  const result = await runStep2(runDir);
  logger.success('Phase 2 complete');
  logger.info(`  Gmail index: ${result.indexFile}`);
  logger.info(`  Emails processed: ${result.emailsProcessed}`);
  logger.info(`  Candidates extracted: ${result.candidatesExtracted}`);
  logger.info(`  Appended: ${result.appended}`);
  logger.info(`  Duplicates skipped: ${result.duplicateUrls}`);
  logger.info(`  Invalid URLs skipped: ${result.invalidUrls}`);
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    logger.error(`Phase 2 failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
