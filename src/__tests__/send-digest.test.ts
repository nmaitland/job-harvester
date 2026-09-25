import * as fs from 'fs/promises';
import { buildDigest, sendDigest } from '../send-digest';
import type { RunFacts } from '../summarize-run';
import type { CompiledJob } from '../types';

jest.mock('fs/promises');
jest.mock('../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
}));

const mockSendMail = jest.fn();
jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({ sendMail: mockSendMail })),
}));

const mockedFs = fs as jest.Mocked<typeof fs>;

const facts: RunFacts = {
  runDir: '/run/run-2026-09-25-05-00-00',
  timestamp: '2026-09-25T05:45:00.000Z',
  runDate: '2026/09/25 05:00:00',
  discovered: 89,
  fetchedSuccess: 80,
  fetchedFailed: 9,
  survivors: 70,
  prefilterRejected: 19,
  pass: 1,
  review: 1,
  aiRejected: 68,
  pdfGenerated: 2,
};

function job(overrides: Partial<CompiledJob>): CompiledJob {
  return {
    jobId: 'j1',
    company: 'Acme',
    title: 'Engineering Manager',
    url: 'https://example.com/job/1',
    specText: '',
    score: 8,
    reasoning: 'Strong leadership match. Extra detail that should be cut.',
    passedPreFilter: true,
    rejectionReason: undefined,
    status: 'scored',
    compiledAt: '2026-09-25T05:44:00.000Z',
    ...overrides,
  };
}

describe('buildDigest', () => {
  it('lists jobs with links, first-sentence reasons, and escaped text', () => {
    const { subject, html } = buildDigest(facts, [
      job({}),
      job({ jobId: 'j2', company: 'R&D <Co>', title: 'Head of "AI"', score: 5 }),
    ]);

    expect(subject).toBe('Jobs 2026/09/25: 2 worth a look');
    expect(html).toContain('<a href="https://example.com/job/1">Engineering Manager</a>');
    expect(html).toContain('Strong leadership match.');
    expect(html).not.toContain('Extra detail');
    expect(html).toContain('R&amp;D &lt;Co&gt;');
    expect(html).toContain('Head of &quot;AI&quot;');
    expect(html).not.toContain('Most spec fetches failed');
  });

  it('still reports when nothing is worth a look, and flags mass fetch failure', () => {
    const { subject, html } = buildDigest({ ...facts, fetchedSuccess: 11, fetchedFailed: 78 }, []);

    expect(subject).toBe('Jobs 2026/09/25: nothing new');
    expect(html).toContain('Nothing scored 4+ today.');
    expect(html).toContain('Most spec fetches failed');
    expect(html).toContain('89 found · 11 fetched · 78 fetch failed');
  });

  it('caps the list and points to Drive for the rest', () => {
    const many = Array.from({ length: 18 }, (_, i) => job({ jobId: `j${i}` }));
    const { subject, html } = buildDigest(facts, many);

    expect(subject).toBe('Jobs 2026/09/25: 18 worth a look');
    expect(html.match(/<a href=/g)).toHaveLength(15);
    expect(html).toContain('+3 more in Drive.');
  });
});

describe('sendDigest', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASSWORD;
    delete process.env.DIGEST_EMAIL_TO;
    mockedFs.readFile.mockRejectedValue(new Error('ENOENT'));
  });

  it('skips when SMTP is not configured', async () => {
    await expect(sendDigest(facts.runDir)).resolves.toBe(false);
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('sends to DIGEST_EMAIL_TO from the SMTP account', async () => {
    process.env.SMTP_USER = 'sender@example.com';
    process.env.SMTP_PASSWORD = 'app-password';
    process.env.DIGEST_EMAIL_TO = 'me@example.com';

    await expect(sendDigest(facts.runDir)).resolves.toBe(true);
    expect(mockSendMail).toHaveBeenCalledWith(expect.objectContaining({
      from: 'sender@example.com',
      to: 'me@example.com',
      subject: 'Jobs 2026/09/25: nothing new',
    }));
  });

  it('throws when sending fails so the run is marked failed', async () => {
    process.env.SMTP_USER = 'sender@example.com';
    process.env.SMTP_PASSWORD = 'app-password';
    mockSendMail.mockRejectedValueOnce(new Error('Invalid login'));

    await expect(sendDigest(facts.runDir)).rejects.toThrow('Invalid login');
  });
});
