import {v4 as uuidv4} from 'uuid';

import type {
  CompletionResult,
  CompletionStreamData,
} from '../../utils/completionTypes';
import {stopQuietly} from '../../utils/stopQuietly';
import {prettyJson, truncate} from './log';
import {
  BadRequestError,
  SSE_DONE,
  buildChatCompletionChunk,
  buildChatCompletionResponse,
  buildCompletionChunk,
  buildCompletionResponse,
  buildErrorResponse,
  buildModelsResponse,
  finishReasonFromResult,
  parseChatCompletionRequest,
  parseCompletionRequest,
  sseEvent,
  usageFromResult,
} from './openaiApi';
import {mergeSystemPrompt} from './prompt';
import type {
  ServerEngine,
  ServerHandlerDeps,
  ServerRequest,
  ServerResponseWriter,
} from './types';

export const DEFAULT_MAX_TOKENS = 512;

/**
 * llama.rn throws this before any token when the prompt itself does not fit
 * the loaded context (ctx_shift is off). String-coupled to the native throw in
 * RNLlamaJSI.cpp; re-check on llama.rn upgrades.
 */
const CONTEXT_FULL_ERROR = /context is full/i;

export const normalisePath = (path: string): string => {
  const withoutQuery = path.split('?')[0];
  const trimmed = withoutQuery.replace(/\/+$/, '');
  return trimmed.length === 0 ? '/' : trimmed;
};

const isChatPath = (path: string) =>
  path === '/v1/chat/completions' || path === '/chat/completions';

const isCompletionPath = (path: string) =>
  path === '/v1/completions' || path === '/completions';

interface StreamState {
  started: boolean;
  bytes: number;
}

/**
 * Summarises an incoming body for the log: parameters, message count, stream
 * flag and the pretty-printed body. The detail keeps the full text so a long
 * prompt can be inspected on the Server screen.
 */
function describeBody(body: string): {
  detail?: string;
  stream?: boolean;
  messages?: number;
} {
  if (!body) {
    return {};
  }
  try {
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object') {
      return {detail: truncate(body)};
    }
    const record = parsed as Record<string, unknown>;
    return {
      detail: prettyJson(parsed),
      stream: record.stream === true,
      messages: Array.isArray(record.messages)
        ? record.messages.length
        : undefined,
    };
  } catch {
    return {detail: truncate(body)};
  }
}

/**
 * Routes one parsed HTTP request to a completion and writes the OpenAI-shaped
 * response. Pure: sockets and MobX live in the store, inference behind deps.
 */
export class ServerRequestHandler {
  constructor(
    private deps: ServerHandlerDeps,
    private now: () => number = Date.now,
  ) {}

  async handle(req: ServerRequest, res: ServerResponseWriter): Promise<void> {
    const started = this.now();
    const method = req.method.toUpperCase();
    const path = normalisePath(req.path);
    const state: StreamState = {started: false, bytes: 0};
    const bodyInfo = describeBody(req.body);

    this.deps.log({
      id: logId(),
      at: started,
      kind: 'request',
      requestId: req.requestId,
      method,
      path,
      stream: bodyInfo.stream,
      remoteAddress: req.remoteAddress,
      model: this.deps.getModelName(),
      pal: this.deps.getPalName(),
      messages: bodyInfo.messages,
      detail: bodyInfo.detail,
      summary: `${method} ${path}${bodyInfo.stream ? ' · stream' : ''}`,
    });

    try {
      if (method === 'OPTIONS') {
        res.json(204, '');
        this.logResponse(req, started, 204, 0);
        return;
      }

      if (method === 'GET' && (path === '/v1/models' || path === '/models')) {
        const body = buildModelsResponse(
          [this.deps.getModelName()],
          Math.floor(this.now() / 1000),
        );
        res.json(200, body);
        this.logResponse(req, started, 200, body.length);
        return;
      }

      if (method === 'GET' && (path === '/' || path === '/health')) {
        const body = JSON.stringify({
          status: 'ok',
          model: this.deps.getModelName(),
          pal: this.deps.getPalName(),
          context: this.deps.getContextSize(),
          endpoints: [
            'GET /v1/models',
            'POST /v1/chat/completions',
            'POST /v1/completions',
          ],
        });
        res.json(200, body);
        this.logResponse(req, started, 200, body.length);
        return;
      }

      if (method === 'POST' && isChatPath(path)) {
        await this.handleChat(req, res, started, state);
        return;
      }

      if (method === 'POST' && isCompletionPath(path)) {
        await this.handleCompletion(req, res, started, state);
        return;
      }

      const body = buildErrorResponse(
        `Unknown endpoint: ${method} ${path}`,
        'invalid_request_error',
      );
      res.json(404, body);
      this.logResponse(req, started, 404, body.length, {
        summary: 'Unknown endpoint',
      });
    } catch (error: any) {
      const message = error?.message ?? 'Internal server error';
      // A prompt that does not fit is the caller's problem to fix (shorter
      // messages or a bigger context), not an internal failure. Answer 400 so
      // OpenAI clients surface the message instead of a generic 5xx.
      // LLAMARN-DEP: string-coupled to the throw in RNLlamaJSI.cpp.
      const contextOverflow = CONTEXT_FULL_ERROR.test(message);
      const status =
        error instanceof BadRequestError || contextOverflow ? 400 : 500;
      const type =
        error instanceof BadRequestError || contextOverflow
          ? 'invalid_request_error'
          : 'server_error';
      const friendly = contextOverflow
        ? `Request exceeds the loaded context size (${this.deps.getContextSize()} tokens). ` +
          'Increase the context size in Settings and reload the model, or send a shorter conversation.'
        : message;

      if (state.started) {
        // Headers are already on the wire; SSE is the only error channel left.
        const payload = sseEvent(buildErrorResponse(friendly, type));
        res.sseChunk(payload);
        res.sseChunk(SSE_DONE);
        res.sseEnd();
        state.bytes += payload.length + SSE_DONE.length;
      } else {
        const body = buildErrorResponse(friendly, type);
        res.json(status, body);
        state.bytes += body.length;
      }

      this.deps.log({
        id: logId(),
        at: this.now(),
        kind: 'error',
        requestId: req.requestId,
        method: req.method.toUpperCase(),
        path: normalisePath(req.path),
        status,
        durationMs: this.now() - started,
        detail: friendly,
        model: this.deps.getModelName(),
        summary: friendly,
      });
    }
  }

