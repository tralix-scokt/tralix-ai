import type {
  Attachment,
  ChatMessage,
  ChatRequest,
  ConversationSummary,
  Source,
  StreamEvent,
  UserProfile,
} from '../../shared/types.js';
import type { Config } from '../config.js';
import type { Repository } from '../db.js';
import type { MemoryStore } from '../memory/index.js';
import type { StorageService } from '../storage/index.js';
import type { Providers } from '../providers/registry.js';
import { ProviderError, type LlmMessage, type ToolCall } from '../providers/types.js';
import { buildSystemPrompt, CONTINUE_PROMPT, TITLE_PROMPT } from './prompt.js';
import { ToolRegistry } from './tools.js';
import { extractVideoFrames, isFfmpegAvailable } from '../media/video.js';

/** Thrown for invalid requests, before any streaming starts. */
export class RequestError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface Deps {
  cfg: Config;
  repo: Repository;
  providers: Providers;
  memory: MemoryStore;
  tools: ToolRegistry;
  storage: StorageService;
}

export interface Plan {
  conversation: ConversationSummary & { titleLocked?: boolean };
  userMessage?: ChatMessage;
  attachments?: Attachment[];
  /** Existing assistant message being extended (continue). */
  continuing?: ChatMessage;
  /** Whether this is the conversation's first exchange (title generation). */
  isFirstExchange: boolean;
  firstUserText: string;
  timeZone?: string;
}

const DEFAULT_TITLE = 'New chat';

export function fallbackTitle(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return DEFAULT_TITLE;
  return t.length <= 48 ? t : t.slice(0, 47).replace(/\s+\S*$/, '') + '…';
}

/** Validate the request and apply its database effects. Throws RequestError. */
export async function prepare(deps: Deps, user: UserProfile, req: ChatRequest, timeZone?: string): Promise<Plan> {
  const { repo, cfg } = deps;
  const text = req.content?.trim() ?? '';
  const hasAttachments = Array.isArray(req.attachmentIds) && req.attachmentIds.length > 0;

  if ((req.action === 'send' || req.action === 'edit') && !text && !hasAttachments) {
    throw new RequestError(400, 'Message cannot be empty.');
  }
  if (text.length > cfg.limits.maxMessageChars) {
    throw new RequestError(413, `Message is too long (max ${cfg.limits.maxMessageChars} characters).`);
  }

  let conv: (ConversationSummary & { titleLocked?: boolean }) | null = null;
  if (req.conversationId) {
    conv = await repo.getConversation(user.id, req.conversationId);
    if (!conv) throw new RequestError(404, 'Conversation not found.');
  } else {
    if (req.action !== 'send') throw new RequestError(400, 'A conversationId is required.');
    const count = await repo.countConversations(user.id);
    if (count >= cfg.limits.maxConversationsPerUser) {
      throw new RequestError(429, 'You have reached the conversation limit. Delete some old chats to continue.');
    }
    conv = await repo.createConversation(user.id, fallbackTitle(text || 'Image'));
  }

  const existing = await repo.listMessages(conv.id);
  let userMessage: ChatMessage | undefined;
  let continuing: ChatMessage | undefined;
  let resolvedAttachments: Attachment[] = [];

  if (hasAttachments) {
    const rawAtts = await repo.getAttachmentsByIds(user.id, req.attachmentIds!);
    resolvedAttachments = rawAtts.map((a) => ({
      id: a.id,
      filename: a.filename,
      mimeType: a.mimeType,
      sizeBytes: a.sizeBytes,
      url: `/api/attachments/${a.id}`,
    }));
  }

  switch (req.action) {
    case 'send': {
      userMessage = await repo.addMessage(conv.id, {
        role: 'user',
        content: text,
        attachments: resolvedAttachments,
      });
      if (hasAttachments) {
        await repo.linkAttachmentsToMessage(user.id, userMessage.id, conv.id, req.attachmentIds!);
      }
      break;
    }
    case 'edit': {
      const target = req.messageId ? await repo.getMessage(conv.id, req.messageId) : null;
      if (!target || target.role !== 'user') throw new RequestError(400, 'That message cannot be edited.');
      await repo.truncateAfter(conv.id, target.id);
      await repo.updateMessage(target.id, { content: text });
      await repo.touchConversation(conv.id);
      userMessage = (await repo.getMessage(conv.id, target.id))!;
      break;
    }
    case 'regenerate': {
      const last = existing[existing.length - 1];
      if (!last) throw new RequestError(400, 'Nothing to regenerate.');
      if (last.role === 'assistant') await repo.deleteMessage(last.id);
      const remaining = await repo.listMessages(conv.id);
      if (remaining[remaining.length - 1]?.role !== 'user') throw new RequestError(400, 'Nothing to regenerate.');
      break;
    }
    case 'continue': {
      const last = existing[existing.length - 1];
      if (!last || last.role !== 'assistant') throw new RequestError(400, 'Nothing to continue.');
      continuing = last;
      break;
    }
    default:
      throw new RequestError(400, 'Unknown action.');
  }

  const all = await repo.listMessages(conv.id);
  const firstUser = all.find((m) => m.role === 'user');
  const isFirstExchange = all.filter((m) => m.role === 'user').length === 1 && !conv.titleLocked;

  return {
    conversation: (await repo.getConversation(user.id, conv.id))!,
    userMessage,
    attachments: resolvedAttachments,
    continuing,
    isFirstExchange,
    firstUserText: firstUser?.content ?? text,
    timeZone,
  };
}

