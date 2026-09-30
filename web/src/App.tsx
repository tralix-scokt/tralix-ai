import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowDown,
  Brain,
  Menu,
  PanelLeftOpen,
  RotateCcw,
  SquarePen,
  X,
} from 'lucide-react';
import type { Attachment, Capabilities, ConversationSummary, UserProfile } from '../../shared/types';
import { api } from './lib/api';
import { useChat } from './lib/useChat';
import { Composer } from './components/Composer';
import { ConfirmDialog } from './components/ConfirmDialog';
import { MessageView } from './components/Message';
import { Sidebar } from './components/Sidebar';
import { Welcome } from './components/Welcome';
import { Logo } from './components/Logo';

const SettingsModal = lazy(() => import('./components/SettingsModal').then((m) => ({ default: m.SettingsModal })));

const routeId = () => /^\/c\/([0-9a-f-]{36})$/i.exec(window.location.pathname)?.[1] ?? null;
const sortConvs = (l: ConversationSummary[]) => [...l].sort((a, b) => b.updatedAt - a.updatedAt);

export default function App() {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState('');
  const [drawer, setDrawer] = useState(false);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('tralix.sidebar') === 'collapsed');
  const [settings, setSettings] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'profile' | 'account' | 'memory' | 'capabilities'>('profile');
  const [toDelete, setToDelete] = useState<ConversationSummary | 'all' | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [memoryIndicator, setMemoryIndicator] = useState(false);

  const queryRef = useRef('');
  queryRef.current = query;

  const upsert = useCallback((c: ConversationSummary) => {
    if (queryRef.current) return;
    setConversations((prev) => {
      const cur = prev.find((x) => x.id === c.id);
      if (!cur) return sortConvs([c, ...prev]);
      return sortConvs(
        prev.map((x) => (x.id === c.id ? { ...x, title: c.title, updatedAt: Math.max(x.updatedAt, c.updatedAt) } : x)),
      );
    });
  }, []);

  const handleMemoryUpdated = useCallback(() => {
    setMemoryIndicator(true);
    setTimeout(() => setMemoryIndicator(false), 3000);
  }, []);

  const chat = useChat({
    onConversation: upsert,
    onRestoreDraft: setDraft,
    onMemoryUpdated: handleMemoryUpdated,
  });
  const { openConversation } = chat;

  const flash = useCallback((m: string) => {
    setToast(m);
    setTimeout(() => setToast((t) => (t === m ? null : t)), 4000);
  }, []);

  // ---- boot ----
  useEffect(() => {
    api.capabilities().then(setCaps).catch(() => undefined);
    api
      .me()
      .then(setUser)
      .catch((e) => setBootError((e as Error).message));
    const id = routeId();
    if (id) {
      openConversation(id).then((ok) => {
        if (!ok) window.history.replaceState(null, '', '/');
      });
    }
    const onPop = () => {
      const rid = routeId();
      openConversation(rid).then((ok) => !ok && window.history.replaceState(null, '', '/'));
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [openConversation]);

  // ---- conversation list (with debounced search) ----
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(
      () => {
        setListLoading(true);
        api
          .listConversations(query.trim() || undefined)
          .then((l) => !cancelled && setConversations(l))
          .catch(() => undefined)
          .finally(() => !cancelled && setListLoading(false));
      },
      query ? 250 : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query]);

  useEffect(() => {
    localStorage.setItem('tralix.sidebar', collapsed ? 'collapsed' : 'open');
  }, [collapsed]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && setDrawer(false);
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  // ---- scrolling ----
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stick.current = near;
    setShowJump(!near);
  };
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [chat.messages, chat.status, chat.error]);
  useEffect(() => {
    stick.current = true;
  }, [chat.conversationId]);
  const jump = () => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };

  // ---- actions ----
  const newChat = useCallback(() => {
    if (window.location.pathname !== '/') window.history.pushState(null, '', '/');
    openConversation(null);
    setDrawer(false);
    setDraft('');
  }, [openConversation]);

  const selectConversation = useCallback(
    (id: string) => {
      if (id !== chat.conversationId) {
        window.history.pushState(null, '', `/c/${id}`);
        openConversation(id);
      }
      setDrawer(false);
    },
    [chat.conversationId, openConversation],
  );

  const send = (attachments: Attachment[]) => {
    const text = draft;
    if ((!text.trim() && !attachments.length) || chat.generating) return;
    setDraft('');
    stick.current = true;
    chat.send(text, attachments);
  };

  const rename = async (id: string, title: string) => {
    const prev = conversations;
    setConversations((l) => l.map((c) => (c.id === id ? { ...c, title } : c)));
    if (id === chat.conversationId) chat.rename(title);
    try {
      await api.renameConversation(id, title);
    } catch (e) {
      setConversations(prev);
      flash((e as Error).message);
    }
  };

  const confirmDelete = async () => {
    const target = toDelete;
    setToDelete(null);
    if (!target) return;
    try {
      if (target === 'all') {
        await api.deleteAllConversations();
        setConversations([]);
        setSettings(false);
        newChat();
      } else {
        await api.deleteConversation(target.id);
        setConversations((l) => l.filter((c) => c.id !== target.id));
        if (target.id === chat.conversationId) newChat();
      }
    } catch (e) {
      flash((e as Error).message);
    }
  };

  const handleLogout = async () => {
    await api.logout();
    const me = await api.me();
    setUser(me);
    newChat();
    flash('Logged out successfully.');
  };

  const { messages, generating, status, error } = chat;
  const empty = messages.length === 0 && !chat.loading;
  const last = messages[messages.length - 1];
  const modelDown = !!caps && caps.text.state !== 'active';
  const awaitingReply = !generating && !error && last?.role === 'user' && !last.id.startsWith('tmp-') && !chat.loading;
  const visionActive = caps?.imageUnderstanding?.state === 'active';

  return (
    <div className={`app ${collapsed ? 'sidebar-collapsed' : ''}`}>
      {drawer && <div className="scrim" onClick={() => setDrawer(false)} aria-hidden="true" />}
      <aside className={`sidebar ${drawer ? 'open' : ''}`} aria-label="Sidebar">
        <Sidebar
          conversations={conversations}
          activeId={chat.conversationId}
          loading={listLoading}
          query={query}
          onQuery={setQuery}
          user={user}
          onNew={newChat}
          onSelect={selectConversation}
          onRename={rename}
          onDelete={setToDelete}
          onSettings={() => {
            setSettingsTab('profile');
            setSettings(true);
            setDrawer(false);
          }}
          onClose={() => (window.matchMedia('(max-width: 899px)').matches ? setDrawer(false) : setCollapsed(true))}
        />
      </aside>

      <main className="main">
        <header className="topbar">
          <button type="button" className="icon-btn mobile-only" onClick={() => setDrawer(true)} aria-label="Open chat history">
            <Menu size={22} />
          </button>
          {collapsed && (
            <button
              type="button"
              className="icon-btn desktop-only"
              onClick={() => setCollapsed(false)}
              aria-label="Open sidebar"
              title="Open sidebar"
            >
              <PanelLeftOpen size={20} />
            </button>
          )}
          <div className="topbar-title">
            {chat.title ? (
              <h1 title={chat.title}>{chat.title}</h1>
            ) : (
              <span className="topbar-brand">
                <Logo size={22} /> TRALIX <b>AI</b> <small className="v2-badge">V2</small>
              </span>
            )}
          </div>

          <div className="topbar-actions">
            {memoryIndicator && (
              <div className="memory-indicator-badge" role="status">
                <Brain size={14} /> Memory updated
              </div>
            )}
            <button
              type="button"
              className={`icon-btn ${collapsed ? '' : 'mobile-only'}`}
              onClick={newChat}
              aria-label="New chat"
              title="New chat"
            >
              <SquarePen size={20} />
            </button>
          </div>
        </header>

        <div className="scroller" ref={scroller} onScroll={onScroll}>
          {chat.loading ? (
            <div className="thread" aria-busy="true">
              <div className="skeleton-msg" />
              <div className="skeleton-msg short" />
              <div className="skeleton-msg" />
            </div>
          ) : empty ? (
            <Welcome
              name={user?.displayName.split(' ')[0] ?? ''}
              caps={caps}
              disabled={generating || modelDown}
              onPick={(p) => chat.send(p)}
              onOpenSettings={() => {
                setSettingsTab('capabilities');
                setSettings(true);
              }}
            />
          ) : (
            <div className="thread">
              {messages.map((m, i) => (
                <MessageView
                  key={m.id}
                  message={m}
                  isLast={i === messages.length - 1}
                  generating={generating}
                  streaming={generating && i === messages.length - 1 && m.role === 'assistant'}
                  status={status}
                  onRegenerate={chat.regenerate}
                  onContinue={chat.continueGeneration}
                  onEdit={chat.edit}
                />
              ))}

              {/* Status while waiting for first bytes */}
              {generating && last?.role === 'user' && status && (
                <div className="msg msg-ai">
                  <div className="avatar" aria-hidden="true">
                    <Logo size={28} />
                  </div>
                  <div className="msg-body">
                    <div className={`status-pill status-${status.status}`} role="status" aria-live="polite">
                      <span className="status-dots" aria-hidden="true">
                        <i />
                        <i />
                        <i />
                      </span>
                      <span className="status-label">
                        {status.status === 'generating_image'
                          ? status.detail || 'Generating image…'
                          : status.status === 'searching'
                            ? status.detail
                              ? `Searching the web for “${status.detail}”…`
                              : 'Searching…'
                            : status.status === 'writing'
                              ? 'Writing…'
                              : 'Thinking…'}
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {error && (
                <div className="notice error" role="alert">
                  <AlertCircle size={18} />
                  <div>
                    <strong>{error.message}</strong>
                    <span>{error.canRetry ? 'Your message was saved.' : 'Your message is still in the box — you can send it again.'}</span>
                  </div>
                  <div className="notice-actions">
                    {error.canRetry && (
                      <button type="button" className="btn primary sm" onClick={chat.regenerate}>
                        <RotateCcw size={14} /> Retry
                      </button>
                    )}
                    <button type="button" className="icon-btn sm" onClick={chat.dismissError} aria-label="Dismiss">
                      <X size={16} />
                    </button>
                  </div>
                </div>
              )}

              {awaitingReply && (
                <div className="notice">
                  <AlertCircle size={18} />
                  <div>
                    <strong>No reply was received.</strong>
                    <span>Your message was saved.</span>
                  </div>
                  <div className="notice-actions">
                    <button type="button" className="btn primary sm" onClick={chat.regenerate}>
                      <RotateCcw size={14} /> Retry
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {showJump && !empty && (
          <button type="button" className="jump" onClick={jump} aria-label="Scroll to latest message">
            <ArrowDown size={18} />
          </button>
        )}

        <Composer
          value={draft}
          onChange={setDraft}
          onSend={send}
          onStop={chat.stop}
          generating={generating}
          autoFocus={empty}
          visionEnabled={visionActive}
        />
      </main>

      {settings && user && (
        <Suspense fallback={null}>
          <SettingsModal
            user={user}
            caps={caps}
            initialTab={settingsTab}
            onClose={() => setSettings(false)}
            onSaved={setUser}
            onDeleteAll={() => setToDelete('all')}
            onLogout={handleLogout}
          />
        </Suspense>
      )}

      {toDelete && (
        <ConfirmDialog
          title={toDelete === 'all' ? 'Delete all conversations?' : 'Delete conversation?'}
          body={
            toDelete === 'all'
              ? 'This permanently deletes every conversation on this account. This cannot be undone.'
              : `“${toDelete.title}” will be permanently deleted. This cannot be undone.`
          }
          confirmLabel="Delete"
          danger
          onConfirm={confirmDelete}
          onCancel={() => setToDelete(null)}
        />
      )}

      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
      {bootError && <div className="toast persistent">{bootError}</div>}
    </div>
  );
}
