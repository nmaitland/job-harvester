import { sleep, withTimeout } from '../utils/http';

type OpenRouterRole = 'system' | 'user' | 'assistant';

export interface OpenRouterMessage {
  role: OpenRouterRole;
  content: string;
}

export interface OpenRouterRequestOptions {
  temperature?: number;
  maxTokens?: number;
}

interface OpenRouterConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
  timeoutMs: number;
  maxRetries: number;
  httpReferer: string;
  title: string;
}

function parseEnvInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }

  return parsed;
}

function readConfig(): OpenRouterConfig {
  const apiKey = process.env.OPENROUTER_API_KEY ?? '';
  const model = process.env.OPENROUTER_MODEL ?? '';

  if (apiKey === '') {
    throw new Error('OPENROUTER_API_KEY is required');
  }

  if (model === '') {
    throw new Error('OPENROUTER_MODEL is required');
  }

  const baseUrl = (process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1').replace(/\/+$/, '');

  return {
    apiKey,
    model,
    baseUrl,
    timeoutMs: parseEnvInt(process.env.OPENROUTER_TIMEOUT_MS, 90000),
    maxRetries: parseEnvInt(process.env.OPENROUTER_MAX_RETRIES, 2),
    httpReferer: process.env.OPENROUTER_HTTP_REFERER ?? '',
    title: process.env.OPENROUTER_TITLE ?? 'job-harvester',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function readStringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}

function extractContent(payload: unknown): string {
  if (!isRecord(payload)) {
    throw new Error('OpenRouter response is not an object');
  }

  const rawChoices = payload.choices;
  if (!isUnknownArray(rawChoices) || rawChoices.length === 0) {
    const errorText = isRecord(payload.error) ? readStringField(payload.error, 'message') : '';
    if (errorText !== '') {
      throw new Error(`OpenRouter error: ${errorText}`);
    }
    throw new Error('OpenRouter response contained no choices');
  }

  const firstChoice = rawChoices[0];
  if (!isRecord(firstChoice)) {
    throw new Error('OpenRouter choice payload is invalid');
  }

  const message = firstChoice.message;
  if (!isRecord(message)) {
    throw new Error('OpenRouter choice message is missing');
  }

  const content = message.content;
  if (typeof content === 'string') {
    const trimmed = content.trim();
    if (trimmed !== '') {
      return trimmed;
    }
  }

  if (Array.isArray(content)) {
    const textParts: string[] = [];
    for (const part of content) {
      if (!isRecord(part)) {
        continue;
      }
      const text = readStringField(part, 'text').trim();
      if (text !== '') {
        textParts.push(text);
      }
    }

    const joined = textParts.join('\n').trim();
    if (joined !== '') {
      return joined;
    }
  }

  throw new Error('OpenRouter response message content was empty');
}

function shouldRetryStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function buildHeaders(config: OpenRouterConfig): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.apiKey}`,
    'Content-Type': 'application/json',
  };

  if (config.httpReferer.trim() !== '') {
    headers['HTTP-Referer'] = config.httpReferer;
  }

  if (config.title.trim() !== '') {
    headers['X-Title'] = config.title;
  }

  return headers;
}

export async function requestOpenRouterChat(
  messages: OpenRouterMessage[],
  options: OpenRouterRequestOptions = {}
): Promise<string> {
  const config = readConfig();
  const endpoint = `${config.baseUrl}/chat/completions`;
  const headers = buildHeaders(config);

  const payload: Record<string, unknown> = {
    model: config.model,
    messages,
    temperature: options.temperature ?? 0,
  };

  if (options.maxTokens !== undefined) {
    payload.max_tokens = options.maxTokens;
  }

  const maxAttempts = config.maxRetries + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const response = await withTimeout(
      fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      }),
      config.timeoutMs,
      'OpenRouter chat completion'
    );

    if (!response.ok) {
      const responseText = await withTimeout(
        response.text(),
        config.timeoutMs,
        'OpenRouter error response body'
      );
      const retryable = shouldRetryStatus(response.status);
      if (retryable && attempt < maxAttempts) {
        await sleep(1000 * attempt);
        continue;
      }

      throw new Error(`OpenRouter HTTP ${response.status}: ${responseText}`);
    }

    const responsePayload = await withTimeout(
      response.json() as Promise<unknown>,
      config.timeoutMs,
      'OpenRouter response body'
    );
    try {
      return extractContent(responsePayload);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`OpenRouter response parsing failed: ${message}`);
    }
  }

  throw new Error('OpenRouter request failed after max retries');
}
