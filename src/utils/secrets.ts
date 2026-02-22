import * as logger from './logger';

export interface SecretProvider {
  get(name: string): Promise<string | undefined>;
}

class EnvSecretProvider implements SecretProvider {
  get(name: string): Promise<string | undefined> {
    const value = process.env[name];
    return Promise.resolve(value !== undefined && value !== '' ? value : undefined);
  }
}

const envProvider = new EnvSecretProvider();

export async function getSecret(name: string, provider: SecretProvider = envProvider): Promise<string> {
  const value = await provider.get(name);
  if (value === undefined) {
    logger.warn(`Secret ${name} not set`);
    return '';
  }
  return value;
}

export async function getSecrets<T extends Record<string, string>>(
  mapping: T,
  provider: SecretProvider = envProvider
): Promise<Record<keyof T, string>> {
  const entries = await Promise.all(
    Object.entries(mapping).map(async ([key, envName]) => {
      const value = await getSecret(envName, provider);
      return [key, value] as const;
    })
  );

  return Object.fromEntries(entries) as Record<keyof T, string>;
}
