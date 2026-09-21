/**
 * Tests for utils/drive-sync.ts
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { google } from 'googleapis';
import {
  resolveDriveSyncConfig,
  findRegistryFileId,
  PULL_ONLY_STATE_FILES,
  pullOperatorStateFiles,
  pullProcessedUrls,
  pullStateFile,
  pushProcessedUrls,
  type DriveSyncConfig,
} from '../utils/drive-sync';

jest.mock('fs/promises');

jest.mock('../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
}));

// Bypass retry/timeout wrappers so failure cases resolve immediately
jest.mock('../utils/http', () => ({
  retry: jest.fn((fn: () => Promise<unknown>) => fn()),
  withTimeout: jest.fn((promise: Promise<unknown>) => promise),
}));

const mockFilesList = jest.fn();
const mockFilesGet = jest.fn();
const mockFilesCreate = jest.fn();
const mockFilesUpdate = jest.fn();

jest.mock('googleapis', () => ({
  google: {
    auth: {
      JWT: jest.fn().mockImplementation(() => ({})),
    },
    drive: jest.fn(),
  },
}));

const mockedFs = fs as jest.Mocked<typeof fs>;
const mockedGoogle = google as jest.Mocked<typeof google>;

const SERVICE_ACCOUNT_KEY = JSON.stringify({
  client_email: 'harvester@example.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n',
});

const CONFIG: DriveSyncConfig = {
  serviceAccountKey: SERVICE_ACCOUNT_KEY,
  impersonatedUser: 'harvester@example.com',
  folderId: 'folder-123',
};

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...ORIGINAL_ENV };

  (mockedGoogle.drive as unknown as jest.Mock).mockReturnValue({
    files: {
      list: mockFilesList,
      get: mockFilesGet,
      create: mockFilesCreate,
      update: mockFilesUpdate,
    },
  });
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe('resolveDriveSyncConfig', () => {
  it('returns a config when all three variables are set', () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY = SERVICE_ACCOUNT_KEY;
    process.env.GOOGLE_DRIVE_IMPERSONATED_USER = 'harvester@example.com';
    process.env.GOOGLE_DRIVE_FOLDER_ID = 'folder-123';

    expect(resolveDriveSyncConfig()).toEqual(CONFIG);
  });

  it.each([
    'GOOGLE_SERVICE_ACCOUNT_KEY',
    'GOOGLE_DRIVE_IMPERSONATED_USER',
    'GOOGLE_DRIVE_FOLDER_ID',
  ])('returns null when %s is missing', (missing) => {
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY = SERVICE_ACCOUNT_KEY;
    process.env.GOOGLE_DRIVE_IMPERSONATED_USER = 'harvester@example.com';
    process.env.GOOGLE_DRIVE_FOLDER_ID = 'folder-123';
    delete process.env[missing];

    expect(resolveDriveSyncConfig()).toBeNull();
  });

  it('treats an empty string as unset', () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY = SERVICE_ACCOUNT_KEY;
    process.env.GOOGLE_DRIVE_IMPERSONATED_USER = 'harvester@example.com';
    process.env.GOOGLE_DRIVE_FOLDER_ID = '';

    expect(resolveDriveSyncConfig()).toBeNull();
  });
});

describe('findRegistryFileId', () => {
  it('returns the id of a matching file scoped to the configured folder', async () => {
    mockFilesList.mockResolvedValue({ data: { files: [{ id: 'file-abc' }] } });

    const drive = (mockedGoogle.drive as unknown as jest.Mock)() as Parameters<typeof findRegistryFileId>[0];
    const id = await findRegistryFileId(drive, 'folder-123');

    expect(id).toBe('file-abc');
    const query = mockFilesList.mock.calls[0]?.[0] as { q: string } | undefined;
    expect(query?.q).toContain("name = 'processed-urls.json'");
    expect(query?.q).toContain("'folder-123' in parents");
    expect(query?.q).toContain('trashed = false');
  });

  it('returns undefined when the folder holds no registry', async () => {
    mockFilesList.mockResolvedValue({ data: { files: [] } });

    const drive = (mockedGoogle.drive as unknown as jest.Mock)() as Parameters<typeof findRegistryFileId>[0];
    await expect(findRegistryFileId(drive, 'folder-123')).resolves.toBeUndefined();
  });
});

describe('pullProcessedUrls', () => {
  it('writes the downloaded registry to the management data directory', async () => {
    mockFilesList.mockResolvedValue({ data: { files: [{ id: 'file-abc' }] } });
    mockFilesGet.mockResolvedValue({ data: '{"version":1,"urls":[]}' });

    const result = await pullProcessedUrls('/mgmt', CONFIG);

    expect(result).toBe(true);
    expect(mockedFs.mkdir).toHaveBeenCalledWith('/mgmt', { recursive: true });
    expect(mockedFs.writeFile).toHaveBeenCalledWith(
      path.join('/mgmt', 'processed-urls.json'),
      '{"version":1,"urls":[]}',
      'utf-8'
    );
  });

  it('serialises a parsed JSON body back to text', async () => {
    mockFilesList.mockResolvedValue({ data: { files: [{ id: 'file-abc' }] } });
    mockFilesGet.mockResolvedValue({ data: { version: 1, urls: [] } });

    await pullProcessedUrls('/mgmt', CONFIG);

    expect(mockedFs.writeFile).toHaveBeenCalledWith(
      path.join('/mgmt', 'processed-urls.json'),
      '{"version":1,"urls":[]}',
      'utf-8'
    );
  });

  it('returns false without writing when Drive has no registry yet', async () => {
    mockFilesList.mockResolvedValue({ data: { files: [] } });

    await expect(pullProcessedUrls('/mgmt', CONFIG)).resolves.toBe(false);
    expect(mockedFs.writeFile).not.toHaveBeenCalled();
  });

  it('swallows Drive errors so the pipeline continues', async () => {
    mockFilesList.mockRejectedValue(new Error('drive unavailable'));

    await expect(pullProcessedUrls('/mgmt', CONFIG)).resolves.toBe(false);
  });
});

describe('pushProcessedUrls', () => {
  it('creates the registry when Drive does not have one', async () => {
    mockedFs.readFile.mockResolvedValue('{"version":1,"urls":[]}' as never);
    mockFilesList.mockResolvedValue({ data: { files: [] } });
    mockFilesCreate.mockResolvedValue({ data: { id: 'new-file' } });

    const result = await pushProcessedUrls('/mgmt', CONFIG);

    expect(result).toBe(true);
    expect(mockFilesUpdate).not.toHaveBeenCalled();
    const createArg = mockFilesCreate.mock.calls[0]?.[0] as
      | { requestBody: { name: string; parents: string[] } }
      | undefined;
    expect(createArg?.requestBody.name).toBe('processed-urls.json');
    expect(createArg?.requestBody.parents).toEqual(['folder-123']);
  });

  it('updates the existing registry in place rather than creating a duplicate', async () => {
    mockedFs.readFile.mockResolvedValue('{"version":1,"urls":[]}' as never);
    mockFilesList.mockResolvedValue({ data: { files: [{ id: 'file-abc' }] } });
    mockFilesUpdate.mockResolvedValue({ data: { id: 'file-abc' } });

    const result = await pushProcessedUrls('/mgmt', CONFIG);

    expect(result).toBe(true);
    expect(mockFilesCreate).not.toHaveBeenCalled();
    const updateArg = mockFilesUpdate.mock.calls[0]?.[0] as { fileId: string } | undefined;
    expect(updateArg?.fileId).toBe('file-abc');
  });

  it('returns false when there is no local registry to push', async () => {
    mockedFs.readFile.mockRejectedValue(new Error('ENOENT'));

    await expect(pushProcessedUrls('/mgmt', CONFIG)).resolves.toBe(false);
    expect(mockFilesCreate).not.toHaveBeenCalled();
    expect(mockFilesUpdate).not.toHaveBeenCalled();
  });

  it('swallows Drive errors so the run still reports success', async () => {
    mockedFs.readFile.mockResolvedValue('{"version":1,"urls":[]}' as never);
    mockFilesList.mockRejectedValue(new Error('drive unavailable'));

    await expect(pushProcessedUrls('/mgmt', CONFIG)).resolves.toBe(false);
  });
});


describe('operator-maintained state files', () => {
  it('pulls every file the operator owns, not just the registry', async () => {
    mockFilesList.mockResolvedValue({ data: { files: [{ id: 'file-abc' }] } });
    mockFilesGet.mockResolvedValue({ data: 'Acme Corp\nGlobex' });

    const results = await pullOperatorStateFiles('/mgmt', CONFIG);

    expect(Object.keys(results).sort()).toEqual(
      [...PULL_ONLY_STATE_FILES].sort()
    );
    for (const filename of PULL_ONLY_STATE_FILES) {
      expect(mockedFs.writeFile).toHaveBeenCalledWith(
        path.join('/mgmt', filename),
        'Acme Corp\nGlobex',
        'utf-8'
      );
    }
  });

  it('keeps going when one file is missing', async () => {
    // A stale keyword list still beats no run, so one absent file must not stop the
    // others — on an ephemeral runner "stopped" means the whole pipeline loses its
    // filters, not just one.
    mockFilesList
      .mockResolvedValueOnce({ data: { files: [] } })
      .mockResolvedValue({ data: { files: [{ id: 'file-def' }] } });
    mockFilesGet.mockResolvedValue({ data: 'keywords' });

    const results = await pullOperatorStateFiles('/mgmt', CONFIG);

    const values = Object.values(results);
    expect(values).toContain(false);
    expect(values).toContain(true);
  });

  it('never offers a push for an operator-owned file', () => {
    // applied-companies.txt records a HUMAN act. If the pipeline could write it,
    // "we sent you this job" would eventually be mistaken for "you applied", and the
    // filter would start hiding roles that were never applied for. The absence of a
    // push path is the guarantee; this test fails if one is ever added.
    const driveSync = jest.requireActual<Record<string, unknown>>('../utils/drive-sync');
    const pushes = Object.keys(driveSync).filter((name) => name.toLowerCase().includes('push'));

    expect(pushes).toEqual(['pushProcessedUrls']);
  });

  it('pulls an arbitrary named file into the management directory', async () => {
    mockFilesList.mockResolvedValue({ data: { files: [{ id: 'file-xyz' }] } });
    mockFilesGet.mockResolvedValue({ data: 'Acme Corp' });

    await pullStateFile('/mgmt', CONFIG, 'applied-companies.txt');

    expect(mockedFs.writeFile).toHaveBeenCalledWith(
      path.join('/mgmt', 'applied-companies.txt'),
      'Acme Corp',
      'utf-8'
    );
  });
});
