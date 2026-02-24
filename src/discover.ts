/**
 * discover.ts — Discovery
 *
 * Discovers job postings from Brave Search API, LinkedIn browser, and Gmail (download only).
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { google } from 'googleapis';
import { chromium } from 'playwright';
import type { DiscoveredJob, DiscoveryOutput } from './types';
import * as logger from './utils/logger';
import { getSecrets } from './utils/secrets';
import { loadEnvFileIfProvided } from './utils/env-loader';
import { sleep } from './utils/http';
import { resolveRequiredRunDirFromCli } from './utils/run-dir';

function getEmailsDir(runDir: string): string {
  return path.join(runDir, 'emails');
}

function getDiscoveredJobsFile(runDir: string): string {
  return path.join(runDir, 'discovered-jobs.json');
}

// Brave Search API configuration
function getBraveApiBase(): string {
  return process.env.BRAVE_API_BASE ?? 'https://api.search.brave.com/res/v1/web/search';
}

function getBraveRateLimitMaxRetries(): number {
  const raw = process.env.BRAVE_RATE_LIMIT_MAX_RETRIES;
  if (raw === undefined) {
    return 3;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 3;
  }

  return parsed;
}

function getBraveRateLimitBaseDelayMs(): number {
  const raw = process.env.BRAVE_RATE_LIMIT_BASE_DELAY_MS;
  if (raw === undefined) {
    return 2000;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 2000;
  }

  return parsed;
}

// LinkedIn configuration
function getLinkedInSearchTerms(): string[] {
  const raw = process.env.LINKEDIN_SEARCH_TERMS;
  if (raw === undefined || raw.trim() === '') {
    return ['CTO', 'Solution Architect', 'Software Engineering Manager'];
  }

  return raw
    .split(',')
    .map(term => term.trim())
    .filter(term => term !== '');
}

function getLinkedInLocations(): string[] {
  const raw = process.env.LINKEDIN_LOCATIONS;
  if (raw === undefined || raw.trim() === '') {
    return ['Zurich'];
  }

  return raw
    .split(',')
    .map(location => location.trim())
    .filter(location => location !== '');
}

function getLinkedInProfileDir(): string {
  return process.env.LINKEDIN_PROFILE_DIR ?? './linkedin-profile';
}

// Gmail configuration
function getGmailMaxResults(): number {
  const raw = process.env.GMAIL_MAX_RESULTS;
  if (raw === undefined) {
    return 40;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 40;
  }

  return parsed;
}

function getBraveQueries(): string[] {
  const raw = process.env.BRAVE_QUERIES;
  if (raw === undefined || raw.trim() === '') {
    return [
      'software engineering manager advert zurich switzerland',
      'Solution Architect advert zurich switzerland',
      'CTO advert zurich Switzerland',
    ];
  }

  return raw
    .split(',')
    .map(query => query.trim())
    .filter(query => query !== '');
}

function getGmailLabel(): string {
  return process.env.GMAIL_LABEL ?? '';
}

function toGmailLabelQuery(label: string): string {
  const trimmed = label.trim();
  if (trimmed.toLowerCase().startsWith('label:')) {
    return trimmed;
  }
  return `label:${trimmed}`;
}

function getGmailUserId(): string {
  return process.env.GOOGLE_GMAIL_IMPERSONATED_USER ?? 'user@example.com';
}

function shouldMarkGmailAsRead(): boolean {
  return (process.env.GMAIL_MARK_AS_READ ?? 'true').toLowerCase() === 'true';
}

interface GmailEmailEntry {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  date: string;
  filePath: string;
}

interface DiscoveryLog {
  timestamp: string;
  brave: { count: number; errors: string[] };
  linkedin: { count: number; errors: string[] };
  gmail: { count: number; errors: string[] };
}

interface BraveSearchResult {
  title?: string;
  url?: string;
  description?: string;
}

interface BraveSearchResponse {
  web?: {
    results?: BraveSearchResult[];
  };
}

/**
 * Load secrets from environment
 */
