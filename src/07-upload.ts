/**
 * 07-upload.ts — Upload
 *
 * Uploads job specs to OneDrive and PDFs to Google Drive.
 */

import { createReadStream, existsSync } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { google } from 'googleapis';
import { Client } from '@microsoft/microsoft-graph-client';
import type { PDFResult, UploadResult, UploadOutput } from './types';
import * as logger from './utils/logger';
import { getSecrets } from './utils/secrets';
import { retry, withTimeout } from './utils/http';
import { loadEnvFileIfProvided } from './utils/env-loader';

// Google Drive configuration
function getGoogleDriveFolderId(): string {
  return process.env.GOOGLE_DRIVE_FOLDER_ID ?? '';
}

interface UploadLog {
  timestamp: string;
  onedrive: { count: number; errors: string[] };
  googledrive: { count: number; errors: string[] };
}

interface GoogleDriveUploadResult {
  count: number;
  errors: string[];
  uploads: UploadResult[];
  folderId: string | undefined;
}

/**
 * Load credentials from environment
 */
async function loadCredentials(): Promise<{
  googleServiceAccount: string;
  googleDriveImpersonatedUser: string;
  oneDriveToken: string;
}> {
  return getSecrets({
    googleServiceAccount: 'GOOGLE_SERVICE_ACCOUNT_KEY',
    googleDriveImpersonatedUser: 'GOOGLE_DRIVE_IMPERSONATED_USER',
    oneDriveToken: 'ONEDRIVE_ACCESS_TOKEN',
  });
}

function resolveDataDir(): string {
  const envDir = process.env.JOB_HARVESTER_WORK_DIR;
  if (envDir === undefined || envDir === '') {
    throw new Error('JOB_HARVESTER_WORK_DIR is required. Set it in environment or via --env-file.');
  }
  return envDir;
}

function getSpecsDir(): string {
  return path.join(resolveDataDir(), 'specs');
}

function getPdfsDir(): string {
  return path.join(resolveDataDir(), 'pdfs');
}

function getCompiledResultsFile(): string {
  return path.join(resolveDataDir(), 'compile-results.json');
}

function getAllRejectionsFile(): string {
  return path.join(resolveDataDir(), 'all-rejections.json');
}

function getUploadResultsFile(): string {
  return path.join(resolveDataDir(), 'upload-results.json');
}

function getRunSummaryDir(): string {
  return path.join(resolveDataDir(), 'run-summary');
}

function getArchiveFolderName(runDir: string): string {
  const base = path.basename(runDir);
  if (base.startsWith('run-')) {
    return `archive-${base.slice(4)}`;
  }
  return `archive-${base}`;
}

/**
 * Upload specs to OneDrive
 */
export async function uploadSpecsToOneDrive(
  accessToken: string,
  specsDir: string,
  folderName: string,
  compileResultsFile: string,
  allRejectionsFile: string,
  summaryFiles: Array<{ name: string; path: string }>
): Promise<{ count: number; errors: string[] }> {
  const result = { count: 0, errors: [] as string[] };

  if (accessToken === '') {
    logger.warn('Skipping OneDrive upload - no access token');
    return result;
  }

  try {
    // Create Graph client
    const client = Client.init({
      authProvider: (done) => {
        done(null, accessToken);
      },
    });

    const folderPath = `JobSpecs/${folderName}`;

    // Get list of files to upload
    const files = await fs.readdir(specsDir);
    const specFiles = files.filter(f => f.endsWith('.json') || f.endsWith('.txt') || f.endsWith('.html'));

    // Also upload compile-results.json and all-rejections.json
    const extraFiles = [
      { name: 'compile-results.json', path: compileResultsFile },
      { name: 'all-rejections.json', path: allRejectionsFile },
      ...summaryFiles,
    ];

    // Upload spec files
    for (const file of specFiles) {
      try {
        const filePath = path.join(specsDir, file);
        const content = await fs.readFile(filePath);

        await withTimeout(
          retry(
            () => client.api(`/me/drive/root:/${folderPath}/${file}:/content`).put(content),
            { maxAttempts: 2, delayMs: 1000 }
          ),
          60000,
          `OneDrive upload ${file}`
        );

        result.count++;
        logger.info(`Uploaded to OneDrive: ${file}`);
      } catch (error) {
        const errorMsg = `Failed to upload ${file}: ${error instanceof Error ? error.message : String(error)}`;
        logger.error(errorMsg);
        result.errors.push(errorMsg);
      }
    }

    // Upload extra files
    for (const { name, path: filePath } of extraFiles) {
      try {
        const content = await fs.readFile(filePath);

        await withTimeout(
          retry(
            () => client.api(`/me/drive/root:/${folderPath}/${name}:/content`).put(content),
            { maxAttempts: 2, delayMs: 1000 }
          ),
          60000,
          `OneDrive upload ${name}`
        );

        result.count++;
        logger.info(`Uploaded to OneDrive: ${name}`);
      } catch (error) {
        const errorMsg = `Failed to upload ${name}: ${error instanceof Error ? error.message : String(error)}`;
        logger.error(errorMsg);
        result.errors.push(errorMsg);
      }
    }
  } catch (error) {
    const errorMsg = `OneDrive upload failed: ${error instanceof Error ? error.message : String(error)}`;
    logger.error(errorMsg);
    result.errors.push(errorMsg);
  }

  return result;
}

