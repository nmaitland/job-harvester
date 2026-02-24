import type { DiscoveredJob } from '../types';
import { mergeWebsiteCandidatesIntoDiscovered } from '../extract-from-websites';
import type { ExtractedJobCandidate } from '../ai/validators';

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
    expect(result.invalidUrls).toBe(1);
  });
});

