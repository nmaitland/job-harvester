/**
 * Simple logger utility for job-harvester
 */

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

let currentLogLevel = LogLevel.INFO;

export function setLogLevel(level: LogLevel): void {
  currentLogLevel = level;
}

function formatMessage(level: string, message: string): string {
  const timestamp = new Date().toISOString();
  return `[${timestamp}] [${level}] ${message}`;
}

export function debug(message: string): void {
  if (currentLogLevel <= LogLevel.DEBUG) {
    console.log(formatMessage('DEBUG', message));
  }
}

export function info(message: string): void {
  if (currentLogLevel <= LogLevel.INFO) {
    console.log(formatMessage('INFO', message));
  }
}

export function warn(message: string): void {
  if (currentLogLevel <= LogLevel.WARN) {
    console.warn(formatMessage('WARN', message));
  }
}

export function error(message: string): void {
  if (currentLogLevel <= LogLevel.ERROR) {
    console.error(formatMessage('ERROR', message));
  }
}

export function success(message: string): void {
  console.log(formatMessage('SUCCESS', message));
}
