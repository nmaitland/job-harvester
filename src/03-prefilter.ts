/**
 * 03-prefilter.ts — Deterministic Pre-Filters
 * 
 * Applies fast, deterministic filters to fetched job specs before expensive AI scoring.
 * Pure logic — no external API calls.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { JobSpec, FilterVerdict, PreFilterOutput, RejectionReason } from './types';
import { JUNIOR_KEYWORDS, MANAGEMENT_DATA_DIR } from './config';
import * as logger from './utils/logger';
import { loadEnvFileIfProvided } from './utils/env-loader';

function getManagementDataDir(): string {
  const envDir = process.env.JOB_HARVESTER_MANAGEMENT_DATA_DIR;
  if (envDir !== undefined && envDir !== '') {
    return envDir;
  }
  return MANAGEMENT_DATA_DIR;
}

function getAppliedCompaniesFile(): string {
  return path.join(getManagementDataDir(), 'applied-companies.txt');
}

function getProcessedJobsFile(): string {
  return path.join(getManagementDataDir(), 'job-search-processed.json');
}

function resolveDataDir(): string {
  const envDir = process.env.JOB_HARVESTER_WORK_DIR;
  if (envDir === undefined || envDir === '') {
    throw new Error('JOB_HARVESTER_WORK_DIR is required. Set it in environment or via --env-file.');
  }
  return envDir;
}

function getFetchedSpecsFile(): string {
  return path.join(resolveDataDir(), 'fetched-specs.json');
}

function getPreFilterSurvivorsFile(): string {
  return path.join(resolveDataDir(), 'pre-filter-survivors.json');
}

function getPreFilterRejectionsFile(): string {
  return path.join(resolveDataDir(), 'pre-filter-rejections.json');
}

/**
 * Normalize company name for comparison
 */
export function normalizeCompany(company: string): string {
  return company
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Normalize URL for comparison
 */
export function normalizeUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    // Remove query params and trailing slash
    return `${urlObj.origin}${urlObj.pathname}`.toLowerCase().replace(/\/$/, '');
  } catch {
    // If URL parsing fails, just lowercase and trim
    return url.toLowerCase().trim().replace(/\/$/, '');
  }
}

/**
 * Load applied companies from file
 */
export async function loadAppliedCompanies(filePath: string): Promise<Set<string>> {
  const companies = new Set<string>();
  
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.split('\n');
    
    for (const line of lines) {
      const trimmed = line.trim();
      // Skip comments and empty lines
      if (trimmed && !trimmed.startsWith('#')) {
        companies.add(normalizeCompany(trimmed));
      }
    }
    
    logger.info(`Loaded ${companies.size} applied companies from ${filePath}`);
  } catch (error) {
    // File may not exist on first run — treat as empty
    logger.warn(`Could not load applied companies file: ${filePath}. Treating as empty.`);
  }
  
  return companies;
}

/**
 * Load processed URLs from file
 */
export async function loadProcessedUrls(filePath: string): Promise<Set<string>> {
  const urls = new Set<string>();
  
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const data = JSON.parse(content) as Array<{ url: string }>;
    
    for (const entry of data) {
      if (entry.url) {
        urls.add(normalizeUrl(entry.url));
      }
    }
    
    logger.info(`Loaded ${urls.size} processed URLs from ${filePath}`);
  } catch (error) {
    // File may not exist — treat as empty
    logger.warn(`Could not load processed jobs file: ${filePath}. Treating as empty.`);
  }
  
  return urls;
}

/**
 * Check if job title indicates a junior role
 */
export function isJuniorRole(title: string): boolean {
  const normalizedTitle = title.toLowerCase();
  
  for (const keyword of JUNIOR_KEYWORDS) {
    // Check if title starts with keyword (e.g., "Junior Developer")
    if (normalizedTitle.startsWith(keyword)) {
      return true;
    }
    
    // Check if title ends with keyword (e.g., "Software Engineering Intern")
    if (normalizedTitle.endsWith(keyword)) {
      return true;
    }
    
    // Check if keyword appears after specific punctuation: -, /, (, [, –, —
    // This handles "Developer (Junior)", "Developer - Junior", etc.
    // Use a simple approach: check if punctuation + keyword exists
    const punctuations = ['(', '[', '-', '–', '—', '/'];
    for (const punct of punctuations) {
      const pattern = punct + keyword;
      if (normalizedTitle.includes(pattern)) {
        return true;
      }
    }
  }
  
  return false;
}

/**
 * Apply all filters to a job spec
 * Returns null if job passes all filters, otherwise returns rejection reason
 */
