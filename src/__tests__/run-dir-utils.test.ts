import * as fs from 'fs/promises';
import {
  assertValidRunDirName,
  parseRunDirArg,
  requireExistingRunDir,
  resolveRequiredRunDirFromCli,
  resolveRootWorkDirFromEnv,
} from '../utils/run-dir';

jest.mock('fs/promises');

const mockedFs = fs as jest.Mocked<typeof fs>;

describe('run-dir utils', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.JOB_HARVESTER_ROOT_WORK_DIR;
    delete process.env.JOB_HARVESTER_WORK_DIR;
  });

  it('parses --run-dir', () => {
    expect(parseRunDirArg(['--run-dir', '/tmp/run-2026-02-24-10-00-00'])).toBe('/tmp/run-2026-02-24-10-00-00');
  });

  it('validates run dir basename', () => {
    expect(() => assertValidRunDirName('/tmp/run-2026-02-24-10-00-00')).not.toThrow();
    expect(() => assertValidRunDirName('/tmp/not-a-run')).toThrow('Expected folder name format');
  });

  it('checks existing run dir', async () => {
    mockedFs.stat.mockResolvedValue({ isDirectory: () => true } as Awaited<ReturnType<typeof fs.stat>>);
    await expect(requireExistingRunDir('/tmp/run-2026-02-24-10-00-00')).resolves.not.toThrow();
  });

  it('fails if run dir is missing', async () => {
    mockedFs.stat.mockRejectedValue(new Error('missing'));
    await expect(requireExistingRunDir('/tmp/run-2026-02-24-10-00-00')).rejects.toThrow('--run-dir does not exist');
  });

  it('resolves required run dir from cli args', async () => {
    mockedFs.stat.mockResolvedValue({ isDirectory: () => true } as Awaited<ReturnType<typeof fs.stat>>);
    await expect(resolveRequiredRunDirFromCli(['--run-dir', '/tmp/run-2026-02-24-10-00-00'])).resolves.toBe('/tmp/run-2026-02-24-10-00-00');
  });

  it('resolves root work dir from new env var', () => {
    process.env.JOB_HARVESTER_ROOT_WORK_DIR = 'C:\\data';
    expect(resolveRootWorkDirFromEnv()).toBe('C:\\data');
  });

  it('throws migration error when legacy env var is used', () => {
    process.env.JOB_HARVESTER_WORK_DIR = 'C:\\legacy';
    expect(() => resolveRootWorkDirFromEnv()).toThrow('has been renamed to JOB_HARVESTER_ROOT_WORK_DIR');
  });
});

