/**
 * Tests for 07-generate-pdfs.ts
 */

import { buildFilename, renderJobHtml, generateJobPdf, decodeHtmlEntities } from '../generate-pdfs';
import type { CompiledJob } from '../types';

// Mock logger
jest.mock('../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
}));

describe('buildFilename', () => {
  it('should include date, score, company, and advert for PASS jobs', () => {
    const job = {
      jobId: '1',
      company: 'Google',
      title: 'Developer',
      url: 'https://example.com',
      specText: '',
      score: 8,
      reasoning: 'Good fit',
      passedPreFilter: true,
      rejectionReason: undefined,
      status: 'scored' as const,
      compiledAt: '2024-01-15T10:00:00Z',
      tier: 'passed' as const,
    };

    const result = buildFilename(job);
    expect(result).toBe('2024-01-15-S8-google-advert.pdf');
  });

  it('should include same format for REVIEW jobs', () => {
    const job = {
      jobId: '1',
      company: 'Startup',
      title: 'Developer',
      url: 'https://example.com',
      specText: '',
      score: 5,
      reasoning: 'Maybe',
      passedPreFilter: true,
      rejectionReason: undefined,
      status: 'scored' as const,
      compiledAt: '2024-01-20T15:30:00Z',
      tier: 'review' as const,
    };

    const result = buildFilename(job);
    expect(result).toBe('2024-01-20-S5-startup-advert.pdf');
  });

  it('should slugify company names correctly', () => {
    const job = {
      jobId: '1',
      company: 'ACME Corp Ltd.',
      title: 'Developer',
      url: 'https://example.com',
      specText: '',
      score: 8,
      reasoning: 'Good',
      passedPreFilter: true,
      rejectionReason: undefined,
      status: 'scored' as const,
      compiledAt: '2024-01-15T10:00:00Z',
      tier: 'passed' as const,
    };

    const result = buildFilename(job);
    expect(result).toContain('acme-corp-ltd');
    expect(result).toContain('-S8-');
  });
});

describe('renderJobHtml', () => {
  it('should produce valid HTML containing company name', () => {
    const job: CompiledJob = {
      jobId: '1',
      company: 'Google',
      title: 'Senior Developer',
      url: 'https://example.com/job',
      specText: 'Job description here',
      score: 8,
      reasoning: 'Strong technical fit',
      passedPreFilter: true,
      rejectionReason: undefined,
      status: 'scored',
      compiledAt: '2024-01-15T10:00:00Z',
    };

    const result = renderJobHtml(job);
    expect(result).toContain('Google');
    expect(result).toContain('<!DOCTYPE html>');
    expect(result).toContain('<html>');
  });

  it('should contain job title', () => {
    const job: CompiledJob = {
      jobId: '1',
      company: 'Company',
      title: 'CTO Position',
      url: 'https://example.com',
      specText: '',
      score: 9,
      reasoning: 'Good',
      passedPreFilter: true,
      rejectionReason: undefined,
      status: 'scored',
      compiledAt: '2024-01-15T10:00:00Z',
    };

    const result = renderJobHtml(job);
    expect(result).toContain('CTO Position');
  });

  it('should contain score badge for PASS jobs', () => {
    const job: CompiledJob = {
      jobId: '1',
      company: 'Company',
      title: 'Developer',
      url: 'https://example.com',
      specText: '',
      score: 8,
      reasoning: 'Excellent match',
      passedPreFilter: true,
      rejectionReason: undefined,
      status: 'scored',
      compiledAt: '2024-01-15T10:00:00Z',
    };

    const result = renderJobHtml(job);
    expect(result).toContain('PASS');
    expect(result).toContain('8/10');
    expect(result).toContain('#4CAF50');
  });

  it('should contain score badge for REVIEW jobs', () => {
    const job: CompiledJob = {
      jobId: '1',
      company: 'Company',
      title: 'Developer',
      url: 'https://example.com',
      specText: '',
      score: 5,
      reasoning: 'Partial match',
      passedPreFilter: true,
      rejectionReason: undefined,
      status: 'scored',
      compiledAt: '2024-01-15T10:00:00Z',
    };

    const result = renderJobHtml(job);
    expect(result).toContain('REVIEW');
    expect(result).toContain('5/10');
    expect(result).toContain('#FF9800');
  });

  it('should contain reasoning', () => {
    const job: CompiledJob = {
      jobId: '1',
      company: 'Company',
      title: 'Developer',
      url: 'https://example.com',
      specText: '',
      score: 7,
      reasoning: 'Strong leadership experience',
      passedPreFilter: true,
      rejectionReason: undefined,
      status: 'scored',
      compiledAt: '2024-01-15T10:00:00Z',
    };

    const result = renderJobHtml(job);
    expect(result).toContain('Strong leadership experience');
  });

  it('should escape HTML in spec text', () => {
    const job: CompiledJob = {
      jobId: '1',
      company: 'Company',
      title: 'Developer',
      url: 'https://example.com',
      specText: '<script>alert("xss")</script>',
      score: 7,
      reasoning: 'Good',
      passedPreFilter: true,
      rejectionReason: undefined,
      status: 'scored',
      compiledAt: '2024-01-15T10:00:00Z',
    };

    const result = renderJobHtml(job);
    expect(result).not.toContain('<script>alert');
    expect(result).toContain('&lt;script&gt;');
  });

  it('should contain job URL', () => {
    const job: CompiledJob = {
      jobId: '1',
      company: 'Company',
      title: 'Developer',
      url: 'https://example.com/job/123',
      specText: '',
      score: 7,
      reasoning: 'Good',
      passedPreFilter: true,
      rejectionReason: undefined,
      status: 'scored',
      compiledAt: '2024-01-15T10:00:00Z',
    };

    const result = renderJobHtml(job);
    expect(result).toContain('https://example.com/job/123');
  });
});

