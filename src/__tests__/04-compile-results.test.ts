/**
 * Tests for 04-compile-results.ts
 */

import * as fs from 'fs/promises';
import {
  applyThreshold,
  readJobScore,
} from '../04-compile-results';
import type { JobScore } from '../types';

// Mock fs/promises
jest.mock('fs/promises');

const mockedFs = fs as jest.Mocked<typeof fs>;

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
