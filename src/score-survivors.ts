import * as fs from 'fs/promises';
import * as path from 'path';
import type { JobSpec } from './types';
import * as logger from './utils/logger';
import { slugify } from './utils/slugify';
import { loadEnvFileIfProvided } from './utils/env-loader';
import { MANAGEMENT_DATA_DIR } from './config';
import { requestOpenRouterChat } from './ai/openrouter-client';
import {
  parseScorePayload,
  scoreToVerdict,
} from './ai/validators';
import { resolveRequiredRunDirFromCli } from './utils/run-dir';

interface ScoreVerdictFile {
  jobId: string;
  company: string;
  title: string;
  url: string;
  score: number;
  reasoning: string;
  verdict: 'PASS' | 'REVIEW' | 'REJECT';
  match_reasons?: string[];
  concerns?: string[];
  red_flags?: string[];
  summary?: string;
  scoredAt: string;
}

interface ScoringResult {
  total: number;
  pass: number;
  review: number;
  reject: number;
  files: string[];
}

interface ScoredBatchItem {
  survivor: JobSpec;
  verdict: ScoreVerdictFile;
}

function resolveManagementDataDir(): string {
  const envDir = process.env.JOB_HARVESTER_MANAGEMENT_DATA_DIR;
  if (envDir !== undefined && envDir !== '') {
    return envDir;
  }

  return MANAGEMENT_DATA_DIR;
}

function getSurvivorsFile(runDir: string): string {
  return path.join(runDir, 'pre-filter-survivors.json');
}

function getScoresDir(runDir: string): string {
  return path.join(runDir, 'job-scores');
}

function getLogFile(runDir: string): string {
  return path.join(runDir, 'score-survivors-log.json');
}

function getCvKeywordsFile(): string {
  return path.join(resolveManagementDataDir(), 'jobs', 'cv-keywords.md');
}

function getScoringBatchConcurrency(): number {
  const raw = process.env.OPENROUTER_SCORING_BATCH_CONCURRENCY;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

async function loadSurvivors(runDir: string): Promise<JobSpec[]> {
  const content = await fs.readFile(getSurvivorsFile(runDir), 'utf-8');
  const parsed = JSON.parse(content) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('Invalid pre-filter-survivors.json: expected JobSpec[]');
  }

  const survivors: JobSpec[] = [];
  for (const item of parsed) {
    if (!isRecord(item)) {
      continue;
    }

    const id = asString(item.id);
    const company = asString(item.company);
    const title = asString(item.title);
    const url = asString(item.url);
    const source = asString(item.source);
    const discoveredAt = asString(item.discoveredAt);
    const specText = asString(item.specText);
    const fetchedAt = asString(item.fetchedAt);
    const fetchStatus = item.fetchStatus === 'failed' ? 'failed' : 'success';
    const fetchError = asString(item.fetchError);

    if (id === '' || company === '' || title === '' || url === '') {
      continue;
    }

    survivors.push({
      id,
      company,
      title,
      url,
      source,
      discoveredAt,
      specText,
      fetchStatus,
      fetchError: fetchError === '' ? undefined : fetchError,
      fetchedAt,
    });
  }

  return survivors;
}

async function loadCvKeywords(): Promise<string> {
  const keywordsFile = getCvKeywordsFile();
  try {
    return await fs.readFile(keywordsFile, 'utf-8');
  } catch {
    throw new Error(`Missing required CV keywords file: ${keywordsFile}`);
  }
}

function buildScoringPrompt(job: JobSpec, cvKeywords: string): string {
  const maxSpecChars = 20000;
  const spec = job.specText.slice(0, maxSpecChars);

  return [
    'Score this job against the CV profile and return JSON only.',
    'Required fields: jobId, company, title, url, score, reasoning.',
    'Optional fields: verdict, match_reasons, concerns, red_flags, summary.',
    'Score rubric:',
    '- 9-10 excellent fit',
    '- 7-8 good fit',
    '- 5-6 borderline',
    '- 3-4 poor fit',
    '- 0-2 reject',
    'Verdict thresholds: PASS 7-10, REVIEW 4-6, REJECT 0-3.',
    'Assess title and seniority and stack overlap and language requirements and coding ratio and industry fit.',
    'Negative signals: explicit German B2+, fully German posting, >50% coding focus, primary tech Rust/Go/Scala/SAP.',
    '',
    `Job ID: ${job.id}`,
    `Company: ${job.company}`,
    `Title: ${job.title}`,
    `URL: ${job.url}`,
    '',
    'CV keywords:',
    cvKeywords,
    '',
    'Job spec text:',
    spec,
  ].join('\n');
}

