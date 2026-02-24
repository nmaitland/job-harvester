/**
 * Tests for 04-compile-results.ts
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import {
  applyThreshold,
  findVerdictFile,
  readJobScore,
} from '../04-compile-results';
import type { JobScore } from '../types';

// Mock fs/promises
jest.mock('fs/promises');

const mockedFs = fs as jest.Mocked<typeof fs>;

function asReaddirResult(files: string[]): Awaited<ReturnType<typeof fs.readdir>> {
  return files as unknown as Awaited<ReturnType<typeof fs.readdir>>;
}

describe('applyThreshold', () => {
  it('should return PASS for scores >= 7', () => {
    expect(applyThreshold(10)).toBe('PASS');
    expect(applyThreshold(7)).toBe('PASS');
  });

  it('should return REVIEW for scores 4-6', () => {
    expect(applyThreshold(6)).toBe('REVIEW');
    expect(applyThreshold(5)).toBe('REVIEW');
    expect(applyThreshold(4)).toBe('REVIEW');
  });

  it('should return REJECT for scores < 4', () => {
    expect(applyThreshold(3)).toBe('REJECT');
    expect(applyThreshold(0)).toBe('REJECT');
  });
});

describe('readJobScore', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should read and parse job score file', async () => {
    const score: JobScore = {
      jobId: '1',
      company: 'Google',
      title: 'Senior Developer',
      url: 'https://example.com/job',
      score: 8,
      reasoning: 'Good match',
      scoredAt: '2024-01-01',
    };

    mockedFs.readFile.mockResolvedValueOnce(JSON.stringify(score));

    const result = await readJobScore('/path/to/score.json');

    expect(result).toEqual(score);
  });

  it('should return null if file does not exist', async () => {
    mockedFs.readFile.mockRejectedValueOnce(new Error('File not found'));

    const result = await readJobScore('/path/to/score.json');

    expect(result).toBeNull();
  });

  it('should return null if JSON is invalid', async () => {
    mockedFs.readFile.mockResolvedValueOnce('invalid json');

    const result = await readJobScore('/path/to/score.json');

    expect(result).toBeNull();
  });
});

describe('findVerdictFile', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should match modern step4 filename format with company and job id slugs', async () => {
    mockedFs.readdir.mockResolvedValueOnce(asReaddirResult([
      '2026-02-23-1password-linkedin-1771856460655-6kln4h4yd.json',
      '2026-02-23-anvil-linkedin-1771856464632-t93b875iy.json',
    ]));

    const result = await findVerdictFile(
      'linkedin-1771856460655-6kln4h4yd',
      '1Password',
      '/tmp/job-scores'
    );

    expect(result).toBe(path.join('/tmp/job-scores', '2026-02-23-1password-linkedin-1771856460655-6kln4h4yd.json'));
  });

  it('should match legacy filename format when present', async () => {
    const today = new Date().toISOString().split('T')[0];
    const legacyFilename = `${today}-gitlab.json`;

    mockedFs.readdir.mockResolvedValueOnce(asReaddirResult([
      legacyFilename,
      `${today}-other-company.json`,
    ]));

    const result = await findVerdictFile('job-123', 'GitLab', '/tmp/job-scores');

    expect(result).toBe(path.join('/tmp/job-scores', legacyFilename));
  });

  it('should fall back to company slug match when exact formats are absent', async () => {
    mockedFs.readdir.mockResolvedValueOnce(asReaddirResult([
      'older-run-1password-custom-name.json',
      'another-file.json',
    ]));

    const result = await findVerdictFile('job-unknown', '1Password', '/tmp/job-scores');

    expect(result).toBe(path.join('/tmp/job-scores', 'older-run-1password-custom-name.json'));
  });

  it('should return null when scores directory cannot be read', async () => {
    mockedFs.readdir.mockRejectedValueOnce(new Error('Directory not found'));

    const result = await findVerdictFile('job-123', 'GitLab', '/tmp/job-scores');

    expect(result).toBeNull();
  });
});
