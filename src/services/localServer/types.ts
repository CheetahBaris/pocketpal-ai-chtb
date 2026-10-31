import type {
  CompletionResult,
  CompletionStreamData,
} from '../../utils/completionTypes';

export type ServerLogKind = 'request' | 'response' | 'error' | 'lifecycle';

/** One line in the in-memory request log shown on the Server screen. */
export interface ServerLogEntry {
  id: string;
  at: number;
  kind: ServerLogKind;
  requestId?: string;
  method?: string;
  path?: string;
  status?: number;
  stream?: boolean;
  remoteAddress?: string;
  model?: string;
  pal?: string;
  messages?: number;
  promptTokens?: number;
  completionTokens?: number;
  durationMs?: number;
  bytes?: number;
  summary?: string;
  detail?: string;
}

/** The subset of LlamaContext the request handler needs. */
export interface ServerEngine {
  completion(
    params: Record<string, unknown>,
    onToken?: (data: CompletionStreamData) => void,
  ): Promise<CompletionResult>;
  stopCompletion(): Promise<void>;
}

export interface ServerRequest {
  requestId: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
  remoteAddress?: string;
}

export interface ServerResponseWriter {
  json(status: number, body: string): void;
  sseStart(): void;
  sseChunk(payload: string): void;
  sseEnd(): void;
  isClosed(): boolean;
}

export interface ServerHandlerDeps {
  /** Makes sure the selected model is loaded and returns its engine. */
  getEngine(): Promise<ServerEngine>;
  getModelName(): string;
  /** Pal system prompt for this request, or '' when no Pal is selected. */
  getSystemPrompt(): string;
  getPalName(): string | undefined;
  /** Global + Pal generation defaults (messages/tools excluded). */
  getDefaultParams(): Promise<Record<string, unknown>>;
  /** Effective context size of the loaded model, in tokens. */
  getContextSize(): number;
  /** Stops from the request plus the loaded model's own stop words. */
  getStopWords(requestStops?: string[]): string[];
  /** A completion is about to start (prefill included). */
  onGenerationStart(): void;
  /** One token was produced; called from the engine callback. */
  onGenerationToken(): void;
  /** The completion settled, successfully or not. */
  onGenerationEnd(): void;
  log(entry: ServerLogEntry): void;
}
