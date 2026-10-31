import {appendServerLog, prettyJson, SERVER_LOG_LIMIT, truncate} from '../log';
import type {ServerLogEntry} from '../types';

const entry = (id: string): ServerLogEntry => ({
  id,
  at: 1,
  kind: 'request',
});

describe('appendServerLog', () => {
  it('puts the newest entry first', () => {
    const logs = appendServerLog([entry('a')], entry('b'));
    expect(logs.map(item => item.id)).toEqual(['b', 'a']);
  });

  it('caps the buffer', () => {
    let logs: ServerLogEntry[] = [];
    for (let index = 0; index < SERVER_LOG_LIMIT + 5; index += 1) {
      logs = appendServerLog(logs, entry(String(index)));
    }
    expect(logs).toHaveLength(SERVER_LOG_LIMIT);
    expect(logs[0].id).toBe(String(SERVER_LOG_LIMIT + 4));
  });
});

describe('truncate', () => {
  it('keeps short strings untouched', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('marks a cut string', () => {
    expect(truncate('abcdef', 3)).toBe('abc…');
  });
});

describe('prettyJson', () => {
  it('formats values', () => {
    expect(prettyJson({a: 1})).toContain('"a": 1');
  });

  it('swallows circular values', () => {
    const value: Record<string, unknown> = {};
    value.self = value;
    expect(prettyJson(value)).toBeUndefined();
  });
});