async function scoreOneJob(job: JobSpec, cvKeywords: string): Promise<ScoreVerdictFile> {
  const response = await requestOpenRouterChat([
    {
      role: 'system',
      content: 'You are a strict evaluator of job fit. Return valid JSON only.',
    },
    {
      role: 'user',
      content: buildScoringPrompt(job, cvKeywords),
    },
  ]);

  const parsed = parseScorePayload(response);
  const score = parsed.score;
  const verdict = parsed.verdict ?? scoreToVerdict(score);

  const output: ScoreVerdictFile = {
    jobId: job.id,
    company: job.company,
    title: job.title,
    url: job.url,
    score,
    reasoning: parsed.reasoning,
    verdict,
    scoredAt: new Date().toISOString(),
  };

  if (parsed.matchReasons.length > 0) {
    output.match_reasons = parsed.matchReasons;
  }
  if (parsed.concerns.length > 0) {
    output.concerns = parsed.concerns;
  }
  if (parsed.redFlags.length > 0) {
    output.red_flags = parsed.redFlags;
  }
  if (parsed.summary !== '') {
    output.summary = parsed.summary;
  }

  return output;
}

function buildScoreFilename(job: JobSpec): string {
  const today = new Date().toISOString().split('T')[0] ?? 'unknown-date';
  const companySlug = slugify(job.company);
  const jobSlug = slugify(job.id);
  return `${today}-${companySlug}-${jobSlug}.json`;
}

async function writeVerdict(scoresDir: string, job: JobSpec, verdict: ScoreVerdictFile): Promise<string> {
  const filename = buildScoreFilename(job);
  const filePath = path.join(scoresDir, filename);
  await fs.writeFile(filePath, JSON.stringify(verdict, null, 2), 'utf-8');
  return filePath;
}

function buildFallbackVerdict(job: JobSpec, reason: string): ScoreVerdictFile {
  return {
    jobId: job.id,
    company: job.company,
    title: job.title,
    url: job.url,
    score: 3,
    reasoning: `Fallback verdict due to scoring error: ${reason}`,
    verdict: 'REJECT',
    concerns: ['AI scoring failed, manual verification recommended'],
    scoredAt: new Date().toISOString(),
  };
}

export async function runScoring(runDir: string): Promise<ScoringResult> {
  const survivors = await loadSurvivors(runDir);
  const cvKeywords = await loadCvKeywords();
  const scoresDir = getScoresDir(runDir);
  const batchConcurrency = getScoringBatchConcurrency();
  await fs.mkdir(scoresDir, { recursive: true });

  const files: string[] = [];
  let pass = 0;
  let review = 0;
  let reject = 0;

  const batches = chunkArray(survivors, batchConcurrency);
  for (const [batchIndex, batch] of batches.entries()) {
    logger.info(`Scoring batch ${batchIndex + 1}/${batches.length} (${batch.length} survivor(s))`);

    const verdictPromises = batch.map(async (survivor, itemIndex): Promise<ScoredBatchItem> => {
      const absoluteIndex = batchIndex * batchConcurrency + itemIndex + 1;
      logger.info(`Scoring survivor ${absoluteIndex}/${survivors.length}: ${survivor.id} (${survivor.company})`);

      try {
        const verdict = await scoreOneJob(survivor, cvKeywords);
        return { survivor, verdict };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`Scoring failed for ${survivor.id}: ${message}`);
        return {
          survivor,
          verdict: buildFallbackVerdict(survivor, message),
        };
      }
    });

    const settled = await Promise.all(verdictPromises);

    for (const item of settled) {
      if (item.verdict.verdict === 'PASS') {
        pass++;
      } else if (item.verdict.verdict === 'REVIEW') {
        review++;
      } else {
        reject++;
      }

      const writtenFile = await writeVerdict(scoresDir, item.survivor, item.verdict);
      files.push(writtenFile);
    }
  }

  const result: ScoringResult = {
    total: survivors.length,
    pass,
    review,
    reject,
    files,
  };

  await fs.writeFile(
    getLogFile(runDir),
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        runDir,
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

  logger.info('Starting scoring: score pre-filter survivors');
  const result = await runScoring(runDir);
  logger.success('Scoring complete');
  logger.info(`  Survivors scored: ${result.total}`);
  logger.info(`  PASS: ${result.pass}`);
  logger.info(`  REVIEW: ${result.review}`);
  logger.info(`  REJECT: ${result.reject}`);
  logger.info(`  Verdict files written: ${result.files.length}`);
}

export const runStep4 = runScoring;

if (require.main === module) {
  void main().catch((error: unknown) => {
    logger.error(`Phase 5 failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