export function applyFilters(
  spec: JobSpec,
  appliedCompanies: Set<string>,
  processedUrls: Set<string>
): RejectionReason | null {
  // Filter 1: fetch_failed
  if (spec.fetchStatus === 'failed') {
    return 'fetch_failed';
  }
  
  // Filter 2: already_applied
  const normalizedCompany = normalizeCompany(spec.company);
  if (appliedCompanies.has(normalizedCompany)) {
    return 'already_applied';
  }
  
  // Filter 3: already_sent
  const normalizedUrl = normalizeUrl(spec.url);
  if (processedUrls.has(normalizedUrl)) {
    return 'already_sent';
  }
  
  // Filter 4: junior
  if (isJuniorRole(spec.title)) {
    return 'junior_role';
  }
  
  // All filters passed
  return null;
}

/**
 * Run pre-filter on all job specs
 */
export async function runPreFilter(specs: JobSpec[]): Promise<PreFilterOutput> {
  const timestamp = new Date().toISOString();
  const appliedCompaniesFile = getAppliedCompaniesFile();
  const processedJobsFile = getProcessedJobsFile();
  
  // Load reference data
  const [appliedCompanies, processedUrls] = await Promise.all([
    loadAppliedCompanies(appliedCompaniesFile),
    loadProcessedUrls(processedJobsFile),
  ]);
  
  const survivors: JobSpec[] = [];
  const rejections: FilterVerdict[] = [];
  const byReason: Record<RejectionReason, number> = {
    fetch_failed: 0,
    already_applied: 0,
    already_sent: 0,
    junior_role: 0,
  };
  
  for (const spec of specs) {
    const rejectionReason = applyFilters(spec, appliedCompanies, processedUrls);
    
    const verdict: FilterVerdict = {
      jobId: spec.id,
      company: spec.company,
      title: spec.title,
      url: spec.url,
      passed: rejectionReason === null,
      rejectionReason: rejectionReason ?? undefined,
      checkedAt: timestamp,
    };
    
    if (rejectionReason) {
      rejections.push(verdict);
      byReason[rejectionReason]++;
    } else {
      survivors.push(spec);
    }
  }
  
  const output: PreFilterOutput = {
    survivors,
    rejections,
    timestamp,
    stats: {
      total: specs.length,
      survivors: survivors.length,
      rejections: rejections.length,
      byReason,
    },
  };
  
  return output;
}

/**
 * Main entry point
 */
export async function main(): Promise<void> {
  await loadEnvFileIfProvided(process.argv.slice(2));
  logger.info('Starting pre-filter...');
  const fetchedSpecsFile = getFetchedSpecsFile();
  const preFilterSurvivorsFile = getPreFilterSurvivorsFile();
  const preFilterRejectionsFile = getPreFilterRejectionsFile();
  
  try {
    // Read fetched specs
    const specsContent = await fs.readFile(fetchedSpecsFile, 'utf-8');
    const parsed = JSON.parse(specsContent) as JobSpec[] | { specs?: JobSpec[] };
    const specs = Array.isArray(parsed) ? parsed : (parsed.specs ?? []);
    
    logger.info(`Loaded ${specs.length} job specs from ${fetchedSpecsFile}`);
    
    // Run filters
    const result = await runPreFilter(specs);
    
    // Write survivors
    await fs.writeFile(
      preFilterSurvivorsFile,
      JSON.stringify(result.survivors, null, 2),
      'utf-8'
    );
    logger.info(`Wrote ${result.survivors.length} survivors to ${preFilterSurvivorsFile}`);
    
    // Write rejections
    await fs.writeFile(
      preFilterRejectionsFile,
      JSON.stringify(result.rejections, null, 2),
      'utf-8'
    );
    logger.info(`Wrote ${result.rejections.length} rejections to ${preFilterRejectionsFile}`);
    
    // Print summary
    logger.success('Pre-filter complete:');
    logger.info(`  Total: ${result.stats.total}`);
    logger.info(`  Survivors: ${result.stats.survivors}`);
    logger.info(`  Rejections: ${result.stats.rejections}`);
    logger.info(`    - fetch_failed: ${result.stats.byReason.fetch_failed}`);
    logger.info(`    - already_applied: ${result.stats.byReason.already_applied}`);
    logger.info(`    - already_sent: ${result.stats.byReason.already_sent}`);
    logger.info(`    - junior_role: ${result.stats.byReason.junior_role}`);
    
  } catch (error) {
    logger.error(`Pre-filter failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  void main();
}
