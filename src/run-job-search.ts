/**
 * run-job-search.ts — Orchestrator
 *
 * Coordinates the full pipeline. Creates the run directory, writes the run manifest,
 * and runs the appropriate phase scripts in sequence.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as logger from './utils/logger';
import { loadEnvFileIfProvided } from './utils/env-loader';
import { assertValidRunDirName, requireExistingRunDir, resolveRootWorkDirFromEnv } from './utils/run-dir';

// Import all script main functions
import { main as discoverMain } from './discover';
import { main as extractFromWebsitesMain } from './extract-from-websites';
import { main as extractFromEmailsMain } from './extract-from-emails';
import { main as fetchSpecsMain } from './fetch-specs';
import { main as prefilterMain } from './prefilter';
import { main as scoreSurvivorsMain } from './score-survivors';
import { main as compileResultsMain } from './compile-results';
import { main as generatePdfsMain } from './generate-pdfs';
import { main as summarizeRunMain } from './summarize-run';
import { main as uploadMain } from './upload';

type Phase = 'all' | 'discovery' | 'email-processing' | 'fetch-and-filter' | 'scoring' | 'output';

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

function resolveDataDir(): string {
  return resolveRootWorkDirFromEnv();
}

/**
 * Parse CLI arguments
 */
export function parseArgs(args: string[]): CliArgs {
  const result: CliArgs = {
    phase: 'all',
    runDir: undefined,
    dryRun: false,
    envFile: undefined,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--phase' && i + 1 < args.length) {
      const phase = args[i + 1] as Phase;
      if (!['all', 'discovery', 'email-processing', 'fetch-and-filter', 'scoring', 'output'].includes(phase)) {
        throw new Error('Invalid phase: ' + phase + ". Must be 'all', 'discovery', 'email-processing', 'fetch-and-filter', 'scoring', or 'output'");
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

  // Validate: partial phases require --run-dir. --phase all can create a new run-dir.
  if (result.phase !== 'all' && result.runDir === undefined) {
    throw new Error(`--phase ${result.phase} requires --run-dir`);
  }

  if (result.runDir !== undefined) {
    assertValidRunDirName(result.runDir);
  }

  return result;
}

/**
 * Create run directory with timestamp
 */
export async function createRunDir(): Promise<string> {
  const now = new Date();
  const timestamp = now.toISOString().replace(/[:T]/g, '-').split('.')[0];
  const runDir = path.join(resolveDataDir(), `run-${timestamp}`);

  await fs.mkdir(runDir, { recursive: true });
  logger.info(`Created run directory: ${runDir}`);

  return runDir;
}

async function ensureFileExists(filePath: string, message: string): Promise<void> {
  try {
    await fs.access(filePath);
  } catch {
    throw new Error(message);
  }
}

/**
 * Validate output phase prerequisites
 */
export async function validateOutputPhase(runDir: string): Promise<void> {
  const survivorsFile = path.join(runDir, 'pre-filter-survivors.json');
  await ensureFileExists(
    survivorsFile,
    `Pre-filter survivors file not found: ${survivorsFile}. Run --phase fetch-and-filter first.`
  );

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
    throw new Error(`Job scores directory not found: ${scoresDir}. Run --phase scoring first.`);
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
        owner: 'discover.ts',
        aiMayRead: true,
        aiMayWrite: false,
        description: 'Jobs discovered from Brave, LinkedIn, Gmail (appended by extractors)',
      },
      'extract-from-websites-log.json': {
        owner: 'extract-from-websites.ts',
        aiMayRead: true,
        aiMayWrite: false,
        description: 'Log of AI extraction from Brave result pages',
      },
      'fetched-specs.json': {
        owner: 'fetch-specs.ts',
        aiMayRead: true,
        aiMayWrite: false,
        description: 'Full job specifications fetched from sources',
      },
      'pre-filter-survivors.json': {
        owner: 'prefilter.ts',
        aiMayRead: true,
        aiMayWrite: false,
        description: 'Jobs that passed pre-filter (for AI scoring)',
      },
      'pre-filter-rejections.json': {
        owner: 'prefilter.ts',
        aiMayRead: false,
        aiMayWrite: false,
        description: 'Jobs rejected by pre-filter',
      },
      'job-scores/*.json': {
        owner: 'score-survivors.ts',
        aiMayRead: false,
        aiMayWrite: true,
        description: 'AI-generated job scores',
      },
      'compile-results.json': {
        owner: 'compile-results.ts',
        aiMayRead: true,
        aiMayWrite: false,
        description: 'Final compiled results with PASS/REVIEW/REJECT',
      },
      'all-rejections.json': {
        owner: 'compile-results.ts',
        aiMayRead: true,
        aiMayWrite: false,
        description: 'All rejected jobs (pre-filter + AI)',
      },
      'pdfs/*.pdf': {
        owner: 'generate-pdfs.ts',
        aiMayRead: true,
        aiMayWrite: false,
        description: 'Generated PDFs for PASS/REVIEW jobs',
      },
      'run-summary/*.txt': {
        owner: 'summarize-run.ts',
        aiMayRead: true,
        aiMayWrite: false,
        description: 'Human-readable run summary and review list',
      },
      'upload-results.json': {
        owner: 'upload.ts',
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
  if (dryRun) {
    logger.info(`[DRY RUN] Would run ${scriptName}`);
    return;
  }

  logger.info(`Running ${scriptName}...`);

  try {
    switch (scriptName) {
      case 'discover':
        await discoverMain(_runDir);
        break;
      case 'extract-from-websites':
        await extractFromWebsitesMain(_runDir);
        break;
      case 'extract-from-emails':
        await extractFromEmailsMain(_runDir);
        break;
      case 'fetch-specs':
        await fetchSpecsMain(_runDir);
        break;
      case 'prefilter':
        await prefilterMain(_runDir);
        break;
      case 'score-survivors':
        await scoreSurvivorsMain(_runDir);
        break;
      case 'compile-results':
        await compileResultsMain(_runDir);
        break;
      case 'generate-pdfs':
        await generatePdfsMain(_runDir);
        break;
      case 'summarize-run':
        await summarizeRunMain(_runDir);
        break;
      case 'upload':
        await uploadMain(_runDir);
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
 * Run discovery phase
 */
export async function runDiscoveryPhase(runDir: string, dryRun: boolean): Promise<void> {
  logger.info('=== Phase: Discovery ===');

  await runScript('discover', runDir, dryRun);
}

/**
 * Run email-processing phase
 */
export async function runEmailProcessingPhase(runDir: string, dryRun: boolean): Promise<void> {
  logger.info('=== Phase: Email Processing ===');

  await runScript('extract-from-websites', runDir, dryRun);
  await runScript('extract-from-emails', runDir, dryRun);
}

/**
 * Run fetch-and-filter phase
 */
export async function runFetchAndFilterPhase(runDir: string, dryRun: boolean): Promise<void> {
  logger.info('=== Phase: Fetch and Filter ===');

  await runScript('fetch-specs', runDir, dryRun);
  await runScript('prefilter', runDir, dryRun);
}

/**
 * Run scoring phase
 */
export async function runScoringPhase(runDir: string, dryRun: boolean): Promise<void> {
  logger.info('=== Phase: Scoring ===');

  await runScript('score-survivors', runDir, dryRun);
}

/**
 * Run output phase
 */
export async function runOutputPhase(runDir: string, dryRun: boolean): Promise<void> {
  logger.info('=== Phase: Output ===');

  await validateOutputPhase(runDir);
  await runScript('compile-results', runDir, dryRun);
  await runScript('generate-pdfs', runDir, dryRun);
  await runScript('summarize-run', runDir, dryRun);
  await runScript('upload', runDir, dryRun);
}

/**
 * Run all phases
 */
export async function runAllPhases(runDir: string, dryRun: boolean): Promise<void> {
  logger.info('=== Fully Automated Pipeline ===');

  await writeRunManifest(runDir, 'all');
  await runDiscoveryPhase(runDir, dryRun);
  await runEmailProcessingPhase(runDir, dryRun);
  await runFetchAndFilterPhase(runDir, dryRun);
  await runScoringPhase(runDir, dryRun);
  await runOutputPhase(runDir, dryRun);

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

  logger.success('Pipeline complete');
  logger.info(`Run directory: ${runDir}`);
  logger.info(`Survivors processed: ${survivorCount}`);
}

/**
 * Main entry point
 */
export async function main(): Promise<void> {
  try {
    await loadEnvFileIfProvided(process.argv.slice(2));
    const args = parseArgs(process.argv.slice(2));

    let runDir: string;

    if (args.runDir !== undefined) {
      runDir = args.runDir;
      await requireExistingRunDir(runDir);
    } else {
      runDir = await createRunDir();
    }

    if (args.phase === 'all') {
      await runAllPhases(runDir, args.dryRun);
    } else if (args.phase === 'discovery') {
      await writeRunManifest(runDir, args.phase);
      await runDiscoveryPhase(runDir, args.dryRun);
    } else if (args.phase === 'email-processing') {
      await writeRunManifest(runDir, args.phase);
      await runEmailProcessingPhase(runDir, args.dryRun);
    } else if (args.phase === 'fetch-and-filter') {
      await writeRunManifest(runDir, args.phase);
      await runFetchAndFilterPhase(runDir, args.dryRun);
    } else if (args.phase === 'scoring') {
      await writeRunManifest(runDir, args.phase);
      await runScoringPhase(runDir, args.dryRun);
    } else if (args.phase === 'output') {
      await writeRunManifest(runDir, args.phase);
      await runOutputPhase(runDir, args.dryRun);
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
