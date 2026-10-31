import {
  BadRequestError,
  SSE_DONE,
  buildChatCompletionChunk,
  buildChatCompletionResponse,
  buildCompletionResponse,
  buildErrorResponse,
  buildModelsResponse,
  finishReasonFromResult,
  normaliseStop,
  parseChatCompletionRequest,
  parseCompletionRequest,
  sseEvent,
  usageFromResult,
} from '../openaiApi';

describe('parseChatCompletionRequest', () => {
  it('reads messages and sampler fields', () => {
    const request = parseChatCompletionRequest(
      JSON.stringify({
        model: 'qwen',
        messages: [
          {role: 'system', content: 'be brief'},
          {role: 'user', content: 'hi'},
        ],
        temperature: 0.7,
        top_p: 0.9,
        max_tokens: 64,
        stop: ['</s>'],
        stream: true,
      }),
    );

    expect(request.model).toBe('qwen');
    expect(request.messages).toHaveLength(2);
    expect(request.temperature).toBe(0.7);
    expect(request.top_p).toBe(0.9);
    expect(request.max_tokens).toBe(64);
    expect(request.stop).toEqual(['</s>']);
    expect(request.stream).toBe(true);
  });

  it('prefers max_tokens and falls back to max_completion_tokens', () => {
    const request = parseChatCompletionRequest(
      JSON.stringify({
        messages: [{role: 'user', content: 'hi'}],
        max_completion_tokens: 12,
      }),
    );
    expect(request.max_tokens).toBe(12);
  });

  it('clamps samplers instead of rejecting them', () => {
    const request = parseChatCompletionRequest(
      JSON.stringify({
        messages: [{role: 'user', content: 'hi'}],
        temperature: 9,
        top_p: -1,
      }),
    );
    expect(request.temperature).toBe(2);
    expect(request.top_p).toBe(0);
  });

  it('rejects invalid JSON', () => {
    expect(() => parseChatCompletionRequest('{')).toThrow(BadRequestError);
  });

  it('rejects an empty message array', () => {
    expect(() =>
      parseChatCompletionRequest(JSON.stringify({messages: []})),
    ).toThrow(BadRequestError);
  });

  it('rejects a message without a role', () => {
    expect(() =>
      parseChatCompletionRequest(JSON.stringify({messages: [{content: 'hi'}]})),
    ).toThrow(BadRequestError);
  });
});

describe('parseCompletionRequest', () => {
  it('requires a prompt', () => {
    expect(() => parseCompletionRequest(JSON.stringify({prompt: ''}))).toThrow(
      BadRequestError,
    );
    expect(() => parseCompletionRequest(JSON.stringify({}))).toThrow(
      BadRequestError,
    );
  });

  it('reads a valid prompt', () => {
    const request = parseCompletionRequest(
      JSON.stringify({prompt: 'hello', max_tokens: 8, stop: 'x'}),
    );
    expect(request.prompt).toBe('hello');
    expect(request.max_tokens).toBe(8);
    expect(request.stop).toEqual(['x']);
  });
});

describe('normaliseStop', () => {
  it('drops empty values and keeps strings', () => {
    expect(normaliseStop('')).toBeUndefined();
    expect(normaliseStop([])).toBeUndefined();
    expect(normaliseStop(['a', '', 1, 'b'])).toEqual(['a', 'b']);
  });
});

describe('response builders', () => {
  it('builds a model list', () => {
    expect(JSON.parse(buildModelsResponse(['m1'], 10))).toEqual({
      object: 'list',
      data: [{id: 'm1', object: 'model', created: 10, owned_by: 'pocketpal'}],
    });
  });

  it('builds a chat completion with usage', () => {
    const payload = JSON.parse(
      buildChatCompletionResponse({
        id: 'chatcmpl-1',
        created: 10,
        model: 'm1',
        content: 'hello',
        usage: {prompt_tokens: 2, completion_tokens: 1, total_tokens: 3},
      }),
    );
    expect(payload.object).toBe('chat.completion');
    expect(payload.choices[0].message).toEqual({
      role: 'assistant',
      content: 'hello',
    });
    expect(payload.choices[0].finish_reason).toBe('stop');
    expect(payload.usage.total_tokens).toBe(3);
  });

  it('builds a streaming chat chunk', () => {
    const payload = JSON.parse(
      buildChatCompletionChunk({
        id: 'chatcmpl-1',
        created: 10,
        model: 'm1',
        delta: {content: 'he'},
      }),
    );
    expect(payload.object).toBe('chat.completion.chunk');
    expect(payload.choices[0].delta).toEqual({content: 'he'});
    expect(payload.choices[0].finish_reason).toBeNull();
  });

  it('builds a legacy completion', () => {
    const payload = JSON.parse(
      buildCompletionResponse({
        id: 'cmpl-1',
        created: 10,
        model: 'm1',
        text: 'hello',
      }),
    );
    expect(payload.object).toBe('text_completion');
    expect(payload.choices[0].text).toBe('hello');
  });

  it('wraps SSE payloads and errors', () => {
    expect(sseEvent('{"a":1}')).toBe('data: {"a":1}\n\n');
    expect(SSE_DONE).toBe('data: [DONE]\n\n');
    expect(JSON.parse(buildErrorResponse('bad')).error.message).toBe('bad');
  });
});

describe('result helpers', () => {
  it('maps stopped_limit to length', () => {
    expect(finishReasonFromResult({})).toBe('stop');
    expect(finishReasonFromResult({stopped_limit: 1})).toBe('length');
  });

  it('derives usage', () => {
    expect(usageFromResult({tokens_evaluated: 4, tokens_predicted: 6})).toEqual(
      {prompt_tokens: 4, completion_tokens: 6, total_tokens: 10},
    );
    expect(usageFromResult({})).toEqual({
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    });
  });
});
