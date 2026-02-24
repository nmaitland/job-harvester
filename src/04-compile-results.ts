/**
 * 04-compile-results.ts — Compile Results
 * 
 * Merges AI verdict files with pre-filter survivors to produce the final PASS/REVIEW/REJECT split.
 * Pure logic — no external API calls.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { FilterVerdict, JobScore, CompiledJob, CompileOutput, RejectionReason, JobSpec } from './types';
import { slugify } from './utils/slugify';
import * as logger from './utils/logger';
import { loadEnvFileIfProvided } from './utils/env-loader';

// Score thresholds
const SCORE_PASS_THRESHOLD = 7;
const SCORE_REVIEW_THRESHOLD = 4;

type JobStatus = 'PASS' | 'REVIEW' | 'REJECT';

interface RejectionEntry {
  jobId: string;
  company: string;
  title: string;
  url: string;
  reason: RejectionReason | 'ai_reject';
  rejectedAt: string;
}

function resolveDataDir(): string {
  const envDir = process.env.JOB_HARVESTER_WORK_DIR;
  if (envDir === undefined || envDir === '') {
    throw new Error('JOB_HARVESTER_WORK_DIR is required. Set it in environment or via --env-file.');
  }
  return envDir;
}

function getPreFilterSurvivorsFile(): string {
  return path.join(resolveDataDir(), 'pre-filter-survivors.json');
}

function getPreFilterRejectionsFile(): string {
  return path.join(resolveDataDir(), 'pre-filter-rejections.json');
}

function getScoresDir(): string {
  return path.join(resolveDataDir(), 'job-scores');
}

function getCompiledResultsFile(): string {
  return path.join(resolveDataDir(), 'compile-results.json');
}

function getAllRejectionsFile(): string {
  return path.join(resolveDataDir(), 'all-rejections.json');
}

/**
 * Find AI verdict file for a job
 * First tries exact modern/legacy matches, then falls back to slug search.
 */
export async function findVerdictFile(jobId: string, company: string, scoresDir: string): Promise<string | null> {
  let jsonFiles: string[] = [];
  try {
    const files = await fs.readdir(scoresDir);
    jsonFiles = files.filter(file => file.endsWith('.json'));
  } catch {
    return null;
  }

  const companySlug = slugify(company);
  const jobSlug = slugify(jobId);
  const today = new Date().toISOString().split('T')[0];

  // Current format from AI step4: {date}-{companySlug}-{jobSlug}.json
  const modernSuffix = `-${companySlug}-${jobSlug}.json`;
  const modernMatch = jsonFiles.find(file => file.endsWith(modernSuffix));
  if (modernMatch !== undefined) {
    return path.join(scoresDir, modernMatch);
  }

  // Legacy format: {date}-{companySlug}.json
  const legacyExact = `${today}-${companySlug}.json`;
  if (jsonFiles.includes(legacyExact)) {
    return path.join(scoresDir, legacyExact);
  }

  // Fallback: any score file containing the company slug
  const companyMatches = jsonFiles.filter(file => file.includes(companySlug));
  if (companyMatches.length >= 1 && companyMatches[0] !== undefined) {
    const selected = companyMatches[0];
    if (companyMatches.length > 1) {
      logger.warn(`Multiple verdict files found for ${company}, using first: ${selected}`);
    } else {
      logger.info(`Found verdict file via slug fallback: ${selected}`);
    }
    return path.join(scoresDir, selected);
  }

  return null;
}

/**
 * Apply score thresholds to determine status
 */
export function applyThreshold(score: number): JobStatus {
  if (score >= SCORE_PASS_THRESHOLD) {
    return 'PASS';
  } else if (score >= SCORE_REVIEW_THRESHOLD) {
    return 'REVIEW';
  } else {
    return 'REJECT';
  }
}

/**
 * Read and parse a job score file
 */