/**
 * Upload PDFs to Google Drive
 */
export async function uploadPdfsToGoogleDrive(
  serviceAccountKey: string,
  impersonatedUser: string,
  pdfs: PDFResult[],
  archiveFolderName: string,
  summaryFiles: Array<{ name: string; path: string }>
): Promise<GoogleDriveUploadResult> {
  const result: GoogleDriveUploadResult = {
    count: 0,
    errors: [],
    uploads: [],
    folderId: undefined,
  };

  if (serviceAccountKey === '') {
    logger.warn('Skipping Google Drive upload - no service account key');
    return result;
  }

  if (impersonatedUser === '') {
    logger.warn('Skipping Google Drive upload - no impersonated user');
    return result;
  }

  const GOOGLE_DRIVE_FOLDER_ID = getGoogleDriveFolderId();
  if (GOOGLE_DRIVE_FOLDER_ID === '') {
    logger.warn('Skipping Google Drive upload - no folder ID');
    return result;
  }

  try {
    // Parse service account key
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const credentials: { client_email: string; private_key: string } = JSON.parse(serviceAccountKey);
    const normalizedPrivateKey = credentials.private_key.includes('\\n')
      ? credentials.private_key.replace(/\\n/g, '\n')
      : credentials.private_key;

    const auth = new google.auth.JWT({
      email: credentials.client_email,
      key: normalizedPrivateKey,
      scopes: ['https://www.googleapis.com/auth/drive.file'],
      subject: impersonatedUser,
    });

    const drive = google.drive({ version: 'v3', auth });

    const folderResponse = await drive.files.create({
      requestBody: {
        name: archiveFolderName,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [GOOGLE_DRIVE_FOLDER_ID],
      },
      fields: 'id',
    });

    const archiveFolderId = folderResponse.data.id ?? undefined;
    if (archiveFolderId === undefined) {
      throw new Error('Failed to create archive folder in Google Drive');
    }
    result.folderId = archiveFolderId;

    // Upload each PDF
    for (const pdf of pdfs) {
      try {
        const filePath = pdf.pdfPath;
        if (!existsSync(filePath)) {
          const missingError = `Failed to upload ${filePath}: PDF file not found`;
          logger.error(missingError);
          result.errors.push(missingError);
          continue;
        }

        const fileName = path.basename(filePath);
        const response = await withTimeout(
          retry(
            () => drive.files.create({
              requestBody: {
                name: fileName,
                parents: [archiveFolderId],
              },
              media: {
                mimeType: 'application/pdf',
                body: createReadStream(filePath),
              },
              fields: 'id, webViewLink',
            }),
            { maxAttempts: 2, delayMs: 1000 }
          ),
          60000,
          `Google Drive upload ${fileName}`
        );

        const uploadResult: UploadResult = {
          jobId: pdf.jobId,
          company: pdf.company,
          title: pdf.title,
          pdfPath: pdf.pdfPath,
          oneDriveUrl: undefined,
          googleDriveUrl: response.data.webViewLink ?? undefined,
          uploadedAt: new Date().toISOString(),
        };

        result.uploads.push(uploadResult);
        result.count++;
        logger.info(`Uploaded to Google Drive: ${fileName} (${response.data.id ?? 'unknown'})`);
      } catch (error) {
        const errorMsg = `Failed to upload ${pdf.pdfPath}: ${error instanceof Error ? error.message : String(error)}`;
        logger.error(errorMsg);
        result.errors.push(errorMsg);
      }
    }

    for (const summaryFile of summaryFiles) {
      try {
        if (!existsSync(summaryFile.path)) {
          continue;
        }

        await withTimeout(
          retry(
            () => drive.files.create({
              requestBody: {
                name: summaryFile.name,
                parents: [archiveFolderId],
              },
              media: {
                mimeType: 'text/plain',
                body: createReadStream(summaryFile.path),
              },
              fields: 'id',
            }),
            { maxAttempts: 2, delayMs: 1000 }
          ),
          60000,
          `Google Drive upload ${summaryFile.name}`
        );

        result.count++;
        logger.info(`Uploaded to Google Drive: ${summaryFile.name}`);
      } catch (error) {
        const errorMsg = `Failed to upload ${summaryFile.path}: ${error instanceof Error ? error.message : String(error)}`;
        logger.error(errorMsg);
        result.errors.push(errorMsg);
      }
    }
  } catch (error) {
    const errorMsg = `Google Drive upload failed: ${error instanceof Error ? error.message : String(error)}`;
    logger.error(errorMsg);
    result.errors.push(errorMsg);
  }

  return result;
}

