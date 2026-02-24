/**
 * Tests for run-job-search.ts
 */

import * as fs from 'fs/promises';
import {
  parseArgs,
  createRunDir,
  validateOutputPhase,
  writeRunManifest,
} from '../run-job-search';

// Mock fs/promises
jest.mock('fs/promises');

// Mock logger
jest.mock('../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
}));

// Mock config
jest.mock('../config', () => ({
  DATA_DIR: 'C:\\data',
  PRE_FILTER_SURVIVORS_FILE: 'C:\\data\\pre-filter-survivors.json',
}));

const mockedFs = fs as jest.Mocked<typeof fs>;

describe('parseArgs', () => {
  const validRunDir = '/tmp/run-2026-02-24-10-00-00';

  it('should default to all phase', () => {
    const result = parseArgs([]);
    expect(result.phase).toBe('all');
    expect(result.runDir).toBeUndefined();
    expect(result.dryRun).toBe(false);
  });

  it('should parse --phase all', () => {
    const result = parseArgs(['--phase', 'all']);
    expect(result.phase).toBe('all');
  });

  it('should parse --phase discovery', () => {
    const result = parseArgs(['--phase', 'discovery', '--run-dir', validRunDir]);
    expect(result.phase).toBe('discovery');
  });

  it('should parse --phase email-processing', () => {
    const result = parseArgs(['--phase', 'email-processing', '--run-dir', validRunDir]);
    expect(result.phase).toBe('email-processing');
  });

  it('should throw for invalid phase', () => {
    expect(() => parseArgs(['--phase', 'invalid'])).toThrow('Invalid phase');
  });

  it('should allow all phase without --run-dir', () => {
    expect(() => parseArgs(['--phase', 'all'])).not.toThrow();
  });

  it('should require --run-dir for partial phases', () => {
    expect(() => parseArgs(['--phase', 'discovery'])).toThrow('--phase discovery requires --run-dir');
    expect(() => parseArgs(['--phase', 'email-processing'])).toThrow('--phase email-processing requires --run-dir');
    expect(() => parseArgs(['--phase', 'fetch-and-filter'])).toThrow('--phase fetch-and-filter requires --run-dir');
    expect(() => parseArgs(['--phase', 'scoring'])).toThrow('--phase scoring requires --run-dir');
    expect(() => parseArgs(['--phase', 'output'])).toThrow('--phase output requires --run-dir');
  });

  it('should validate run-dir naming for all phases when provided', () => {
    expect(() => parseArgs(['--phase', 'all', '--run-dir', '/tmp/not-a-run'])).toThrow('Expected folder name format');
    expect(() => parseArgs(['--phase', 'output', '--run-dir', '/tmp/not-a-run'])).toThrow('Expected folder name format');
  });

  it('should parse --dry-run', () => {
    const result = parseArgs(['--dry-run']);
    expect(result.dryRun).toBe(true);
  });

  it('should parse --env-file', () => {
    const result = parseArgs(['--env-file', '.env.dev']);
    expect(result.envFile).toBe('.env.dev');
  });

  it('should parse combined args', () => {
    const result = parseArgs(['--phase', 'all', '--run-dir', validRunDir, '--dry-run', '--env-file', '.env.local']);
    expect(result.phase).toBe('all');
    expect(result.runDir).toBe(validRunDir);
    expect(result.dryRun).toBe(true);
    expect(result.envFile).toBe('.env.local');
  });
});

describe('createRunDir', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.JOB_HARVESTER_ROOT_WORK_DIR = 'C:\\data';
  });

  afterEach(() => {
    delete process.env.JOB_HARVESTER_ROOT_WORK_DIR;
  });

  it('should create directory with timestamp format', async () => {
    mockedFs.mkdir.mockResolvedValue(undefined);

    const result = await createRunDir();

    expect(result).toMatch(/run-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}$/);
    expect(mockedFs.mkdir).toHaveBeenCalledWith(
      expect.stringContaining('run-'),
      { recursive: true }
    );
  });

  it('should create directory in WORK_DIR', async () => {
    mockedFs.mkdir.mockResolvedValue(undefined);

    await createRunDir();

    const callArg = mockedFs.mkdir.mock.calls[0]?.[0] as string;
    expect(callArg.includes('data')).toBe(true);
  });

  it('should throw migration error when only legacy env var is set', async () => {
    delete process.env.JOB_HARVESTER_ROOT_WORK_DIR;
    process.env.JOB_HARVESTER_WORK_DIR = 'C:\\legacy-data';

    await expect(createRunDir()).rejects.toThrow('JOB_HARVESTER_WORK_DIR has been renamed to JOB_HARVESTER_ROOT_WORK_DIR');

    delete process.env.JOB_HARVESTER_WORK_DIR;
  });
});

