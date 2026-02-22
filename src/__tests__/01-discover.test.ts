/**
 * Tests for 01-discover.ts
 */

import {
  discoverViaBrave,
  checkLinkedInLoginState,
  extractEmailBody,
  deduplicateByUrl,
} from '../01-discover';
import type { DiscoveredJob } from '../types';

// Mock fetch globally
global.fetch = jest.fn();

// Mock logger
jest.mock('../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
}));

describe('discoverViaBrave', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return empty array when API key is empty', async () => {
    const result = await discoverViaBrave('', ['query']);
    expect(result).toEqual([]);
  });

  it('should discover jobs from Brave API results', async () => {
    const mockResponse = {
      web: {
        results: [
          {
            title: 'Senior Developer at Google',
            url: 'https://example.com/job1',
            description: 'Job description',
          },
          {
            title: 'CTO at Startup',
            url: 'https://linkedin.com/jobs/123',
            description: 'Another job',
          },
        ],
      },
    };

    (fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => mockResponse,
    });

    const result = await discoverViaBrave('api-key', ['software engineer']);

    expect(result).toHaveLength(2);
    expect(result[0]?.company).toBe('Google');  // Company is extracted from title, not normalized
    expect(result[0]?.title).toBe('Senior Developer');
    expect(result[0]?.source).toBe('brave');
    expect(result[1]?.source).toBe('linkedin');
  });

  it('should skip query on 429 rate limit', async () => {
    (fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
    });

    const result = await discoverViaBrave('api-key', ['software engineer']);

    expect(result).toEqual([]);
  });

  it('should continue after HTTP errors', async () => {
    const mockResponse = {
      web: {
        results: [
          {
            title: 'Developer at Company',
            url: 'https://example.com/job',
            description: 'Job',
          },
        ],
      },
    };

    (fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Server Error',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockResponse,
      });

    const result = await discoverViaBrave('api-key', ['query1', 'query2']);

    expect(result).toHaveLength(1);
  });

  it('should handle network errors gracefully', async () => {
    (fetch as jest.Mock).mockRejectedValueOnce(new Error('Network error'));

    const result = await discoverViaBrave('api-key', ['query']);

    expect(result).toEqual([]);
  });

  it('should skip results without title or URL', async () => {
    const mockResponse = {
      web: {
        results: [
          { title: '', url: 'https://example.com/job1' },
          { title: 'Job Title', url: '' },
          { title: 'Valid Job', url: 'https://example.com/job2' },
        ],
      },
    };

    (fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => mockResponse,
    });

    const result = await discoverViaBrave('api-key', ['query']);

    expect(result).toHaveLength(1);
    expect(result[0]?.title).toBe('Valid Job');
  });
});

describe('checkLinkedInLoginState', () => {
  it('should return false when on login page', async () => {
    const mockPage = {
      url: () => 'https://www.linkedin.com/login',
      content: async () => '<html>Login Page</html>',
    };

    const result = await checkLinkedInLoginState(mockPage);
    expect(result).toBe(false);
  });

  it('should return true when profile name found', async () => {
    const mockPage = {
      url: () => 'https://www.linkedin.com/feed',
      content: async () => '<html><div>Swiss Assistant</div></html>',
    };

    const result = await checkLinkedInLoginState(mockPage);
    expect(result).toBe(true);
  });

  it('should return true when global-nav found', async () => {
    const mockPage = {
      url: () => 'https://www.linkedin.com/jobs',
      content: async () => '<html><nav class="global-nav">Nav</nav></html>',
    };

    const result = await checkLinkedInLoginState(mockPage);
    expect(result).toBe(true);
  });

  it('should return false when no login indicators found', async () => {
    const mockPage = {
      url: () => 'https://www.linkedin.com/some-page',
      content: async () => '<html><body>Generic Page</body></html>',
    };

    const result = await checkLinkedInLoginState(mockPage);
    expect(result).toBe(false);
  });
});

