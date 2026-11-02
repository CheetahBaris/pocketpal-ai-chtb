import type {ServerLogEntry} from './types';

/** The Server screen keeps a short, in-memory history; it is never persisted. */
export const SERVER_LOG_LIMIT = 200;

/**
 * Safety ceiling for one log detail. Effectively no truncation for a normal
 * request or answer; it only keeps a pathological body from exhausting memory.
 */
export const LOG_DETAIL_LIMIT = 1_000_000;

export function appendServerLog(
  logs: ServerLogEntry[],
  entry: ServerLogEntry,
): ServerLogEntry[] {
  return [entry, ...logs].slice(0, SERVER_LOG_LIMIT);
}

export function truncate(value: string, max = LOG_DETAIL_LIMIT): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

export function prettyJson(value: unknown): string | undefined {
  try {
    return truncate(JSON.stringify(value, null, 2));
  } catch {
    return undefined;
  }
}