describe('decodeHtmlEntities', () => {
  it('should decode named entities', () => {
    expect(decodeHtmlEntities('We&apos;re hiring')).toBe("We're hiring");
    expect(decodeHtmlEntities('R&amp;D team')).toBe('R&D team');
    expect(decodeHtmlEntities('&ldquo;hello&rdquo;')).toBe('\u201Chello\u201D');
  });

  it('should decode hex numeric entities', () => {
    expect(decodeHtmlEntities('fast&#x2014;moving')).toBe('fast\u2014moving');
    expect(decodeHtmlEntities('2013&#x2013;2024')).toBe('2013\u20132024');
    expect(decodeHtmlEntities('it&#x2019;s')).toBe('it\u2019s');
  });

  it('should decode decimal numeric entities', () => {
    expect(decodeHtmlEntities('em&#8212;dash')).toBe('em\u2014dash');
    expect(decodeHtmlEntities('en&#8211;dash')).toBe('en\u2013dash');
  });

  it('should handle mixed entities in one string', () => {
    const input = 'We&apos;re building &#x2014; R&amp;D &ldquo;team&rdquo;';
    const expected = "We're building \u2014 R&D \u201Cteam\u201D";
    expect(decodeHtmlEntities(input)).toBe(expected);
  });

  it('should pass through text without entities unchanged', () => {
    expect(decodeHtmlEntities('plain text')).toBe('plain text');
  });
});

describe('renderJobHtml HTML entity handling', () => {
  it('should decode HTML entities in specText before rendering', () => {
    const job: CompiledJob = {
      jobId: '1',
      company: 'Company',
      title: 'Developer',
      url: 'https://example.com',
      specText: 'We&apos;re hiring &#x2014; join us',
      score: 8,
      reasoning: 'Good',
      passedPreFilter: true,
      rejectionReason: undefined,
      status: 'scored',
      compiledAt: '2024-01-15T10:00:00Z',
    };

    const result = renderJobHtml(job);
    // Should NOT contain double-encoded &amp;apos;
    expect(result).not.toContain('&amp;apos;');
    expect(result).not.toContain('&amp;#x2014;');
    // Should contain the decoded characters (re-escaped where needed)
    expect(result).toContain("We&#039;re hiring \u2014 join us");
  });

  it('should decode HTML entities in title, company, and reasoning', () => {
    const job: CompiledJob = {
      jobId: '1',
      company: 'O&apos;Reilly',
      title: 'R&amp;D Lead',
      url: 'https://example.com',
      specText: '',
      score: 8,
      reasoning: 'Great fit &#x2014; strong match',
      passedPreFilter: true,
      rejectionReason: undefined,
      status: 'scored',
      compiledAt: '2024-01-15T10:00:00Z',
    };

    const result = renderJobHtml(job);
    expect(result).toContain("O&#039;Reilly");
    expect(result).toContain('R&amp;D Lead');
    expect(result).toContain('Great fit \u2014 strong match');
    expect(result).not.toContain('&amp;apos;');
    expect(result).not.toContain('&amp;amp;');
  });
});

