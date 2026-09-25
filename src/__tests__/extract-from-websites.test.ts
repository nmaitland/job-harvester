import * as fs from 'fs/promises';
import * as path from 'path';
import type { DiscoveredJob } from '../types';
import { mergeWebsiteCandidatesIntoDiscovered, runWebsiteExtraction, stripHtmlToText } from '../extract-from-websites';
import type { ExtractedJobCandidate } from '../ai/validators';
import { extractJobCandidates } from '../ai/extract-job-candidates';

jest.mock('fs/promises');
jest.mock('../ai/extract-job-candidates', () => ({
  extractJobCandidates: jest.fn(),
}));

const mockedFs = fs as jest.Mocked<typeof fs>;
const mockedExtractJobCandidates = extractJobCandidates as jest.MockedFunction<typeof extractJobCandidates>;

describe('mergeWebsiteCandidatesIntoDiscovered', () => {
  const discoveredAt = '2026-02-24T12:00:00.000Z';

  it('appends only new jobs and skips duplicate URLs', () => {
    const existing: DiscoveredJob[] = [
      {
        id: 'existing-1',
        company: 'Acme',
        title: 'Head of Engineering',
        url: 'https://example.com/jobs/123?utm=abc',
        source: 'brave',
        discoveredAt,
      },
    ];

    const candidates: ExtractedJobCandidate[] = [
      {
        company: 'Acme',
        title: 'Head of Engineering',
        url: 'https://example.com/jobs/123',
      },
      {
        company: 'Beta',
        title: 'CTO',
        url: 'https://beta.example/jobs/999?source=search',
      },
    ];

    const result = mergeWebsiteCandidatesIntoDiscovered(existing, candidates, discoveredAt);

    expect(result.jobs).toHaveLength(2);
    expect(result.appended).toBe(1);
    expect(result.duplicateUrls).toBe(1);
    expect(result.alreadyProcessed).toBe(0);
    expect(result.invalidUrls).toBe(0);
    expect(result.jobs[1]?.source).toBe('brave-extracted');
    expect(result.jobs[1]?.url).toBe('https://beta.example/jobs/999');
    expect(result.jobs[1]?.id.startsWith('brave-extracted-2026-02-24-beta-')).toBe(true);
  });

  it('skips invalid URLs', () => {
    const result = mergeWebsiteCandidatesIntoDiscovered(
      [],
      [
        {
          company: 'Gamma',
          title: 'Director',
          url: 'mailto:test@example.com',
        },
      ],
      discoveredAt
    );

    expect(result.jobs).toHaveLength(0);
    expect(result.appended).toBe(0);
    expect(result.alreadyProcessed).toBe(0);
    expect(result.invalidUrls).toBe(1);
  });

  it('skips URLs already processed in previous runs', () => {
    const candidates: ExtractedJobCandidate[] = [
      {
        company: 'Gamma',
        title: 'Director',
        url: 'https://gamma.example/jobs/777?utm=abc',
      },
    ];

    const result = mergeWebsiteCandidatesIntoDiscovered(
      [],
      candidates,
      discoveredAt,
      new Set<string>(['https://gamma.example/jobs/777'])
    );

    expect(result.jobs).toHaveLength(0);
    expect(result.appended).toBe(0);
    expect(result.duplicateUrls).toBe(0);
    expect(result.alreadyProcessed).toBe(1);
    expect(result.invalidUrls).toBe(0);
  });
});