/** Keep the most recent messages that fit the context budget. */
export function trimHistory(messages: LlmMessage[], maxChars: number): LlmMessage[] {
  const size = (m: LlmMessage) => (m.content?.length ?? 0) + 16;
  let total = 0;
  const kept: LlmMessage[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    total += size(messages[i]);
    if (total > maxChars && kept.length > 0) break;
    kept.unshift(messages[i]);
  }
  while (kept.length > 1 && kept[0].role !== 'user') kept.shift();
  return kept;
}

const toLlm = (m: ChatMessage): LlmMessage => ({ role: m.role, content: m.content });

const dedupe = (sources: Source[]): Source[] => {
  const seen = new Set<string>();
  return sources.filter((s) => (seen.has(s.url) ? false : (seen.add(s.url), true)));
};

export async function run(
  deps: Deps,
  user: UserProfile,
  plan: Plan,
  emit: (e: StreamEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const { repo, cfg, providers, tools, storage } = deps;
  const conv = plan.conversation;
  const assistantMessageId = plan.continuing?.id ?? crypto.randomUUID();

  emit({ type: 'meta', conversation: conv, userMessage: plan.userMessage, assistantMessageId });

  // Title generation runs alongside the answer
  let titleTask: Promise<void> = Promise.resolve();
  if (plan.isFirstExchange && providers.text.isConfigured()) {
    titleTask = generateTitle(deps, conv.id, plan.firstUserText, signal, emit);
  }

  const baseText = plan.continuing?.content ?? '';
  let text = baseText;
  let sources: Source[] = plan.continuing?.sources ?? [];
  let status: ChatMessage['status'] = 'complete';
  let failure: ProviderError | null = null;

  try {
    if (!providers.text.isConfigured()) {
      throw new ProviderError(
        'not_configured',
        'TRALIX AI is not connected to an AI model yet. The server administrator needs to set LLM_API_KEY and LLM_MODEL.',
        false,
      );
    }

    // Retrieve relevant memories
    const memories =
      deps.memory.enabled && user.memoryEnabled
        ? await deps.memory.recall(user.id, plan.firstUserText)
        : [];

    const system = buildSystemPrompt({
      now: new Date(),
      timeZone: plan.timeZone,
      displayName: user.displayName,
      customInstructions: user.customInstructions,
      memories,
      webSearch: tools.has('web_search'),
      weather: tools.has('get_weather'),
      imageGeneration: tools.has('generate_image'),
      vision: !!providers.vision?.isConfigured(),
    });

    // Check if user message has media attachments to analyse with Vision model
    let mediaObservation = '';
    const attachmentsToProcess = plan.userMessage?.attachments ?? plan.attachments ?? [];

    if (attachmentsToProcess.length > 0 && providers.vision?.isConfigured()) {
      emit({ type: 'status', status: 'thinking', detail: 'Analysing uploaded media…' });

      for (const att of attachmentsToProcess) {
        const fullAtt = await repo.getAttachment(user.id, att.id);
        if (!fullAtt) continue;

        const obj = await storage.getObject(fullAtt.storageKey);
        if (!obj) continue;

        const isVideo = att.mimeType.startsWith('video/');
        const isImage = att.mimeType.startsWith('image/');

        if (isImage) {
          try {
            const analysis = await providers.vision.analyze({
              prompt: plan.userMessage?.content
                ? `Analyze this photo in the context of the user's question: "${plan.userMessage.content}". Describe what is in the image, key text, and details.`
                : 'Describe this photo in detail, including all key elements, colors, text, and composition.',
              images: [{ buffer: obj.buffer, mimeType: att.mimeType }],
              signal,
            });
            mediaObservation += `\n[Image attachment "${att.filename}": ${analysis}]\n`;
          } catch (e) {
            console.error('[orchestrator] vision analysis error:', (e as Error)?.message);
            mediaObservation += `\n[Image attachment "${att.filename}": Analysis could not be completed.]\n`;
          }
        } else if (isVideo) {
          const ffmpegOk = await isFfmpegAvailable();
          if (!ffmpegOk) {
            mediaObservation += `\n[Video attachment "${att.filename}": ffmpeg is not available on this server to extract video frames.]\n`;
          } else {
            try {
              const { frames, note } = await extractVideoFrames(obj.buffer, 4);
              if (frames.length) {
                const analysis = await providers.vision.analyze({
                  prompt: `This video was analysed from ${frames.length} sampled frames. User's query: "${plan.userMessage?.content || 'Describe this video'}". Describe the motion, sequence of actions, and content across these sampled frames.`,
                  images: frames.map((f) => ({ buffer: f.buffer, mimeType: 'image/jpeg' })),
                  signal,
                });
                mediaObservation += `\n[Video attachment "${att.filename}" (${note}): ${analysis}]\n`;
              }
            } catch (e) {
              console.error('[orchestrator] video analysis error:', (e as Error)?.message);
              mediaObservation += `\n[Video attachment "${att.filename}": Frame extraction failed.]\n`;
            }
          }
        }
      }
    }

    const rawMessages = await repo.listMessages(conv.id);
    const history = trimHistory(
      rawMessages.filter((m) => m.content.trim() || (m.attachments && m.attachments.length > 0)).map(toLlm),
      cfg.limits.maxContextChars,
    );

    // If media observations were made, attach to the latest user message
    if (mediaObservation) {
      for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].role === 'user') {
          history[i].content += `\n\n${mediaObservation.trim()}`;
          break;
        }
      }
    }

    const messages: LlmMessage[] = [{ role: 'system', content: system }, ...history];
    if (plan.continuing) messages.push({ role: 'user', content: CONTINUE_PROMPT });

    const toolDefs = providers.text.supportsTools() ? tools.definitions() : [];
    let announced: string | null = null;
    const announce = (s: 'thinking' | 'searching' | 'writing' | 'generating_image', detail?: string) => {
      const key = `${s}:${detail ?? ''}`;
      if (key === announced) return;
      announced = key;
      emit({ type: 'status', status: s, detail });
    };

    for (let round = 0; ; round++) {
      const allowTools = toolDefs.length > 0 && round < cfg.limits.maxToolRounds;
      announce('thinking');
      let pending: ToolCall[] = [];
      let roundText = '';
      let finishReason = 'stop';

      for await (const ev of providers.text.stream({
        messages,
        tools: allowTools ? toolDefs : undefined,
        signal,
      })) {
        if (ev.type === 'text') {
          announce('writing');
          roundText += ev.text;
          text += ev.text;
          emit({ type: 'delta', text: ev.text });
        } else if (ev.type === 'tool_calls') {
          pending = ev.calls;
        } else if (ev.type === 'finish') {
          finishReason = ev.reason;
        }
      }

      if (!pending.length) {
        if (finishReason === 'length') status = 'stopped';
        break;
      }

      messages.push({ role: 'assistant', content: roundText || null, toolCalls: pending });
      for (const call of pending) {
        if (signal.aborted) throw new ProviderError('aborted', 'Generation stopped.', false);
        const stType = tools.getStatusType(call.name);
        const detail = stType === 'generating_image' ? 'Generating image…' : (tools.describe(call.name, call.arguments) || undefined);
        announce(stType, detail);

        const outcome = await tools.execute(call.name, call.arguments, user, signal);
        messages.push({ role: 'tool', toolCallId: call.id, content: outcome.content });
        if (outcome.sources.length) {
          sources = dedupe([...sources, ...outcome.sources]);
          emit({ type: 'sources', sources });
        }
      }

      // If text was streamed before a tool call, keep paragraphs separated.
      if (roundText && !/\s$/.test(text)) {
        text += '\n\n';
        emit({ type: 'delta', text: '\n\n' });
      }
    }
  } catch (e) {
    if (signal.aborted) {
      status = 'stopped';
    } else {
      failure =
        e instanceof ProviderError
          ? e
          : new ProviderError('unknown', 'Something went wrong while generating the response. Please try again.', true);
      if (!(e instanceof ProviderError)) console.error('[chat] unexpected error:', (e as Error)?.message);
      status = 'error';
    }
  }

  // Persist whatever was produced.
  const produced = text.length > baseText.length || (plan.continuing && status === 'complete');
  let saved: ChatMessage | undefined;
  if (produced) {
    if (plan.continuing) {
      await repo.updateMessage(assistantMessageId, { content: text, status, sources });
      await repo.touchConversation(conv.id);
      saved = (await repo.getMessage(conv.id, assistantMessageId))!;
    } else {
      saved = await repo.addMessage(conv.id, {
        id: assistantMessageId,
        role: 'assistant',
        content: text,
        status,
        sources,
      });
    }
  }

  if (failure) {
    emit({ type: 'error', code: failure.code, message: failure.userMessage, retryable: failure.retryable });
  } else if (saved && !signal.aborted) {
    emit({ type: 'done', message: saved });
  }

  // Extract durable long-term memory across chats in background
  if (!signal.aborted && saved && status === 'complete' && deps.memory.enabled && user.memoryEnabled) {
    deps.memory
      .extractAndSave(
        deps.providers.text,
        user.id,
        { userText: plan.firstUserText, assistantText: text },
        signal,
      )
      .then((savedMemories) => {
        if (savedMemories.length > 0) {
          emit({ type: 'memory_updated', count: savedMemories.length });
        }
      })
      .catch((e) => console.error('[memory] background extraction error:', (e as Error)?.message));
  }

  // Give the title task a moment to finish so the client sees the new title.
  if (!signal.aborted) await Promise.race([titleTask, new Promise((r) => setTimeout(r, 4000))]);
}

async function generateTitle(
  deps: Deps,
  convId: string,
  firstUserText: string,
  signal: AbortSignal,
  emit: (e: StreamEvent) => void,
): Promise<void> {
  try {
    const raw = await deps.providers.text.complete({
      messages: [
        { role: 'system', content: TITLE_PROMPT },
        { role: 'user', content: firstUserText.slice(0, 1000) },
      ],
      maxTokens: 24,
      signal,
    });
    const title = raw
      .replace(/^["'“”\s]+|["'“”.\s]+$/g, '')
      .replace(/^title:\s*/i, '')
      .replace(/\s+/g, ' ')
      .slice(0, 60);
    if (title && (await deps.repo.setGeneratedTitle(convId, title))) {
      emit({ type: 'title', title });
    }
  } catch {
    /* keep the fallback title */
  }
}
