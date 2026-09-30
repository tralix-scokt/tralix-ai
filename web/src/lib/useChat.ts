import { useCallback, useEffect, useRef, useState } from 'react';
import type { Attachment, AiStatus, ChatMessage, ConversationSummary } from '../../../shared/types';
import { api, ApiError, streamChat } from './api';

export interface ChatError {
  message: string;
  /** True when the server holds the user's message and a retry (regenerate) makes sense. */
  canRetry: boolean;
}

export interface UseChatOptions {
  /** Called when a conversation is created or its metadata (title/updatedAt) changes. */
  onConversation: (c: ConversationSummary) => void;
  /** Called when a send fails before anything was saved, so the composer can restore the text. */
  onRestoreDraft: (text: string) => void;
  /** Called when memory was updated in background. */
  onMemoryUpdated?: () => void;
}

const tmpId = () => `tmp-${crypto.randomUUID()}`;

/** All chat state for the active conversation, including streaming. */
export function useChat({ onConversation, onRestoreDraft, onMemoryUpdated }: UseChatOptions) {
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [status, setStatus] = useState<{ status: AiStatus; detail?: string } | null>(null);
  const [error, setError] = useState<ChatError | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const runRef = useRef(0);
  const convRef = useRef<string | null>(null);
  const cbs = useRef({ onConversation, onRestoreDraft, onMemoryUpdated });
  cbs.current = { onConversation, onRestoreDraft, onMemoryUpdated };

  const setConv = (id: string | null) => {
    convRef.current = id;
    setConversationId(id);
  };

  const stop = useCallback(() => abortRef.current?.abort(), []);

  const run = useCallback(
    async (
      req: {
        action: 'send' | 'regenerate' | 'edit' | 'continue';
        content?: string;
        messageId?: string;
        attachmentIds?: string[];
      },
      optimistic: (prev: ChatMessage[]) => ChatMessage[],
      draftOnEarlyFailure?: string,
    ) => {
      abortRef.current?.abort();
      const ctl = new AbortController();
      abortRef.current = ctl;
      const runId = ++runRef.current;
      const active = () => runRef.current === runId;

      setError(null);
      setGenerating(true);
      setStatus({ status: 'thinking' });
      setMessages(optimistic);

      let assistantId: string | null = null;
      let saved = false; // true once the server confirmed the request (meta received)
      let buffer = '';
      let raf = 0;
      const flush = () => {
        raf = 0;
        if (!buffer || !assistantId || !active()) return;
        const chunk = buffer;
        const id = assistantId;
        buffer = '';
        setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, content: m.content + chunk } : m)));
      };
      const flushNow = () => {
        if (raf) cancelAnimationFrame(raf);
        flush();
      };

      try {
        for await (const ev of streamChat({ ...req, conversationId: convRef.current ?? undefined }, ctl.signal)) {
          if (!active()) return;
          switch (ev.type) {
            case 'meta': {
              saved = true;
              assistantId = ev.assistantMessageId;
              setConv(ev.conversation.id);
              setTitle(ev.conversation.title);
              cbs.current.onConversation(ev.conversation);
              if (window.location.pathname !== `/c/${ev.conversation.id}`) {
                window.history.replaceState(null, '', `/c/${ev.conversation.id}`);
              }
              const aid = assistantId;
              setMessages((prev) => {
                let next = prev;
                if (ev.userMessage) {
                  const um = ev.userMessage;
                  const idx = next.findIndex((m) => m.role === 'user' && (m.id.startsWith('tmp-') || m.id === um.id));
                  next = idx >= 0 ? next.map((m, i) => (i === idx ? um : m)) : [...next, um];
                }
                if (!next.some((m) => m.id === aid)) {
                  next = [
                    ...next,
                    {
                      id: aid,
                      conversationId: ev.conversation.id,
                      role: 'assistant',
                      content: '',
                      status: 'complete',
                      sources: [],
                      createdAt: Date.now(),
                    },
                  ];
                }
                return next;
              });
              break;
            }
            case 'status':
              setStatus({ status: ev.status, detail: ev.detail });
              break;
            case 'delta':
              buffer += ev.text;
              if (!raf) raf = requestAnimationFrame(flush);
              break;
            case 'sources': {
              const id = assistantId;
              setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, sources: ev.sources } : m)));
              break;
            }
            case 'title':
              setTitle(ev.title);
              if (convRef.current) {
                cbs.current.onConversation({
                  id: convRef.current,
                  title: ev.title,
                  createdAt: 0,
                  updatedAt: Date.now(),
                });
              }
              break;
            case 'memory_updated':
              cbs.current.onMemoryUpdated?.();
              break;
            case 'done': {
              flushNow();
              const m = ev.message;
              setMessages((prev) => prev.map((x) => (x.id === m.id ? m : x)));
              break;
            }
            case 'error':
              flushNow();
              setError({ message: ev.message, canRetry: ev.retryable });
              break;
          }
        }
      } catch (e) {
        if (!active()) return;
        flushNow();
        const msg = e instanceof ApiError ? e.message : 'Something went wrong. Please try again.';
        if (!saved) {
          // Rejected before anything was stored: undo optimistic UI
          setMessages((prev) => prev.filter((m) => !m.id.startsWith('tmp-')));
          if (draftOnEarlyFailure) cbs.current.onRestoreDraft(draftOnEarlyFailure);
          if (convRef.current === null) setTitle('');
        }
        setError({ message: msg, canRetry: saved });
      } finally {
        if (raf) cancelAnimationFrame(raf);
        if (active()) {
          flush();
          const id = assistantId;
          const stoppedByUser = ctl.signal.aborted;
          setMessages((prev) => {
            const next = prev.filter((m) => !(m.id === id && m.role === 'assistant' && !m.content));
            return stoppedByUser
              ? next.map((m) => (m.id === id && m.status === 'complete' ? { ...m, status: 'stopped' as const } : m))
              : next;
          });
          setGenerating(false);
          setStatus(null);
          abortRef.current = null;
        }
      }
    },
    [],
  );

  const send = useCallback(
    (text: string, attachments?: Attachment[]) => {
      const content = text.trim();
      const hasAtts = attachments && attachments.length > 0;
      if (!content && !hasAtts) return;

      const um: ChatMessage = {
        id: tmpId(),
        conversationId: convRef.current ?? '',
        role: 'user',
        content,
        attachments: attachments ?? [],
        status: 'complete',
        sources: [],
        createdAt: Date.now(),
      };
      return run(
        {
          action: 'send',
          content,
          attachmentIds: attachments?.map((a) => a.id),
        },
        (prev) => [...prev, um],
        content,
      );
    },
    [run],
  );

  const regenerate = useCallback(() => {
    return run({ action: 'regenerate' }, (prev) => {
      const last = prev[prev.length - 1];
      return last?.role === 'assistant' ? prev.slice(0, -1) : prev;
    });
  }, [run]);

  const edit = useCallback(
    (messageId: string, text: string) => {
      const content = text.trim();
      if (!content) return;
      return run({ action: 'edit', messageId, content }, (prev) => {
        const idx = prev.findIndex((m) => m.id === messageId);
        return idx < 0 ? prev : [...prev.slice(0, idx), { ...prev[idx], content }];
      });
    },
    [run],
  );

  const continueGeneration = useCallback(() => {
    return run({ action: 'continue' }, (prev) =>
      prev.map((m, i) => (i === prev.length - 1 ? { ...m, status: 'complete' as const } : m)),
    );
  }, [run]);

  const openConversation = useCallback(async (id: string | null) => {
    abortRef.current?.abort();
    runRef.current++;
    setGenerating(false);
    setStatus(null);
    setError(null);
    setConv(id);
    if (!id) {
      setMessages([]);
      setTitle('');
      setLoading(false);
      return true;
    }
    setMessages([]);
    setLoading(true);
    const my = runRef.current;
    try {
      const c = await api.getConversation(id);
      if (runRef.current !== my) return true;
      setMessages(c.messages);
      setTitle(c.title);
      return true;
    } catch (e) {
      if (runRef.current !== my) return true;
      if (e instanceof ApiError && e.status === 404) {
        setConv(null);
        return false;
      }
      setError({ message: e instanceof ApiError ? e.message : 'Could not load this conversation.', canRetry: false });
      return true;
    } finally {
      if (runRef.current === my) setLoading(false);
    }
  }, []);

  const rename = useCallback((t: string) => setTitle(t), []);
  useEffect(() => () => abortRef.current?.abort(), []);

  return {
    conversationId,
    title,
    messages,
    loading,
    generating,
    status,
    error,
    dismissError: () => setError(null),
    send,
    regenerate,
    edit,
    continueGeneration,
    stop,
    openConversation,
    rename,
  };
}