async function loadSecrets(): Promise<{
  braveApiKey: string;
  linkedinUsername: string;
  linkedinPassword: string;
  googleServiceAccountKey: string;
  googleGmailImpersonatedUser: string;
}> {
  const secrets = await getSecrets({
    braveApiKey: 'BRAVE_API_KEY',
    linkedinUsername: 'LINKEDIN_USERNAME',
    linkedinPassword: 'LINKEDIN_PASSWORD',
    googleServiceAccountKey: 'GOOGLE_SERVICE_ACCOUNT_KEY',
    googleGmailImpersonatedUser: 'GOOGLE_GMAIL_IMPERSONATED_USER',
  });

  if (secrets.braveApiKey === '') {
    logger.warn('BRAVE_API_KEY not set - Brave search will be skipped');
  }
  if (secrets.linkedinUsername === '' || secrets.linkedinPassword === '') {
    logger.warn('LinkedIn credentials not set - LinkedIn search will be skipped');
  }
  if (secrets.googleServiceAccountKey === '' || secrets.googleGmailImpersonatedUser === '') {
    logger.warn('Google service-account Gmail settings not set - Gmail will be skipped');
  }

  return secrets;
}

/**
 * Discover jobs via Brave Search API
 */
export async function discoverViaBrave(
  apiKey: string,
  queries: string[]
): Promise<DiscoveredJob[]> {
  const jobs: DiscoveredJob[] = [];
  const errors: string[] = [];
  const braveApiBase = getBraveApiBase();
  const braveRateLimitMaxRetries = getBraveRateLimitMaxRetries();
  const braveRateLimitBaseDelayMs = getBraveRateLimitBaseDelayMs();

  if (apiKey === '') {
    logger.warn('Skipping Brave search - no API key');
    return jobs;
  }

  for (const query of queries) {
    let rateLimitRetries = 0;
    let shouldContinueQuery = true;

    try {
      while (shouldContinueQuery) {
        const response = await fetch(
          `${braveApiBase}?q=${encodeURIComponent(query)}&freshness=pw&count=20`,
          {
            headers: {
              'X-Subscription-Token': apiKey,
              'Accept': 'application/json',
            },
          }
        );

        if (response.status === 429) {
          rateLimitRetries++;
          if (rateLimitRetries > braveRateLimitMaxRetries) {
            logger.warn(`Brave API rate limit exhausted for query: ${query}`);
            errors.push(`Rate limit exhausted: ${query}`);
            shouldContinueQuery = false;
            continue;
          }

          const retryAfterHeader = response.headers.get('retry-after');
          const retryAfterSeconds = retryAfterHeader !== null ? Number.parseInt(retryAfterHeader, 10) : Number.NaN;
          const delayMs = Number.isFinite(retryAfterSeconds)
            ? retryAfterSeconds * 1000
            : braveRateLimitBaseDelayMs * rateLimitRetries;

          logger.warn(
            `Brave API rate limit hit for query: ${query}. Retrying in ${delayMs}ms (attempt ${rateLimitRetries}/${braveRateLimitMaxRetries})`
          );
          await sleep(delayMs);
          continue;
        }

        if (!response.ok) {
          logger.error(`Brave API error: ${response.status} ${response.statusText}`);
          errors.push(`HTTP ${response.status}: ${query}`);
          shouldContinueQuery = false;
          continue;
        }

        const data = await response.json() as BraveSearchResponse;
        const results = data.web?.results ?? [];

        for (const result of results) {
          const job = extractJobFromBraveResult(result);
          if (job !== null) {
            jobs.push(job);
          }
        }

        logger.info(`Brave search for "${query}": ${results.length} results`);
        shouldContinueQuery = false;
      }
    } catch (error) {
      logger.error(`Brave search failed for "${query}": ${error instanceof Error ? error.message : String(error)}`);
      errors.push(`Error: ${query}`);
    }
  }

  return jobs;
}

/**
 * Extract job info from Brave search result
 */
