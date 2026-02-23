/**
 * 01-discover.ts — Discovery
 *
 * Discovers job postings from Brave Search API, LinkedIn browser, and Gmail (download only).
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { google } from 'googleapis';
import { chromium } from 'playwright';
import type { DiscoveredJob, DiscoveryOutput } from './types';
import { DISCOVERED_JOBS_FILE, EMAILS_DIR, DATA_DIR } from './config';
import * as logger from './utils/logger';
import { getSecrets } from './utils/secrets';
import { loadEnvFileIfProvided } from './utils/env-loader';

// Brave Search API configuration
const BRAVE_API_BASE = 'https://api.search.brave.com/res/v1/web/search';

// LinkedIn configuration
const LINKEDIN_BROWSER_PROFILE_DIR = process.env.LINKEDIN_PROFILE_DIR ?? './linkedin-profile';
const LINKEDIN_SEARCH_TERMS = ['CTO', 'Solution Architect', 'Software Engineering Manager'];

// Gmail configuration
const GMAIL_MAX_RESULTS = 40;
const GMAIL_LABEL = 'Jobs-2025-Adverts';

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

  if (apiKey === '') {
    logger.warn('Skipping Brave search - no API key');
    return jobs;
  }

  for (const query of queries) {
    try {
      const response = await fetch(
        `${BRAVE_API_BASE}?q=${encodeURIComponent(query)}&freshness=pw&count=20`,
        {
          headers: {
            'X-Subscription-Token': apiKey,
            'Accept': 'application/json',
          },
        }
      );

      if (response.status === 429) {
        logger.warn(`Brave API rate limit hit for query: ${query}`);
        errors.push(`Rate limit: ${query}`);
        continue;
      }

      if (!response.ok) {
        logger.error(`Brave API error: ${response.status} ${response.statusText}`);
        errors.push(`HTTP ${response.status}: ${query}`);
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

  if (username === '' || password === '') {
    logger.warn('Skipping LinkedIn search - no credentials');
    return jobs;
  }

  // Check if profile directory exists
  try {
    await fs.access(LINKEDIN_BROWSER_PROFILE_DIR);
  } catch {
    logger.error(`LinkedIn profile directory not found: ${LINKEDIN_BROWSER_PROFILE_DIR}`);
    return jobs;
  }

  const browser = await chromium.launchPersistentContext(LINKEDIN_BROWSER_PROFILE_DIR, {
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
      await page.waitForLoadState('networkidle');

      // Verify login succeeded
      const loginSuccess = await checkLinkedInLoginState(page);
      if (!loginSuccess) {
        logger.error('LinkedIn login failed');
        return jobs;
      }
    }

    logger.info('LinkedIn login successful');

    // Search for jobs
    for (const term of LINKEDIN_SEARCH_TERMS) {
      try {
        const searchUrl = `https://www.linkedin.com/jobs/search?keywords=${encodeURIComponent(term)}&location=Zurich`;
        await page.goto(searchUrl);
        await page.waitForLoadState('networkidle');

        // Extract job cards
        const jobCards = await page.$$('[data-job-id]');
        logger.info(`LinkedIn search for "${term}": ${jobCards.length} job cards found`);

        for (const card of jobCards) {
          try {
            const title = await card.$eval('.job-card-list__title', (el: Element) => (el.textContent ?? '').trim());
            const company = await card.$eval('.job-card-container__company-name', (el: Element) => (el.textContent ?? '').trim());
            const href = await card.$eval('a', (el: Element) => el.getAttribute('href') ?? '');

            if (title !== '' && company !== '' && href !== '') {
              // Strip query params from URL
              const url = `https://www.linkedin.com${href.split('?')[0]}`;

              jobs.push({
                id: `linkedin-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                company,
                title,
                url,
                source: 'linkedin',
                discoveredAt: new Date().toISOString(),
              });
            }
          } catch {
            // Skip cards that can't be parsed
          }
        }
      } catch (error) {
        logger.error(`LinkedIn search failed for "${term}": ${error instanceof Error ? error.message : String(error)}`);
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
  impersonatedUser: string
): Promise<GmailEmailEntry[]> {
  const entries: GmailEmailEntry[] = [];
  const gmailUserId = getGmailUserId();
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
    const auth = new google.auth.JWT({
      email: credentials.client_email,
      key: credentials.private_key,
      scopes: ['https://www.googleapis.com/auth/gmail.modify'],
      subject: impersonatedUser,
    });

    const gmail = google.gmail({ version: 'v1', auth });

    // List unread messages in Jobs label
    const listResponse = await gmail.users.messages.list({
      userId: gmailUserId,
      labelIds: [GMAIL_LABEL],
      q: 'is:unread',
      maxResults: GMAIL_MAX_RESULTS,
    });

    const messages = listResponse.data.messages ?? [];
    logger.info(`Gmail: ${messages.length} unread messages found`);

    // Ensure emails directory exists
    await fs.mkdir(EMAILS_DIR, { recursive: true });

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
        const filePath = path.join(EMAILS_DIR, fileName);
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
      path.join(EMAILS_DIR, 'index.json'),
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
export async function main(): Promise<void> {
  await loadEnvFileIfProvided(process.argv.slice(2));

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
    const braveQueries = [
      'software engineer jobs Switzerland',
      'backend developer remote',
      'software engineer remote',
    ];
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
      secrets.googleGmailImpersonatedUser
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

    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(
      DISCOVERED_JOBS_FILE,
      JSON.stringify(output, null, 2),
      'utf-8'
    );
    logger.info(`Wrote discovered jobs to ${DISCOVERED_JOBS_FILE}`);

    // Write discovery log
    await fs.writeFile(
      path.join(DATA_DIR, 'discovery-log.json'),
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