describe('generateJobPdf', () => {
  const mockPage = {
    setContent: jest.fn(),
    pdf: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should call page.setContent with rendered HTML', async () => {
    const job = {
      jobId: '1',
      company: 'Google',
      title: 'Developer',
      url: 'https://example.com',
      specText: 'Description',
      score: 8,
      reasoning: 'Good fit',
      passedPreFilter: true,
      rejectionReason: undefined,
      status: 'scored' as const,
      compiledAt: '2024-01-15T10:00:00Z',
      tier: 'passed' as const,
    };

    mockPage.setContent.mockResolvedValue(undefined);
    mockPage.pdf.mockResolvedValue(undefined);

    await generateJobPdf(job, '/output/dir', mockPage as unknown as import('playwright').Page);

    expect(mockPage.setContent).toHaveBeenCalled();
    const htmlArg = mockPage.setContent.mock.calls[0]?.[0] as string;
    expect(htmlArg).toContain('Google');
    expect(htmlArg).toContain('Developer');
  });

  it('should call page.pdf with correct path', async () => {
    const job = {
      jobId: '1',
      company: 'Startup',
      title: 'CTO',
      url: 'https://example.com',
      specText: '',
      score: 9,
      reasoning: 'Excellent',
      passedPreFilter: true,
      rejectionReason: undefined,
      status: 'scored' as const,
      compiledAt: '2024-01-15T10:00:00Z',
      tier: 'passed' as const,
    };

    mockPage.setContent.mockResolvedValue(undefined);
    mockPage.pdf.mockResolvedValue(undefined);

    await generateJobPdf(job, '/output/dir', mockPage as unknown as import('playwright').Page);

    expect(mockPage.pdf).toHaveBeenCalledWith({
      path: expect.stringContaining('startup'),
      format: 'A4',
    });
  });

  it('should return PDF result on success', async () => {
    const job = {
      jobId: 'job-123',
      company: 'Company',
      title: 'Developer',
      url: 'https://example.com',
      specText: '',
      score: 8,
      reasoning: 'Good',
      passedPreFilter: true,
      rejectionReason: undefined,
      status: 'scored' as const,
      compiledAt: '2024-01-15T10:00:00Z',
      tier: 'passed' as const,
    };

    mockPage.setContent.mockResolvedValue(undefined);
    mockPage.pdf.mockResolvedValue(undefined);

    const result = await generateJobPdf(job, '/output', mockPage as unknown as import('playwright').Page);

    expect(result.jobId).toBe('job-123');
    expect(result.company).toBe('Company');
    expect(result.title).toBe('Developer');
    expect(result.pdfPath).toContain('company');
    expect(result.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}/);
  });

  it('should throw on PDF generation error', async () => {
    const job = {
      jobId: '1',
      company: 'Company',
      title: 'Developer',
      url: 'https://example.com',
      specText: '',
      score: 8,
      reasoning: 'Good',
      passedPreFilter: true,
      rejectionReason: undefined,
      status: 'scored' as const,
      compiledAt: '2024-01-15T10:00:00Z',
      tier: 'passed' as const,
    };

    mockPage.setContent.mockResolvedValue(undefined);
    mockPage.pdf.mockRejectedValue(new Error('PDF generation failed'));

    await expect(
      generateJobPdf(job, '/output', mockPage as unknown as import('playwright').Page)
    ).rejects.toThrow('PDF generation failed');
  });
});
