/**
 * Configuration constants for job-harvester pipeline
 * Based on plans/job-search-pipeline/config.md
 */

import * as path from 'path';

function resolveManagementDataDir(): string {
  const envDir = process.env.JOB_HARVESTER_MANAGEMENT_DATA_DIR;
  if (envDir !== undefined && envDir !== '') {
    return envDir;
  }
  return path.join(__dirname, '..', '..');
}

// ============================================================================
// Directory Paths
// ============================================================================

export const MANAGEMENT_DATA_DIR = resolveManagementDataDir();

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
