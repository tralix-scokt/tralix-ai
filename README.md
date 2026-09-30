# TRALIX AI (V2)

A fast, private, multimodal AI companion with streaming responses, real-time web knowledge, photo/video understanding, AI image generation, cross-chat long-term memory, and real accounts. Built mobile-first for Safari on iPhone and modern web browsers.

Everything is real: responses stream from live models, images and videos are analyzed by real multimodal vision models, pictures are generated via live FLUX endpoints, web questions cite real search results, and memories persist across sessions in hosted PostgreSQL.

---

## What's New in V2

1. **Real Accounts & Persistent Data**
   - Email + password authentication hashed securely with Node's native `scrypt` and timing-safe verification.
   - Secure `httpOnly`, `sameSite=lax` session cookies and rate-limited signup/login endpoints.
   - Hosted PostgreSQL (`DATABASE_URL`, e.g. Neon free tier) with automatic startup migrations that survive restarts and zero-disk ephemeral deploys on Render.
   - User data isolation: every conversation, message, attachment, image, and memory strictly belongs to the authenticated user.
   - Account settings: change password, export all account data (JSON), and delete account with permanent cascading data purge.
   - Seamless anonymous-device migration: chats created before signing up are merged automatically upon registration.

2. **Photo & Video Upload (AI Understanding)**
   - Composer attach button natively opens the iPhone Camera Roll and Camera via `<input type="file" accept="image/*,video/*">`.
   - Live attachment previews with remove button and upload progress indicators.
   - Server-side validation of file types, sizes (20MB photos, 50MB videos), and count limits (max 5 files).
   - Storage in S3-compatible object storage (e.g. Cloudflare R2) with per-user access via signed URLs (and local disk fallback).
   - Dedicated Vision model provider slot (`VISION_BASE_URL`, `VISION_API_KEY`, `VISION_MODEL`) powered by NVIDIA's live `meta/llama-3.2-11b-vision-instruct`.
   - Videos are sampled into keyframes server-side using `ffmpeg` and analyzed sequentially. The UI is completely transparent that video is analyzed from sampled frames.
   - If the vision provider is unconfigured, the attach button is cleanly disabled with an informative label.

3. **AI Image Generation**
   - Active image generation via NVIDIA NIM (`black-forest-labs/flux.1-schnell` or `stabilityai/stable-diffusion-3.5-large`) and OpenAI-compatible endpoints.
   - The assistant autonomously decides to invoke the `generate_image` tool when the user asks for artwork, drawings, or pictures.
   - Chat interface displays generated images with inline preview, Download button (saves to device), and Regenerate button.
   - Per-user daily limits and built-in safety & moderation checks with clear refusal explanations.
   - Status indicators reflect actual server work ("Generating image…").

4. **Long-Term Memory Across Chats**
   - Cross-conversation memory architecture turned ON.
   - Automatic background extraction of durable facts and user preferences (name, projects, interests, coding stacks, style preferences) after exchanges.
   - Sensitive data guardrails: secrets, tokens, and passwords are never extracted or stored.
   - Relevance-ranked memory retrieval with character caps injected into the system prompt for new conversations.
   - Dedicated Memory manager in Settings: toggle memory on/off, view memories, edit individual items inline, delete items, and clear all.
   - Subtle "Memory updated" indicator appears only when new facts are actually saved.

---

## iPhone-Friendly Render Setup Checklist

Deploying TRALIX AI V2 on Render's free tier takes less than 5 minutes from Safari on an iPhone. Follow this checklist:

### 1. Database (Free Neon Postgres)
1. Go to [neon.tech](https://neon.tech) in Safari and create a free account.
2. Create a project named `tralix-db`.
3. Copy the **Connection string** (it looks like `postgresql://neondb_owner:***@ep-***.us-east-2.aws.neon.tech/neondb?sslmode=require`).

### 2. NVIDIA API Key (Free build.nvidia.com)
1. Go to [build.nvidia.com](https://build.nvidia.com) in Safari and sign up for a free developer account.
2. Go to **API Keys** and generate a key (`nvapi-...`).

### 3. Deploy on Render
1. Go to [dashboard.render.com](https://dashboard.render.com) in Safari.
2. Select **New +** -> **Web Service**.
3. Connect your GitHub repository (`tralix-ai`) on branch `arena/01a0f2ca-tralix-ai`.
4. Choose **Docker** as the environment (Render detects the included `Dockerfile`).
5. Choose the **Free** instance type.
6. Under **Environment Variables**, tap **Add Environment Variable** and copy-paste these values:

```env
DATABASE_URL
postgresql://<paste-your-neon-connection-string-here>

SESSION_SECRET
c8f9210e4a64d1f278bc034d6e91a5fb71092a83e0c4b2a1975e

LLM_BASE_URL
https://integrate.api.nvidia.com/v1

LLM_API_KEY
<paste-your-nvapi-key-here>

LLM_MODEL
z-ai/glm-5.3

VISION_BASE_URL
https://integrate.api.nvidia.com/v1

VISION_API_KEY
<paste-your-nvapi-key-here>

VISION_MODEL
meta/llama-3.2-11b-vision-instruct

IMAGE_PROVIDER
nvidia

IMAGE_BASE_URL
https://ai.api.nvidia.com/v1/genai

IMAGE_API_KEY
<paste-your-nvapi-key-here>

IMAGE_MODEL
black-forest-labs/flux.1-schnell

IMAGE_DAILY_LIMIT_PER_USER
10
```

*Optional Web Search (e.g. Tavily):*
```env
TAVILY_API_KEY
tvly-<your-tavily-key>
```

*Optional Cloudflare R2 / S3 Object Storage (if omitted, files store in `/data/uploads`):*
```env
STORAGE_ENDPOINT
https://<account-id>.r2.cloudflarestorage.com

STORAGE_ACCESS_KEY
<your-r2-access-key>

STORAGE_SECRET_KEY
<your-r2-secret-key>

STORAGE_BUCKET
tralix-media
```

7. Tap **Deploy Web Service**.
8. Render builds the Docker container (with Node 22, `ffmpeg`, and automatic startup migrations). Once live, open your Render `.onrender.com` URL in Safari!

---

## Local Development

```bash
npm install
cp .env.example .env
# Fill in LLM_API_KEY, VISION_API_KEY, and IMAGE_API_KEY (or use local fallback)
npm run dev
```

Run tests and typecheck:
```bash
npm test            # Vitest: 19 tests across streaming, auth, memory, upload, migrations
npm run typecheck   # TypeScript check for both server and web
npm run build       # Full Vite and TS build
```

---

## Security & Privacy Notes

- **Zero Client Secrets:** Upstream credentials (`LLM_API_KEY`, `VISION_API_KEY`, `IMAGE_API_KEY`, `DATABASE_URL`) exist only in server process memory and are never sent to the browser.
- **Argon2/scrypt Passwords:** Password hashes use Node's native `crypto.scrypt` with random 16-byte salts and timing-safe equality checks.
- **Strict User Scoping:** Every SQL query for chats, messages, attachments, images, and memories is scoped by `user_id`.
- **Signed URLs:** Storage downloads use short-lived presigned URLs generated server-side for the owning user only.
- **Safety Filtering:** Image prompts pass through built-in moderation checks prior to provider dispatch.
