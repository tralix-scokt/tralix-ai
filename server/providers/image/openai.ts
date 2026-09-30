import { postJson } from '../http.js';
import { ProviderError, type ImageGenerationProvider } from '../types.js';

export interface OpenAiImageConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
}

export class OpenAiImageProvider implements ImageGenerationProvider {
  readonly id = 'openai-image';
  private baseUrl: string;
  private apiKey?: string;
  private model: string;

  constructor(cfg: OpenAiImageConfig) {
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, '');
    this.apiKey = cfg.apiKey;
    this.model = cfg.model;
  }

  isConfigured(): boolean {
    return !!this.apiKey && !!this.model;
  }

  describe(): string | undefined {
    return this.model;
  }

  async generate(req: { prompt: string; size?: string; signal?: AbortSignal }): Promise<{ buffer: Buffer; mimeType: string }> {
    if (!this.isConfigured()) {
      throw new ProviderError(
        'not_configured',
        'Image generation is not configured. Server administrator needs to set IMAGE_API_KEY and IMAGE_MODEL.',
        false,
      );
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };

    const url = `${this.baseUrl}/images/generations`;
    const body = {
      model: this.model,
      prompt: req.prompt,
      size: req.size || '1024x1024',
      response_format: 'b64_json',
      n: 1,
    };

    try {
      const res = await postJson<any>(url, headers, body, 90_000, req.signal);
      const b64 = res?.data?.[0]?.b64_json;
      if (b64) {
        return { buffer: Buffer.from(b64, 'base64'), mimeType: 'image/png' };
      }
      const imgUrl = res?.data?.[0]?.url;
      if (imgUrl) {
        const fetchRes = await fetch(imgUrl, { signal: req.signal });
        if (!fetchRes.ok) throw new Error(`Failed to fetch image URL: ${fetchRes.statusText}`);
        const arrayBuf = await fetchRes.arrayBuffer();
        const mime = fetchRes.headers.get('content-type') || 'image/png';
        return { buffer: Buffer.from(arrayBuf), mimeType: mime };
      }
      throw new ProviderError('unavailable', 'No image data returned from provider.', true);
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      const msg = (err as Error)?.message || 'Image generation failed';
      console.error('[image-openai] upstream error:', msg);
      if (msg.includes('401') || msg.includes('auth')) {
        throw new ProviderError('auth', 'Authentication with the image provider failed.', false);
      }
      if (msg.includes('429')) {
        throw new ProviderError('rate_limit', 'The image generation service is busy. Please try again soon.', true);
      }
      throw new ProviderError('unavailable', 'Image generation failed. Please try again.', true);
    }
  }
}
