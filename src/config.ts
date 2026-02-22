/**
 * Configuration constants for job-harvester pipeline
 * Based on plans/job-search-pipeline/config.md
 */

import * as path from 'path';

function resolveDataDir(): string {
  const envDir = process.env.JOB_HARVESTER_DATA_DIR;
  if (envDir !== undefined && envDir !== '') {
    return envDir;
  }
  return path.join(__dirname, '..', '..', 'data');
}

// ============================================================================
// Directory Paths
// ============================================================================

export const DATA_DIR = resolveDataDir();
export const EMAILS_DIR = path.join(DATA_DIR, 'emails');
export const SPECS_DIR = path.join(DATA_DIR, 'specs');
export const SCORES_DIR = path.join(DATA_DIR, 'job-scores');
export const PDFS_DIR = path.join(DATA_DIR, 'pdfs');
export const LOGS_DIR = path.join(DATA_DIR, 'logs');

// ============================================================================
// File Paths
// ============================================================================

export const DISCOVERED_JOBS_FILE = path.join(DATA_DIR, 'discovered-jobs.json');
export const FETCHED_SPECS_FILE = path.join(DATA_DIR, 'fetched-specs.json');
export const PRE_FILTER_SURVIVORS_FILE = path.join(DATA_DIR, 'pre-filter-survivors.json');
export const PRE_FILTER_REJECTIONS_FILE = path.join(DATA_DIR, 'pre-filter-rejections.json');
export const COMPILED_RESULTS_FILE = path.join(DATA_DIR, 'compile-results.json');
export const ALL_REJECTIONS_FILE = path.join(DATA_DIR, 'all-rejections.json');
export const UPLOAD_RESULTS_FILE = path.join(DATA_DIR, 'upload-results.json');
export const APPLIED_COMPANIES_FILE = path.join(__dirname, '..', '..', 'applied-companies.txt');
export const CV_KEYWORDS_FILE = path.join(__dirname, '..', '..', 'cv-keywords.md');

// ============================================================================
// Brightdata API Configuration
// ============================================================================

export const BRIGHTDATA_API_BASE = 'https://api.brightdata.com';
export const BRIGHTDATA_DCA_BASE = 'https://api.brightdata.com/dca';

export const BRIGHTDATA_DATASETS = {
  LINKEDIN: 'gd_lpfll7v5hcqtkxl6l',
} as const;

export const BRIGHTDATA_COLLECTORS = {
  JOBAGENT_PRIMARY: 'c_mlta06cd1xkig7r3l1',
  JOBAGENT_FALLBACK: 'c_mltoo4j21tydaoc3d0',
  WELLFOUND: 'c_mlt88fj435ph2ljf0',
} as const;

// ============================================================================
// Retry Configuration
// ============================================================================

export const RETRY_CONFIG = {
  MAX_RETRIES: 3,
  INITIAL_DELAY_MS: 1000,
  MAX_DELAY_MS: 30000,
  BACKOFF_MULTIPLIER: 2,
} as const;

// ============================================================================
// Rate Limiting
// ============================================================================

export const RATE_LIMITS = {
  BRIGHTDATA_REQUESTS_PER_MINUTE: 10,
  BRIGHTDATA_POLL_INTERVAL_MS: 5000,
  BRIGHTDATA_MAX_POLL_ATTEMPTS: 60,
  GMAIL_REQUESTS_PER_MINUTE: 60,
} as const;

// ============================================================================
// Filter Configuration
// ============================================================================

export const JUNIOR_KEYWORDS = [
  'junior',
  'entry level',
  'entry-level',
  'graduate',
  '0-2 years',
  '0-3 years',
  '1-2 years',
  '1-3 years',
  '2-3 years',
  'associate',
  'trainee',
  'intern',
  'internship',
  'apprentice',
  'starter',
  'beginner',
  'first year',
  'recent grad',
] as const;

// ============================================================================
// PDF Generation
// ============================================================================

export const PDF_CONFIG = {
  FORMAT: 'A4' as const,
  MARGIN: {
    top: '40px',
    right: '40px',
    bottom: '40px',
    left: '40px',
  },
  PRINT_BACKGROUND: true,
} as const;

// ============================================================================
// Scoring Thresholds
// ============================================================================

export const SCORING_THRESHOLDS = {
  MIN_SCORE_TO_GENERATE_PDF: 70,
  MAX_JOBS_PER_DAY: 20,
} as const;

// ============================================================================
// Upload Configuration
// ============================================================================

export const UPLOAD_CONFIG = {
  ONE_DRIVE_FOLDER: 'JobSpecs',
  GOOGLE_DRIVE_FOLDER: 'JobSpecs',
} as const;

// ============================================================================
// Discovery Configuration
// ============================================================================

export const DISCOVERY_CONFIG = {
  GMAIL_QUERY: 'subject:(job OR position OR opportunity OR hiring) newer_than:1d',
  LINKEDIN_SEARCH_URLS: [
    'https://www.linkedin.com/jobs/search/?keywords=software%20engineer&location=Switzerland',
    'https://www.linkedin.com/jobs/search/?keywords=full%20stack%20developer&location=Switzerland',
  ],
  BRAVE_SEARCH_QUERIES: [
    'software engineer jobs Switzerland',
    'backend developer remote',
    'TypeScript developer jobs Switzerland',
  ],
} as const;