/**
 * Main entry point
 */
export async function main(): Promise<void> {
  await loadEnvFileIfProvided(process.argv.slice(2));
  logger.info('Starting upload...');
  const specsDir = getSpecsDir();
  const pdfsDir = getPdfsDir();
  const runSummaryDir = getRunSummaryDir();
  const compileResultsFile = getCompiledResultsFile();
  const allRejectionsFile = getAllRejectionsFile();
  const uploadResultsFile = getUploadResultsFile();
  const archiveFolderName = getArchiveFolderName(resolveDataDir());

  const credentials = await loadCredentials();
  const timestamp = new Date().toISOString();
  const summaryFiles = [
    { name: 'summary-log.txt', path: path.join(runSummaryDir, 'summary-log.txt') },
    { name: 'review-jobs.txt', path: path.join(runSummaryDir, 'review-jobs.txt') },
  ];

  const log: UploadLog = {
    timestamp,
    onedrive: { count: 0, errors: [] },
    googledrive: { count: 0, errors: [] },
  };

  try {
    // Upload specs to OneDrive
    const oneDriveResult = await uploadSpecsToOneDrive(
      credentials.oneDriveToken,
      specsDir,
      archiveFolderName,
      compileResultsFile,
      allRejectionsFile,
      summaryFiles
    );
    log.onedrive = oneDriveResult;
    logger.info(`OneDrive upload: ${oneDriveResult.count} files`);

    // Read PDF results
    const pdfResultsPath = path.join(pdfsDir, 'pdf-results.json');
    let pdfs: PDFResult[] = [];
    try {
      const pdfContent = await fs.readFile(pdfResultsPath, 'utf-8');
      const pdfData = JSON.parse(pdfContent) as { pdfs: PDFResult[] };
      if (!Array.isArray(pdfData.pdfs)) {
        throw new Error('Invalid pdf-results.json: expected { pdfs: PDFResult[] }');
      }
      pdfs = pdfData.pdfs.filter(p => p.pdfPath !== '');
    } catch {
      logger.warn('No PDF results found');
    }

    // Upload PDFs to Google Drive
    const googleDriveResult = await uploadPdfsToGoogleDrive(
      credentials.googleServiceAccount,
      credentials.googleDriveImpersonatedUser,
      pdfs,
      archiveFolderName,
      summaryFiles
    );
    log.googledrive = {
      count: googleDriveResult.count,
      errors: googleDriveResult.errors,
    };
    logger.info(`Google Drive upload: ${googleDriveResult.count} files`);

    // Write upload results
    const output: UploadOutput = {
      uploads: googleDriveResult.uploads,
      timestamp,
      archiveFolderName,
      ...(googleDriveResult.folderId !== undefined ? { googleDriveFolderId: googleDriveResult.folderId } : {}),
      stats: {
        total: pdfs.length,
        success: googleDriveResult.count,
        failed: googleDriveResult.errors.length,
      },
    };

    await fs.writeFile(
      uploadResultsFile,
      JSON.stringify(output, null, 2),
      'utf-8'
    );

    logger.success('Upload complete:');
    logger.info(`  OneDrive: ${log.onedrive.count} files`);
    logger.info(`  Google Drive: ${log.googledrive.count} files`);

    if (log.onedrive.errors.length > 0) {
      logger.warn(`  OneDrive errors: ${log.onedrive.errors.length}`);
    }
    if (log.googledrive.errors.length > 0) {
      logger.warn(`  Google Drive errors: ${log.googledrive.errors.length}`);
    }
  } catch (error) {
    logger.error(`Upload failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  void main();
}