export async function readJobScore(filePath: string): Promise<JobScore | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content) as JobScore;
  } catch (error) {
    logger.error(`Failed to read job score from ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Compile results from all sources
 */
export async function compileResults(): Promise<CompileOutput> {
  const timestamp = new Date().toISOString();
  const preFilterSurvivorsFile = getPreFilterSurvivorsFile();
  const preFilterRejectionsFile = getPreFilterRejectionsFile();
  const scoresDir = getScoresDir();
  const allRejectionsFile = getAllRejectionsFile();
  
  // Read pre-filter survivors
  const survivorsContent = await fs.readFile(preFilterSurvivorsFile, 'utf-8');
  const survivors = JSON.parse(survivorsContent) as JobSpec[];
  if (!Array.isArray(survivors)) {
    throw new Error('Invalid pre-filter survivors input: expected JobSpec[]');
  }
  
  // Read pre-filter rejections
  const preFilterRejectionsContent = await fs.readFile(preFilterRejectionsFile, 'utf-8');
  const preFilterRejections = JSON.parse(preFilterRejectionsContent) as FilterVerdict[];
  if (!Array.isArray(preFilterRejections)) {
    throw new Error('Invalid pre-filter rejections input: expected FilterVerdict[]');
  }
  
  const passed: CompiledJob[] = [];
  const review: CompiledJob[] = [];
  const aiRejections: RejectionEntry[] = [];
  
  // Process each survivor
  for (const survivor of survivors) {
    const verdictFile = await findVerdictFile(survivor.id, survivor.company, scoresDir);
    
    if (verdictFile === null) {
      // Missing verdict → REVIEW (conservative)
      logger.warn(`Missing AI verdict for ${survivor.company} - marking as REVIEW`);
        review.push({
        jobId: survivor.id,
        company: survivor.company,
        title: survivor.title,
        url: survivor.url,
        specText: '', // Will be filled from spec file
        score: 0,
        reasoning: 'Missing AI verdict - manual review required',
        passedPreFilter: true,
        rejectionReason: undefined,
        status: 'scored',
        compiledAt: timestamp,
      });
      continue;
    }
    
    const jobScore = await readJobScore(verdictFile);
    
    if (!jobScore) {
      // Failed to read score → REVIEW
      logger.warn(`Failed to read AI verdict for ${survivor.company} - marking as REVIEW`);
      review.push({
        jobId: survivor.id,
        company: survivor.company,
        title: survivor.title,
        url: survivor.url,
        specText: '',
        score: 0,
        reasoning: 'Failed to read AI verdict - manual review required',
        passedPreFilter: true,
        rejectionReason: undefined,
        status: 'scored',
        compiledAt: timestamp,
      });
      continue;
    }
    
    const status = applyThreshold(jobScore.score);
    
    const compiledJob: CompiledJob = {
      jobId: survivor.id,
      company: survivor.company,
      title: survivor.title,
      url: survivor.url,
      specText: survivor.specText,
      score: jobScore.score,
      reasoning: jobScore.reasoning,
      rejectionReason: undefined,
      passedPreFilter: true,
      status: 'scored',
      compiledAt: timestamp,
    };
    
    if (status === 'PASS') {
      passed.push(compiledJob);
    } else if (status === 'REVIEW') {
      review.push(compiledJob);
    } else {
      // REJECT
        aiRejections.push({
        jobId: survivor.id,
        company: survivor.company,
        title: survivor.title,
        url: survivor.url,
        reason: 'ai_reject',
        rejectedAt: timestamp,
      });
    }
  }
  
  // Merge rejections
  const allRejections: RejectionEntry[] = [
    ...preFilterRejections.map(r => ({
      jobId: r.jobId,
      company: r.company,
      title: r.title,
      url: r.url,
      reason: r.rejectionReason!,
      rejectedAt: r.checkedAt,
    })),
    ...aiRejections,
  ];
  
  // Write all-rejections.json
  await fs.writeFile(
    allRejectionsFile,
    JSON.stringify(allRejections, null, 2),
    'utf-8'
  );
  
  const output: CompileOutput = {
    jobs: [...passed, ...review],
    timestamp,
    stats: {
      total: survivors.length,
      scored: survivors.length,
      rejectedPreFilter: preFilterRejections.length,
    },
  };
  
  return output;
}

/**
 * Main entry point
 */
export async function main(): Promise<void> {
  await loadEnvFileIfProvided(process.argv.slice(2));
  logger.info('Starting compile results...');
  const compiledResultsFile = getCompiledResultsFile();
  
  try {
    const result = await compileResults();
    
    // Write compile-results.json
    await fs.writeFile(
      compiledResultsFile,
      JSON.stringify(result, null, 2),
      'utf-8'
    );
    
    // Count by status
    const passed = result.jobs.filter(j => j.score >= SCORE_PASS_THRESHOLD).length;
    const review = result.jobs.filter(j => j.score >= SCORE_REVIEW_THRESHOLD && j.score < SCORE_PASS_THRESHOLD).length;
    const rejectedPreFilter = result.stats.rejectedPreFilter;
    const aiReject = result.jobs.filter(j => j.score < SCORE_REVIEW_THRESHOLD).length;
    
    logger.success('Compile results complete:');
    logger.info(`  Total survivors: ${result.stats.total}`);
    logger.info(`  PASS (score >= ${SCORE_PASS_THRESHOLD}): ${passed}`);
    logger.info(`  REVIEW (score ${SCORE_REVIEW_THRESHOLD}-${SCORE_PASS_THRESHOLD - 1}): ${review}`);
    logger.info(`  REJECT (AI, score < ${SCORE_REVIEW_THRESHOLD}): ${aiReject}`);
    logger.info(`  REJECT (pre-filter): ${rejectedPreFilter}`);
    
  } catch (error) {
    logger.error(`Compile results failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  void main();
}