function extractJobFromBraveResult(result: BraveSearchResult): DiscoveredJob | null {
  const title = result.title ?? '';
  const url = result.url ?? '';

  if (title === '' || url === '') {
    return null;
  }

  // Extract company from title (heuristic)
  const companyMatch = title.match(/at\s+([^-]+)/i);
  const company = companyMatch?.[1]?.trim() ?? 'Unknown';

  // Clean up title
  const cleanTitle = title.replace(/at\s+[^-]+/i, '').replace(/[-|].*$/, '').trim();

  // Detect source from URL
  let source: DiscoveredJob['source'] = 'brave';
  if (url.includes('linkedin.com')) {
    source = 'linkedin';
  }

  return {
    id: `brave-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    company,
    title: cleanTitle,
    url,
    source,
    discoveredAt: new Date().toISOString(),
  };
}

/**
 * Check if logged into LinkedIn
 */
export async function checkLinkedInLoginState(page: {
  url: () => string;
  content: () => Promise<string>;
}): Promise<boolean> {
  const url = page.url();
  const content = await page.content();

  // Check if we're on login page
  if (url.includes('/login')) {
    return false;
  }

  // Check for profile name in page content
  if (content.includes('Swiss Assistant')) {
    return true;
  }

  // Alternative: check for nav element
  if (content.includes('global-nav')) {
    return true;
  }

  return false;
}

/**
 * Discover jobs via LinkedIn browser
 */
export async function discoverViaLinkedIn(
  username: string,
  password: string
): Promise<DiscoveredJob[]> {
  const jobs: DiscoveredJob[] = [];
  const linkedInProfileDir = getLinkedInProfileDir();

  if (username === '' || password === '') {
    logger.warn('Skipping LinkedIn search - no credentials');
    return jobs;
  }

  // Check if profile directory exists
  try {
    await fs.access(linkedInProfileDir);
  } catch {
    await fs.mkdir(linkedInProfileDir, { recursive: true });
    logger.info(`Created LinkedIn profile directory: ${linkedInProfileDir}`);
  }

  const browser = await chromium.launchPersistentContext(linkedInProfileDir, {
    headless: true,
  });

  try {
    const page = await browser.newPage();

    // Navigate to login page
    await page.goto('https://www.linkedin.com/login');

    // Check login state
    const isLoggedIn = await checkLinkedInLoginState(page);

    if (!isLoggedIn) {
      logger.info('Logging into LinkedIn...');
      await page.fill('#username', username);
      await page.fill('#password', password);
      await page.click('button[type="submit"]');

      // LinkedIn can keep long-lived background requests open, so networkidle can timeout.
      await page.waitForURL((url: URL) => !url.pathname.includes('/login'), { timeout: 45000 }).catch(() => undefined);
      await page.waitForLoadState('domcontentloaded', { timeout: 45000 }).catch(() => undefined);

      // Give the app a moment to settle after redirects/challenges.
      await sleep(2000);

      // Verify login succeeded
      const loginSuccess = await checkLinkedInLoginState(page);
      if (!loginSuccess) {
        logger.error('LinkedIn login failed');
        return jobs;
      }
    }

    logger.info('LinkedIn login successful');

    // Search for jobs
    const linkedInSearchTerms = getLinkedInSearchTerms();
    const linkedInLocations = getLinkedInLocations();
    for (const term of linkedInSearchTerms) {
      for (const location of linkedInLocations) {
        try {
          const searchUrl = `https://www.linkedin.com/jobs/search?keywords=${encodeURIComponent(term)}&location=${encodeURIComponent(location)}`;
          await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
          await sleep(1500);

          // Extract job cards
          const jobCards = await page.$$('[data-job-id]');
          logger.info(`LinkedIn search for "${term}" in "${location}": ${jobCards.length} job cards found`);

          for (const card of jobCards) {
            try {
              const extracted = await card.evaluate((el: Element) => {
                const pickText = (selectors: string[]): string => {
                  for (const selector of selectors) {
                    const node = el.querySelector(selector);
                    const text = (node?.textContent ?? '').trim();
                    if (text !== '') {
                      return text;
                    }
                  }
                  return '';
                };

                const title = pickText([
                  '.job-card-list__title',
                  '.job-card-container__link',
                  '.artdeco-entity-lockup__title',
                  'a.job-card-list__title',
                  'a[href*="/jobs/view/"]',
                ]);

                const company = pickText([
                  '.job-card-container__company-name',
                  '.artdeco-entity-lockup__subtitle',
                  '.job-card-container__primary-description',
                ]);

                const anchors = Array.from(el.querySelectorAll('a'));
                const href = anchors
                  .map(a => a.getAttribute('href') ?? '')
                  .find(h => h.includes('/jobs/view/')) ?? '';

                return { title, company, href };
              });

              const title = extracted.title;
              const company = extracted.company;
              const href = extracted.href;

              if (title !== '' && company !== '' && href !== '') {
                // Strip query params from URL
                const normalizedHref = href.startsWith('http') ? href : `https://www.linkedin.com${href}`;
                const url = normalizedHref.split('?')[0] ?? normalizedHref;

                jobs.push({
                  id: `linkedin-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                  company,
                  title,
                  url,
                  source: 'linkedin',
                  discoveredAt: new Date().toISOString(),
                });
              }
            } catch (error) {
              logger.warn(
                `LinkedIn card parse skipped for "${term}" in "${location}": ${error instanceof Error ? error.message : String(error)}`
              );
            }
          }
        } catch (error) {
          logger.error(
            `LinkedIn search failed for "${term}" in "${location}": ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    }
  } finally {
    await browser.close();
  }

  return jobs;
}

/**
 * Download Gmail emails
 */
export async function downloadGmailEmails(
  serviceAccountKey: string,
  impersonatedUser: string,
  runDir: string
): Promise<GmailEmailEntry[]> {
  const entries: GmailEmailEntry[] = [];
  const emailsDir = getEmailsDir(runDir);
  const gmailUserId = getGmailUserId();
  const gmailLabel = getGmailLabel();
  const gmailLabelQuery = toGmailLabelQuery(gmailLabel);
  const gmailMaxResults = getGmailMaxResults();
  const markAsRead = shouldMarkGmailAsRead();

  if (serviceAccountKey === '') {
    logger.warn('Skipping Gmail - missing service account key');
    return entries;
  }

  if (impersonatedUser === '') {
    logger.warn('Skipping Gmail - missing Gmail impersonated user');
    return entries;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const credentials: { client_email: string; private_key: string } = JSON.parse(serviceAccountKey);
    const normalizedPrivateKey = credentials.private_key.includes('\\n')
      ? credentials.private_key.replace(/\\n/g, '\n')
      : credentials.private_key;
    const auth = new google.auth.JWT({
      email: credentials.client_email,
      key: normalizedPrivateKey,
      scopes: ['https://www.googleapis.com/auth/gmail.modify'],
      subject: impersonatedUser,
    });

    const gmail = google.gmail({ version: 'v1', auth });

    // List unread messages in Jobs label
    const listResponse = await gmail.users.messages.list({
      userId: gmailUserId,
      q: `${gmailLabelQuery} is:unread`,
      maxResults: gmailMaxResults,
    });

    const messages = listResponse.data.messages ?? [];
    logger.info(`Gmail: ${messages.length} unread messages found`);

    // Ensure emails directory exists
    await fs.mkdir(emailsDir, { recursive: true });

    for (const message of messages) {
      if (message.id === null || message.id === undefined) continue;

      try {
        // Get full message
        const msgResponse = await gmail.users.messages.get({
          userId: gmailUserId,
          id: message.id,
          format: 'full',
        });

        const msg = msgResponse.data;
        const headers = msg.payload?.headers ?? [];
        const from = headers.find(h => h.name === 'From')?.value ?? '';
        const subject = headers.find(h => h.name === 'Subject')?.value ?? '';
        const date = headers.find(h => h.name === 'Date')?.value ?? '';

        // Extract body
        const body = extractEmailBody(msg.payload);

        // Write to file
        const fileName = `email-${message.id}.txt`;
        const filePath = path.join(emailsDir, fileName);
        const content = `From: ${from}\nSubject: ${subject}\nDate: ${date}\n\n${body}`;

        await fs.writeFile(filePath, content, 'utf-8');

        entries.push({
          id: message.id,
          threadId: msg.threadId ?? '',
          from,
          subject,
          date,
          filePath,
        });

        // Mark as read (optional)
        if (markAsRead) {
          await gmail.users.messages.modify({
            userId: gmailUserId,
            id: message.id,
            requestBody: {
              removeLabelIds: ['UNREAD'],
            },
          });
        }
      } catch (error) {
        logger.error(`Failed to process Gmail message ${message.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // Write index
    await fs.writeFile(
      path.join(emailsDir, 'index.json'),
      JSON.stringify(entries, null, 2),
      'utf-8'
    );
  } catch (error) {
    logger.error(`Gmail download failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  return entries;
}

/**
 * Extract email body from Gmail message payload
 */
export function extractEmailBody(payload: {
  mimeType?: string | null;
  body?: { data?: string | null } | null;
  parts?: Array<{
    mimeType?: string | null;
    body?: { data?: string | null } | null;
    parts?: Array<{ mimeType?: string | null; body?: { data?: string | null } | null }> | null;
  }> | null;
} | null | undefined): string {
  if (payload === null || payload === undefined) {
    return '';
  }

  // Try to find text/plain part
  if (payload.parts !== null && payload.parts !== undefined) {
    for (const part of payload.parts) {
      if (part === null || part === undefined) continue;

      if (part.mimeType === 'text/plain' && part.body?.data !== null && part.body?.data !== undefined) {
        return Buffer.from(part.body.data, 'base64').toString('utf-8');
      }

      // Check nested parts
      if (part.parts !== null && part.parts !== undefined) {
        for (const nestedPart of part.parts) {
          if (nestedPart === null || nestedPart === undefined) continue;
          if (nestedPart.mimeType === 'text/plain' && nestedPart.body?.data !== null && nestedPart.body?.data !== undefined) {
            return Buffer.from(nestedPart.body.data, 'base64').toString('utf-8');
          }
        }
      }
    }
  }

  // Fallback to top-level body
  if (payload.body?.data !== null && payload.body?.data !== undefined) {
    return Buffer.from(payload.body.data, 'base64').toString('utf-8');
  }

  return '';
}

/**
 * Deduplicate jobs by URL
 */
export function deduplicateByUrl(jobs: DiscoveredJob[]): DiscoveredJob[] {
  const seen = new Set<string>();
  const unique: DiscoveredJob[] = [];

  for (const job of jobs) {
    // Normalize URL: lowercase, strip query params
    if (job.url === undefined) {
      continue;
    }
    const normalized = job.url.toLowerCase().split('?')[0];

    if (normalized !== undefined && !seen.has(normalized)) {
      seen.add(normalized);
      unique.push(job);
    }
  }

  return unique;
}

/**
 * Main entry point
 */
export async function main(runDirArg?: string): Promise<void> {
  const args = process.argv.slice(2);
  await loadEnvFileIfProvided(args);
  const dataDir = runDirArg ?? await resolveRequiredRunDirFromCli(args);
  const discoveredJobsFile = getDiscoveredJobsFile(dataDir);

  logger.info('Starting discovery...');

  const secrets = await loadSecrets();
  const timestamp = new Date().toISOString();
  const log: DiscoveryLog = {
    timestamp,
    brave: { count: 0, errors: [] },
    linkedin: { count: 0, errors: [] },
    gmail: { count: 0, errors: [] },
  };

  try {
    // Discover from Brave
    const braveQueries = getBraveQueries();
    const braveJobs = await discoverViaBrave(secrets.braveApiKey, braveQueries);
    log.brave.count = braveJobs.length;
    logger.info(`Brave discovery: ${braveJobs.length} jobs`);

    // Discover from LinkedIn
    const linkedinJobs = await discoverViaLinkedIn(
      secrets.linkedinUsername,
      secrets.linkedinPassword
    );
    log.linkedin.count = linkedinJobs.length;
    logger.info(`LinkedIn discovery: ${linkedinJobs.length} jobs`);

    // Download Gmail emails
    const gmailEntries = await downloadGmailEmails(
      secrets.googleServiceAccountKey,
      secrets.googleGmailImpersonatedUser,
      dataDir
    );
    log.gmail.count = gmailEntries.length;
    logger.info(`Gmail download: ${gmailEntries.length} emails`);

    // Combine and deduplicate
    const allJobs = deduplicateByUrl([...braveJobs, ...linkedinJobs]);
    logger.info(`Total unique jobs after deduplication: ${allJobs.length}`);

    // Write discovered jobs
    const output: DiscoveryOutput = {
      jobs: allJobs,
      timestamp,
      stats: {
        total: allJobs.length,
        bySource: {
          gmail: 0,
          linkedin: linkedinJobs.length,
          brave: braveJobs.length,
        },
      },
    };

    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(
      discoveredJobsFile,
      JSON.stringify(output, null, 2),
      'utf-8'
    );
    logger.info(`Wrote discovered jobs to ${discoveredJobsFile}`);

    // Write discovery log
    await fs.writeFile(
      path.join(dataDir, 'discovery-log.json'),
      JSON.stringify(log, null, 2),
      'utf-8'
    );

    logger.success('Discovery complete');
  } catch (error) {
    logger.error(`Discovery failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  void main();
}
