/**
 * Tests for 04-prefilter.ts
 */

import * as fs from 'fs/promises';
import {
  normalizeCompany,
  normalizeUrl,
  loadAppliedCompanies,
  loadProcessedUrls,
  isJuniorRole,
  applyFilters,
  runPreFilter,
} from '../04-prefilter';
import type { JobSpec } from '../types';

// Mock fs/promises
jest.mock('fs/promises');

const mockedFs = fs as jest.Mocked<typeof fs>;

describe('normalizeCompany', () => {
  it('should lowercase company names', () => {
    expect(normalizeCompany('Google')).toBe('google');
    expect(normalizeCompany('Microsoft LLC')).toBe('microsoft llc');
  });

  it('should trim whitespace', () => {
    expect(normalizeCompany('  Google  ')).toBe('google');
  });

  it('should collapse multiple spaces', () => {
    expect(normalizeCompany('Google   LLC')).toBe('google llc');
  });
});

describe('normalizeUrl', () => {
  it('should lowercase URLs', () => {
    expect(normalizeUrl('https://EXAMPLE.COM/Jobs')).toBe('https://example.com/jobs');
  });

  it('should strip query parameters', () => {
    expect(normalizeUrl('https://example.com/jobs?id=123')).toBe('https://example.com/jobs');
  });

  it('should strip trailing slash', () => {
    expect(normalizeUrl('https://example.com/jobs/')).toBe('https://example.com/jobs');
  });

  it('should handle URLs without protocol', () => {
    expect(normalizeUrl('example.com/jobs')).toBe('example.com/jobs');
  });
});

describe('loadAppliedCompanies', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should load companies from file', async () => {
    mockedFs.readFile.mockResolvedValueOnce('Google\nMicrosoft\nApple');
    
    const companies = await loadAppliedCompanies('/path/to/applied.txt');
    
    expect(companies).toContain('google');
    expect(companies).toContain('microsoft');
    expect(companies).toContain('apple');
    expect(companies.size).toBe(3);
  });

  it('should ignore comment lines starting with #', async () => {
    mockedFs.readFile.mockResolvedValueOnce('# This is a comment\nGoogle\n# Another comment\nMicrosoft');
    
    const companies = await loadAppliedCompanies('/path/to/applied.txt');
    
    expect(companies).toContain('google');
    expect(companies).toContain('microsoft');
    expect(companies.size).toBe(2);
  });

  it('should ignore blank lines', async () => {
    mockedFs.readFile.mockResolvedValueOnce('Google\n\n\nMicrosoft\n\n');
    
    const companies = await loadAppliedCompanies('/path/to/applied.txt');
    
    expect(companies.size).toBe(2);
  });

  it('should return empty set if file does not exist', async () => {
    mockedFs.readFile.mockRejectedValueOnce(new Error('File not found'));
    
    const companies = await loadAppliedCompanies('/path/to/applied.txt');
    
    expect(companies.size).toBe(0);
  });
});

describe('loadProcessedUrls', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should load URLs from JSON file', async () => {
    const data = [
      { url: 'https://example.com/job1' },
      { url: 'https://example.com/job2' },
    ];
    mockedFs.readFile.mockResolvedValueOnce(JSON.stringify(data));
    
    const urls = await loadProcessedUrls('/path/to/processed.json');
    
    expect(urls).toContain('https://example.com/job1');
    expect(urls).toContain('https://example.com/job2');
    expect(urls.size).toBe(2);
  });

  it('should normalize URLs', async () => {
    const data = [
      { url: 'https://EXAMPLE.COM/Job1/' },
    ];
    mockedFs.readFile.mockResolvedValueOnce(JSON.stringify(data));
    
    const urls = await loadProcessedUrls('/path/to/processed.json');
    
    expect(urls).toContain('https://example.com/job1');
  });

  it('should return empty set if file does not exist', async () => {
    mockedFs.readFile.mockRejectedValueOnce(new Error('File not found'));
    
    const urls = await loadProcessedUrls('/path/to/processed.json');
    
    expect(urls.size).toBe(0);
  });
});

describe('isJuniorRole', () => {
  it('should detect junior roles', () => {
    expect(isJuniorRole('Junior Developer')).toBe(true);
    expect(isJuniorRole('Junior Software Engineer')).toBe(true);
  });

  it('should detect entry-level roles', () => {
    expect(isJuniorRole('Entry Level Developer')).toBe(true);
    expect(isJuniorRole('Entry-Level Developer')).toBe(true);
  });

  it('should detect graduate roles', () => {
    expect(isJuniorRole('Graduate Developer')).toBe(true);
  });

  it('should detect intern roles', () => {
    expect(isJuniorRole('Software Engineering Intern')).toBe(true);
    expect(isJuniorRole('Intern Developer')).toBe(true);
  });

  it('should detect trainee roles', () => {
    expect(isJuniorRole('Trainee Developer')).toBe(true);
  });

  it('should NOT match junior in different context', () => {
    expect(isJuniorRole('Senior managing junior team')).toBe(false);
    expect(isJuniorRole('Senior Developer')).toBe(false);
  });

  it('should be case-insensitive', () => {
    expect(isJuniorRole('JUNIOR DEVELOPER')).toBe(true);
    expect(isJuniorRole('Entry Level Developer')).toBe(true);
  });
});

