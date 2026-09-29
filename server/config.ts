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

export interface Config {
  port: number;
  host: string;
  nodeEnv: string;
  databasePath: string;
  trustProxy: boolean;
  llm: {
    /** OpenAI-compatible base URL, e.g. https://api.openai.com/v1 */
    baseUrl: string;
    apiKey?: string;
    model?: string;
    /** Model for short utility calls (titles). Defaults to `model`. */
    titleModel?: string;
    temperature: number;
    maxOutputTokens: number;
    requestTimeoutMs: number;
    /** Whether the model supports OpenAI-style tool calling. */
    toolsEnabled: boolean;
    /** Whether an API key is required (false for local servers like Ollama). */
    requireKey: boolean;
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
  const baseUrl = (str('LLM_BASE_URL') ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
  return {
    port: int('PORT', 8787),
    host: str('HOST') ?? '0.0.0.0',
    nodeEnv: str('NODE_ENV') ?? 'development',
    databasePath: str('DATABASE_PATH') ?? path.resolve(process.cwd(), 'data', 'tralix.db'),
    trustProxy: bool('TRUST_PROXY', true),
    llm: {
      baseUrl,
      apiKey: str('LLM_API_KEY'),
      model: str('LLM_MODEL'),
      titleModel: str('LLM_TITLE_MODEL') ?? str('LLM_MODEL'),
      temperature: Number.parseFloat(env.LLM_TEMPERATURE ?? '') || 0.7,
      maxOutputTokens: int('LLM_MAX_OUTPUT_TOKENS', 2048),
      requestTimeoutMs: int('LLM_TIMEOUT_MS', 90_000),
      toolsEnabled: bool('LLM_TOOLS', true),
      requireKey: bool('LLM_REQUIRE_KEY', true),
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
      maxConversationsPerUser: int('MAX_CONVERSATIONS_PER_USER', 500),
    },
  };
}
