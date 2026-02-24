import {
  clampScore,
  normalizeHttpUrl,
  parseExtractedCandidates,
  parseModelJson,
  parseOptionalStringArray,
  parseScorePayload,
  scoreToVerdict,
} from '../ai/validators';

describe('parseModelJson', () => {
  it('parses fenced JSON', () => {
    const result = parseModelJson('```json\n{"a":1}\n```') as { a: number };
    expect(result.a).toBe(1);
  });

  it('parses JSON embedded in extra text', () => {
    const result = parseModelJson('noise before\n{"a":2}\nnoise after') as { a: number };
    expect(result.a).toBe(2);
  });
});

describe('parseExtractedCandidates', () => {
  it('accepts candidates wrapper format', () => {
    const raw = JSON.stringify({
      candidates: [
        { company: 'Acme', title: 'CTO', url: 'https://example.com/jobs/1' },
      ],
    });

    const candidates = parseExtractedCandidates(raw);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.company).toBe('Acme');
  });

  it('accepts top-level array format and filters invalid rows', () => {
    const raw = JSON.stringify([
      { company: 'Acme', title: 'CTO', url: 'https://example.com/jobs/1' },
      { company: '', title: 'Nope', url: 'https://example.com/jobs/2' },
      { company: 'Beta', title: 'Role', url: '' },
    ]);

    const candidates = parseExtractedCandidates(raw);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.company).toBe('Acme');
  });
});

describe('normalizeHttpUrl', () => {
  it('normalizes valid http URLs and strips query params', () => {
    const normalized = normalizeHttpUrl('https://EXAMPLE.com/jobs/123?x=1');
    expect(normalized).toBe('https://example.com/jobs/123');
  });

  it('rejects non-http URLs', () => {
    expect(normalizeHttpUrl('mailto:test@example.com')).toBeNull();
  });
});

describe('score and verdict helpers', () => {
  it('clamps scores into 0-10 range', () => {
    expect(clampScore(11)).toBe(10);
    expect(clampScore(-2)).toBe(0);
    expect(clampScore(5.6)).toBe(6);
  });

  it('maps thresholds to verdicts', () => {
    expect(scoreToVerdict(8)).toBe('PASS');
    expect(scoreToVerdict(5)).toBe('REVIEW');
    expect(scoreToVerdict(2)).toBe('REJECT');
  });
});

describe('parseScorePayload', () => {
  it('parses full score payload with optional arrays', () => {
    const raw = JSON.stringify({
      score: 8,
      reasoning: 'Strong fit',
      verdict: 'PASS',
      match_reasons: ['leadership'],
      concerns: ['some coding expected'],
      red_flags: [],
      summary: 'Good fit',
    });

    const parsed = parseScorePayload(raw);
    expect(parsed.score).toBe(8);
    expect(parsed.verdict).toBe('PASS');
    expect(parsed.matchReasons).toEqual(['leadership']);
    expect(parsed.concerns).toEqual(['some coding expected']);
    expect(parsed.summary).toBe('Good fit');
  });

  it('falls back safely on malformed payload', () => {
    const parsed = parseScorePayload('[]');
    expect(parsed.score).toBe(0);
    expect(parsed.reasoning).toContain('non-object payload');
  });
});

describe('parseOptionalStringArray', () => {
  it('filters to non-empty strings only', () => {
    const result = parseOptionalStringArray(['a', ' ', 1, 'b']);
    expect(result).toEqual(['a', 'b']);
  });
});