describe('validateOutputPhase', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should throw if pre-filter-survivors.json missing', async () => {
    mockedFs.access.mockRejectedValue(new Error('File not found'));

    await expect(validateOutputPhase('/run/123')).rejects.toThrow(
      'Pre-filter survivors file not found'
    );
  });

  it('should throw if job-scores directory missing', async () => {
    mockedFs.access.mockResolvedValue(undefined);
    mockedFs.readdir.mockRejectedValue(new Error('Directory not found'));

    await expect(validateOutputPhase('/run/123')).rejects.toThrow(
      'Job scores directory not found'
    );
  });

  it('should throw if job-scores directory empty', async () => {
    mockedFs.access.mockResolvedValue(undefined);
    mockedFs.readdir.mockResolvedValue([]);

    await expect(validateOutputPhase('/run/123')).rejects.toThrow(
      'No job score files found'
    );
  });

  it('should pass when prerequisites exist', async () => {
    mockedFs.access.mockResolvedValue(undefined);
    mockedFs.readdir.mockResolvedValue(['score1.json', 'score2.json'] as any);

    await expect(validateOutputPhase('/run/123')).resolves.not.toThrow();
  });

  it('should only check .json files in job-scores', async () => {
    mockedFs.access.mockResolvedValue(undefined);
    mockedFs.readdir.mockResolvedValue(['readme.txt', 'score.json'] as any);

    await expect(validateOutputPhase('/run/123')).resolves.not.toThrow();
  });
});

describe('writeRunManifest', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should write manifest with correct structure', async () => {
    mockedFs.writeFile.mockResolvedValue(undefined);

    await writeRunManifest('/run/123', 'all');

    expect(mockedFs.writeFile).toHaveBeenCalled();
    const writeCall = mockedFs.writeFile.mock.calls[0];
    const filePath = writeCall?.[0] as string;
    const content = writeCall?.[1] as string;

    expect(filePath.includes('run-manifest.json')).toBe(true);

    const manifest = JSON.parse(content);
    expect(manifest.runDir.includes('run')).toBe(true);
    expect(manifest.phase).toBe('all');
    expect(manifest.files).toBeDefined();
  });

  it('should include all expected file entries', async () => {
    mockedFs.writeFile.mockResolvedValue(undefined);

    await writeRunManifest('/run/123', 'all');

    const writeCall = mockedFs.writeFile.mock.calls[0];
    const content = writeCall?.[1] as string;
    const manifest = JSON.parse(content);

    expect(manifest.files['discovered-jobs.json']).toBeDefined();
    expect(manifest.files['fetched-specs.json']).toBeDefined();
    expect(manifest.files['pre-filter-survivors.json']).toBeDefined();
    expect(manifest.files['pre-filter-rejections.json']).toBeDefined();
    expect(manifest.files['job-scores/*.json']).toBeDefined();
    expect(manifest.files['compile-results.json']).toBeDefined();
    expect(manifest.files['all-rejections.json']).toBeDefined();
    expect(manifest.files['pdfs/*.pdf']).toBeDefined();
    expect(manifest.files['run-summary/*.txt']).toBeDefined();
    expect(manifest.files['upload-results.json']).toBeDefined();
  });

  it('should set correct ownership for each file', async () => {
    mockedFs.writeFile.mockResolvedValue(undefined);

    await writeRunManifest('/run/123', 'all');

    const writeCall = mockedFs.writeFile.mock.calls[0];
    const content = writeCall?.[1] as string;
    const manifest = JSON.parse(content);

    expect(manifest.files['discovered-jobs.json'].owner).toBe('01-discover.ts');
    expect(manifest.files['fetched-specs.json'].owner).toBe('03-fetch-specs.ts');
    expect(manifest.files['pre-filter-survivors.json'].owner).toBe('04-prefilter.ts');
    expect(manifest.files['job-scores/*.json'].owner).toBe('05-score-survivors.ts');
    expect(manifest.files['compile-results.json'].owner).toBe('06-compile-results.ts');
    expect(manifest.files['pdfs/*.pdf'].owner).toBe('07-generate-pdfs.ts');
    expect(manifest.files['run-summary/*.txt'].owner).toBe('08-summarize-run.ts');
    expect(manifest.files['upload-results.json'].owner).toBe('09-upload.ts');
  });

  it('should set correct AI permissions', async () => {
    mockedFs.writeFile.mockResolvedValue(undefined);

    await writeRunManifest('/run/123', 'all');

    const writeCall = mockedFs.writeFile.mock.calls[0];
    const content = writeCall?.[1] as string;
    const manifest = JSON.parse(content);

    // AI can read discovered jobs
    expect(manifest.files['discovered-jobs.json'].aiMayRead).toBe(true);
    expect(manifest.files['discovered-jobs.json'].aiMayWrite).toBe(false);

    // AI can write job scores
    expect(manifest.files['job-scores/*.json'].aiMayRead).toBe(false);
    expect(manifest.files['job-scores/*.json'].aiMayWrite).toBe(true);

    // AI cannot read rejections
    expect(manifest.files['pre-filter-rejections.json'].aiMayRead).toBe(false);
  });
});
