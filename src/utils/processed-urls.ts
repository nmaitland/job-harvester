import * as fs from 'fs/promises';
import * as path from 'path';
import { normalizeHttpUrl } from '../ai/validators';
import type { DiscoveredJob } from '../types';

interface RegistryEntry {
  url: string;
  normalizedUrl: string;
  recordedAt: string;
  runTimestamp: string;
  source: string;
}

interface RegistryFile {
  version: 1;
  updatedAt: string;
  urls: RegistryEntry[];
}

function getProcessedUrlsFile(managementDataDir: string): string {
  return path.join(managementDataDir, 'processed-urls.json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function extractRunTimestamp(runDir: string): string {
  const base = path.basename(runDir);
  const match = /^run-(\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2})$/.exec(base);
  if (match !== null) {
    const captured = match[1];
    if (captured !== undefined) {
      return captured;
    }
  }
  return base.startsWith('run-') ? base.slice(4) : base;
}

function parseEntry(raw: unknown): RegistryEntry | null {
  if (!isRecord(raw)) {
    return null;
  }

  const rawUrl = typeof raw.url === 'string' ? raw.url : '';
  const normalized = typeof raw.normalizedUrl === 'string' ? raw.normalizedUrl : normalizeHttpUrl(rawUrl);
  if (rawUrl.trim() === '' || normalized === null) {
    return null;
  }

  const recordedAt = typeof raw.recordedAt === 'string' && raw.recordedAt.trim() !== ''
    ? raw.recordedAt
    : new Date().toISOString();

  const runTimestamp = typeof raw.runTimestamp === 'string' && raw.runTimestamp.trim() !== ''
    ? raw.runTimestamp
    : 'unknown';

  const source = typeof raw.source === 'string' && raw.source.trim() !== ''
    ? raw.source
    : 'unknown';

  return {
    url: rawUrl,
    normalizedUrl: normalized,
    recordedAt,
    runTimestamp,
    source,
  };
}

async function readRegistryEntries(managementDataDir: string): Promise<RegistryEntry[]> {
  try {
    const filePath = getProcessedUrlsFile(managementDataDir);
    const content = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(content) as unknown;

    const rawUrls = isRecord(parsed) ? parsed.urls : undefined;
    if (!Array.isArray(rawUrls)) {
      return [];
    }

    const entries: RegistryEntry[] = [];
    for (const rawEntry of rawUrls as unknown[]) {
      const entry = parseEntry(rawEntry);
      if (entry !== null) {
        entries.push(entry);
      }
    }

    return entries;
  } catch {
    return [];
  }
}

export async function loadProcessedUrlRegistry(managementDataDir: string): Promise<Set<string>> {
  const entries = await readRegistryEntries(managementDataDir);
  const knownUrls = new Set<string>();
  for (const entry of entries) {
    knownUrls.add(entry.normalizedUrl);
  }
  return knownUrls;
}

export function buildProcessedUrlEntries(jobs: DiscoveredJob[], runDir: string): RegistryEntry[] {
  const runTimestamp = extractRunTimestamp(runDir);
  const recordedAt = new Date().toISOString();
  const byNormalizedUrl = new Map<string, RegistryEntry>();

  for (const job of jobs) {
    const normalizedUrl = normalizeHttpUrl(job.url);
    if (normalizedUrl === null) {
      continue;
    }

    if (byNormalizedUrl.has(normalizedUrl)) {
      continue;
    }

    byNormalizedUrl.set(normalizedUrl, {
      url: job.url,
      normalizedUrl,
      recordedAt,
      runTimestamp,
      source: job.source,
    });
  }

  return Array.from(byNormalizedUrl.values());
}

export async function appendUrlsToRegistry(
  managementDataDir: string,
  entries: RegistryEntry[]
): Promise<void> {
  if (entries.length === 0) {
    return;
  }

  const existing = await readRegistryEntries(managementDataDir);
  const mergedByNormalizedUrl = new Map<string, RegistryEntry>();

  for (const entry of existing) {
    mergedByNormalizedUrl.set(entry.normalizedUrl, entry);
  }

  for (const entry of entries) {
    if (!mergedByNormalizedUrl.has(entry.normalizedUrl)) {
      mergedByNormalizedUrl.set(entry.normalizedUrl, entry);
    }
  }

  const payload: RegistryFile = {
    version: 1,
    updatedAt: new Date().toISOString(),
    urls: Array.from(mergedByNormalizedUrl.values()),
  };

  await fs.mkdir(managementDataDir, { recursive: true });
  await fs.writeFile(
    getProcessedUrlsFile(managementDataDir),
    JSON.stringify(payload, null, 2),
    'utf-8'
  );
}
