# TRALIX AI

A text-first AI assistant with a ChatGPT-style interface, streaming responses, real-time web knowledge with sources, and searchable conversation history. Built mobile-first.

Everything is real: replies come from an actual LLM API, and current-information answers come from an actual search API. If a capability isn't configured, the UI says so instead of pretending.

## Features (V1)

- Streaming chat with Markdown, tables, syntax-highlighted code blocks, copy, regenerate, edit-and-resend, and *Continue* for stopped/truncated replies
- Stop-generation button; partial replies are kept
- Live web search (Tavily, Brave, or SearXNG) and real weather (Open-Meteo), chosen by the model via tool calling; sources are shown under the answer
- Status indicators that map to real operations: **Thinking…** (waiting on the model), **Searching…** (a tool is running), **Writing…** (tokens streaming)
- Conversations: create, continue, rename, delete, search (titles and message content), automatic LLM-generated titles
- In-conversation context (the whole thread is sent to the model, trimmed to a budget)
- Settings: display name, custom instructions, capability status
- Errors are explained plainly, the user's message is preserved, and Retry is offered; no keys, prompts, or upstream error bodies reach the browser
- Responsive layout: desktop sidebar, mobile drawer, safe-area aware composer, installable (PWA manifest)

**Not in V1 (by design):** image/video understanding, uploads, camera, image generation (shown as *Coming soon*), voice, cross-conversation memory.

## Quick start

```bash
npm install
cp .env.example .env      # then fill in LLM_API_KEY and LLM_MODEL (and a search key)
npm run dev               # web on :5173 (proxied API on :8787)
```

Production:

```bash
npm run build
npm start                 # serves API + web app on $PORT (default 8787)
```

Docker: `docker build -t tralix-ai . && docker run -p 8787:8787 -v tralix-data:/data --env-file .env tralix-ai`

Requires Node 20.12+ (22 recommended). See [`.env.example`](.env.example) for every setting.

### Choosing a model provider

`LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` work with any OpenAI-compatible endpoint (OpenAI, OpenRouter, Groq, Gemini's OpenAI endpoint, Ollama, vLLM, …). Use a model that supports **tool calling** for live search/weather; if yours doesn't, set `LLM_TOOLS=false` and TRALIX AI will say it has no live access.

### Real-time search

Set one of `TAVILY_API_KEY`, `BRAVE_API_KEY`, or `SEARXNG_URL`. Without one, TRALIX AI is told it has no web access and will say so for time-sensitive questions. Weather works out of the box.

## Architecture

```
shared/            types + SSE parser shared by server and web
server/
  config.ts        env-only configuration (secrets never leave the server)
  providers/
    types.ts       contracts: Text, Search, ImageGeneration, Voice, Vision, Video
    registry.ts    the ONE place providers are chosen + /api/capabilities
    text/          OpenAI-compatible streaming provider
    search/        Tavily, Brave, SearXNG
    weather/       Open-Meteo
  chat/
    orchestrator.ts  request → history → model ↔ tools loop → persistence → SSE events
    tools.ts         tool registry (web_search, get_weather)
    prompt.ts        system prompt (server-side only)
  memory/          MemoryStore interface (disabled in V1) + `memories` table
  db.ts            SQLite (WAL, indexed) repository
  app.ts           Express API, security headers, rate limits, static hosting
web/src/           React + Vite UI (Markdown/highlighting and Settings are lazy-loaded)
tests/             API + streaming + tool-loop tests
```

### Adding capabilities later

- **New model vendor:** implement `TextProvider` and return it from `createProviders`. The UI is untouched.
- **Image generation:** implement `ImageGenerationProvider`, assign it in `createProviders`, add an `image_generate` tool (or endpoint). `/api/capabilities` flips the Settings badge from *Coming soon* to *Active* automatically.
- **Vision / voice / video:** the interfaces and capability slots already exist. Message rows can gain an attachments table without changing the streaming protocol.
- **Persistent memory:** implement `MemoryStore` against the `memories` table and ship it with user controls; the orchestrator already asks the store for memories.
- **Accounts:** V1 identifies each browser by an anonymous device token (only its SHA-256 hash is stored, all queries are user-scoped). Replace `requireUser` in `server/auth.ts` with a real session/JWT resolver.

### Streaming protocol

`POST /api/chat` returns Server-Sent Events: `meta`, `status`, `delta`, `sources`, `title`, `done`, `error` (see `shared/types.ts`). Aborting the request (the Stop button) cancels the upstream call and stores the partial reply.

## Security notes

- API keys and the system prompt exist only in server process memory; upstream error bodies are logged server-side and replaced with generic messages for users.
- Strict CSP (no third-party scripts, fonts, or images), Markdown rendering without raw HTML, remote images never loaded, links use `rel="noopener noreferrer nofollow"`.
- Per-IP and per-user rate limits (in-memory; use a shared store when running multiple instances), request-size limits, concurrent-stream limit, per-user conversation cap.
- Tool results are labelled as untrusted data in the prompt to blunt prompt injection.

## Development

```bash
npm test            # vitest (uses a local protocol-level stand-in for the LLM API, test-only)
npm run typecheck
```

> The previous static WebLLM prototype and Cloudflare worker were replaced by this application.
