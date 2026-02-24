import * as fs from 'fs/promises';
import * as path from 'path';
import type { CompiledJob, DiscoveryOutput, FetchOutput, FilterVerdict, JobSpec, PDFOutput } from './types';
import * as logger from './utils/logger';
import { loadEnvFileIfProvided } from './utils/env-loader';
import { requestOpenRouterChat } from './ai/openrouter-client';
import { resolveRequiredRunDirFromCli } from './utils/run-dir';

interface RunFacts {
  runDir: string;
  timestamp: string;
  runDate: string;
  discovered: number;
  fetchedSuccess: number;
  fetchedFailed: number;
  survivors: number;
  prefilterRejected: number;
  pass: number;
  review: number;
  aiRejected: number;
  pdfGenerated: number;
}

interface SummaryResult {
  runSummaryDir: string;
  summaryLogFile: string;
  reviewJobsMdFile: string;
  reviewJobsCsvFile: string;
  metadataFile: string;
}

function getRunSummaryDir(runDir: string): string {
  return path.join(runDir, 'run-summary');
}

async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

function formatDateTimeForOutput(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hour = String(date.getUTCHours()).padStart(2, '0');
  const minute = String(date.getUTCMinutes()).padStart(2, '0');
  const second = String(date.getUTCSeconds()).padStart(2, '0');
  return `${year}/${month}/${day} ${hour}:${minute}:${second}`;
}

function parseRunDate(runDir: string, fallbackIsoTimestamp: string): string {
  const base = path.basename(runDir);
  const match = /^run-(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})$/.exec(base);
  if (match !== null) {
    const [, year, month, day, hour, minute, second] = match;
    return `${year}/${month}/${day} ${hour}:${minute}:${second}`;
  }

  const fallbackDate = new Date(fallbackIsoTimestamp);
  if (!Number.isNaN(fallbackDate.getTime())) {
    return formatDateTimeForOutput(fallbackDate);
  }

  return fallbackIsoTimestamp;
}

function sanitizeTitle(title: string): string {
  const withoutCarriageReturns = title.replace(/\r/g, '').trim();
  const firstLine = withoutCarriageReturns.split('\n')[0]?.trim() ?? '';
  let cleaned = firstLine.replace(/\s+/g, ' ').replace(/\s+with verification$/i, '').trim();

  if (cleaned.length > 0 && cleaned.length % 2 === 0) {
    const midpoint = cleaned.length / 2;
    const firstHalf = cleaned.slice(0, midpoint);
    const secondHalf = cleaned.slice(midpoint);
    if (firstHalf === secondHalf) {
      cleaned = firstHalf.trim();
    }
  }

  return cleaned;
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/g, '\\|');
}

