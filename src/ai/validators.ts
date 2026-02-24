import { normalizeUrl } from '../prefilter';

export type ScoreVerdict = 'PASS' | 'REVIEW' | 'REJECT';

export interface ExtractedJobCandidate {
  company: string;
  title: string;
  url: string;
}

export interface ParsedScorePayload {
  score: number;
  reasoning: string;
  verdict: ScoreVerdict | undefined;
  matchReasons: string[];
  concerns: string[];
  redFlags: string[];
  summary: string;
}

interface ParsedCandidateRecord {
  company: string;
  title: string;
  url: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asNumber(value: unknown): number {
  return typeof value === 'number' ? value : Number.NaN;
}

function stripMarkdownCodeFences(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith('```')) {
    return trimmed;
  }

  const withoutStart = trimmed.replace(/^```[a-zA-Z0-9_-]*\s*/u, '');
  return withoutStart.replace(/\s*```$/u, '').trim();
}

function findLikelyJsonSegment(value: string): string {
  const firstBrace = value.indexOf('{');
  const firstBracket = value.indexOf('[');

  const candidates = [firstBrace, firstBracket].filter(index => index >= 0);
  if (candidates.length === 0) {
    return value;
  }

  const start = Math.min(...candidates);
  const lastBrace = value.lastIndexOf('}');
  const lastBracket = value.lastIndexOf(']');
  const end = Math.max(lastBrace, lastBracket);
  if (end < start) {
    return value;
  }

  return value.slice(start, end + 1).trim();
}

export function parseModelJson(rawText: string): unknown {
  const noFence = stripMarkdownCodeFences(rawText);

  try {
    return JSON.parse(noFence) as unknown;
  } catch {
    const segment = findLikelyJsonSegment(noFence);
    return JSON.parse(segment) as unknown;
  }
}

function coerceCandidate(value: unknown): ParsedCandidateRecord | null {
  if (!isRecord(value)) {
    return null;
  }

  const company = asString(value.company);
  const title = asString(value.title);
  const url = asString(value.url);

  if (company === '' || url === '') {
    return null;
  }

  return {
    company,
    title,
    url,
  };
}

export function parseExtractedCandidates(rawText: string): ExtractedJobCandidate[] {
  const parsed = parseModelJson(rawText);

  let rawCandidates: unknown[] = [];
  if (Array.isArray(parsed)) {
    rawCandidates = parsed;
  } else if (isRecord(parsed) && Array.isArray(parsed.candidates)) {
    rawCandidates = parsed.candidates;
  }

  const output: ExtractedJobCandidate[] = [];
  for (const candidate of rawCandidates) {
    const coerced = coerceCandidate(candidate);
    if (coerced === null) {
      continue;
    }

    output.push({
      company: coerced.company,
      title: coerced.title,
      url: coerced.url,
    });
  }

  return output;
}

export function normalizeHttpUrl(rawUrl: string): string | null {
  if (rawUrl.trim() === '') {
    return null;
  }

  try {
    const parsed = new URL(rawUrl);
    const protocol = parsed.protocol.toLowerCase();
    if (protocol !== 'http:' && protocol !== 'https:') {
      return null;
    }
    return normalizeUrl(rawUrl);
  } catch {
    return null;
  }
}

export function clampScore(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  const rounded = Math.round(value);
  if (rounded < 0) {
    return 0;
  }
  if (rounded > 10) {
    return 10;
  }

  return rounded;
}

export function scoreToVerdict(score: number): ScoreVerdict {
  if (score >= 7) {
    return 'PASS';
  }
  if (score >= 4) {
    return 'REVIEW';
  }
  return 'REJECT';
}

export function parseOptionalStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      continue;
    }
    const trimmed = item.trim();
    if (trimmed !== '') {
      normalized.push(trimmed);
    }
  }

  return normalized;
}

function parseOptionalVerdict(value: unknown): ScoreVerdict | undefined {
  const verdict = asString(value).toUpperCase();
  if (verdict === 'PASS' || verdict === 'REVIEW' || verdict === 'REJECT') {
    return verdict;
  }
  return undefined;
}

export function parseScorePayload(rawText: string): ParsedScorePayload {
  const parsed = parseModelJson(rawText);
  if (!isRecord(parsed)) {
    return {
      score: 0,
      reasoning: 'Model returned a non-object payload',
      verdict: undefined,
      matchReasons: [],
      concerns: [],
      redFlags: [],
      summary: '',
    };
  }

  const score = clampScore(asNumber(parsed.score));
  const reasoning = asString(parsed.reasoning);

  return {
    score,
    reasoning: reasoning === '' ? 'Model did not provide reasoning' : reasoning,
    verdict: parseOptionalVerdict(parsed.verdict),
    matchReasons: parseOptionalStringArray(parsed.match_reasons),
    concerns: parseOptionalStringArray(parsed.concerns),
    redFlags: parseOptionalStringArray(parsed.red_flags),
    summary: asString(parsed.summary),
  };
}
