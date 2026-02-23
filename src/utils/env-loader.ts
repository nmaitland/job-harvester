import * as fs from 'fs/promises';
import * as logger from './logger';

export interface EnvCliArgs {
  envFile: string | undefined;
}

export function parseEnvFileArg(args: string[]): EnvCliArgs {
  const result: EnvCliArgs = { envFile: undefined };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--env-file' && i + 1 < args.length) {
      result.envFile = args[i + 1];
      i++;
    }
  }

  return result;
}

export function parseEnvContent(content: string): Record<string, string> {
  const env: Record<string, string> = {};

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    if (key !== '') {
      env[key] = value;
    }
  }

  return env;
}

export async function loadEnvFileIfProvided(args: string[]): Promise<void> {
  const { envFile } = parseEnvFileArg(args);
  if (envFile === undefined || envFile === '') {
    return;
  }

  const content = await fs.readFile(envFile, 'utf-8');
  const parsed = parseEnvContent(content);

  // File wins: override existing process env values.
  for (const [key, value] of Object.entries(parsed)) {
    process.env[key] = value;
  }

  logger.info(`Loaded environment variables from ${envFile}`);
}

