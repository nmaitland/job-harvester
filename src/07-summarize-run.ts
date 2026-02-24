import * as fs from 'fs/promises';
import * as path from 'path';
import type { CompiledJob, DiscoveryOutput, FetchOutput, FilterVerdict, JobSpec, PDFOutput } from './types';
import * as logger from './utils/logger';
import { loadEnvFileIfProvided } from './utils/env-loader';
import { requestOpenRouterChat } from './ai/openrouter-client';

interface CliArgs {
  runDir: string | undefined;
}

interface RunFacts {
  runDir: string;
  timestamp: string;
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
  reviewJobsFile: string;
  metadataFile: string;
}

function parseArgs(args: string[]): CliArgs {
  const parsed: CliArgs = { runDir: undefined };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--run-dir' && i + 1 < args.length) {
      parsed.runDir = args[i + 1];
      i++;
    }
  }
  return parsed;
}

function resolveRunDir(args: CliArgs): string {
  const runDir = args.runDir ?? process.env.JOB_HARVESTER_WORK_DIR;
  if (runDir === undefined || runDir === '') {
    throw new Error('--run-dir is required (or set JOB_HARVESTER_WORK_DIR)');
  }
  return runDir;
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

function buildDeterministicReviewList(reviewable: CompiledJob[]): string {
  const lines: string[] = ['Review-worthy jobs (PASS + REVIEW):', ''];
  for (const job of reviewable) {
    lines.push(`S${job.score} | ${job.company} | ${job.title} | ${job.url}`);
  }
  if (reviewable.length === 0) {
    lines.push('No PASS/REVIEW jobs were found in compile-results.json.');
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
  const deterministicReviewText = buildDeterministicReviewList(reviewable);
  const reviewLines = reviewable.map(job => `S${job.score} | ${job.company} | ${job.title} | ${job.url}`);
  const ai = await polishWithAi(facts, reviewLines);

  const summaryLogText = ai?.summary ?? deterministicSummary;
  const reviewJobsText = [
    ai?.reviewIntro ?? 'Detailed review list for jobs worth reviewing.',
    '',
    deterministicReviewText,
  ].join('\n');

  const summaryLogFile = path.join(runSummaryDir, 'summary-log.txt');
  const reviewJobsFile = path.join(runSummaryDir, 'review-jobs.txt');
  const metadataFile = path.join(runSummaryDir, 'summary-meta.json');

  await fs.writeFile(summaryLogFile, `${summaryLogText.trim()}\n`, 'utf-8');
  await fs.writeFile(reviewJobsFile, `${reviewJobsText.trim()}\n`, 'utf-8');
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
    reviewJobsFile,
    metadataFile,
  };
}

export async function main(): Promise<void> {
  await loadEnvFileIfProvided(process.argv.slice(2));
  const args = parseArgs(process.argv.slice(2));
  const runDir = resolveRunDir(args);
  logger.info('Starting run summary generation...');
  const result = await runSummarize(runDir);
  logger.success('Run summary generation complete');
  logger.info(`  Output dir: ${result.runSummaryDir}`);
  logger.info(`  Summary log: ${result.summaryLogFile}`);
  logger.info(`  Review list: ${result.reviewJobsFile}`);
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    logger.error(`Run summary generation failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}

