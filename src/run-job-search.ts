/**
 * run-job-search.ts — Orchestrator
 *
 * Coordinates the full pipeline. Creates the run directory, writes the run manifest,
 * and runs the appropriate phase scripts in sequence.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as logger from './utils/logger';
import { DATA_DIR } from './config';
import { loadEnvFileIfProvided } from './utils/env-loader';

// Import all script main functions
import { main as discoverMain } from './01-discover';
import { main as fetchSpecsMain } from './02-fetch-specs';
import { main as prefilterMain } from './03-prefilter';
import { main as compileResultsMain } from './04-compile-results';
import { main as generatePdfsMain } from './05-generate-pdfs';
import { main as uploadMain } from './06-upload';

type Phase = 'pre' | 'post' | 'all';

interface RunManifest {
  runDir: string;
  runTimestamp: string;
  phase: Phase;
  startedAt: string;
  files: Record<string, {
    owner: string;
    aiMayRead: boolean;
    aiMayWrite: boolean;
    description: string;
  }>;
}

interface CliArgs {
  phase: Phase;
  runDir: string | undefined;
  dryRun: boolean;
  envFile: string | undefined;
}

/**
 * Parse CLI arguments
 */
export function parseArgs(args: string[]): CliArgs {
  const result: CliArgs = {
    phase: 'pre',
    runDir: undefined,
    dryRun: false,
    envFile: undefined,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--phase' && i + 1 < args.length) {
      const phase = args[i + 1] as Phase;
      if (!['pre', 'post', 'all'].includes(phase)) {
        throw new Error(`Invalid phase: ${phase}. Must be 'pre', 'post', or 'all'`);
      }
      result.phase = phase;
      i++;
    } else if (arg === '--run-dir' && i + 1 < args.length) {
      result.runDir = args[i + 1];
      i++;
    } else if (arg === '--dry-run') {
      result.dryRun = true;
    } else if (arg === '--env-file' && i + 1 < args.length) {
      result.envFile = args[i + 1];
      i++;
    }
  }

  // Validate: post phase requires run-dir
  if (result.phase === 'post' && result.runDir === undefined) {
    throw new Error('--phase post requires --run-dir');
  }

  return result;
}

/**
 * Create run directory with timestamp
 */
export async function createRunDir(): Promise<string> {
  const now = new Date();
  const timestamp = now.toISOString().replace(/[:T]/g, '-').split('.')[0];
  const runDir = path.join(DATA_DIR, `run-${timestamp}`);

  await fs.mkdir(runDir, { recursive: true });
  logger.info(`Created run directory: ${runDir}`);

  return runDir;
}

/**
 * Validate post phase prerequisites
 */
