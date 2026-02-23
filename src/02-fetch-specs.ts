/**
 * 02-fetch-specs.ts — Fetch Job Specs
 *
 * Fetches full job descriptions for all discovered jobs using Brightdata API and Playwright.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { chromium } from 'playwright';
import type { DiscoveredJob, JobSpec, FetchOutput } from './types';
import {
  DISCOVERED_JOBS_FILE,
  FETCHED_SPECS_FILE,
  SPECS_DIR,
  BRIGHTDATA_API_BASE,
  BRIGHTDATA_DCA_BASE,
  BRIGHTDATA_DATASETS,
  BRIGHTDATA_COLLECTORS,
} from './config';
import { slugify } from './utils/slugify';
import * as logger from './utils/logger';
import { getSecret } from './utils/secrets';
import { retry, sleep, withTimeout } from './utils/http';
import { loadEnvFileIfProvided } from './utils/env-loader';

// Brightdata configuration - read at runtime for testability
async function getBrightdataApiKey(): Promise<string> {
  return getSecret('BRIGHTDATA_API_KEY');
}

interface FetchResult {
  success: boolean;
  error: string | undefined;
  specText: string;
  jsonData: unknown;
}

interface BrightdataResponse {
  collection_id?: string;
  error?: string;
}

interface BrightdataDatasetItem {
  error?: string;
  job_description_formatted?: string;
  job_summary?: string;
  job_title?: string;
  job_description?: string;
  qualifications?: string;
  responsibilities?: string;
  company?: string;
  skills?: string;
}

/**
 * Route job to appropriate fetcher based on URL
 */
export function routeByUrl(url: string): 'linkedin' | 'jobagent' | 'wellfound' | 'web' {
  if (url.includes('linkedin.com')) {
    return 'linkedin';
  }
  if (url.includes('jobagent.ch')) {
    return 'jobagent';
  }
  if (url.includes('wellfound.com') || url.includes('angel.co')) {
    return 'wellfound';
  }
  return 'web';
}

/**
 * Fetch LinkedIn job via Brightdata sync API
 */
export async function fetchLinkedIn(job: DiscoveredJob): Promise<FetchResult> {
  const BRIGHTDATA_API_KEY = await getBrightdataApiKey();
  if (BRIGHTDATA_API_KEY === '') {
    return { success: false, error: 'Brightdata API key not configured', specText: '', jsonData: null };
  }

  const maxRetries = 2;
  const delayMs = 5000;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await withTimeout(fetch(
        `${BRIGHTDATA_API_BASE}/datasets/v3/trigger?dataset_id=${BRIGHTDATA_DATASETS.LINKEDIN}&notify=false`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${BRIGHTDATA_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            input: [{ url: job.url }],
          }),
        }
      ), 120000, 'LinkedIn fetch');

      if (!response.ok) {
        const errorText = await response.text();
        logger.warn(`LinkedIn fetch HTTP ${response.status} (attempt ${attempt}): ${errorText}`);
        if (attempt < maxRetries) {
          await sleep(delayMs);
          continue;
        }
        return { success: false, error: `HTTP ${response.status}: ${errorText}`, specText: '', jsonData: null };
      }

      const data = await response.json() as BrightdataDatasetItem[];

      // Check for crawler error
      if (data[0]?.error !== undefined) {
        logger.warn(`LinkedIn crawler error (attempt ${attempt}): ${data[0].error}`);
        if (attempt < maxRetries) {
          await sleep(delayMs);
          continue;
        }
        return { success: false, error: `Crawler error: ${data[0].error}`, specText: '', jsonData: data };
      }

      const specText = extractLinkedInText(data);
      return { success: true, error: undefined, specText, jsonData: data };
    } catch (error) {
      logger.error(`LinkedIn fetch error (attempt ${attempt}): ${error instanceof Error ? error.message : String(error)}`);
      if (attempt < maxRetries) {
        await sleep(delayMs);
      }
    }
  }

  return { success: false, error: 'Max retries exceeded', specText: '', jsonData: null };
}

/**
 * Fetch JobAgent job via Brightdata DCA async
 */
