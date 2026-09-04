/**
 * drive-sync.ts — Google Drive persistence for cross-run state
 *
 * Scheduled runs (GitHub Actions, Render, any ephemeral runner) start with a clean
 * filesystem, so `processed-urls.json` would reset every run and the pipeline would
 * re-process every job it has already seen. This module keeps that registry in the
 * same Google Drive folder the run output is uploaded to: pulled before discovery,
 * pushed after upload.
 *
 * Uses the `drive.file` scope already granted to the service account. That scope only
 * covers files the application itself created, which is sufficient here because this
 * module both creates and maintains the registry file.
 *
 * Every operation is best-effort: a Drive failure is logged and reported, never thrown,
 * so a sync problem degrades deduplication rather than failing the run.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { google } from 'googleapis';
import type { drive_v3 } from 'googleapis';
import * as logger from './logger';
import { retry, withTimeout } from './http';

const PROCESSED_URLS_FILENAME = 'processed-urls.json';
const DRIVE_TIMEOUT_MS = 60000;
const DRIVE_RETRY = { maxAttempts: 2, delayMs: 1000 } as const;

export interface DriveSyncConfig {
  serviceAccountKey: string;
  impersonatedUser: string;
  folderId: string;
}

/**
 * Read Drive sync configuration from the environment.
 *
 * Returns null when any required value is absent, which is the normal case for local
 * runs: the caller then skips syncing and uses the on-disk registry as before.
 */
export function resolveDriveSyncConfig(): DriveSyncConfig | null {
  const serviceAccountKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY ?? '';
  const impersonatedUser = process.env.GOOGLE_DRIVE_IMPERSONATED_USER ?? '';
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID ?? '';

  if (serviceAccountKey === '' || impersonatedUser === '' || folderId === '') {
    return null;
  }

  return { serviceAccountKey, impersonatedUser, folderId };
}

/**
 * Build an authenticated Drive client using the service account's domain-wide delegation.
 */
export function createDriveClient(config: DriveSyncConfig): drive_v3.Drive {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const credentials: { client_email: string; private_key: string } = JSON.parse(config.serviceAccountKey);

  const normalizedPrivateKey = credentials.private_key.includes('\\n')
    ? credentials.private_key.replace(/\\n/g, '\n')
    : credentials.private_key;

  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: normalizedPrivateKey,
    scopes: ['https://www.googleapis.com/auth/drive.file'],
    subject: config.impersonatedUser,
  });

  return google.drive({ version: 'v3', auth });
}

function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * Locate the registry file in the configured Drive folder.
 *
 * Returns the file id, or undefined on the very first run when it does not exist yet.
 */
export async function findRegistryFileId(
  drive: drive_v3.Drive,
  folderId: string
): Promise<string | undefined> {
  const nameClause = `name = '${escapeDriveQueryValue(PROCESSED_URLS_FILENAME)}'`;
  const parentClause = `'${escapeDriveQueryValue(folderId)}' in parents`;

  const response = await withTimeout(
    retry(
      () => drive.files.list({
        q: `${nameClause} and ${parentClause} and trashed = false`,
        fields: 'files(id, modifiedTime)',
        orderBy: 'modifiedTime desc',
        pageSize: 1,
      }),
      DRIVE_RETRY
    ),
    DRIVE_TIMEOUT_MS,
    'Drive registry lookup'
  );

  const files = response.data.files ?? [];
  const first = files[0];
  if (first === undefined) {
    return undefined;
  }

  return first.id ?? undefined;
}

/**
 * Download the registry from Drive into the management data directory.
 *
 * Returns true when a registry was written locally, false when there was nothing to
 * pull or the pull failed. A false result is not fatal — the run continues with an
 * empty registry, which costs deduplication but produces correct output.
 */
export async function pullProcessedUrls(
  managementDataDir: string,
  config: DriveSyncConfig
): Promise<boolean> {
  try {
    const drive = createDriveClient(config);
    const fileId = await findRegistryFileId(drive, config.folderId);

    if (fileId === undefined) {
      logger.info(`No ${PROCESSED_URLS_FILENAME} in Drive yet — starting a fresh registry`);
      return false;
    }

    const response = await withTimeout(
      retry(
        () => drive.files.get({ fileId, alt: 'media' }, { responseType: 'text' }),
        DRIVE_RETRY
      ),
      DRIVE_TIMEOUT_MS,
      'Drive registry download'
    );

    const raw: unknown = response.data;
    const content = typeof raw === 'string' ? raw : JSON.stringify(raw);

    await fs.mkdir(managementDataDir, { recursive: true });
    await fs.writeFile(path.join(managementDataDir, PROCESSED_URLS_FILENAME), content, 'utf-8');

    logger.info(`Pulled ${PROCESSED_URLS_FILENAME} from Drive (${content.length} bytes)`);
    return true;
  } catch (error) {
    logger.warn(
      `Could not pull ${PROCESSED_URLS_FILENAME} from Drive, continuing with local state: ` +
        `${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  }
}

/**
 * Upload the local registry back to Drive, updating the existing file when present.
 *
 * Returns true when the registry reached Drive. A false result means the next run will
 * fall back to whatever is already stored there.
 */
export async function pushProcessedUrls(
  managementDataDir: string,
  config: DriveSyncConfig
): Promise<boolean> {
  try {
    const localPath = path.join(managementDataDir, PROCESSED_URLS_FILENAME);

    let content: string;
    try {
      content = await fs.readFile(localPath, 'utf-8');
    } catch {
      logger.info(`No local ${PROCESSED_URLS_FILENAME} to push to Drive`);
      return false;
    }

    const drive = createDriveClient(config);
    const existingFileId = await findRegistryFileId(drive, config.folderId);

    if (existingFileId === undefined) {
      await withTimeout(
        retry(
          () => drive.files.create({
            requestBody: {
              name: PROCESSED_URLS_FILENAME,
              parents: [config.folderId],
            },
            media: { mimeType: 'application/json', body: content },
            fields: 'id',
          }),
          DRIVE_RETRY
        ),
        DRIVE_TIMEOUT_MS,
        'Drive registry create'
      );

      logger.info(`Created ${PROCESSED_URLS_FILENAME} in Drive (${content.length} bytes)`);
      return true;
    }

    await withTimeout(
      retry(
        () => drive.files.update({
          fileId: existingFileId,
          media: { mimeType: 'application/json', body: content },
          fields: 'id',
        }),
        DRIVE_RETRY
      ),
      DRIVE_TIMEOUT_MS,
      'Drive registry update'
    );

    logger.info(`Updated ${PROCESSED_URLS_FILENAME} in Drive (${content.length} bytes)`);
    return true;
  } catch (error) {
    logger.warn(
      `Could not push ${PROCESSED_URLS_FILENAME} to Drive, next run may re-process jobs: ` +
        `${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  }
}
