import type { ChatMessage, ChatRequest, ConversationSummary, Source, StreamEvent } from '../../shared/types.js';
import type { Config } from '../config.js';
import type { Repository } from '../db.js';
import type { MemoryStore } from '../memory/index.js';
import type { Providers } from '../providers/registry.js';
import { ProviderError, type LlmMessage, type ToolCall } from '../providers/types.js';
import { buildSystemPrompt, CONTINUE_PROMPT, TITLE_PROMPT } from './prompt.js';
import { ToolRegistry } from './tools.js';

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
}

interface User {
  id: string;
  displayName: string;
  customInstructions: string;
}

export interface Plan {
  conversation: ConversationSummary & { titleLocked?: boolean };
  userMessage?: ChatMessage;
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
export function prepare(deps: Deps, user: User, req: ChatRequest, timeZone?: string): Plan {
  const { repo, cfg } = deps;
  const text = req.content?.trim() ?? '';
  if ((req.action === 'send' || req.action === 'edit') && !text) throw new RequestError(400, 'Message cannot be empty.');
  if (text.length > cfg.limits.maxMessageChars)
    throw new RequestError(413, `Message is too long (max ${cfg.limits.maxMessageChars} characters).`);

  let conv: (ConversationSummary & { titleLocked?: boolean }) | null = null;
  if (req.conversationId) {
    conv = repo.getConversation(user.id, req.conversationId);
    if (!conv) throw new RequestError(404, 'Conversation not found.');
  } else {
    if (req.action !== 'send') throw new RequestError(400, 'A conversationId is required.');
    if (repo.countConversations(user.id) >= cfg.limits.maxConversationsPerUser)
      throw new RequestError(429, 'You have reached the conversation limit. Delete some old chats to continue.');
    conv = repo.createConversation(user.id, fallbackTitle(text));
  }

  const existing = repo.listMessages(conv.id);
  let userMessage: ChatMessage | undefined;
  let continuing: ChatMessage | undefined;

  switch (req.action) {
    case 'send':
      userMessage = repo.addMessage(conv.id, { role: 'user', content: text });
      break;
    case 'edit': {
      const target = req.messageId ? repo.getMessage(conv.id, req.messageId) : null;
      if (!target || target.role !== 'user') throw new RequestError(400, 'That message cannot be edited.');
      repo.truncateAfter(conv.id, target.id);
      repo.updateMessage(target.id, { content: text });
      repo.touchConversation(conv.id);
      userMessage = repo.getMessage(conv.id, target.id)!;
      break;
    }
    case 'regenerate': {
      const last = existing[existing.length - 1];
      if (!last) throw new RequestError(400, 'Nothing to regenerate.');
      if (last.role === 'assistant') repo.deleteMessage(last.id);
      const remaining = repo.listMessages(conv.id);
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

  const all = repo.listMessages(conv.id);
  const firstUser = all.find((m) => m.role === 'user');
  const isFirstExchange = all.filter((m) => m.role === 'user').length === 1 && !conv.titleLocked;
  return {
    conversation: repo.getConversation(user.id, conv.id)!,
    userMessage,
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
  user: User,
  plan: Plan,
  emit: (e: StreamEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const { repo, cfg, providers, tools } = deps;
  const conv = plan.conversation;
  const assistantMessageId = plan.continuing?.id ?? crypto.randomUUID();

  emit({ type: 'meta', conversation: conv, userMessage: plan.userMessage, assistantMessageId });

  // Title generation runs alongside the answer (real LLM call, refines the fallback title).
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
    if (!providers.text.isConfigured())
      throw new ProviderError(
        'not_configured',
        'TRALIX AI is not connected to an AI model yet. The server administrator needs to set LLM_API_KEY and LLM_MODEL.',
        false,
      );

    const memories = deps.memory.enabled ? await deps.memory.recall(user.id, plan.firstUserText) : [];
    const system = buildSystemPrompt({
      now: new Date(),
      timeZone: plan.timeZone,
      displayName: user.displayName,
      customInstructions: user.customInstructions,
      memories,
      webSearch: tools.has('web_search'),
      weather: tools.has('get_weather'),
    });

    const history = trimHistory(repo.listMessages(conv.id).filter((m) => m.content.trim()).map(toLlm), cfg.limits.maxContextChars);
    const messages: LlmMessage[] = [{ role: 'system', content: system }, ...history];
    if (plan.continuing) messages.push({ role: 'user', content: CONTINUE_PROMPT });

    const toolDefs = providers.text.supportsTools() ? tools.definitions() : [];
    let announced: string | null = null;
    const announce = (s: 'thinking' | 'searching' | 'writing', detail?: string) => {
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
      let finishReason: string = 'stop';

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
        } else if (ev.type === 'tool_calls') pending = ev.calls;
        else if (ev.type === 'finish') finishReason = ev.reason;
      }

      if (!pending.length) {
        if (finishReason === 'length') status = 'stopped';
        break;
      }

      messages.push({ role: 'assistant', content: roundText || null, toolCalls: pending });
      for (const call of pending) {
        if (signal.aborted) throw new ProviderError('aborted', 'Generation stopped.', false);
        announce('searching', tools.describe(call.name, call.arguments) || undefined);
        const outcome = await tools.execute(call.name, call.arguments, signal);
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

  // Persist whatever was produced. Empty stopped/failed replies leave only the user's message.
  const produced = text.length > baseText.length || (plan.continuing && status === 'complete');
  let saved: ChatMessage | undefined;
  if (produced) {
    if (plan.continuing) {
      repo.updateMessage(assistantMessageId, { content: text, status, sources });
      repo.touchConversation(conv.id);
      saved = repo.getMessage(conv.id, assistantMessageId)!;
    } else {
      saved = repo.addMessage(conv.id, { id: assistantMessageId, role: 'assistant', content: text, status, sources });
    }
  }

  if (failure) {
    emit({ type: 'error', code: failure.code, message: failure.userMessage, retryable: failure.retryable });
  } else if (saved && !signal.aborted) {
    emit({ type: 'done', message: saved });
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
    if (title && deps.repo.setGeneratedTitle(convId, title)) emit({ type: 'title', title });
  } catch {
    /* keep the fallback title — a failed title is not worth surfacing */
  }
}