export async function validatePostPhase(runDir: string): Promise<void> {
  // Check pre-filter-survivors.json exists
  const survivorsFile = path.join(runDir, 'pre-filter-survivors.json');
  try {
    await fs.access(survivorsFile);
  } catch {
    throw new Error(`Pre-filter survivors file not found: ${survivorsFile}. Run --phase pre first.`);
  }

  // Check job-scores directory exists and has files
  const scoresDir = path.join(runDir, 'job-scores');
  try {
    const files = await fs.readdir(scoresDir);
    const jsonFiles = files.filter(f => f.endsWith('.json'));
    if (jsonFiles.length === 0) {
      throw new Error(`No job score files found in ${scoresDir}. AI scoring step required.`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('No job score files found')) {
      throw error;
    }
    throw new Error(`Job scores directory not found: ${scoresDir}. AI scoring step required.`);
  }
}

/**
 * Write run manifest
 */
export async function writeRunManifest(runDir: string, phase: Phase): Promise<void> {
  const manifest: RunManifest = {
    runDir,
    runTimestamp: new Date().toISOString(),
    phase,
    startedAt: new Date().toISOString(),
    files: {
      'discovered-jobs.json': {
        owner: '01-discover.ts',
        aiMayRead: true,
        aiMayWrite: false,
        description: 'Jobs discovered from Brave, LinkedIn, Gmail',
      },
      'fetched-specs.json': {
        owner: '02-fetch-specs.ts',
        aiMayRead: true,
        aiMayWrite: false,
        description: 'Full job specifications fetched from sources',
      },
      'pre-filter-survivors.json': {
        owner: '03-prefilter.ts',
        aiMayRead: true,
        aiMayWrite: false,
        description: 'Jobs that passed pre-filter (for AI scoring)',
      },
      'pre-filter-rejections.json': {
        owner: '03-prefilter.ts',
        aiMayRead: false,
        aiMayWrite: false,
        description: 'Jobs rejected by pre-filter',
      },
      'job-scores/*.json': {
        owner: 'AI',
        aiMayRead: false,
        aiMayWrite: true,
        description: 'AI-generated job scores',
      },
      'compile-results.json': {
        owner: '04-compile-results.ts',
        aiMayRead: true,
        aiMayWrite: false,
        description: 'Final compiled results with PASS/REVIEW/REJECT',
      },
      'all-rejections.json': {
        owner: '04-compile-results.ts',
        aiMayRead: true,
        aiMayWrite: false,
        description: 'All rejected jobs (pre-filter + AI)',
      },
      'pdfs/*.pdf': {
        owner: '05-generate-pdfs.ts',
        aiMayRead: true,
        aiMayWrite: false,
        description: 'Generated PDFs for PASS/REVIEW jobs',
      },
      'upload-results.json': {
        owner: '06-upload.ts',
        aiMayRead: true,
        aiMayWrite: false,
        description: 'Upload results with cloud URLs',
      },
    },
  };

  await fs.writeFile(
    path.join(runDir, 'run-manifest.json'),
    JSON.stringify(manifest, null, 2),
    'utf-8'
  );

  logger.info(`Wrote run manifest to ${runDir}/run-manifest.json`);
}

/**
 * Run a script
 */
export async function runScript(scriptName: string, _runDir: string, dryRun: boolean): Promise<void> {
  process.env.JOB_HARVESTER_DATA_DIR = _runDir;

  if (dryRun) {
    logger.info(`[DRY RUN] Would run ${scriptName}`);
    return;
  }

  logger.info(`Running ${scriptName}...`);

  try {
    switch (scriptName) {
      case '01-discover':
        await discoverMain();
        break;
      case '02-fetch-specs':
        await fetchSpecsMain();
        break;
      case '03-prefilter':
        await prefilterMain();
        break;
      case '04-compile-results':
        await compileResultsMain();
        break;
      case '05-generate-pdfs':
        await generatePdfsMain();
        break;
      case '06-upload':
        await uploadMain();
        break;
      default:
        throw new Error(`Unknown script: ${scriptName}`);
    }

    logger.success(`${scriptName} completed`);
  } catch (error) {
    logger.error(`${scriptName} failed: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

/**
 * Run pre phase
 */
export async function runPrePhase(runDir: string, dryRun: boolean): Promise<void> {
  logger.info('=== Pre-AI Pipeline ===');
  process.env.JOB_HARVESTER_DATA_DIR = runDir;

  await writeRunManifest(runDir, 'pre');
  await runScript('01-discover', runDir, dryRun);
  await runScript('02-fetch-specs', runDir, dryRun);
  await runScript('03-prefilter', runDir, dryRun);

  // Count survivors
  let survivorCount = 0;
  if (!dryRun) {
    try {
      const survivorsPath = path.join(runDir, 'pre-filter-survivors.json');
      const survivorsContent = await fs.readFile(survivorsPath, 'utf-8');
      const survivors = JSON.parse(survivorsContent) as unknown[];
      survivorCount = survivors.length;
    } catch {
      // Ignore errors reading survivors
    }
  }

  logger.success('Pre-AI pipeline complete');
  logger.info(`Run directory: ${runDir}`);
  logger.info(`Survivors: ${survivorCount} jobs ready for AI scoring`);
  logger.info('');
  logger.info('Next steps:');
  logger.info('  1. AI Step 1: Read gmail/index.json, extract jobs → append to discovered-jobs.json');
  logger.info('  2. AI Step 2: Read pre-filter-survivors.json, score each → write job-scores/*.json');
  logger.info(`  3. Run: npx ts-node src/run-job-search.ts --phase post --run-dir ${runDir}`);
}

/**
 * Run post phase
 */
export async function runPostPhase(runDir: string, dryRun: boolean): Promise<void> {
  logger.info('=== Post-AI Pipeline ===');
  process.env.JOB_HARVESTER_DATA_DIR = runDir;

  await validatePostPhase(runDir);
  await writeRunManifest(runDir, 'post');
  await runScript('04-compile-results', runDir, dryRun);
  await runScript('05-generate-pdfs', runDir, dryRun);
  await runScript('06-upload', runDir, dryRun);

  logger.success('Post-AI pipeline complete');
}

/**
 * Main entry point
 */
export async function main(): Promise<void> {
  try {
    await loadEnvFileIfProvided(process.argv.slice(2));
    const args = parseArgs(process.argv.slice(2));

    let runDir: string;

    if (args.phase === 'pre') {
      runDir = await createRunDir();
      await runPrePhase(runDir, args.dryRun);
    } else if (args.phase === 'post') {
      runDir = args.runDir!;
      await runPostPhase(runDir, args.dryRun);
    } else if (args.phase === 'all') {
      // For testing: requires existing run-dir with job-scores
      runDir = args.runDir ?? await createRunDir();
      await validatePostPhase(runDir);
      await runPostPhase(runDir, args.dryRun);
    }
  } catch (error) {
    logger.error(`Pipeline failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  void main();
}