describe('runWebsiteExtraction', () => {
  const runDir = '/tmp/run-websites';

  beforeEach(() => {
    jest.clearAllMocks();
    mockedFs.writeFile.mockResolvedValue(undefined);
    (globalThis as unknown as { fetch: jest.Mock }).fetch = jest.fn();
  });

  it('processes only brave-discovered sources for fetching and extraction', async () => {
    mockedFs.readFile.mockRejectedValueOnce(new Error('no processed registry yet'));
    mockedFs.readFile.mockResolvedValueOnce(
      JSON.stringify({
        jobs: [
          {
            id: 'b1',
            company: 'Acme',
            title: 'Head of Engineering',
            url: 'https://acme.example/jobs/1',
            source: 'brave',
            discoveredAt: '2026-02-24T00:00:00.000Z',
          },
          {
            id: 'g1',
            company: 'Inbox Corp',
            title: 'CTO',
            url: 'https://inbox.example/jobs/1',
            source: 'gmail',
            discoveredAt: '2026-02-24T00:00:00.000Z',
          },
          {
            id: 'be1',
            company: 'Derived Co',
            title: 'VP Engineering',
            url: 'https://derived.example/jobs/1',
            source: 'brave-extracted',
            discoveredAt: '2026-02-24T00:00:00.000Z',
          },
        ],
      })
    );

    (globalThis as unknown as { fetch: jest.Mock }).fetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '<html><body>Role text</body></html>',
    });
    mockedExtractJobCandidates.mockResolvedValue([]);

    await runWebsiteExtraction(runDir);

    expect((globalThis as unknown as { fetch: jest.Mock }).fetch).toHaveBeenCalledTimes(1);
    expect((globalThis as unknown as { fetch: jest.Mock }).fetch.mock.calls[0]?.[0]).toBe(
      'https://acme.example/jobs/1'
    );
    expect(mockedExtractJobCandidates).toHaveBeenCalledTimes(1);
  });

  it('calls extractor with webpage context and source hint', async () => {
    mockedFs.readFile.mockRejectedValueOnce(new Error('no processed registry yet'));
    mockedFs.readFile.mockResolvedValueOnce(
      JSON.stringify({
        jobs: [
          {
            id: 'b1',
            company: 'Acme',
            title: 'Head of Engineering',
            url: 'https://acme.example/jobs/1',
            source: 'brave',
            discoveredAt: '2026-02-24T00:00:00.000Z',
          },
        ],
      })
    );

    (globalThis as unknown as { fetch: jest.Mock }).fetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '<html><body>Hello <b>Role</b></body></html>',
    });
    mockedExtractJobCandidates.mockResolvedValue([]);

    await runWebsiteExtraction(runDir);

    expect(mockedExtractJobCandidates).toHaveBeenCalledWith(
      'Hello Role',
      expect.objectContaining({
        type: 'webpage',
        hint: expect.stringContaining('Source URL: https://acme.example/jobs/1'),
      })
    );
  });

  it('writes step log with expected shape and counters', async () => {
    mockedFs.readFile.mockRejectedValueOnce(new Error('no processed registry yet'));
    mockedFs.readFile.mockResolvedValueOnce(
      JSON.stringify({
        jobs: [
          {
            id: 'b1',
            company: 'Acme',
            title: 'Head of Engineering',
            url: 'https://acme.example/jobs/1',
            source: 'brave',
            discoveredAt: '2026-02-24T00:00:00.000Z',
          },
        ],
      })
    );

    (globalThis as unknown as { fetch: jest.Mock }).fetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '<html><body>Role text</body></html>',
    });
    mockedExtractJobCandidates.mockResolvedValue([
      {
        company: 'Beta',
        title: 'CTO',
        url: 'https://beta.example/jobs/2',
      },
    ]);

    await runWebsiteExtraction(runDir);

    expect(mockedFs.writeFile).toHaveBeenCalledTimes(2);
    const logCall = mockedFs.writeFile.mock.calls.find(call =>
      String(call[0]).endsWith('extract-from-websites-log.json')
    );

    expect(logCall).toBeDefined();
    const payload = JSON.parse(logCall?.[1] as string) as Record<string, unknown>;
    expect(payload.runDir).toBe(runDir);
    expect(payload.discoveredFile).toBe(path.join(runDir, 'discovered-jobs.json'));
    expect(payload.pagesProcessed).toBe(1);
    expect(payload.candidatesExtracted).toBe(1);
    expect(payload.appended).toBe(1);
    expect(payload.duplicateUrls).toBe(0);
    expect(payload.alreadyProcessed).toBe(0);
    expect(payload.invalidUrls).toBe(0);
    expect(typeof payload.timestamp).toBe('string');
  });

  it('handles fetch failures gracefully and still writes outputs', async () => {
    mockedFs.readFile.mockRejectedValueOnce(new Error('no processed registry yet'));
    mockedFs.readFile.mockResolvedValueOnce(
      JSON.stringify({
        jobs: [
          {
            id: 'b1',
            company: 'Acme',
            title: 'Head of Engineering',
            url: 'https://acme.example/jobs/1',
            source: 'brave',
            discoveredAt: '2026-02-24T00:00:00.000Z',
          },
        ],
      })
    );

    (globalThis as unknown as { fetch: jest.Mock }).fetch.mockRejectedValue(new Error('network down'));

    const result = await runWebsiteExtraction(runDir);

    expect(result).toEqual({
      pagesProcessed: 0,
      candidatesExtracted: 0,
      appended: 0,
      duplicateUrls: 0,
      alreadyProcessed: 0,
      invalidUrls: 0,
    });
    expect(mockedExtractJobCandidates).not.toHaveBeenCalled();
    expect(mockedFs.writeFile).toHaveBeenCalledTimes(2);
  });

  it('replaces raw Brave hits with extracted jobs, keeping a self-link posting', async () => {
    mockedFs.readFile.mockRejectedValueOnce(new Error('no processed registry yet'));
    mockedFs.readFile.mockResolvedValueOnce(
      JSON.stringify({
        jobs: [
          { id: 'b1', company: 'Unknown', title: 'Solar news', url: 'https://news.example/solar', source: 'brave', discoveredAt: '2026-02-24T00:00:00.000Z' },
          { id: 'b2', company: 'Acme', title: 'CTO', url: 'https://acme.example/jobs/1', source: 'brave', discoveredAt: '2026-02-24T00:00:00.000Z' },
          { id: 'g1', company: 'Inbox Corp', title: 'CTO', url: 'https://inbox.example/jobs/1', source: 'gmail', discoveredAt: '2026-02-24T00:00:00.000Z' },
        ],
      })
    );
    (globalThis as unknown as { fetch: jest.Mock }).fetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '<html><body>Page</body></html>',
    });
    mockedExtractJobCandidates
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ company: 'Acme', title: 'CTO', url: 'https://acme.example/jobs/1' }]);

    await runWebsiteExtraction(runDir);

    const discoveredCall = mockedFs.writeFile.mock.calls.find(call => String(call[0]).endsWith('discovered-jobs.json'));
    const written = JSON.parse(discoveredCall?.[1] as string) as { jobs: DiscoveredJob[] };
    expect(written.jobs.map(job => [job.source, job.url])).toEqual([
      ['gmail', 'https://inbox.example/jobs/1'],
      ['brave-extracted', 'https://acme.example/jobs/1'],
    ]);
  });
});

describe('stripHtmlToText', () => {
  it('keeps absolute link targets so the extractor can see job URLs', () => {
    const html = '<p>Open roles: <a class="x" href="/jobs/42">Head of Engineering</a> <a href="mailto:hr@x.ch">Mail</a></p>';
    expect(stripHtmlToText(html, 'https://careers.example.ch/team')).toBe(
      'Open roles: Head of Engineering (https://careers.example.ch/jobs/42) Mail'
    );
  });
});
