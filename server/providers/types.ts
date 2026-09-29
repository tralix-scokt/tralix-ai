/**
 * Provider contracts.
 *
 * Every capability TRALIX AI can have (text, search, image generation, voice,
 * vision, video) is expressed as a small interface here and wired up in
 * `registry.ts`. The chat orchestrator and the web UI only depend on these
 * interfaces, so swapping a vendor — or turning on a new capability — never
 * requires touching application code.
 */
import type { Source } from '../../shared/types.js';

export type ProviderErrorCode =
  | 'not_configured'
  | 'auth'
  | 'rate_limit'
  | 'timeout'
  | 'unavailable'
  | 'bad_request'
  | 'aborted'
  | 'unknown';

/** Error whose `userMessage` is safe to show to end users. Never contains secrets. */
export class ProviderError extends Error {
  constructor(
    public code: ProviderErrorCode,
    public userMessage: string,
    public retryable: boolean,
    detail?: string,
  ) {
    super(detail ?? userMessage);
    this.name = 'ProviderError';
  }
}

// ---------- Text generation ----------

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON string of arguments as produced by the model. */
  arguments: string;
}

export type LlmMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
}

export type TextStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_calls'; calls: ToolCall[] }
  | { type: 'finish'; reason: 'stop' | 'length' | 'tool_calls' | 'other' };

export interface TextGenerationRequest {
  messages: LlmMessage[];
  tools?: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface TextProvider {
  readonly id: string;
  isConfigured(): boolean;
  /** Non-sensitive description, e.g. the model name. */
  describe(): string | undefined;
  supportsTools(): boolean;
  stream(req: TextGenerationRequest): AsyncGenerator<TextStreamEvent>;
  /** Short non-streaming completion (titles, summaries). */
  complete(req: TextGenerationRequest & { model?: string }): Promise<string>;
}

// ---------- Web search ----------

export interface SearchRequest {
  query: string;
  topic?: 'general' | 'news';
  maxResults?: number;
  signal?: AbortSignal;
}

export interface SearchResult extends Source {
  publishedAt?: string;
  /** Longer content extract passed to the model (not shown in UI). */
  content: string;
}

export interface SearchProvider {
  readonly id: string;
  search(req: SearchRequest): Promise<SearchResult[]>;
}

// ---------- Future capabilities (interfaces only — not implemented in V1) ----------

export interface ImageGenerationProvider {
  readonly id: string;
  generate(req: { prompt: string; size?: string; signal?: AbortSignal }): Promise<{ url: string; mimeType: string }>;
}
export interface VoiceProvider {
  readonly id: string;
  transcribe?(audio: ArrayBuffer): Promise<string>;
  synthesize?(text: string): Promise<ArrayBuffer>;
}
export interface VisionProvider {
  readonly id: string;
  analyze(req: { prompt: string; image: ArrayBuffer; mimeType: string }): Promise<string>;
}
export interface VideoProvider {
  readonly id: string;
  analyze(req: { prompt: string; video: ArrayBuffer; mimeType: string }): Promise<string>;
}