function escapeCsvCell(value: string): string {
  const escaped = value.replace(/"/g, '""');
  if (/[",\n\r]/.test(escaped)) {
    return `"${escaped}"`;
  }
  return escaped;
}

interface ReviewRow {
  score: string;
  company: string;
  title: string;
  url: string;
}

function buildReviewRows(reviewable: CompiledJob[]): ReviewRow[] {
  return reviewable.map(job => ({
    score: `S${job.score}`,
    company: job.company.trim(),
    title: sanitizeTitle(job.title),
    url: job.url.trim(),
  }));
}

async function collectFacts(runDir: string): Promise<{ facts: RunFacts; reviewable: CompiledJob[] }> {
  const now = new Date().toISOString();
  const discovered = await readJsonIfExists<DiscoveryOutput>(path.join(runDir, 'discovered-jobs.json'));
  const fetched = await readJsonIfExists<FetchOutput>(path.join(runDir, 'fetched-specs.json'));
  const survivors = await readJsonIfExists<JobSpec[]>(path.join(runDir, 'pre-filter-survivors.json'));
  const prefilterRejections = await readJsonIfExists<FilterVerdict[]>(path.join(runDir, 'pre-filter-rejections.json'));
  const compiled = await readJsonIfExists<{ jobs: CompiledJob[] }>(path.join(runDir, 'compile-results.json'));
  const pdfOutput = await readJsonIfExists<PDFOutput>(path.join(runDir, 'pdfs', 'pdf-results.json'));

  const compiledJobs = Array.isArray(compiled?.jobs) ? compiled.jobs : [];
  const pass = compiledJobs.filter(job => job.score >= 7).length;
  const review = compiledJobs.filter(job => job.score >= 4 && job.score < 7).length;
  const reviewable = compiledJobs
    .filter(job => job.score >= 4)
    .sort((a, b) => b.score - a.score || a.company.localeCompare(b.company));

  return {
    facts: {
      runDir,
      timestamp: now,
      runDate: parseRunDate(runDir, now),
      discovered: discovered?.stats.total ?? discovered?.jobs.length ?? 0,
      fetchedSuccess: fetched?.stats.success ?? 0,
      fetchedFailed: fetched?.stats.failed ?? 0,
      survivors: Array.isArray(survivors) ? survivors.length : 0,
      prefilterRejected: Array.isArray(prefilterRejections) ? prefilterRejections.length : 0,
      pass,
      review,
      aiRejected: compiledJobs.filter(job => job.score < 4).length,
      pdfGenerated: pdfOutput?.stats.success ?? 0,
    },
    reviewable,
  };
}

function buildDeterministicSummary(facts: RunFacts): string {
  return [
    `Run summary (${facts.timestamp})`,
    `Run directory: ${facts.runDir}`,
    '',
    `Jobs discovered: ${facts.discovered}`,
    `Specs fetched: ${facts.fetchedSuccess} success, ${facts.fetchedFailed} failed`,
    `Pre-filter: ${facts.survivors} survivors, ${facts.prefilterRejected} rejected`,
    `AI outcomes: ${facts.pass} PASS, ${facts.review} REVIEW, ${facts.aiRejected} REJECT`,
    `PDFs generated: ${facts.pdfGenerated}`,
  ].join('\n');
}

function buildReviewMarkdown(runDate: string, reviewIntro: string, rows: ReviewRow[]): string {
  const lines: string[] = [
    `# Job Review List — ${runDate}`,
    '',
    reviewIntro,
    '',
    '| Score | Company | Title | URL |',
    '| --- | --- | --- | --- |',
  ];

  if (rows.length === 0) {
    lines.push('| - | - | No PASS/REVIEW jobs were found in compile-results.json. | - |');
  } else {
    for (const row of rows) {
      lines.push(
        `| ${escapeMarkdownCell(row.score)} | ${escapeMarkdownCell(row.company)} | ${escapeMarkdownCell(row.title)} | ${escapeMarkdownCell(row.url)} |`
      );
    }
  }

  return lines.join('\n');
}

function buildReviewCsv(runDate: string, rows: ReviewRow[]): string {
  const lines = ['RunDate,Score,Company,Title,URL'];
  for (const row of rows) {
    lines.push(
      [runDate, row.score, row.company, row.title, row.url]
        .map(cell => escapeCsvCell(cell))
        .join(',')
    );
  }
  return lines.join('\n');
}

function canUseOpenRouter(): boolean {
  const key = process.env.OPENROUTER_API_KEY ?? '';
  const model = process.env.OPENROUTER_MODEL ?? '';
  return key.trim() !== '' && model.trim() !== '';
}

async function polishWithAi(facts: RunFacts, reviewLines: string[]): Promise<{ summary: string; reviewIntro: string } | null> {
  if (!canUseOpenRouter()) {
    return null;
  }

  try {
    const prompt = [
      'Return JSON only with keys: summary, review_intro.',
      'Use concise professional tone. Keep summary to 4-7 lines.',
      'Facts:',
      JSON.stringify(facts),
      'Top review lines:',
      reviewLines.slice(0, 25).join('\n'),
    ].join('\n');

    const response = await requestOpenRouterChat([
      { role: 'system', content: 'You produce concise human-readable run summaries. Return valid JSON only.' },
      { role: 'user', content: prompt },
    ]);

    const parsed = JSON.parse(response) as { summary?: unknown; review_intro?: unknown };
    const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
    const reviewIntro = typeof parsed.review_intro === 'string' ? parsed.review_intro.trim() : '';
    if (summary === '' || reviewIntro === '') {
      return null;
    }
    return { summary, reviewIntro };
  } catch {
    return null;
  }
}

export async function runSummarize(runDir: string): Promise<SummaryResult> {
  const runSummaryDir = getRunSummaryDir(runDir);
  await fs.mkdir(runSummaryDir, { recursive: true });

  const { facts, reviewable } = await collectFacts(runDir);
  const deterministicSummary = buildDeterministicSummary(facts);
  const reviewRows = buildReviewRows(reviewable);
  const reviewLines = reviewRows.map(row => `${row.score} | ${row.company} | ${row.title} | ${row.url}`);
  const ai = await polishWithAi(facts, reviewLines);

  const summaryLogText = ai?.summary ?? deterministicSummary;
  const reviewIntro = ai?.reviewIntro ?? 'Detailed review list for jobs worth reviewing.';
  const reviewJobsMdText = buildReviewMarkdown(facts.runDate, reviewIntro, reviewRows);
  const reviewJobsCsvText = buildReviewCsv(facts.runDate, reviewRows);

  const summaryLogFile = path.join(runSummaryDir, 'summary-log.txt');
  const reviewJobsMdFile = path.join(runSummaryDir, 'review-jobs.md');
  const reviewJobsCsvFile = path.join(runSummaryDir, 'review-jobs.csv');
  const metadataFile = path.join(runSummaryDir, 'summary-meta.json');

  await fs.writeFile(summaryLogFile, `${summaryLogText.trim()}\n`, 'utf-8');
  await fs.writeFile(reviewJobsMdFile, `${reviewJobsMdText.trim()}\n`, 'utf-8');
  await fs.writeFile(reviewJobsCsvFile, `${reviewJobsCsvText.trim()}\n`, 'utf-8');
  await fs.writeFile(
    metadataFile,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        runDir,
        aiUsed: ai !== null,
        facts,
        reviewCount: reviewable.length,
      },
      null,
      2
    ),
    'utf-8'
  );

  return {
    runSummaryDir,
    summaryLogFile,
    reviewJobsMdFile,
    reviewJobsCsvFile,
    metadataFile,
  };
}

export async function main(runDirArg?: string): Promise<void> {
  const argv = process.argv.slice(2);
  await loadEnvFileIfProvided(argv);
  const runDir = runDirArg ?? await resolveRequiredRunDirFromCli(argv);
  logger.info('Starting run summary generation...');
  const result = await runSummarize(runDir);
  logger.success('Run summary generation complete');
  logger.info(`  Output dir: ${result.runSummaryDir}`);
  logger.info(`  Summary log: ${result.summaryLogFile}`);
  logger.info(`  Review list (Markdown): ${result.reviewJobsMdFile}`);
  logger.info(`  Review list (CSV): ${result.reviewJobsCsvFile}`);
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    logger.error(`Run summary generation failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
