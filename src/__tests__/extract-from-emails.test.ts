import type { DiscoveredJob } from '../types';
import { mergeCandidatesIntoDiscovered } from '../extract-from-emails';
import type { ExtractedJobCandidate } from '../ai/validators';

describe('mergeCandidatesIntoDiscovered', () => {
  const discoveredAt = '2026-02-23T12:00:00.000Z';

  it('appends only new jobs and skips duplicate URLs', () => {
    const existing: DiscoveredJob[] = [
      {
        id: 'existing-1',
        company: 'Acme',
        title: 'Head of Engineering',
        url: 'https://example.com/jobs/123?utm=abc',
        source: 'linkedin',
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
        url: 'https://beta.example/jobs/999?source=gmail',
      },
    ];

    const result = mergeCandidatesIntoDiscovered(existing, candidates, discoveredAt);

    expect(result.jobs).toHaveLength(2);
    expect(result.appended).toBe(1);
    expect(result.duplicateUrls).toBe(1);
    expect(result.alreadyProcessed).toBe(0);
    expect(result.invalidUrls).toBe(0);
    expect(result.jobs[1]?.source).toBe('gmail');
    expect(result.jobs[1]?.url).toBe('https://beta.example/jobs/999');
    expect(result.jobs[1]?.id.startsWith('gmail-2026-02-23-beta-')).toBe(true);
  });

  it('skips invalid URLs', () => {
    const result = mergeCandidatesIntoDiscovered(
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
    const result = mergeCandidatesIntoDiscovered(
      [],
      [
        {
          company: 'Gamma',
          title: 'Director',
          url: 'https://gamma.example/jobs/777?utm=email',
        },
      ],
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