describe('extractEmailBody', () => {
  it('should extract text/plain from multipart email', () => {
    const payload = {
      mimeType: 'multipart/alternative',
      parts: [
        {
          mimeType: 'text/plain',
          body: { data: Buffer.from('Hello World').toString('base64') },
        },
        {
          mimeType: 'text/html',
          body: { data: Buffer.from('<p>Hello</p>').toString('base64') },
        },
      ],
    };

    const result = extractEmailBody(payload);
    expect(result).toBe('Hello World');
  });

  it('should extract from nested multipart', () => {
    const payload = {
      mimeType: 'multipart/mixed',
      parts: [
        {
          mimeType: 'multipart/alternative',
          parts: [
            {
              mimeType: 'text/plain',
              body: { data: Buffer.from('Nested text').toString('base64') },
            },
          ],
        },
      ],
    };

    const result = extractEmailBody(payload);
    expect(result).toBe('Nested text');
  });

  it('should fall back to top-level body', () => {
    const payload = {
      mimeType: 'text/plain',
      body: { data: Buffer.from('Top level body').toString('base64') },
    };

    const result = extractEmailBody(payload);
    expect(result).toBe('Top level body');
  });

  it('should return empty string for null payload', () => {
    const result = extractEmailBody(null);
    expect(result).toBe('');
  });

  it('should return empty string for undefined payload', () => {
    const result = extractEmailBody(undefined);
    expect(result).toBe('');
  });

  it('should return empty string when no text/plain found', () => {
    const payload = {
      mimeType: 'multipart/alternative',
      parts: [
        {
          mimeType: 'text/html',
          body: { data: Buffer.from('<p>HTML only</p>').toString('base64') },
        },
      ],
    };

    const result = extractEmailBody(payload);
    expect(result).toBe('');
  });
});

describe('deduplicateByUrl', () => {
  it('should remove duplicate URLs', () => {
    const jobs: DiscoveredJob[] = [
      {
        id: '1',
        company: 'Google',
        title: 'Developer',
        url: 'https://example.com/job',
        source: 'brave',
        discoveredAt: '2024-01-01',
      },
      {
        id: '2',
        company: 'Google',
        title: 'Engineer',
        url: 'https://example.com/job',
        source: 'linkedin',
        discoveredAt: '2024-01-01',
      },
    ];

    const result = deduplicateByUrl(jobs);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('1');
  });

  it('should strip query params when comparing', () => {
    const jobs: DiscoveredJob[] = [
      {
        id: '1',
        company: 'Google',
        title: 'Developer',
        url: 'https://example.com/job?id=123',
        source: 'brave',
        discoveredAt: '2024-01-01',
      },
      {
        id: '2',
        company: 'Google',
        title: 'Engineer',
        url: 'https://example.com/job?id=456',
        source: 'linkedin',
        discoveredAt: '2024-01-01',
      },
    ];

    const result = deduplicateByUrl(jobs);
    expect(result).toHaveLength(1);
  });

  it('should be case-insensitive', () => {
    const jobs: DiscoveredJob[] = [
      {
        id: '1',
        company: 'Google',
        title: 'Developer',
        url: 'https://EXAMPLE.COM/JOB',
        source: 'brave',
        discoveredAt: '2024-01-01',
      },
      {
        id: '2',
        company: 'Google',
        title: 'Engineer',
        url: 'https://example.com/job',
        source: 'linkedin',
        discoveredAt: '2024-01-01',
      },
    ];

    const result = deduplicateByUrl(jobs);
    expect(result).toHaveLength(1);
  });

  it('should keep unique URLs', () => {
    const jobs: DiscoveredJob[] = [
      {
        id: '1',
        company: 'Google',
        title: 'Developer',
        url: 'https://example.com/job1',
        source: 'brave',
        discoveredAt: '2024-01-01',
      },
      {
        id: '2',
        company: 'Microsoft',
        title: 'Engineer',
        url: 'https://example.com/job2',
        source: 'linkedin',
        discoveredAt: '2024-01-01',
      },
    ];

    const result = deduplicateByUrl(jobs);
    expect(result).toHaveLength(2);
  });

  it('should skip jobs with undefined URLs', () => {
    const jobs = [
      {
        id: '1',
        company: 'Google',
        title: 'Developer',
        url: undefined as unknown as string,
        source: 'brave' as const,
        discoveredAt: '2024-01-01',
      },
      {
        id: '2',
        company: 'Microsoft',
        title: 'Engineer',
        url: 'https://example.com/job',
        source: 'linkedin' as const,
        discoveredAt: '2024-01-01',
      },
    ];

    const result = deduplicateByUrl(jobs as DiscoveredJob[]);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('2');
  });
});
