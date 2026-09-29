import type { Capabilities } from '../../shared/types.js';
import type { Config } from '../config.js';
import { OpenAICompatibleProvider } from './text/openaiCompatible.js';
import { createSearchProvider } from './search/index.js';
import type {
  ImageGenerationProvider,
  SearchProvider,
  TextProvider,
  VideoProvider,
  VisionProvider,
  VoiceProvider,
} from './types.js';

/**
 * The single place where providers are chosen. To change the text model
 * vendor, add a `TextProvider` implementation and return it here.
 *
 * Future capabilities (image generation, voice, vision, video) have reserved
 * slots below. They are intentionally `undefined` in V1; when one is
 * implemented, assign it here and it will surface through /api/capabilities.
 */
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
  return {
    text: new OpenAICompatibleProvider(cfg.llm),
    search: createSearchProvider(cfg.search),
    weatherEnabled: cfg.weatherEnabled,
    imageGeneration: undefined,
    voice: undefined,
    vision: undefined,
    video: undefined,
  };
}

/** Non-sensitive description of what this deployment can do. Safe to send to clients. */
export function describeCapabilities(p: Providers): Capabilities {
  const textOk = p.text.isConfigured();
  return {
    text: textOk
      ? { state: 'active', detail: p.text.describe() }
      : { state: 'unavailable', detail: 'No AI model is configured on the server' },
    webSearch: p.search
      ? { state: 'active', detail: p.search.id }
      : { state: 'unavailable', detail: 'No search provider is configured on the server' },
    weather: p.weatherEnabled ? { state: 'active', detail: 'Open-Meteo' } : { state: 'unavailable' },
    memory: { state: 'coming_soon' },
    imageGeneration: p.imageGeneration ? { state: 'active' } : { state: 'coming_soon' },
    imageUnderstanding: p.vision ? { state: 'active' } : { state: 'coming_soon' },
    voice: p.voice ? { state: 'active' } : { state: 'coming_soon' },
    video: p.video ? { state: 'active' } : { state: 'coming_soon' },
  };
}
