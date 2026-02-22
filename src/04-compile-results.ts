/**
 * 04-compile-results.ts — Compile Results
 * 
 * Merges AI verdict files with pre-filter survivors to produce the final PASS/REVIEW/REJECT split.
 * Pure logic — no external API calls.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as glob from 'glob';
import type { FilterVerdict, JobScore, CompiledJob, CompileOutput, RejectionReason } from './types';
import { PRE_FILTER_SURVIVORS_FILE, PRE_FILTER_REJECTIONS_FILE, SCORES_DIR, COMPILED_RESULTS_FILE, ALL_REJECTIONS_FILE } from './config';
import { slugify } from './utils/slugify';
import * as logger from './utils/logger';

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

/**
 * Find AI verdict file for a job
 * First tries exact match, then falls back to glob
 */
export async function findVerdictFile(_jobId: string, company: string, scoresDir: string): Promise<string | null> {
  const companySlug = slugify(company);
  const today = new Date().toISOString().split('T')[0];
  
  // Try exact match first: {date}-{slug}.json
  const exactPath = path.join(scoresDir, `${today}-${companySlug}.json`);
  try {
    await fs.access(exactPath);
    return exactPath;
  } catch {
    // Exact match not found, try glob
  }
  
  // Fallback: glob for any file containing the slug
  const pattern = path.join(scoresDir, `*${companySlug}*.json`);
  const matches = glob.sync(pattern);
  
  if (matches.length >= 1 && matches[0] !== undefined) {
    if (matches.length > 1) {
      logger.warn(`Multiple verdict files found for ${company}, using first: ${matches[0]}`);
    } else {
      logger.info(`Found verdict file via glob: ${matches[0]}`);
    }
    return matches[0];
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
  
  // Read pre-filter survivors
  const survivorsContent = await fs.readFile(PRE_FILTER_SURVIVORS_FILE, 'utf-8');
  const survivors = JSON.parse(survivorsContent) as FilterVerdict[];
  
  // Read pre-filter rejections
  const preFilterRejectionsContent = await fs.readFile(PRE_FILTER_REJECTIONS_FILE, 'utf-8');
  const preFilterRejections = JSON.parse(preFilterRejectionsContent) as FilterVerdict[];
  
  const passed: CompiledJob[] = [];
  const review: CompiledJob[] = [];
  const aiRejections: RejectionEntry[] = [];
  
  // Process each survivor
  for (const survivor of survivors) {
    const verdictFile = await findVerdictFile(survivor.jobId, survivor.company, SCORES_DIR);
    
    if (verdictFile === null) {
      // Missing verdict → REVIEW (conservative)
      logger.warn(`Missing AI verdict for ${survivor.company} - marking as REVIEW`);
      review.push({
        jobId: survivor.jobId,
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
        jobId: survivor.jobId,
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
      jobId: survivor.jobId,
      company: survivor.company,
      title: survivor.title,
      url: survivor.url,
      specText: '', // Will be filled from spec file
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
        jobId: survivor.jobId,
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
    ALL_REJECTIONS_FILE,
    JSON.stringify(allRejections, null, 2),
    'utf-8'
  );
  
  const output: CompileOutput = {
    jobs: [...passed, ...review],
    timestamp,
    stats: {
      total: survivors.length,
      scored: passed.length + review.length,
      rejectedPreFilter: preFilterRejections.length,
    },
  };
  
  return output;
}

/**
 * Main entry point
 */
export async function main(): Promise<void> {
  logger.info('Starting compile results...');
  
  try {
    const result = await compileResults();
    
    // Write compile-results.json
    await fs.writeFile(
      COMPILED_RESULTS_FILE,
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
