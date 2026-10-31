import {ServerRequestHandler} from '../requestHandler';
import type {
  ServerEngine,
  ServerHandlerDeps,
  ServerLogEntry,
  ServerRequest,
  ServerResponseWriter,
} from '../types';

class Recorder implements ServerResponseWriter {
  jsons: Array<{status: number; body: string}> = [];
  chunks: string[] = [];
  started = false;
  ended = false;
  closed = false;

  json(status: number, body: string) {
    this.jsons.push({status, body});
  }
  sseStart() {
    this.started = true;
  }
  sseChunk(payload: string) {
    this.chunks.push(payload);
  }
  sseEnd() {
    this.ended = true;
  }
  isClosed() {
    return this.closed;
  }

  get body() {
    return JSON.parse(this.jsons[0]?.body ?? '{}');
  }
}

const request = (partial: Partial<ServerRequest>): ServerRequest => ({
  requestId: 'r1',
  method: 'GET',
  path: '/',
  headers: {},
  body: '',
  ...partial,
});

const createDeps = (overrides: Partial<ServerHandlerDeps> = {}) => {
  const logs: ServerLogEntry[] = [];
  const completion = jest.fn();
  const engine: ServerEngine = {
    completion,
    stopCompletion: jest.fn(async () => {}),
  };
  const deps: ServerHandlerDeps = {
    getEngine: jest.fn(async () => engine),
    getModelName: () => 'test-model',
    getSystemPrompt: () => 'You are a test pal.',
    getPalName: () => 'Test Pal',
    getDefaultParams: jest.fn(async () => ({temperature: 0.1, n_predict: 77})),
    getStopWords: jest.fn(() => ['</s>']),
    log: entry => logs.push(entry),
    ...overrides,
  };
  return {deps, logs, completion};
};

const sseEvents = (recorder: Recorder) =>
  recorder.chunks
    .filter(chunk => chunk !== 'data: [DONE]\n\n')
    .map(chunk => JSON.parse(chunk.replace(/^data: /, '').trim()));

describe('ServerRequestHandler routing', () => {
  it('lists the served model', async () => {
    const {deps} = createDeps();
    const recorder = new Recorder();
    await new ServerRequestHandler(deps).handle(
      request({path: '/v1/models'}),
      recorder,
    );

    expect(recorder.jsons[0].status).toBe(200);
    expect(recorder.body.data[0].id).toBe('test-model');
  });

  it('reports the pal in /health', async () => {
    const {deps} = createDeps();
    const recorder = new Recorder();
    await new ServerRequestHandler(deps).handle(
      request({path: '/health'}),
      recorder,
    );

    expect(recorder.body.pal).toBe('Test Pal');
    expect(recorder.body.status).toBe('ok');
  });

  it('answers preflight requests without touching the model', async () => {
    const {deps, completion} = createDeps();
    const recorder = new Recorder();
    await new ServerRequestHandler(deps).handle(
      request({method: 'OPTIONS', path: '/v1/chat/completions'}),
      recorder,
    );

    expect(recorder.jsons[0].status).toBe(204);
    expect(completion).not.toHaveBeenCalled();
  });

  it('returns 404 for unknown paths', async () => {
    const {deps} = createDeps();
    const recorder = new Recorder();
    await new ServerRequestHandler(deps).handle(
      request({path: '/nope'}),
      recorder,
    );

    expect(recorder.jsons[0].status).toBe(404);
  });
});

