/**
 * 05-generate-pdfs.ts — Generate PDFs
 *
 * Generates PDFs for PASS and REVIEW jobs using Playwright.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { chromium, type Page } from 'playwright';
import type { CompiledJob, PDFResult, PDFOutput } from './types';
import { COMPILED_RESULTS_FILE, PDFS_DIR, PDF_CONFIG } from './config';
import { slugify } from './utils/slugify';
import * as logger from './utils/logger';
import { loadEnvFileIfProvided } from './utils/env-loader';

interface JobWithTier extends CompiledJob {
  tier: 'passed' | 'review';
}

/**
 * Build filename for PDF
 */
export function buildFilename(job: JobWithTier): string {
  const prefix = job.tier === 'review' ? 'REVIEW-' : '';
  const date = job.compiledAt.split('T')[0];
  const companySlug = slugify(job.company);
  return `${prefix}${date}-${companySlug}-advert.pdf`;
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
    <div class="title">${job.title}</div>
    <div class="company">${job.company}</div>
    <div class="meta">Source: <a href="${job.url}">${job.url}</a></div>
    <div class="score">${scoreBadge}</div>
    <div style="font-style: italic; color: #666; margin-top: 10px;">${job.reasoning}</div>
  </div>
  
  <div class="description">${escapeHtml(job.specText)}</div>
  
  <div class="footer">Generated: ${new Date().toISOString()}<br>
    Job ID: ${job.jobId}
  </div>
</body>
</html>`;
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
export async function main(): Promise<void> {
  await loadEnvFileIfProvided(process.argv.slice(2));
  logger.info('Starting PDF generation...');

  try {
    // Read compiled results
    const compiledContent = await fs.readFile(COMPILED_RESULTS_FILE, 'utf-8');
    const compiled = JSON.parse(compiledContent) as { jobs?: CompiledJob[] };
    if (!Array.isArray(compiled.jobs)) {
      throw new Error('Invalid compile results input: expected { jobs: CompiledJob[] }');
    }

    logger.info(`Loaded ${compiled.jobs.length} compiled jobs`);

    // Ensure PDFs directory exists
    await fs.mkdir(PDFS_DIR, { recursive: true });

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
          const result = await generateJobPdf(job, PDFS_DIR, page);
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
          const result = await generateJobPdf(job, PDFS_DIR, page);
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
      path.join(PDFS_DIR, 'pdf-results.json'),
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
