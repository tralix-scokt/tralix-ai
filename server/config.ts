import path from 'node:path';

/**
 * All configuration comes from environment variables. Secrets never leave the
 * server: nothing in this module is ever serialised to a client response.
 */
try {
  process.loadEnvFile(path.resolve(process.cwd(), '.env'));
} catch {
  /* .env is optional — real environments inject variables directly. */
}

const env = process.env;
const str = (k: string): string | undefined => {
  const v = env[k]?.trim();
  return v ? v : undefined;
};
const int = (k: string, d: number): number => {
  const n = Number.parseInt(env[k] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : d;
};
const bool = (k: string, d: boolean): boolean => {
  const v = env[k]?.trim().toLowerCase();
  if (!v) return d;
  return ['1', 'true', 'yes', 'on'].includes(v);
};

export type SearchProviderName = 'tavily' | 'brave' | 'searxng';
export type ImageProviderName = 'nvidia' | 'openai';

export interface Config {
  port: number;
  host: string;
  nodeEnv: string;
  databaseUrl?: string;
  databasePath: string;
  trustProxy: boolean;
  sessionSecret: string;
  googleClientId?: string;
  llm: {
    /** OpenAI-compatible base URL, e.g. https://api.openai.com/v1 or https://integrate.api.nvidia.com/v1 */
    baseUrl: string;
    apiKey?: string;
    model?: string;
    /** Model for short utility calls (titles, memory extraction). Defaults to `model`. */
    titleModel?: string;
    temperature: number;
    maxOutputTokens: number;
    requestTimeoutMs: number;
    /** Whether the model supports OpenAI-style tool calling. */
    toolsEnabled: boolean;
    /** Whether an API key is required (false for local servers like Ollama). */
    requireKey: boolean;
  };
  vision: {
    baseUrl: string;
    apiKey?: string;
    model: string;
  };
  image: {
    provider: ImageProviderName;
    baseUrl: string;
    apiKey?: string;
    model: string;
    dailyLimit: number;
  };
  storage: {
    endpoint?: string;
    accessKey?: string;
    secretKey?: string;
    bucket?: string;
    region: string;
    uploadDir: string;
  };
  search: {
    provider?: SearchProviderName;
    tavilyKey?: string;
    braveKey?: string;
    searxngUrl?: string;
    maxResults: number;
    timeoutMs: number;
  };
  weatherEnabled: boolean;
  limits: {
    maxMessageChars: number;
    maxContextChars: number;
    maxToolRounds: number;
    chatPerMinute: number;
    apiPerMinute: number;
    authPerMinute: number;
    maxConversationsPerUser: number;
  };
}

function resolveSearchProvider(): SearchProviderName | undefined {
  const explicit = str('SEARCH_PROVIDER')?.toLowerCase();
  if (explicit === 'none' || explicit === 'off') return undefined;
  if (explicit === 'tavily' || explicit === 'brave' || explicit === 'searxng') return explicit;
  if (str('TAVILY_API_KEY')) return 'tavily';
  if (str('BRAVE_API_KEY')) return 'brave';
  if (str('SEARXNG_URL')) return 'searxng';
  return undefined;
}

export function loadConfig(): Config {
  const baseUrl = (str('LLM_BASE_URL') ?? 'https://integrate.api.nvidia.com/v1').replace(/\/+$/, '');
  const llmKey = str('LLM_API_KEY') ?? str('NVIDIA_API_KEY');
  const visionBaseUrl = (str('VISION_BASE_URL') ?? 'https://integrate.api.nvidia.com/v1').replace(/\/+$/, '');
  const imageBaseUrl = (str('IMAGE_BASE_URL') ?? 'https://ai.api.nvidia.com/v1/genai').replace(/\/+$/, '');

  return {
    port: int('PORT', 8787),
    host: str('HOST') ?? '0.0.0.0',
    nodeEnv: str('NODE_ENV') ?? 'development',
    databaseUrl: str('DATABASE_URL'),
    databasePath: str('DATABASE_PATH') ?? path.resolve(process.cwd(), 'data', 'tralix.db'),
    trustProxy: bool('TRUST_PROXY', true),
    sessionSecret: str('SESSION_SECRET') ?? 'tralix-secret-dev-session-change-in-production',
    googleClientId: str('GOOGLE_CLIENT_ID'),
    llm: {
      baseUrl,
      apiKey: llmKey,
      model: str('LLM_MODEL') ?? 'z-ai/glm-5.3',
      titleModel: str('LLM_TITLE_MODEL') ?? str('LLM_MODEL') ?? 'z-ai/glm-5.3',
      temperature: Number.parseFloat(env.LLM_TEMPERATURE ?? '') || 0.7,
      maxOutputTokens: int('LLM_MAX_OUTPUT_TOKENS', 2048),
      requestTimeoutMs: int('LLM_TIMEOUT_MS', 90_000),
      toolsEnabled: bool('LLM_TOOLS', true),
      requireKey: bool('LLM_REQUIRE_KEY', true),
    },
    vision: {
      baseUrl: visionBaseUrl,
      apiKey: str('VISION_API_KEY') ?? llmKey,
      model: str('VISION_MODEL') ?? 'meta/llama-3.2-11b-vision-instruct',
    },
    image: {
      provider: (str('IMAGE_PROVIDER')?.toLowerCase() as ImageProviderName) ?? 'nvidia',
      baseUrl: imageBaseUrl,
      apiKey: str('IMAGE_API_KEY') ?? llmKey,
      model: str('IMAGE_MODEL') ?? 'black-forest-labs/flux.1-schnell',
      dailyLimit: int('IMAGE_DAILY_LIMIT_PER_USER', 10),
    },
    storage: {
      endpoint: str('STORAGE_ENDPOINT') ?? str('S3_ENDPOINT'),
      accessKey: str('STORAGE_ACCESS_KEY') ?? str('S3_ACCESS_KEY_ID'),
      secretKey: str('STORAGE_SECRET_KEY') ?? str('S3_SECRET_ACCESS_KEY'),
      bucket: str('STORAGE_BUCKET') ?? str('S3_BUCKET_NAME'),
      region: str('STORAGE_REGION') ?? 'auto',
      uploadDir: str('UPLOAD_DIR') ?? path.resolve(process.cwd(), 'data', 'uploads'),
    },
    search: {
      provider: resolveSearchProvider(),
      tavilyKey: str('TAVILY_API_KEY'),
      braveKey: str('BRAVE_API_KEY'),
      searxngUrl: str('SEARXNG_URL')?.replace(/\/+$/, ''),
      maxResults: int('SEARCH_MAX_RESULTS', 6),
      timeoutMs: int('SEARCH_TIMEOUT_MS', 12_000),
    },
    weatherEnabled: bool('ENABLE_WEATHER', true),
    limits: {
      maxMessageChars: int('MAX_MESSAGE_CHARS', 12_000),
      maxContextChars: int('MAX_CONTEXT_CHARS', 60_000),
      maxToolRounds: int('MAX_TOOL_ROUNDS', 3),
      chatPerMinute: int('RATE_LIMIT_CHAT_PER_MIN', 20),
      apiPerMinute: int('RATE_LIMIT_API_PER_MIN', 240),
      authPerMinute: int('RATE_LIMIT_AUTH_PER_MIN', 10),
      maxConversationsPerUser: int('MAX_CONVERSATIONS_PER_USER', 500),
    },
  };
}