  private async handleChat(
    req: ServerRequest,
    res: ServerResponseWriter,
    started: number,
    state: StreamState,
  ): Promise<void> {
    const request = parseChatCompletionRequest(req.body);
    const engine = await this.deps.getEngine();
    if (!res.isClosed()) {
      const defaults = await this.deps.getDefaultParams();
      const model = this.deps.getModelName();
      const id = `chatcmpl-${uuidv4().replace(/-/g, '')}`;
      const created = Math.floor(this.now() / 1000);
      const messages = mergeSystemPrompt(
        request.messages,
        this.deps.getSystemPrompt(),
      );

      const params: Record<string, unknown> = {
        ...defaults,
        messages,
        n_predict:
          request.max_tokens ??
          (defaults.n_predict as number | undefined) ??
          DEFAULT_MAX_TOKENS,
        stop: this.deps.getStopWords(request.stop),
        reasoning_format: 'auto',
      };
      if (request.temperature !== undefined) {
        params.temperature = request.temperature;
      }
      if (request.top_p !== undefined) {
        params.top_p = request.top_p;
      }
      if (request.tools !== undefined) {
        params.tools = request.tools;
      }
      if (request.tool_choice !== undefined) {
        params.tool_choice = request.tool_choice;
      }
      if (request.reasoning_effort) {
        params.chat_template_kwargs = {
          reasoning_effort: request.reasoning_effort,
        };
      }

      if (request.stream) {
        state.started = true;
        res.sseStart();
        this.streamChunk(
          res,
          state,
          buildChatCompletionChunk({
            id,
            created,
            model,
            delta: {role: 'assistant', content: ''},
          }),
        );

        let previousContent = '';
        let previousReasoning = '';
        let stopRequested = false;
        const flush = (content: string, reasoning: string) => {
          if (reasoning.length > previousReasoning.length) {
            const delta = reasoning.slice(previousReasoning.length);
            previousReasoning = reasoning;
            this.streamChunk(
              res,
              state,
              buildChatCompletionChunk({
                id,
                created,
                model,
                delta: {reasoning_content: delta},
              }),
            );
          }
          if (content.length > previousContent.length) {
            const delta = content.slice(previousContent.length);
            previousContent = content;
            this.streamChunk(
              res,
              state,
              buildChatCompletionChunk({
                id,
                created,
                model,
                delta: {content: delta},
              }),
            );
          }
          if (!stopRequested && res.isClosed()) {
            stopRequested = true;
            stopQuietly(() => engine.stopCompletion());
          }
        };

        const result = await this.complete(engine, params, data => {
          flush(data.content ?? '', data.reasoning_content ?? '');
        });

        // A parser that never reported content still owes the final text.
        const finalContent = result.content ?? result.text ?? '';
        if (finalContent.length > previousContent.length) {
          flush(finalContent, result.reasoning_content ?? '');
        }
        if (result.tool_calls && result.tool_calls.length > 0) {
          this.streamChunk(
            res,
            state,
            buildChatCompletionChunk({
              id,
              created,
              model,
              delta: {tool_calls: result.tool_calls},
            }),
          );
        }

        this.streamChunk(
          res,
          state,
          buildChatCompletionChunk({
            id,
            created,
            model,
            delta: {},
            finishReason: finishReasonFromResult(result),
          }),
        );
        this.streamChunk(res, state, SSE_DONE, false);
        res.sseEnd();

        this.logResponse(req, started, 200, state.bytes, {
          stream: true,
          result,
          detail: prettyJson({
            finish_reason: finishReasonFromResult(result),
            content: truncate(finalContent),
          }),
        });
        return;
      }

      const result = await this.complete(engine, params);
      const content = result.content ?? result.text ?? '';
      const body = buildChatCompletionResponse({
        id,
        created,
        model,
        content,
        reasoningContent: result.reasoning_content,
        toolCalls: result.tool_calls,
        usage: usageFromResult(result),
        finishReason: finishReasonFromResult(result),
      });
      res.json(200, body);
      this.logResponse(req, started, 200, body.length, {
        result,
        detail: prettyJson({
          finish_reason: finishReasonFromResult(result),
          content: truncate(content),
        }),
      });
    }
  }

