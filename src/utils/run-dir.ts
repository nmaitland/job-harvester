import * as fs from 'fs/promises';
import * as path from 'path';

const RUN_DIR_BASENAME_REGEX = /^run-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}$/;

export function parseRunDirArg(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--run-dir' && i + 1 < args.length) {
      return args[i + 1];
    }
  }
  return undefined;
}

export function assertValidRunDirName(runDir: string): void {
  const base = path.basename(runDir);
  if (!RUN_DIR_BASENAME_REGEX.test(base)) {
    throw new Error(`Invalid --run-dir '${runDir}'. Expected folder name format: run-YYYY-MM-DD-HH-mm-ss`);
  }
}

export async function requireExistingRunDir(runDir: string): Promise<void> {
  let statResult: Awaited<ReturnType<typeof fs.stat>>;
  try {
    statResult = await fs.stat(runDir);
  } catch {
    throw new Error(`--run-dir does not exist: ${runDir}`);
  }

  if (!statResult.isDirectory()) {
    throw new Error(`--run-dir is not a directory: ${runDir}`);
  }
}

export async function resolveRequiredRunDirFromCli(args: string[]): Promise<string> {
  const runDir = parseRunDirArg(args);
  if (runDir === undefined || runDir.trim() === '') {
    throw new Error('Missing required --run-dir. Provide a path to an existing run-YYYY-MM-DD-HH-mm-ss folder.');
  }

  assertValidRunDirName(runDir);
  await requireExistingRunDir(runDir);
  return runDir;
}

export function resolveRootWorkDirFromEnv(): string {
  const root = process.env.JOB_HARVESTER_ROOT_WORK_DIR;
  if (root !== undefined && root !== '') {
    return root;
  }

  const legacy = process.env.JOB_HARVESTER_WORK_DIR;
  if (legacy !== undefined && legacy !== '') {
    throw new Error('JOB_HARVESTER_WORK_DIR has been renamed to JOB_HARVESTER_ROOT_WORK_DIR. Update your .env file.');
  }

  throw new Error('JOB_HARVESTER_ROOT_WORK_DIR is required. Set it in environment or via --env-file.');
}
