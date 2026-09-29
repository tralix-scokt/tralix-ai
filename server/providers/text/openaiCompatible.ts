import { SSEParser } from '../../../shared/sse.js';
import type { Config } from '../../config.js';
import {
  ProviderError,
  type LlmMessage,
  type TextGenerationRequest,
  type TextProvider,
  type TextStreamEvent,
  type ToolCall,
} from '../types.js';

/**
 * Text provider for any server that implements the OpenAI Chat Completions
 * protocol: OpenAI, OpenRouter, Groq, Together, Mistral, Gemini's OpenAI
 * endpoint, Ollama, vLLM, LM Studio, ...
 *
 * Configure with LLM_BASE_URL / LLM_API_KEY / LLM_MODEL.
 */
export class OpenAICompatibleProvider implements TextProvider {
  readonly id = 'openai-compatible';
  constructor(private cfg: Config['llm']) {}

  isConfigured(): boolean {
    return !!this.cfg.model && (!this.cfg.requireKey || !!this.cfg.apiKey);
  }
  describe(): string | undefined {
    return this.cfg.model;
  }
  supportsTools(): boolean {
    return this.cfg.toolsEnabled;
  }

  private toWire(messages: LlmMessage[]) {
    return messages.map((m) => {
      if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
      if (m.role === 'assistant' && m.toolCalls?.length)
        return {
          role: 'assistant',
          content: m.content,
          tool_calls: m.toolCalls.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: c.arguments },
          })),
        };
      return { role: m.role, content: m.content };
    });
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'text/event-stream, application/json' };
    if (this.cfg.apiKey) h.Authorization = `Bearer ${this.cfg.apiKey}`;
    return h;
  }

  private async request(body: Record<string, unknown>, signal: AbortSignal | undefined, ctl: AbortController) {
    if (!this.isConfigured())
      throw new ProviderError('not_configured', 'The AI model has not been configured on this server yet.', false);
    const onAbort = () => ctl.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) ctl.abort();
    let res: Response;
    try {
      res = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
    } catch (e) {
      signal?.removeEventListener('abort', onAbort);
      throw this.mapFetchError(e, signal);
    }
    if (!res.ok) {
      signal?.removeEventListener('abort', onAbort);
      const text = await res.text().catch(() => '');
      // Details go to server logs only — never to the client.
      console.error(`[llm] upstream ${res.status}: ${text.slice(0, 500)}`);
      throw this.mapStatus(res.status);
    }
    return { res, cleanup: () => signal?.removeEventListener('abort', onAbort) };
  }

  private mapStatus(status: number): ProviderError {
    if (status === 401 || status === 403)
      return new ProviderError('auth', 'TRALIX AI could not authenticate with its AI model provider. The server administrator needs to check the configuration.', false);
    if (status === 429)
      return new ProviderError('rate_limit', 'The AI model is receiving too many requests right now. Please try again in a moment.', true);
    if (status === 408 || status === 504)
      return new ProviderError('timeout', 'The AI model took too long to respond. Please try again.', true);
    if (status >= 500)
      return new ProviderError('unavailable', 'The AI model is temporarily unavailable. Please try again shortly.', true);
    return new ProviderError('bad_request', 'The AI model could not process that request.', false);
  }

  private mapFetchError(e: unknown, signal?: AbortSignal): ProviderError {
    if (signal?.aborted) return new ProviderError('aborted', 'Generation stopped.', false);
    const name = (e as Error)?.name;
    if (name === 'AbortError' || name === 'TimeoutError')
      return new ProviderError('timeout', 'The AI model took too long to respond. Please try again.', true);
    console.error('[llm] network error:', (e as Error)?.message);
    return new ProviderError('unavailable', 'TRALIX AI could not reach its AI model. Please try again shortly.', true);
  }

  async *stream(req: TextGenerationRequest): AsyncGenerator<TextStreamEvent> {
    const ctl = new AbortController();
    let idle: NodeJS.Timeout | undefined;
    const arm = () => {
      clearTimeout(idle);
      idle = setTimeout(() => ctl.abort(new Error('idle-timeout')), this.cfg.requestTimeoutMs);
    };
    arm();
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages: this.toWire(req.messages),
      stream: true,
      temperature: req.temperature ?? this.cfg.temperature,
      max_tokens: req.maxTokens ?? this.cfg.maxOutputTokens,
    };
    if (req.tools?.length && this.supportsTools()) {
      body.tools = req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      body.tool_choice = 'auto';
    }

    const { res, cleanup } = await this.request(body, req.signal, ctl).catch((e) => {
      clearTimeout(idle);
      throw e;
    });

    const calls = new Map<number, ToolCall>();
    let finish: TextStreamEvent & { type: 'finish' } = { type: 'finish', reason: 'stop' };
    const queue: TextStreamEvent[] = [];
    const parser = new SSEParser((m) => {
      if (m.data === '[DONE]') return;
      let json: any;
      try {
        json = JSON.parse(m.data);
      } catch {
        return;
      }
      const choice = json?.choices?.[0];
      if (!choice) return;
      const delta = choice.delta ?? {};
      if (typeof delta.content === 'string' && delta.content) queue.push({ type: 'text', text: delta.content });
      for (const tc of delta.tool_calls ?? []) {
        const idx = typeof tc.index === 'number' ? tc.index : 0;
        const cur = calls.get(idx) ?? { id: '', name: '', arguments: '' };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.arguments += tc.function.arguments;
        calls.set(idx, cur);
      }
      if (choice.finish_reason) {
        const r = choice.finish_reason;
        finish = { type: 'finish', reason: r === 'stop' ? 'stop' : r === 'length' ? 'length' : r === 'tool_calls' ? 'tool_calls' : 'other' };
      }
    });

    try {
      if (!res.body) throw new ProviderError('unavailable', 'The AI model returned an empty response.', true);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (e) {
          throw this.mapFetchError(e, req.signal);
        }
        if (chunk.done) break;
        arm();
        parser.push(decoder.decode(chunk.value, { stream: true }));
        while (queue.length) yield queue.shift()!;
      }
      parser.end();
      while (queue.length) yield queue.shift()!;
      const finalCalls = [...calls.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([i, c]) => ({ ...c, id: c.id || `call_${i}_${Date.now()}` }))
        .filter((c) => c.name);
      if (finalCalls.length) {
        yield { type: 'tool_calls', calls: finalCalls };
        yield { type: 'finish', reason: 'tool_calls' };
      } else {
        yield finish;
      }
    } finally {
      clearTimeout(idle);
      cleanup();
      ctl.abort(); // release the connection if we bailed early
    }
  }

  async complete(req: TextGenerationRequest & { model?: string }): Promise<string> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), Math.min(this.cfg.requestTimeoutMs, 30_000));
    try {
      const { res, cleanup } = await this.request(
        {
          model: req.model ?? this.cfg.titleModel ?? this.cfg.model,
          messages: this.toWire(req.messages),
          stream: false,
          temperature: req.temperature ?? 0.3,
          max_tokens: req.maxTokens ?? 64,
        },
        req.signal,
        ctl,
      );
      try {
        const json: any = await res.json();
        const c = json?.choices?.[0]?.message?.content;
        return typeof c === 'string' ? c : '';
      } finally {
        cleanup();
      }
    } finally {
      clearTimeout(t);
    }
  }
}