describe('chat completions', () => {
  it('returns a non-streaming completion and logs request/response', async () => {
    const {deps, logs, completion} = createDeps();
    completion.mockResolvedValue({
      text: 'Hello',
      content: 'Hello',
      tokens_evaluated: 3,
      tokens_predicted: 2,
    });
    const recorder = new Recorder();

    await new ServerRequestHandler(deps).handle(
      request({
        method: 'POST',
        path: '/v1/chat/completions',
        body: JSON.stringify({
          messages: [{role: 'user', content: 'hi'}],
          max_tokens: 32,
          temperature: 0.9,
        }),
      }),
      recorder,
    );

    expect(recorder.jsons[0].status).toBe(200);
    expect(recorder.body.choices[0].message.content).toBe('Hello');
    expect(recorder.body.usage.total_tokens).toBe(5);
    expect(completion).toHaveBeenCalledWith(
      expect.objectContaining({
        n_predict: 32,
        temperature: 0.9,
        stop: ['</s>'],
      }),
    );
    expect(logs.map(entry => entry.kind)).toEqual(['request', 'response']);
    expect(logs[1].completionTokens).toBe(2);
  });

  it('keeps the request body and the response preview in the log', async () => {
    const {deps, logs, completion} = createDeps();
    completion.mockResolvedValue({text: 'Hello', content: 'Hello'});
    const recorder = new Recorder();

    await new ServerRequestHandler(deps).handle(
      request({
        method: 'POST',
        path: '/v1/chat/completions',
        body: JSON.stringify({
          messages: [{role: 'user', content: 'hi'}],
          max_tokens: 64,
        }),
      }),
      recorder,
    );

    expect(logs[0].detail).toContain('"max_tokens": 64');
    expect(logs[0].messages).toBe(1);
    expect(logs[1].messages).toBeUndefined();
    expect(logs[1].detail).toContain('Hello');
    expect(logs[1].detail).toContain('stop');
  });

  it('streams cumulative content as deltas', async () => {
    const {deps, completion} = createDeps();
    completion.mockImplementation(async (_params, onToken) => {
      onToken?.({token: 'Hel', content: 'Hel'});
      onToken?.({token: 'lo', content: 'Hello'});
      return {
        text: 'Hello',
        content: 'Hello',
        tokens_evaluated: 1,
        tokens_predicted: 2,
      };
    });
    const recorder = new Recorder();

    await new ServerRequestHandler(deps).handle(
      request({
        method: 'POST',
        path: '/v1/chat/completions',
        body: JSON.stringify({
          stream: true,
          messages: [{role: 'user', content: 'hi'}],
        }),
      }),
      recorder,
    );

    expect(recorder.started).toBe(true);
    expect(recorder.ended).toBe(true);
    expect(recorder.chunks[recorder.chunks.length - 1]).toBe(
      'data: [DONE]\n\n',
    );

    const events = sseEvents(recorder);
    const content = events
      .map(event => event.choices?.[0]?.delta?.content ?? '')
      .join('');
    expect(content).toBe('Hello');
    expect(events[events.length - 1].choices[0].finish_reason).toBe('stop');
  });

  it('merges the pal system prompt ahead of the client one', async () => {
    const {deps, completion} = createDeps();
    completion.mockResolvedValue({text: '', content: ''});
    const recorder = new Recorder();

    await new ServerRequestHandler(deps).handle(
      request({
        method: 'POST',
        path: '/v1/chat/completions',
        body: JSON.stringify({
          messages: [
            {role: 'system', content: 'client rule'},
            {role: 'user', content: 'hi'},
          ],
        }),
      }),
      recorder,
    );

    const params = completion.mock.calls[0][0];
    expect(params.messages[0]).toEqual({
      role: 'system',
      content: 'You are a test pal.\n\nclient rule',
    });
    expect(params.messages).toHaveLength(2);
  });

  it('lets the request override pal defaults', async () => {
    const {deps, completion} = createDeps();
    completion.mockResolvedValue({text: '', content: ''});
    const recorder = new Recorder();

    await new ServerRequestHandler(deps).handle(
      request({
        method: 'POST',
        path: '/v1/chat/completions',
        body: JSON.stringify({
          messages: [{role: 'user', content: 'hi'}],
          temperature: 0.8,
        }),
      }),
      recorder,
    );

    const params = completion.mock.calls[0][0];
    expect(params.temperature).toBe(0.8);
    expect(params.n_predict).toBe(77);
  });

  it('rejects an empty message list with 400 and an error log', async () => {
    const {deps, logs} = createDeps();
    const recorder = new Recorder();

    await new ServerRequestHandler(deps).handle(
      request({
        method: 'POST',
        path: '/v1/chat/completions',
        body: JSON.stringify({messages: []}),
      }),
      recorder,
    );

    expect(recorder.jsons[0].status).toBe(400);
    expect(recorder.body.error.type).toBe('invalid_request_error');
    expect(logs.some(entry => entry.kind === 'error')).toBe(true);
  });

  it('reports a mid-stream failure as an SSE error', async () => {
    const {deps, completion} = createDeps();
    completion.mockRejectedValue(new Error('boom'));
    const recorder = new Recorder();

    await new ServerRequestHandler(deps).handle(
      request({
        method: 'POST',
        path: '/v1/chat/completions',
        body: JSON.stringify({
          stream: true,
          messages: [{role: 'user', content: 'hi'}],
        }),
      }),
      recorder,
    );

    expect(recorder.started).toBe(true);
    expect(recorder.ended).toBe(true);
    const events = sseEvents(recorder);
    expect(events[events.length - 1].error.message).toBe('boom');
    expect(recorder.chunks[recorder.chunks.length - 1]).toBe(
      'data: [DONE]\n\n',
    );
  });
});

describe('legacy completions', () => {
  it('answers a prompt completion', async () => {
    const {deps, completion} = createDeps();
    completion.mockResolvedValue({text: 'world', content: 'world'});
    const recorder = new Recorder();

    await new ServerRequestHandler(deps).handle(
      request({
        method: 'POST',
        path: '/v1/completions',
        body: JSON.stringify({prompt: 'hello'}),
      }),
      recorder,
    );

    expect(recorder.body.object).toBe('text_completion');
    expect(recorder.body.choices[0].text).toBe('world');
    expect(completion.mock.calls[0][0]).toEqual(
      expect.objectContaining({prompt: 'hello', stop: ['</s>']}),
    );
  });

  it('requires a prompt', async () => {
    const {deps} = createDeps();
    const recorder = new Recorder();

    await new ServerRequestHandler(deps).handle(
      request({
        method: 'POST',
        path: '/v1/completions',
        body: JSON.stringify({prompt: ''}),
      }),
      recorder,
    );

    expect(recorder.jsons[0].status).toBe(400);
  });
});