export async function fetchJobAgent(job: DiscoveredJob): Promise<FetchResult> {
  const BRIGHTDATA_API_KEY = await getBrightdataApiKey();
  if (BRIGHTDATA_API_KEY === '') {
    return { success: false, error: 'Brightdata API key not configured', specText: '', jsonData: null };
  }

  const collectors = [
    BRIGHTDATA_COLLECTORS.JOBAGENT_PRIMARY,
    BRIGHTDATA_COLLECTORS.JOBAGENT_FALLBACK,
  ];

  for (const collector of collectors) {
    try {
      // Phase 1: Trigger
      const triggerResponse = await withTimeout(fetch(
        `${BRIGHTDATA_DCA_BASE}/trigger?collector=${collector}&queue_next=1`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${BRIGHTDATA_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify([{ url: job.url }]),
        }
      ), 60000, 'JobAgent trigger');

      if (!triggerResponse.ok) {
        const errorText = await triggerResponse.text();
        logger.warn(`JobAgent trigger HTTP ${triggerResponse.status}: ${errorText}`);
        continue;
      }

      const triggerData = await triggerResponse.json() as BrightdataResponse;
      const collectionId = triggerData.collection_id;

      if (collectionId === undefined) {
        logger.warn('JobAgent trigger: no collection_id in response');
        continue;
      }

      // Phase 2: Poll
      const maxPolls = 10;
      const pollDelayMs = 30000;

      for (let poll = 1; poll <= maxPolls; poll++) {
        await sleep(pollDelayMs);

        const pollResponse = await withTimeout(fetch(
          `${BRIGHTDATA_DCA_BASE}/dataset?id=${collectionId}`,
          {
            headers: {
              'Authorization': `Bearer ${BRIGHTDATA_API_KEY}`,
            },
          }
        ), 60000, 'JobAgent poll');

        if (!pollResponse.ok) {
          logger.warn(`JobAgent poll HTTP ${pollResponse.status}`);
          continue;
        }

        const pollData = await pollResponse.text();

        // Check if ready (starts with '[')
        if (pollData.trim().startsWith('[')) {
          const data = JSON.parse(pollData) as BrightdataDatasetItem[];

          // Check for crawler error
          if (data[0]?.error !== undefined) {
            logger.warn(`JobAgent crawler error: ${data[0].error}`);
            break; // Try next collector
          }

          const specText = extractJobAgentText(data);
          return { success: true, error: undefined, specText, jsonData: data };
        }

        // Check if still building
        if (pollData.includes('"status":"building"')) {
          logger.info(`JobAgent still building (poll ${poll}/${maxPolls})`);
          continue;
        }
      }

      logger.warn('JobAgent max polls exceeded');
    } catch (error) {
      logger.error(`JobAgent fetch error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { success: false, error: 'All collectors failed', specText: '', jsonData: null };
}

/**
 * Fetch Wellfound job via Brightdata DCA async
 */
export async function fetchWellfound(job: DiscoveredJob): Promise<FetchResult> {
  // Check URL pattern first
  if (job.url.includes('wellfound.com/company/')) {
    return { success: false, error: 'wellfound_company_page', specText: '', jsonData: null };
  }

  const BRIGHTDATA_API_KEY = await getBrightdataApiKey();
  if (BRIGHTDATA_API_KEY === '') {
    return { success: false, error: 'Brightdata API key not configured', specText: '', jsonData: null };
  }

  const collector = BRIGHTDATA_COLLECTORS.WELLFOUND;
  const maxTriggerAttempts = 2;

  for (let attempt = 1; attempt <= maxTriggerAttempts; attempt++) {
    try {
      // Phase 1: Trigger
      const triggerResponse = await withTimeout(fetch(
        `${BRIGHTDATA_DCA_BASE}/trigger?collector=${collector}&queue_next=1`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${BRIGHTDATA_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify([{ url: job.url }]),
        }
      ), 60000, 'Wellfound trigger');

      if (!triggerResponse.ok) {
        const errorText = await triggerResponse.text();
        logger.warn(`Wellfound trigger HTTP ${triggerResponse.status} (attempt ${attempt}): ${errorText}`);
        continue;
      }

      const triggerData = await triggerResponse.json() as BrightdataResponse;
      const collectionId = triggerData.collection_id;

      if (collectionId === undefined) {
        logger.warn('Wellfound trigger: no collection_id in response');
        continue;
      }

      // Phase 2: Poll
      const maxPolls = 10;
      const pollDelayMs = 30000;

      for (let poll = 1; poll <= maxPolls; poll++) {
        await sleep(pollDelayMs);

        const pollResponse = await withTimeout(fetch(
          `${BRIGHTDATA_DCA_BASE}/dataset?id=${collectionId}`,
          {
            headers: {
              'Authorization': `Bearer ${BRIGHTDATA_API_KEY}`,
            },
          }
        ), 60000, 'Wellfound poll');

        if (!pollResponse.ok) {
          logger.warn(`Wellfound poll HTTP ${pollResponse.status}`);
          continue;
        }

        const pollData = await pollResponse.text();

        // Check if ready
        if (pollData.trim().startsWith('[')) {
          const data = JSON.parse(pollData) as BrightdataDatasetItem[];

          // Check for crawler error
          if (data[0]?.error !== undefined) {
            logger.warn(`Wellfound crawler error (attempt ${attempt}): ${data[0].error}`);
            break; // Retry trigger
          }

          const specText = extractWellfoundText(data);
          return { success: true, error: undefined, specText, jsonData: data };
        }

        if (pollData.includes('"status":"building"')) {
          logger.info(`Wellfound still building (poll ${poll}/${maxPolls})`);
        }
      }
    } catch (error) {
      logger.error(`Wellfound fetch error (attempt ${attempt}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { success: false, error: 'Max retries exceeded', specText: '', jsonData: null };
}

/**
 * Fetch generic web job via Playwright
 */
export async function fetchWeb(job: DiscoveredJob): Promise<FetchResult> {
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage();
    await withTimeout(page.goto(job.url, { waitUntil: 'networkidle' }), 90000, 'Web fetch page.goto');

    // Get text content
    const text = await page.evaluate((): string => {
      return document.body.innerText;
    });

    // Get HTML content
    const html = await page.content();

    return { success: true, error: undefined, specText: text, jsonData: { html } };
  } catch (error) {
    logger.error(`Web fetch error for ${job.url}: ${error instanceof Error ? error.message : String(error)}`);
    return { success: false, error: error instanceof Error ? error.message : String(error), specText: '', jsonData: null };
  } finally {
    await browser.close();
  }
}

/**
 * Extract text from LinkedIn response
 */
export function extractLinkedInText(data: unknown[]): string {
  if (!Array.isArray(data) || data.length === 0) {
    return '';
  }

  const job = data[0] as BrightdataDatasetItem;
  const description = job.job_description_formatted ?? job.job_summary ?? '';
  // Strip HTML tags
  return description.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Extract text from JobAgent response
 */
export function extractJobAgentText(data: unknown[]): string {
  if (!Array.isArray(data) || data.length === 0) {
    return '';
  }

  const job = data[0] as BrightdataDatasetItem;
  const parts = [
    job.job_title,
    job.job_description,
    job.qualifications,
    job.responsibilities,
  ].filter((item): item is string => item !== undefined && item !== '');

  return parts.join('\n\n');
}

/**
 * Extract text from Wellfound response
 */
export function extractWellfoundText(data: unknown[]): string {
  if (!Array.isArray(data) || data.length === 0) {
    return '';
  }

  const job = data[0] as BrightdataDatasetItem;
  const parts = [
    job.job_title,
    job.company,
    job.skills,
    job.job_description,
  ].filter((item): item is string => item !== undefined && item !== '');

  return parts.join('\n\n');
}

/**
 * Main entry point
 */
export async function main(): Promise<void> {
  await loadEnvFileIfProvided(process.argv.slice(2));
  logger.info('Starting fetch specs...');

  try {
    // Read discovered jobs
    const discoveredContent = await fs.readFile(DISCOVERED_JOBS_FILE, 'utf-8');
    const discovered = JSON.parse(discoveredContent) as { jobs?: DiscoveredJob[] };
    if (!Array.isArray(discovered.jobs)) {
      throw new Error('Invalid discovered jobs input: expected { jobs: DiscoveredJob[] }');
    }

    logger.info(`Loaded ${discovered.jobs.length} discovered jobs`);

    // Ensure specs directory exists
    await fs.mkdir(SPECS_DIR, { recursive: true });

    const specs: JobSpec[] = [];
    let successCount = 0;
    let failedCount = 0;

    // Process each job
    for (const job of discovered.jobs) {
      const fetcher = routeByUrl(job.url);
      logger.info(`Fetching ${job.company} - ${job.title} via ${fetcher}`);

      let result: FetchResult;

      switch (fetcher) {
        case 'linkedin':
          result = await retry(() => fetchLinkedIn(job), { maxAttempts: 2, delayMs: 1000 });
          break;
        case 'jobagent':
          result = await retry(() => fetchJobAgent(job), { maxAttempts: 2, delayMs: 1000 });
          break;
        case 'wellfound':
          result = await retry(() => fetchWellfound(job), { maxAttempts: 2, delayMs: 1000 });
          break;
        case 'web':
          result = await retry(() => fetchWeb(job), { maxAttempts: 2, delayMs: 1000 });
          break;
        default:
          result = { success: false, error: 'Unknown fetcher', specText: '', jsonData: null };
      }

      const timestamp = new Date().toISOString();
      const baseName = `${timestamp.split('T')[0]}-${slugify(job.company)}`;

      // Write spec text
      if (result.success) {
        await fs.writeFile(
          path.join(SPECS_DIR, `${baseName}.txt`),
          result.specText,
          'utf-8'
        );

        // Write JSON data if available
        if (result.jsonData !== null) {
          await fs.writeFile(
            path.join(SPECS_DIR, `${baseName}.json`),
            JSON.stringify(result.jsonData, null, 2),
            'utf-8'
          );
        }

        successCount++;
      }

      // Build spec entry
      const spec: JobSpec = {
        id: job.id,
        company: job.company,
        title: job.title,
        url: job.url,
        source: job.source,
        discoveredAt: job.discoveredAt,
        specText: result.specText,
        fetchStatus: result.success ? 'success' : 'failed',
        fetchError: result.error,
        fetchedAt: timestamp,
      };

      specs.push(spec);

      if (!result.success) {
        failedCount++;
        logger.error(`Failed to fetch ${job.company}: ${result.error}`);
      }
    }

    // Write index
    const output: FetchOutput = {
      specs,
      timestamp: new Date().toISOString(),
      stats: {
        total: specs.length,
        success: successCount,
        failed: failedCount,
      },
    };

    await fs.writeFile(
      FETCHED_SPECS_FILE,
      JSON.stringify(output, null, 2),
      'utf-8'
    );

    logger.success('Fetch specs complete:');
    logger.info(`  Total: ${specs.length}`);
    logger.info(`  Success: ${successCount}`);
    logger.info(`  Failed: ${failedCount}`);
  } catch (error) {
    logger.error(`Fetch specs failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  void main();
}