describe('applyFilters', () => {
  const appliedCompanies = new Set(['google', 'microsoft']);
  const processedUrls = new Set(['https://example.com/job1']);

  it('should reject fetch_failed jobs', () => {
    const spec: JobSpec = {
      id: '1',
      company: 'New Company',
      title: 'Senior Developer',
      url: 'https://example.com/new',
      source: 'linkedin',
      discoveredAt: '2024-01-01',
      specText: '',
      fetchStatus: 'failed',
      fetchError: 'Network error',
      fetchedAt: '2024-01-01',
    };

    const result = applyFilters(spec, appliedCompanies, processedUrls);
    expect(result).toBe('fetch_failed');
  });

  it('should reject already_applied companies', () => {
    const spec: JobSpec = {
      id: '1',
      company: 'Google',
      title: 'Senior Developer',
      url: 'https://example.com/new',
      source: 'linkedin',
      discoveredAt: '2024-01-01',
      specText: '',
      fetchStatus: 'success',
      fetchError: undefined,
      fetchedAt: '2024-01-01',
    };

    const result = applyFilters(spec, appliedCompanies, processedUrls);
    expect(result).toBe('already_applied');
  });

  it('should reject already_sent URLs', () => {
    const spec: JobSpec = {
      id: '1',
      company: 'New Company',
      title: 'Senior Developer',
      url: 'https://example.com/job1',
      source: 'linkedin',
      discoveredAt: '2024-01-01',
      specText: '',
      fetchStatus: 'success',
      fetchError: undefined,
      fetchedAt: '2024-01-01',
    };

    const result = applyFilters(spec, appliedCompanies, processedUrls);
    expect(result).toBe('already_sent');
  });

  it('should reject junior roles', () => {
    const spec: JobSpec = {
      id: '1',
      company: 'New Company',
      title: 'Junior Developer',
      url: 'https://example.com/new',
      source: 'linkedin',
      discoveredAt: '2024-01-01',
      specText: '',
      fetchStatus: 'success',
      fetchError: undefined,
      fetchedAt: '2024-01-01',
    };

    const result = applyFilters(spec, appliedCompanies, processedUrls);
    expect(result).toBe('junior_role');
  });

  it('should return null for passing jobs', () => {
    const spec: JobSpec = {
      id: '1',
      company: 'New Company',
      title: 'Senior Developer',
      url: 'https://example.com/new',
      source: 'linkedin',
      discoveredAt: '2024-01-01',
      specText: '',
      fetchStatus: 'success',
      fetchError: undefined,
      fetchedAt: '2024-01-01',
    };

    const result = applyFilters(spec, appliedCompanies, processedUrls);
    expect(result).toBeNull();
  });

  it('should apply first matching filter only', () => {
    // This job would match both fetch_failed and already_applied
    const spec: JobSpec = {
      id: '1',
      company: 'Google',
      title: 'Senior Developer',
      url: 'https://example.com/new',
      source: 'linkedin',
      discoveredAt: '2024-01-01',
      specText: '',
      fetchStatus: 'failed',
      fetchError: 'Network error',
      fetchedAt: '2024-01-01',
    };

    const result = applyFilters(spec, appliedCompanies, processedUrls);
    // fetch_failed is checked first
    expect(result).toBe('fetch_failed');
  });
});

describe('runPreFilter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should separate survivors and rejections', async () => {
    const specs: JobSpec[] = [
      {
        id: '1',
        company: 'New Company',
        title: 'Senior Developer',
        url: 'https://example.com/new',
        source: 'linkedin',
        discoveredAt: '2024-01-01',
        specText: '',
        fetchStatus: 'success',
        fetchError: undefined,
        fetchedAt: '2024-01-01',
      },
      {
        id: '2',
        company: 'Google',
        title: 'Senior Developer',
        url: 'https://example.com/job2',
        source: 'linkedin',
        discoveredAt: '2024-01-01',
        specText: '',
        fetchStatus: 'success',
        fetchError: undefined,
        fetchedAt: '2024-01-01',
      },
    ];

    mockedFs.readFile.mockResolvedValueOnce('Google\nMicrosoft');
    mockedFs.readFile.mockResolvedValueOnce('[]');

    const result = await runPreFilter(specs);

    expect(result.survivors).toHaveLength(1);
    expect(result.survivors[0]?.id).toBe('1');
    expect(result.rejections).toHaveLength(1);
    expect(result.rejections[0]?.jobId).toBe('2');
    expect(result.stats.total).toBe(2);
    expect(result.stats.survivors).toBe(1);
    expect(result.stats.rejections).toBe(1);
  });

  it('should track rejection reasons', async () => {
    const specs: JobSpec[] = [
      {
        id: '1',
        company: 'New Company',
        title: 'Senior Developer',
        url: 'https://example.com/new',
        source: 'linkedin',
        discoveredAt: '2024-01-01',
        specText: '',
        fetchStatus: 'failed',
        fetchError: 'Error',
        fetchedAt: '2024-01-01',
      },
      {
        id: '2',
        company: 'Google',
        title: 'Senior Developer',
        url: 'https://example.com/job2',
        source: 'linkedin',
        discoveredAt: '2024-01-01',
        specText: '',
        fetchStatus: 'success',
        fetchError: undefined,
        fetchedAt: '2024-01-01',
      },
      {
        id: '3',
        company: 'New Company',
        title: 'Junior Developer',
        url: 'https://example.com/job3',
        source: 'linkedin',
        discoveredAt: '2024-01-01',
        specText: '',
        fetchStatus: 'success',
        fetchError: undefined,
        fetchedAt: '2024-01-01',
      },
    ];

    mockedFs.readFile.mockResolvedValueOnce('Google');
    mockedFs.readFile.mockResolvedValueOnce('[]');

    const result = await runPreFilter(specs);

    expect(result.stats.byReason.fetch_failed).toBe(1);
    expect(result.stats.byReason.already_applied).toBe(1);
    expect(result.stats.byReason.junior_role).toBe(1);
  });
});
