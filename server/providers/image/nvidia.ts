import { postJson } from '../http.js';
import { ProviderError, type ImageGenerationProvider } from '../types.js';

export interface NvidiaImageConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
}

export class NvidiaImageProvider implements ImageGenerationProvider {
  readonly id = 'nvidia-image';
  private baseUrl: string;
  private apiKey?: string;
  private model: string;

  constructor(cfg: NvidiaImageConfig) {
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
      Accept: 'application/json',
    };

    // First attempt: NVIDIA GenAI per-model endpoint (ai.api.nvidia.com/v1/genai/{model})
    // e.g. https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.1-schnell
    const isPerModelUrl = this.baseUrl.includes('/genai');
    const genaiUrl = isPerModelUrl
      ? `${this.baseUrl}/${this.model}`
      : `${this.baseUrl}/images/generations`;

    try {
      if (isPerModelUrl) {
        const body = {
          prompt: req.prompt,
          seed: 0,
          steps: 4,
        };
        const res = await postJson<any>(genaiUrl, headers, body, 90_000, req.signal);
        if (res?.artifacts?.[0]?.base64) {
          const buffer = Buffer.from(res.artifacts[0].base64, 'base64');
          return { buffer, mimeType: 'image/jpeg' };
        }
      }

      // Fallback or OpenAI-compatible endpoint format:
      // POST /v1/images/generations with { model, prompt, response_format: 'b64_json' }
      const fallbackUrl = isPerModelUrl
        ? 'https://integrate.api.nvidia.com/v1/images/generations'
        : genaiUrl;

      const body = {
        model: this.model,
        prompt: req.prompt,
        response_format: 'b64_json',
        n: 1,
      };

      const res = await postJson<any>(fallbackUrl, headers, body, 90_000, req.signal);
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

      throw new ProviderError('unavailable', 'No image data was returned by the image provider.', true);
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      const msg = (err as Error)?.message || 'Image generation failed';
      console.error('[image] upstream error:', msg);
      if (msg.includes('401') || msg.includes('auth')) {
        throw new ProviderError('auth', 'Authentication with the image provider failed. Check IMAGE_API_KEY.', false);
      }
      if (msg.includes('429')) {
        throw new ProviderError('rate_limit', 'The image generation service is currently busy. Please try again soon.', true);
      }
      throw new ProviderError('unavailable', 'Image generation failed. Please try a different prompt.', true);
    }
  }
}