  private async handleCompletion(
    req: ServerRequest,
    res: ServerResponseWriter,
    started: number,
    state: StreamState,
  ): Promise<void> {
    const request = parseCompletionRequest(req.body);
    const engine = await this.deps.getEngine();
    if (res.isClosed()) {
      return;
    }

    const defaults = await this.deps.getDefaultParams();
    const model = this.deps.getModelName();
    const id = `cmpl-${uuidv4().replace(/-/g, '')}`;
    const created = Math.floor(this.now() / 1000);

    const params: Record<string, unknown> = {
      ...defaults,
      prompt: request.prompt,
      n_predict:
        request.max_tokens ??
        (defaults.n_predict as number | undefined) ??
        DEFAULT_MAX_TOKENS,
      stop: this.deps.getStopWords(request.stop),
    };
    if (request.temperature !== undefined) {
      params.temperature = request.temperature;
    }
    if (request.top_p !== undefined) {
      params.top_p = request.top_p;
    }

    if (request.stream) {
      state.started = true;
      res.sseStart();
      let streamed = '';
      const result = await this.complete(engine, params, data => {
        if (data.token) {
          streamed += data.token;
          this.streamChunk(
            res,
            state,
            buildCompletionChunk({
              id,
              created,
              model,
              text: data.token,
            }),
          );
        }
        if (res.isClosed()) {
          stopQuietly(() => engine.stopCompletion());
        }
      });
      this.streamChunk(
        res,
        state,
        buildCompletionChunk({
          id,
          created,
          model,
          text: '',
          finishReason: finishReasonFromResult(result),
        }),
      );
      this.streamChunk(res, state, SSE_DONE, false);
      res.sseEnd();
      this.logResponse(req, started, 200, state.bytes, {
        stream: true,
        result,
        detail: prettyJson({
          finish_reason: finishReasonFromResult(result),
          content: truncate(streamed || result.text || ''),
        }),
      });
      return;
    }

    const result = await this.complete(engine, params);
    const text = result.text ?? '';
    const body = buildCompletionResponse({
      id,
      created,
      model,
      text,
      usage: usageFromResult(result),
      finishReason: finishReasonFromResult(result),
    });
    res.json(200, body);
    this.logResponse(req, started, 200, body.length, {
      result,
      detail: prettyJson({
        finish_reason: finishReasonFromResult(result),
        content: truncate(text),
      }),
    });
  }

  /**
   * Runs one completion and reports generation state to the store. The token
   * callback is always attached so the store can count tokens even when the
   * response itself is not streamed.
   */
  private async complete(
    engine: ServerEngine,
    params: Record<string, unknown>,
    onToken?: (data: CompletionStreamData) => void,
  ): Promise<CompletionResult> {
    this.deps.onGenerationStart();
    try {
      return await engine.completion(params, data => {
        this.deps.onGenerationToken();
        onToken?.(data);
      });
    } finally {
      this.deps.onGenerationEnd();
    }
  }

  private streamChunk(
    res: ServerResponseWriter,
    state: StreamState,
    payload: string,
    wrap = true,
  ): void {
    const text = wrap ? sseEvent(payload) : payload;
    if (res.isClosed()) {
      return;
    }
    res.sseChunk(text);
    state.bytes += text.length;
  }

  private logResponse(
    req: ServerRequest,
    started: number,
    status: number,
    bytes: number,
    extra: {
      stream?: boolean;
      result?: CompletionResult;
      detail?: string;
      summary?: string;
    } = {},
  ): void {
    const usage = extra.result ? usageFromResult(extra.result) : undefined;
    this.deps.log({
      id: logId(),
      at: this.now(),
      kind: 'response',
      requestId: req.requestId,
      method: req.method.toUpperCase(),
      path: normalisePath(req.path),
      status,
      stream: extra.stream,
      remoteAddress: req.remoteAddress,
      durationMs: this.now() - started,
      bytes,
      promptTokens: usage?.prompt_tokens,
      completionTokens: usage?.completion_tokens,
      model: this.deps.getModelName(),
      pal: this.deps.getPalName(),
      summary:
        extra.summary ??
        `${status} · ${(this.now() - started) / 1000}s${
          usage
            ? ` · ${usage.prompt_tokens}→${usage.completion_tokens} tok`
            : ''
        }`,
      detail: extra.detail,
    });
  }
}

let logCounter = 0;

function logId(): string {
  logCounter += 1;
  return `${Date.now().toString(36)}-${logCounter.toString(36)}`;
}
