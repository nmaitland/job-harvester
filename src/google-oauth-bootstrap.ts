/**
 * google-oauth-bootstrap.ts
 *
 * Interactive utility for first-time Google OAuth desktop authorization.
 * - Generates consent URL
 * - Accepts pasted auth code
 * - Exchanges code for tokens
 * - Writes token payload to .google-credentials.json
 * - Upserts GOOGLE_REFRESH_TOKEN in .env
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createInterface } from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import { google } from 'googleapis';

const ENV_FILE = '.env';
const ENV_DEV_FILE = '.env.dev';
const GOOGLE_CREDENTIALS_FILE = '.google-credentials.json';
const DEFAULT_SCOPES = ['https://www.googleapis.com/auth/gmail.modify'];

function normalizeRedirectUri(value: string): string {
  return value.trim();
}

function parseEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    if (key !== '') {
      result[key] = value;
    }
  }

  return result;
}

function upsertEnvValue(content: string, key: string, value: string): string {
  const lines = content.split(/\r?\n/);
  let updated = false;

  const nextLines = lines.map((line) => {
    if (line.startsWith(`${key}=`)) {
      updated = true;
      return `${key}=${value}`;
    }
    return line;
  });

  if (!updated) {
    if (nextLines.length > 0 && nextLines[nextLines.length - 1] !== '') {
      nextLines.push('');
    }
    nextLines.push(`${key}=${value}`);
  }

  return `${nextLines.join('\n')}\n`;
}

async function readEnvFile(): Promise<string> {
  try {
    return await fs.readFile(ENV_FILE, 'utf-8');
  } catch {
    try {
      return await fs.readFile(ENV_DEV_FILE, 'utf-8');
    } catch {
      return '';
    }
  }
}

async function main(): Promise<void> {
  const envContent = await readEnvFile();
  const env = parseEnv(envContent);

  const clientId =
    env.GOOGLE_CLIENT_ID ??
    process.env.GOOGLE_CLIENT_ID ??
    '';
  const clientSecret =
    env.GOOGLE_CLIENT_SECRET ??
    process.env.GOOGLE_CLIENT_SECRET ??
    '';
  const redirectUri = normalizeRedirectUri(
    env.GOOGLE_REDIRECT_URI ?? process.env.GOOGLE_REDIRECT_URI ?? 'http://localhost'
  );

  if (clientId === '' || clientSecret === '') {
    throw new Error('Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in .env or process env');
  }

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: DEFAULT_SCOPES,
  });

  output.write('\n=== Google OAuth Bootstrap ===\n');
  output.write('1) Open this URL in your browser and complete consent:\n\n');
  output.write(`${authUrl}\n\n`);
  output.write('2) Paste the authorization code below.\n\n');

  const rl = createInterface({ input, output });
  const authCode = (await rl.question('Authorization code: ')).trim();
  rl.close();

  if (authCode === '') {
    throw new Error('No authorization code provided');
  }

  const tokenResponse = await oauth2Client.getToken(authCode);
  const tokens = tokenResponse.tokens;

  await fs.writeFile(
    GOOGLE_CREDENTIALS_FILE,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        redirectUri,
        scopes: DEFAULT_SCOPES,
        tokens,
      },
      null,
      2
    ),
    'utf-8'
  );

  if (tokens.refresh_token === undefined || tokens.refresh_token === '') {
    throw new Error(
      `Token exchange succeeded but no refresh token was returned. ${
        'Ensure this is the first consent grant or use prompt=consent and access_type=offline.'
      }`
    );
  }

  const refreshToken = tokens.refresh_token;
  if (refreshToken === null || refreshToken === undefined || refreshToken === '') {
    throw new Error('Missing refresh token after token exchange');
  }

  const updatedEnv = upsertEnvValue(envContent, 'GOOGLE_REFRESH_TOKEN', refreshToken);
  await fs.writeFile(path.join('.', ENV_FILE), updatedEnv, 'utf-8');

  output.write('\nBootstrap complete.\n');
  output.write(`- Wrote token payload: ${GOOGLE_CREDENTIALS_FILE}\n`);
  output.write(`- Updated ${ENV_FILE} with GOOGLE_REFRESH_TOKEN\n`);
  if (tokens.access_token !== undefined && tokens.access_token !== '') {
    output.write('- Access token captured in .google-credentials.json\n');
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    output.write(`\nOAuth bootstrap failed: ${message}\n`);
    process.exit(1);
  });
}
