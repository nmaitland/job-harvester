/**
 * generate-pdfs.ts — Generate PDFs
 *
 * Generates PDFs for PASS and REVIEW jobs using Playwright.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { chromium, type Page } from 'playwright';
import type { CompiledJob, PDFResult, PDFOutput } from './types';
import { PDF_CONFIG } from './config';
import { slugify } from './utils/slugify';
import * as logger from './utils/logger';
import { loadEnvFileIfProvided, parseEnvFileArg } from './utils/env-loader';
import { resolveRequiredRunDirFromCli } from './utils/run-dir';

interface JobWithTier extends CompiledJob {
  tier: 'passed' | 'review';
}

function getCompiledResultsFile(runDir: string): string {
  return path.join(runDir, 'compile-results.json');
}

function getPdfsDir(runDir: string): string {
  return path.join(runDir, 'pdfs');
}

async function loadDefaultEnvIfNeeded(args: string[]): Promise<void> {
  const { envFile } = parseEnvFileArg(args);
  if (envFile !== undefined && envFile !== '') {
    return;
  }

  for (const candidate of ['.env', '.env.dev']) {
    try {
      await fs.access(candidate);
      await loadEnvFileIfProvided(['--env-file', candidate]);
      return;
    } catch {
      // Try next candidate.
    }
  }
}

/**
 * Build filename for PDF
 */
export function buildFilename(job: JobWithTier): string {
  const date = job.compiledAt.split('T')[0] ?? 'unknown-date';
  const score = Math.max(0, Math.min(10, Math.round(job.score)));
  const companySlug = slugify(job.company);
  return `${date}-S${score}-${companySlug}-advert.pdf`;
}

/**
 * Render HTML template for job
 */
