import * as fs from 'fs/promises';
import type { DiscoveredJob } from '../types';
import {
  appendUrlsToRegistry,
  buildProcessedUrlEntries,
  loadProcessedUrlRegistry,
} from '../utils/processed-urls';

jest.mock('fs/promises');

const mockedFs = fs as jest.Mocked<typeof fs>;

describe('processed-urls utilities', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedFs.mkdir.mockResolvedValue(undefined);
    mockedFs.writeFile.mockResolvedValue(undefined);
  });

  it('loadProcessedUrlRegistry returns empty set when file is missing', async () => {
    mockedFs.readFile.mockRejectedValueOnce(new Error('missing'));

    const result = await loadProcessedUrlRegistry('/mgmt');

    expect(result.size).toBe(0);
  });

  it('loadProcessedUrlRegistry returns normalized URL set from file', async () => {
    mockedFs.readFile.mockResolvedValueOnce(
      JSON.stringify({
        version: 1,
        updatedAt: '2026-02-24T00:00:00.000Z',
        urls: [
          {
            url: 'https://A.example/jobs/1?utm=x',
            normalizedUrl: 'https://a.example/jobs/1',
            recordedAt: '2026-02-24T00:00:00.000Z',
            runTimestamp: '2026-02-24-00-00-00',
            source: 'brave',
          },
        ],
      })
    );

    const result = await loadProcessedUrlRegistry('/mgmt');

    expect(result.has('https://a.example/jobs/1')).toBe(true);
  });

  it('loadProcessedUrlRegistry re-normalizes legacy LinkedIn /comm entries from raw url', async () => {
    mockedFs.readFile.mockResolvedValueOnce(
      JSON.stringify({
        version: 1,
        updatedAt: '2026-02-24T00:00:00.000Z',
        urls: [
          {
            url: 'https://www.linkedin.com/comm/jobs/view/4377882826/',
            normalizedUrl: 'https://www.linkedin.com/comm/jobs/view/4377882826',
            recordedAt: '2026-02-24T00:00:00.000Z',
            runTimestamp: '2026-02-24-00-00-00',
            source: 'gmail',
          },
        ],
      })
    );

    const result = await loadProcessedUrlRegistry('/mgmt');

    expect(result.has('https://www.linkedin.com/jobs/view/4377882826')).toBe(true);
    expect(result.has('https://www.linkedin.com/comm/jobs/view/4377882826')).toBe(false);
  });

  it('appendUrlsToRegistry creates registry file and deduplicates by normalized URL', async () => {
    mockedFs.readFile.mockRejectedValueOnce(new Error('missing'));

    await appendUrlsToRegistry('/mgmt', [
      {
        url: 'https://a.example/jobs/1?utm=x',
        normalizedUrl: 'https://a.example/jobs/1',
        recordedAt: '2026-02-24T00:00:00.000Z',
        runTimestamp: '2026-02-24-00-00-00',
        source: 'brave',
      },
      {
        url: 'https://a.example/jobs/1',
        normalizedUrl: 'https://a.example/jobs/1',
        recordedAt: '2026-02-24T00:00:00.000Z',
        runTimestamp: '2026-02-24-00-00-00',
        source: 'brave',
      },
    ]);

    expect(mockedFs.writeFile).toHaveBeenCalledTimes(1);
    const writtenPayload = JSON.parse(String(mockedFs.writeFile.mock.calls[0]?.[1])) as { urls: unknown[] };
    expect(writtenPayload.urls).toHaveLength(1);
  });

  it('appendUrlsToRegistry preserves existing entries and appends only new normalized URLs', async () => {
    mockedFs.readFile.mockResolvedValueOnce(
      JSON.stringify({
        version: 1,
        updatedAt: '2026-02-24T00:00:00.000Z',
        urls: [
          {
            url: 'https://a.example/jobs/1',
            normalizedUrl: 'https://a.example/jobs/1',
            recordedAt: '2026-02-24T00:00:00.000Z',
            runTimestamp: '2026-02-24-00-00-00',
            source: 'brave',
          },
        ],
      })
    );

    await appendUrlsToRegistry('/mgmt', [
      {
        url: 'https://a.example/jobs/1?utm=x',
        normalizedUrl: 'https://a.example/jobs/1',
        recordedAt: '2026-02-25T00:00:00.000Z',
        runTimestamp: '2026-02-25-00-00-00',
        source: 'gmail',
      },
      {
        url: 'https://b.example/jobs/2',
        normalizedUrl: 'https://b.example/jobs/2',
        recordedAt: '2026-02-25T00:00:00.000Z',
        runTimestamp: '2026-02-25-00-00-00',
        source: 'gmail',
      },
    ]);

    const writtenPayload = JSON.parse(String(mockedFs.writeFile.mock.calls[0]?.[1])) as { urls: Array<{ normalizedUrl: string }> };
    expect(writtenPayload.urls.map(x => x.normalizedUrl).sort()).toEqual([
      'https://a.example/jobs/1',
      'https://b.example/jobs/2',
    ]);
  });

  it('buildProcessedUrlEntries maps jobs and extracts run timestamp', () => {
    const jobs: DiscoveredJob[] = [
      {
        id: '1',
        company: 'Acme',
        title: 'Head of Eng',
        url: 'https://acme.example/jobs/1?utm=x',
        source: 'brave',
        discoveredAt: '2026-02-24T00:00:00.000Z',
      },
      {
        id: '2',
        company: 'Acme',
        title: 'Head of Eng',
        url: 'mailto:test@example.com',
        source: 'gmail',
        discoveredAt: '2026-02-24T00:00:00.000Z',
      },
    ];

    const entries = buildProcessedUrlEntries(jobs, '/data/run-2026-02-24-10-11-12');

    expect(entries).toHaveLength(1);
    expect(entries[0]?.normalizedUrl).toBe('https://acme.example/jobs/1');
    expect(entries[0]?.runTimestamp).toBe('2026-02-24-10-11-12');
  });

  it('buildProcessedUrlEntries normalizes LinkedIn /comm URLs', () => {
    const jobs: DiscoveredJob[] = [
      {
        id: '1',
        company: 'Acme',
        title: 'Head of Eng',
        url: 'https://www.linkedin.com/comm/jobs/view/4377882826/',
        source: 'linkedin',
        discoveredAt: '2026-02-24T00:00:00.000Z',
      },
    ];

    const entries = buildProcessedUrlEntries(jobs, '/data/run-2026-02-24-10-11-12');

    expect(entries).toHaveLength(1);
    expect(entries[0]?.normalizedUrl).toBe('https://www.linkedin.com/jobs/view/4377882826');
  });
});
