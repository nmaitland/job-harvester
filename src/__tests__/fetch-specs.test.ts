/**
 * Tests for 03-fetch-specs.ts
 */

import {
  routeByUrl,
  fetchLinkedIn,
  normalizeLinkedInUrl,
  extractLinkedInText,
  extractJobAgentText,
  extractWellfoundText,
} from '../fetch-specs';
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

describe('routeByUrl', () => {
  it('should route LinkedIn URLs to linkedin fetcher', () => {
    expect(routeByUrl('https://www.linkedin.com/jobs/view/123')).toBe('linkedin');
    expect(routeByUrl('https://linkedin.com/in/profile')).toBe('linkedin');
  });

  it('should route JobAgent URLs to jobagent fetcher', () => {
    expect(routeByUrl('https://www.jobagent.ch/jobs/123')).toBe('jobagent');
    expect(routeByUrl('https://jobagent.ch/company/abc')).toBe('jobagent');
  });

  it('should route Wellfound URLs to wellfound fetcher', () => {
    expect(routeByUrl('https://wellfound.com/jobs/123')).toBe('wellfound');
    expect(routeByUrl('https://angel.co/company/xyz/jobs')).toBe('wellfound');
  });

  it('should route other URLs to web fetcher', () => {
    expect(routeByUrl('https://example.com/jobs/123')).toBe('web');
    expect(routeByUrl('https://company.com/careers')).toBe('web');
  });
});

describe('normalizeLinkedInUrl', () => {
  it('should remove /comm segment from LinkedIn URL', () => {
    expect(normalizeLinkedInUrl('https://www.linkedin.com/comm/jobs/view/4377937396'))
      .toBe('https://www.linkedin.com/jobs/view/4377937396');
  });

  it('should keep regular LinkedIn URLs unchanged', () => {
    expect(normalizeLinkedInUrl('https://www.linkedin.com/jobs/view/4377937396'))
      .toBe('https://www.linkedin.com/jobs/view/4377937396');
  });
});

describe('fetchLinkedIn', () => {
  const mockJob: DiscoveredJob = {
    id: '1',
    company: 'Google',
    title: 'Developer',
    url: 'https://linkedin.com/jobs/123',
    source: 'linkedin',
    discoveredAt: '2024-01-01',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.BRIGHTDATA_API_KEY = 'test-key';
  });

  afterEach(() => {
    delete process.env.BRIGHTDATA_API_KEY;
  });

  it('should return error when API key not configured', async () => {
    delete process.env.BRIGHTDATA_API_KEY;
    const result = await fetchLinkedIn(mockJob);
    expect(result.success).toBe(false);
    expect(result.error).toBe('Brightdata API key not configured');
  });

  it('should fetch LinkedIn job successfully', async () => {
    const mockData = [{
      job_description_formatted: '<p>Job description</p>',
      job_summary: 'Summary text',
    }];

    (fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => mockData,
    });

    const result = await fetchLinkedIn(mockJob);

    expect(result.success).toBe(true);
    expect(result.specText).toBe('Job description');
  });

  it('should send normalized LinkedIn URL to Brightdata', async () => {
    const commJob: DiscoveredJob = {
      ...mockJob,
      url: 'https://www.linkedin.com/comm/jobs/view/4377937396',
    };

    (fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ([{ job_description_formatted: '<p>Job description</p>' }]),
    });

    const result = await fetchLinkedIn(commJob);

    expect(result.success).toBe(true);
    const request = (fetch as jest.Mock).mock.calls[0]?.[1] as { body: string };
    const body = JSON.parse(request.body) as { input: Array<{ url: string }> };
    expect(body.input[0]?.url).toBe('https://www.linkedin.com/jobs/view/4377937396');
  });

  it('should retry on HTTP error', async () => {
    const mockData = [{
      job_description: 'Job description',
    }];

    (fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Server Error',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockData,
      });

    const result = await fetchLinkedIn(mockJob);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(true);
  }, 15000);

  it('should return error after max retries exceeded', async () => {
    (fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'Server Error',
    });

    const result = await fetchLinkedIn(mockJob);

    expect(result.success).toBe(false);
    expect(result.error).toContain('HTTP 500');
  }, 15000);
});

describe('extractLinkedInText', () => {
  it('should extract text from job_description_formatted', () => {
    const data = [{
      job_description_formatted: '<p>Job description</p><ul><li>Item 1</li></ul>',
      job_summary: 'Summary',
    }];

    const result = extractLinkedInText(data);
    expect(result).toBe('Job description Item 1');
  });

  it('should fall back to job_summary', () => {
    const data = [{
      job_summary: 'Summary text',
    }];

    const result = extractLinkedInText(data);
    expect(result).toBe('Summary text');
  });

  it('should return empty string for empty array', () => {
    expect(extractLinkedInText([])).toBe('');
  });

  it('should return empty string for non-array', () => {
    expect(extractLinkedInText(null as unknown as unknown[])).toBe('');
  });
});

describe('extractJobAgentText', () => {
  it('should combine job fields', () => {
    const data = [{
      job_title: 'Senior Developer',
      job_description: 'Job description',
      qualifications: 'Required skills',
      responsibilities: 'Daily tasks',
    }];

    const result = extractJobAgentText(data);
    expect(result).toContain('Senior Developer');
    expect(result).toContain('Job description');
    expect(result).toContain('Required skills');
    expect(result).toContain('Daily tasks');
  });

  it('should skip undefined fields', () => {
    const data = [{
      job_title: 'Developer',
      job_description: undefined,
      qualifications: 'Skills',
    }];

    const result = extractJobAgentText(data);
    expect(result).toBe('Developer\n\nSkills');
  });

  it('should return empty string for empty array', () => {
    expect(extractJobAgentText([])).toBe('');
  });
});

describe('extractWellfoundText', () => {
  it('should combine job fields', () => {
    const data = [{
      job_title: 'CTO',
      company: 'Startup',
      skills: 'React, Node',
      job_description: 'Job details',
    }];

    const result = extractWellfoundText(data);
    expect(result).toContain('CTO');
    expect(result).toContain('Startup');
    expect(result).toContain('React, Node');
    expect(result).toContain('Job details');
  });

  it('should skip undefined fields', () => {
    const data = [{
      job_title: 'Developer',
      company: undefined,
      job_description: 'Details',
    }];

    const result = extractWellfoundText(data);
    expect(result).toBe('Developer\n\nDetails');
  });

  it('should return empty string for empty array', () => {
    expect(extractWellfoundText([])).toBe('');
  });
});
