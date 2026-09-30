import type { Capabilities } from '../../shared/types.js';
import type { Config } from '../config.js';
import { OpenAICompatibleProvider } from './text/openaiCompatible.js';
import { createSearchProvider } from './search/index.js';
import { NvidiaVisionProvider } from './vision/nvidia.js';
import { NvidiaImageProvider } from './image/nvidia.js';
import { OpenAiImageProvider } from './image/openai.js';
import type {
  ImageGenerationProvider,
  SearchProvider,
  TextProvider,
  VideoProvider,
  VisionProvider,
  VoiceProvider,
} from './types.js';

export interface Providers {
  text: TextProvider;
  search?: SearchProvider;
  weatherEnabled: boolean;
  imageGeneration?: ImageGenerationProvider;
  voice?: VoiceProvider;
  vision?: VisionProvider;
  video?: VideoProvider;
}

export function createProviders(cfg: Config): Providers {
  const vision = new NvidiaVisionProvider(cfg.vision);
  const imageGeneration =
    cfg.image.provider === 'openai'
      ? new OpenAiImageProvider(cfg.image)
      : new NvidiaImageProvider(cfg.image);

  return {
    text: new OpenAICompatibleProvider(cfg.llm),
    search: createSearchProvider(cfg.search),
    weatherEnabled: cfg.weatherEnabled,
    imageGeneration,
    voice: undefined,
    vision,
    video: undefined,
  };
}

/** Non-sensitive description of what this deployment can do. Safe to send to clients. */
export function describeCapabilities(p: Providers): Capabilities {
  const textOk = p.text.isConfigured();
  const visionOk = !!p.vision?.isConfigured();
  const imageOk = !!p.imageGeneration?.isConfigured();

  return {
    text: textOk
      ? { state: 'active', detail: p.text.describe() }
      : { state: 'unavailable', detail: 'No AI model is configured on the server' },
    webSearch: p.search
      ? { state: 'active', detail: p.search.id }
      : { state: 'unavailable', detail: 'No search provider is configured on the server' },
    weather: p.weatherEnabled ? { state: 'active', detail: 'Open-Meteo' } : { state: 'unavailable' },
    memory: { state: 'active', detail: 'Personal cross-conversation memory' },
    imageGeneration: imageOk
      ? { state: 'active', detail: p.imageGeneration?.describe() }
      : { state: 'unavailable', detail: 'Image generation model not configured' },
    imageUnderstanding: visionOk
      ? { state: 'active', detail: p.vision?.describe() }
      : { state: 'unavailable', detail: 'Vision model not configured' },
    voice: p.voice ? { state: 'active' } : { state: 'coming_soon' },
    video: visionOk
      ? { state: 'active', detail: 'Sampled frame analysis' }
      : { state: 'unavailable', detail: 'Vision model not configured' },
  };
}
