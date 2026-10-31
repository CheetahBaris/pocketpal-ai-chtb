/**
 * Pure request/response helpers for the built-in OpenAI-compatible server.
 *
 * Nothing here touches the model or the network: the store owns those, this
 * module only turns HTTP bodies into validated values and values back into the
 * JSON/SSE shapes OpenAI clients expect. Keeping it pure is what the tests
 * exercise.
 */

export type OpenAIChatRole = 'system' | 'user' | 'assistant' | 'tool' | string;

export interface OpenAIChatContentPart {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface OpenAIChatMessage {
  role: OpenAIChatRole;
  content?: string | OpenAIChatContentPart[] | null;
  name?: string;
  tool_calls?: unknown;
  tool_call_id?: string;
}

export interface ChatCompletionRequest {
  model?: string;
  messages: OpenAIChatMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  stop?: string[];
  stream: boolean;
  tools?: unknown;
  tool_choice?: unknown;
  reasoning_effort?: string;
}

export interface CompletionRequest {
  model?: string;
  prompt: string;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string[];
  stream: boolean;
}

export class BadRequestError extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseBody = (body: string): Record<string, unknown> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new BadRequestError('Request body is not valid JSON');
  }
  if (!isRecord(parsed)) {
    throw new BadRequestError('Request body must be a JSON object');
  }
  return parsed;
};

const finiteInRange = (
  value: unknown,
  min: number,
  max: number,
): number | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.min(max, Math.max(min, value));
};

const positiveInt = (value: unknown): number | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  const rounded = Math.floor(value);
  return rounded > 0 ? rounded : undefined;
};

export const normaliseStop = (value: unknown): string[] | undefined => {
  if (typeof value === 'string') {
    return value.length > 0 ? [value] : undefined;
  }
  if (Array.isArray(value)) {
    const stop = value.filter(
      (item): item is string => typeof item === 'string' && item.length > 0,
    );
    return stop.length > 0 ? stop : undefined;
  }
  return undefined;
};

const readMessages = (value: unknown): OpenAIChatMessage[] => {
  if (!Array.isArray(value) || value.length === 0) {
    throw new BadRequestError('`messages` must be a non-empty array');
  }
  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new BadRequestError(`\`messages[${index}]\` must be an object`);
    }
    if (typeof entry.role !== 'string' || entry.role.length === 0) {
      throw new BadRequestError(`\`messages[${index}].role\` is required`);
    }
    const content = entry.content;
    if (
      content !== undefined &&
      content !== null &&
      typeof content !== 'string' &&
      !Array.isArray(content)
    ) {
      throw new BadRequestError(
        `\`messages[${index}].content\` must be a string or an array`,
      );
    }
    return entry as unknown as OpenAIChatMessage;
  });
};

export function parseChatCompletionRequest(
  body: string,
): ChatCompletionRequest {
  const raw = parseBody(body);
  return {
    model: typeof raw.model === 'string' ? raw.model : undefined,
    messages: readMessages(raw.messages),
    temperature: finiteInRange(raw.temperature, 0, 2),
    top_p: finiteInRange(raw.top_p, 0, 1),
    max_tokens: positiveInt(raw.max_tokens ?? raw.max_completion_tokens),
    max_completion_tokens: positiveInt(raw.max_completion_tokens),
    stop: normaliseStop(raw.stop),
    stream: raw.stream === true,
    tools: raw.tools,
    tool_choice: raw.tool_choice,
    reasoning_effort:
      typeof raw.reasoning_effort === 'string'
        ? raw.reasoning_effort
        : undefined,
  };
}

export function parseCompletionRequest(body: string): CompletionRequest {
  const raw = parseBody(body);
  if (typeof raw.prompt !== 'string' || raw.prompt.length === 0) {
    throw new BadRequestError('`prompt` must be a non-empty string');
  }
  return {
    model: typeof raw.model === 'string' ? raw.model : undefined,
    prompt: raw.prompt,
    temperature: finiteInRange(raw.temperature, 0, 2),
    top_p: finiteInRange(raw.top_p, 0, 1),
    max_tokens: positiveInt(raw.max_tokens),
    stop: normaliseStop(raw.stop),
    stream: raw.stream === true,
  };
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatCompletionPayload {
  id: string;
  created: number;
  model: string;
  content: string;
  reasoningContent?: string;
  toolCalls?: unknown;
  usage?: Usage;
  finishReason?: string;
}

export interface CompletionPayload {
  id: string;
  created: number;
  model: string;
  text: string;
  usage?: Usage;
  finishReason?: string;
}

/** `stopped_limit` and `context_full` both mean generation hit a ceiling. */
export const finishReasonFromResult = (result: {
  stopped_limit?: number;
  context_full?: boolean;
}): string => (result.stopped_limit || result.context_full ? 'length' : 'stop');

export const buildModelsResponse = (
  modelIds: string[],
  created: number,
): string =>
  JSON.stringify({
    object: 'list',
    data: modelIds.map(id => ({
      id,
      object: 'model',
      created,
      owned_by: 'pocketpal',
    })),
  });

export const buildChatCompletionResponse = (
  payload: ChatCompletionPayload,
): string => {
  const message: Record<string, unknown> = {
    role: 'assistant',
    content: payload.content,
  };
  if (payload.reasoningContent) {
    message.reasoning_content = payload.reasoningContent;
  }
  if (payload.toolCalls) {
    message.tool_calls = payload.toolCalls;
  }
  return JSON.stringify({
    id: payload.id,
    object: 'chat.completion',
    created: payload.created,
    model: payload.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: payload.finishReason ?? 'stop',
      },
    ],
    ...(payload.usage ? {usage: payload.usage} : {}),
  });
};

export const buildChatCompletionChunk = (payload: {
  id: string;
  created: number;
  model: string;
  delta: Record<string, unknown>;
  finishReason?: string | null;
}): string =>
  JSON.stringify({
    id: payload.id,
    object: 'chat.completion.chunk',
    created: payload.created,
    model: payload.model,
    choices: [
      {
        index: 0,
        delta: payload.delta,
        finish_reason: payload.finishReason ?? null,
      },
    ],
  });

export const buildCompletionResponse = (payload: CompletionPayload): string =>
  JSON.stringify({
    id: payload.id,
    object: 'text_completion',
    created: payload.created,
    model: payload.model,
    choices: [
      {
        index: 0,
        text: payload.text,
        finish_reason: payload.finishReason ?? 'stop',
      },
    ],
    ...(payload.usage ? {usage: payload.usage} : {}),
  });

export const buildCompletionChunk = (payload: {
  id: string;
  created: number;
  model: string;
  text: string;
  finishReason?: string | null;
}): string =>
  JSON.stringify({
    id: payload.id,
    object: 'text_completion',
    created: payload.created,
    model: payload.model,
    choices: [
      {
        index: 0,
        text: payload.text,
        finish_reason: payload.finishReason ?? null,
      },
    ],
  });

export const sseEvent = (payload: string): string => `data: ${payload}\n\n`;

export const SSE_DONE = 'data: [DONE]\n\n';

export const buildErrorResponse = (
  message: string,
  type = 'invalid_request_error',
): string =>
  JSON.stringify({
    error: {
      message,
      type,
      param: null,
      code: null,
    },
  });

export const usageFromResult = (result: {
  tokens_evaluated?: number;
  tokens_predicted?: number;
}): Usage => {
  const prompt = result.tokens_evaluated ?? 0;
  const completion = result.tokens_predicted ?? 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
  };
};
