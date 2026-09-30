import { postJson } from '../http.js';
import { ProviderError, type VisionProvider } from '../types.js';

export interface NvidiaVisionConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
}

export class NvidiaVisionProvider implements VisionProvider {
  readonly id = 'nvidia-vision';
  private baseUrl: string;
  private apiKey?: string;
  private model: string;

  constructor(cfg: NvidiaVisionConfig) {
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

  async analyze(req: {
    prompt: string;
    images: { buffer: Buffer; mimeType: string }[];
    signal?: AbortSignal;
  }): Promise<string> {
    if (!this.isConfigured()) {
      throw new ProviderError(
        'not_configured',
        'Vision provider is not configured. Server administrator needs to set VISION_API_KEY and VISION_MODEL.',
        false,
      );
    }

    if (!req.images.length) {
      throw new ProviderError('bad_request', 'No images provided for visual analysis.', false);
    }

    const content: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = [
      { type: 'text', text: req.prompt || 'Please describe and analyse what you see in the provided image(s) in detail.' },
    ];

    for (const img of req.images) {
      const mime = img.mimeType.startsWith('image/') ? img.mimeType : 'image/jpeg';
      const b64 = img.buffer.toString('base64');
      content.push({
        type: 'image_url',
        image_url: { url: `data:${mime};base64,${b64}` },
      });
    }

    const url = `${this.baseUrl}/chat/completions`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };

    const body = {
      model: this.model,
      messages: [{ role: 'user', content }],
      max_tokens: 2048,
      temperature: 0.2,
    };

    try {
      const res = await postJson<any>(url, headers, body, 90_000, req.signal);
      const text = res?.choices?.[0]?.message?.content;
      if (!text || typeof text !== 'string') {
        throw new ProviderError('unavailable', 'The vision model returned an empty response. Please try again.', true);
      }
      return text.trim();
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      const msg = (err as Error)?.message || 'Vision analysis failed';
      console.error('[vision] upstream error:', msg);
      if (msg.includes('401') || msg.includes('auth')) {
        throw new ProviderError('auth', 'Authentication with the vision provider failed. Check VISION_API_KEY.', false);
      }
      if (msg.includes('429')) {
        throw new ProviderError('rate_limit', 'The vision model is busy or rate limited. Please try again in a moment.', true);
      }
      throw new ProviderError('unavailable', 'Could not analyse image at this time. Please try again.', true);
    }
  }
}
