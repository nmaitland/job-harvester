/**
 * send-digest.ts — Email a short, phone-sized digest of the run
 *
 * Lists the PASS/REVIEW jobs (score >= 4) with links, and still sends when nothing
 * scored well, so a missing email means the run itself did not finish.
 *
 * Sent through Gmail SMTP with an app password (SMTP_USER / SMTP_PASSWORD). Skipped
 * with a warning when those are unset, which is the normal local case. A send failure
 * throws so the scheduled run is marked failed and Render's failure alert fires.
 */

import * as nodemailer from 'nodemailer';
import type { CompiledJob } from './types';
import * as logger from './utils/logger';
import { loadEnvFileIfProvided } from './utils/env-loader';
import { resolveRequiredRunDirFromCli } from './utils/run-dir';
import { getSecrets } from './utils/secrets';
import { collectFacts, sanitizeTitle } from './summarize-run';
import type { RunFacts } from './summarize-run';

const MAX_LISTED = 15;
const REASON_MAX_CHARS = 110;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function shortReason(reasoning: string): string {
  const firstSentence = reasoning.trim().split(/(?<=[.!?])\s/)[0] ?? '';
  return firstSentence.length > REASON_MAX_CHARS
    ? `${firstSentence.slice(0, REASON_MAX_CHARS - 1).trimEnd()}…`
    : firstSentence;
}

function renderJob(job: CompiledJob): string {
  const title = escapeHtml(sanitizeTitle(job.title));
  const url = escapeHtml(job.url.trim());
  return [
    '<p style="margin:0 0 14px">',
    `<b>${job.score}</b> · <a href="${url}">${title}</a><br>`,
    `${escapeHtml(job.company.trim())}<br>`,
    `<span style="color:#666">${escapeHtml(shortReason(job.reasoning))}</span>`,
    '</p>',
  ].join('');
}

/**
 * Build subject and HTML body. `reviewable` is expected sorted best-first.
 */
export function buildDigest(facts: RunFacts, reviewable: CompiledJob[]): { subject: string; html: string } {
  const runDay = facts.runDate.slice(0, 10);
  const subject = reviewable.length === 0
    ? `Jobs ${runDay}: nothing new`
    : `Jobs ${runDay}: ${reviewable.length} worth a look`;

  const parts: string[] = [];
  if (reviewable.length === 0) {
    parts.push('<p>Nothing scored 4+ today.</p>');
  } else {
    parts.push(...reviewable.slice(0, MAX_LISTED).map(renderJob));
    if (reviewable.length > MAX_LISTED) {
      parts.push(`<p>+${reviewable.length - MAX_LISTED} more in Drive.</p>`);
    }
  }

  // Catches a dead Brightdata key or similar: the run "succeeds" but sees almost nothing.
  if (facts.fetchedFailed > facts.fetchedSuccess) {
    parts.push('<p><b>Most spec fetches failed — check the logs.</b></p>');
  }

  parts.push(
    `<p style="color:#888;font-size:12px">${facts.discovered} found · ${facts.fetchedSuccess} fetched · ` +
    `${facts.fetchedFailed} fetch failed · ${facts.survivors} scored</p>`
  );

  return {
    subject,
    html: `<div style="font-family:sans-serif;font-size:15px;line-height:1.35">${parts.join('')}</div>`,
  };
}

/**
 * Send the digest. Returns false when SMTP is not configured.
 */
export async function sendDigest(runDir: string): Promise<boolean> {
  const secrets = await getSecrets({ user: 'SMTP_USER', password: 'SMTP_PASSWORD' });
  if (secrets.user === '' || secrets.password === '') {
    logger.warn('Digest email SKIPPED: SMTP_USER / SMTP_PASSWORD not set.');
    return false;
  }

  const configuredTo = process.env.DIGEST_EMAIL_TO ?? '';
  const to = configuredTo === '' ? secrets.user : configuredTo;

  const { facts, reviewable } = await collectFacts(runDir);
  const { subject, html } = buildDigest(facts, reviewable);

  const transport = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: secrets.user, pass: secrets.password },
  });
  await transport.sendMail({ from: secrets.user, to, subject, html });

  logger.info(`Digest emailed to ${to}: ${subject}`);
  return true;
}

export async function main(runDirArg?: string): Promise<void> {
  const argv = process.argv.slice(2);
  await loadEnvFileIfProvided(argv);
  const runDir = runDirArg ?? await resolveRequiredRunDirFromCli(argv);
  await sendDigest(runDir);
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    logger.error(`Send digest failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