export function renderJobHtml(job: CompiledJob): string {
  const scoreBadge = job.score >= 7
    ? `<span style="background: #4CAF50; color: white; padding: 4px 8px; border-radius: 4px;">PASS ${job.score}/10</span>`
    : `<span style="background: #FF9800; color: white; padding: 4px 8px; border-radius: 4px;">REVIEW ${job.score}/10</span>`;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${job.title} at ${job.company}</title>
  <style>
    body {
      font-family: Arial, sans-serif;
      line-height: 1.6;
      max-width: 800px;
      margin: 0 auto;
      padding: 40px;
    }
    .header {
      border-bottom: 2px solid #333;
      padding-bottom: 20px;
      margin-bottom: 30px;
    }
    .title {
      font-size: 28px;
      font-weight: bold;
      margin-bottom: 10px;
    }
    .company {
      font-size: 20px;
      color: #666;
      margin-bottom: 10px;
    }
    .meta {
      color: #999;
      font-size: 14px;
      margin-bottom: 15px;
    }
    .score {
      margin: 15px 0;
    }
    .description {
      margin-top: 30px;
      white-space: pre-wrap;
    }
    .footer {
      margin-top: 40px;
      padding-top: 20px;
      border-top: 1px solid #ccc;
      font-size: 12px;
      color: #999;
    }
    a {
      color: #1976D2;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="title">${sanitizeForHtml(job.title)}</div>
    <div class="company">${sanitizeForHtml(job.company)}</div>
    <div class="meta">Source: <a href="${job.url}">${job.url}</a></div>
    <div class="score">${scoreBadge}</div>
    <div style="font-style: italic; color: #666; margin-top: 10px;">${sanitizeForHtml(job.reasoning)}</div>
  </div>

  <div class="description">${sanitizeForHtml(job.specText)}</div>
  
  <div class="footer">Generated: ${new Date().toISOString()}<br>
    Job ID: ${job.jobId}
  </div>
</body>
</html>`;
}

/**
 * Decode HTML entities to their actual characters.
 * Handles named entities, hex numeric (&#xNNNN;), and decimal numeric (&#NNNN;).
 * Must be applied before escapeHtml to avoid double-encoding.
 */
export function decodeHtmlEntities(text: string): string {
  const namedEntities: Record<string, string> = {
    '&amp;': '&',
    '&apos;': "'",
    '&quot;': '"',
    '&lt;': '<',
    '&gt;': '>',
    '&nbsp;': '\u00A0',
    '&ndash;': '\u2013',
    '&mdash;': '\u2014',
    '&lsquo;': '\u2018',
    '&rsquo;': '\u2019',
    '&ldquo;': '\u201C',
    '&rdquo;': '\u201D',
    '&hellip;': '\u2026',
    '&bull;': '\u2022',
    '&trade;': '\u2122',
    '&copy;': '\u00A9',
    '&reg;': '\u00AE',
  };

  return text
    // Hex numeric entities: &#xNNNN;
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex: string) =>
      String.fromCodePoint(parseInt(hex, 16)))
    // Decimal numeric entities: &#NNNN;
    .replace(/&#(\d+);/g, (_match, dec: string) =>
      String.fromCodePoint(parseInt(dec, 10)))
    // Named entities (case-insensitive)
    .replace(/&[a-zA-Z]+;/g, (entity) =>
      namedEntities[entity.toLowerCase()] ?? entity);
}

/**
 * Escape HTML special characters
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Decode HTML entities then escape for safe HTML insertion.
 */
function sanitizeForHtml(text: string): string {
  return escapeHtml(decodeHtmlEntities(text));
}

/**
 * Generate PDF for a job
 */
export async function generateJobPdf(
  job: JobWithTier,
  outputDir: string,
  page: Page
): Promise<PDFResult> {
  const filename = buildFilename(job);
  const outputPath = path.join(outputDir, filename);

  try {
    // Render HTML
    const html = renderJobHtml(job);

    // Generate PDF
    await page.setContent(html);
    await page.pdf({
      path: outputPath,
      format: PDF_CONFIG.FORMAT,
    });

    logger.info(`Generated PDF: ${filename}`);

    return {
      jobId: job.jobId,
      company: job.company,
      title: job.title,
      pdfPath: outputPath,
      generatedAt: new Date().toISOString(),
    };
  } catch (error) {
    logger.error(`Failed to generate PDF for ${job.company}: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

/**
 * Main entry point
 */
export async function main(runDirArg?: string): Promise<void> {
  const args = process.argv.slice(2);
  await loadEnvFileIfProvided(args);
  await loadDefaultEnvIfNeeded(args);
  const runDir = runDirArg ?? await resolveRequiredRunDirFromCli(args);
  logger.info('Starting PDF generation...');
  const compiledResultsFile = getCompiledResultsFile(runDir);
  const pdfsDir = getPdfsDir(runDir);

  try {
    // Read compiled results
    const compiledContent = await fs.readFile(compiledResultsFile, 'utf-8');
    const compiled = JSON.parse(compiledContent) as { jobs?: CompiledJob[] };
    if (!Array.isArray(compiled.jobs)) {
      throw new Error('Invalid compile results input: expected { jobs: CompiledJob[] }');
    }

    logger.info(`Loaded ${compiled.jobs.length} compiled jobs`);

    // Ensure PDFs directory exists
    await fs.mkdir(pdfsDir, { recursive: true });

    // Separate passed and review jobs
    const passedJobs: JobWithTier[] = compiled.jobs
      .filter(j => j.score >= 7)
      .map(j => ({ ...j, tier: 'passed' }));

    const reviewJobs: JobWithTier[] = compiled.jobs
      .filter(j => j.score >= 4 && j.score < 7)
      .map(j => ({ ...j, tier: 'review' }));

    logger.info(`Generating PDFs: ${passedJobs.length} passed, ${reviewJobs.length} review`);

    // Launch browser once for all jobs
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    const pdfs: PDFResult[] = [];
    let successCount = 0;
    let failedCount = 0;

    try {
      // Process passed jobs
      for (const job of passedJobs) {
        try {
          const result = await generateJobPdf(job, pdfsDir, page);
          pdfs.push(result);
          successCount++;
        } catch (error) {
          failedCount++;
          logger.error(`Failed to generate PDF for ${job.company}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      // Process review jobs
      for (const job of reviewJobs) {
        try {
          const result = await generateJobPdf(job, pdfsDir, page);
          pdfs.push(result);
          successCount++;
        } catch (error) {
          failedCount++;
          logger.error(`Failed to generate PDF for ${job.company}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } finally {
      await browser.close();
    }

    // Write results
    const output: PDFOutput = {
      pdfs,
      timestamp: new Date().toISOString(),
      stats: {
        total: passedJobs.length + reviewJobs.length,
        success: successCount,
        failed: failedCount,
      },
    };

    await fs.writeFile(
      path.join(pdfsDir, 'pdf-results.json'),
      JSON.stringify(output, null, 2),
      'utf-8'
    );

    logger.success('PDF generation complete:');
    logger.info(`  Total: ${output.stats.total}`);
    logger.info(`  Success: ${output.stats.success}`);
    logger.info(`  Failed: ${output.stats.failed}`);
  } catch (error) {
    logger.error(`PDF generation failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  void main();
}
