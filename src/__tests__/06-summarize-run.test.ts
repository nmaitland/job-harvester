import * as fs from 'fs/promises';
import * as path from 'path';
import { runSummarize } from '../06-summarize-run';

jest.mock('fs/promises');
jest.mock('../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
}));

const mockedRequestOpenRouterChat = jest.fn();
jest.mock('../ai/openrouter-client', () => ({
  requestOpenRouterChat: (...args: unknown[]) => {
    return mockedRequestOpenRouterChat(...args) as Promise<string>;
  },
}));

const mockedFs = fs as jest.Mocked<typeof fs>;

describe('runSummarize', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.OPENROUTER_API_KEY = '';
    process.env.OPENROUTER_MODEL = '';
  });

  afterEach(() => {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_MODEL;
  });

  it('writes deterministic summary files when AI is not configured', async () => {
    const runDir = '/run/123';

    mockedFs.readFile.mockImplementation(async (filePath: unknown) => {
      const p = String(filePath);
      if (p.endsWith('discovered-jobs.json')) {
        return JSON.stringify({ jobs: [{ id: '1' }], stats: { total: 1 } });
      }
      if (p.endsWith('fetched-specs.json')) {
        return JSON.stringify({ stats: { success: 1, failed: 0 } });
      }
      if (p.endsWith('pre-filter-survivors.json')) {
        return JSON.stringify([{ id: 'job-1' }]);
      }
      if (p.endsWith('pre-filter-rejections.json')) {
        return JSON.stringify([]);
      }
      if (p.endsWith('compile-results.json')) {
        return JSON.stringify({
          jobs: [
            {
              jobId: 'job-1',
              company: 'ACME',
              title: 'Architect',
              url: 'https://example.com/1',
              specText: '',
              score: 8,
              reasoning: 'Strong fit',
              passedPreFilter: true,
              rejectionReason: undefined,
              status: 'scored',
              compiledAt: '2026-02-24T00:00:00Z',
            },
          ],
        });
      }
      if (p.endsWith(path.join('pdfs', 'pdf-results.json'))) {
        return JSON.stringify({ stats: { success: 1 } });
      }
      throw new Error('missing');
    });

    const result = await runSummarize(runDir);

    expect(result.runSummaryDir).toBe(path.join(runDir, 'run-summary'));
    expect(mockedRequestOpenRouterChat).not.toHaveBeenCalled();

    const summaryWrite = mockedFs.writeFile.mock.calls.find(call => String(call[0]).endsWith('summary-log.txt'));
    const reviewWrite = mockedFs.writeFile.mock.calls.find(call => String(call[0]).endsWith('review-jobs.txt'));

    expect(summaryWrite?.[1]).toEqual(expect.stringContaining('Jobs discovered: 1'));
    expect(reviewWrite?.[1]).toEqual(expect.stringContaining('S8 | ACME | Architect | https://example.com/1'));
  });

  it('uses AI narrative when configured and response is valid JSON', async () => {
    process.env.OPENROUTER_API_KEY = 'k';
    process.env.OPENROUTER_MODEL = 'm';

    mockedFs.readFile.mockResolvedValue(JSON.stringify({ jobs: [], stats: { total: 0, success: 0, failed: 0 } }));
    mockedRequestOpenRouterChat.mockResolvedValueOnce(
      JSON.stringify({
        summary: 'AI summary line',
        review_intro: 'AI review intro',
      })
    );

    await runSummarize('/run/ai');

    const summaryWrite = mockedFs.writeFile.mock.calls.find(call => String(call[0]).endsWith('summary-log.txt'));
    const reviewWrite = mockedFs.writeFile.mock.calls.find(call => String(call[0]).endsWith('review-jobs.txt'));

    expect(mockedRequestOpenRouterChat).toHaveBeenCalledTimes(1);
    expect(summaryWrite?.[1]).toEqual(expect.stringContaining('AI summary line'));
    expect(reviewWrite?.[1]).toEqual(expect.stringContaining('AI review intro'));
  });
});
