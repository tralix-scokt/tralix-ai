import { lazy, memo, Suspense, useEffect, useRef, useState } from 'react';
import { Check, Copy, ExternalLink, Globe, Pencil, RefreshCw, StepForward } from 'lucide-react';
import type { AiStatus, ChatMessage, Source } from '../../../shared/types';
import { copyText } from '../lib/clipboard';
import { Logo } from './Logo';
// Markdown + syntax highlighting is the heaviest dependency: load it on demand so the first paint is fast.
const Markdown = lazy(() => import('./Markdown').then((m) => ({ default: m.Markdown })));

const domain = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

function StatusPill({ status, detail }: { status: AiStatus; detail?: string }) {
  const label =
    status === 'searching' ? (detail ? `Searching the web for “${detail}”…` : 'Searching…') : status === 'writing' ? 'Writing…' : 'Thinking…';
  return (
    <div className={`status-pill status-${status}`} role="status" aria-live="polite">
      <span className="status-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span className="status-label">{label}</span>
    </div>
  );
}

function Sources({ sources }: { sources: Source[] }) {
  const [open, setOpen] = useState(false);
  if (!sources.length) return null;
  return (
    <div className="sources">
      <button type="button" className="sources-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <Globe size={14} />
        <span>
          {sources.length} source{sources.length === 1 ? '' : 's'}
        </span>
      </button>
      <div className={`sources-list ${open ? 'open' : ''}`}>
        {(open ? sources : sources.slice(0, 3)).map((s, i) => (
          <a key={s.url} className="source-chip" href={s.url} target="_blank" rel="noopener noreferrer nofollow" title={s.title}>
            <span className="source-index">{i + 1}</span>
            <span className="source-text">
              <span className="source-title">{s.title}</span>
              <span className="source-domain">{domain(s.url)}</span>
            </span>
            <ExternalLink size={12} className="source-ext" />
          </a>
        ))}
        {!open && sources.length > 3 && (
          <button type="button" className="source-more" onClick={() => setOpen(true)}>
            +{sources.length - 3} more
          </button>
        )}
      </div>
    </div>
  );
}

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="icon-btn sm"
      title={label}
      aria-label={label}
      onClick={async () => {
        if (await copyText(text)) {
          setDone(true);
          setTimeout(() => setDone(false), 1600);
        }
      }}
    >
      {done ? <Check size={16} /> : <Copy size={16} />}
    </button>
  );
}

interface Props {
  message: ChatMessage;
  isLast: boolean;
  generating: boolean;
  streaming: boolean;
  status: { status: AiStatus; detail?: string } | null;
  onRegenerate: () => void;
  onContinue: () => void;
  onEdit: (id: string, text: string) => void;
}

export const MessageView = memo(function MessageView(p: Props) {
  const { message: m } = p;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(m.content);
  const ta = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing && ta.current) {
      ta.current.focus();
      ta.current.style.height = 'auto';
      ta.current.style.height = `${ta.current.scrollHeight}px`;
    }
  }, [editing, draft]);

  if (m.role === 'user') {
    const canEdit = !p.generating && !m.id.startsWith('tmp-');
    return (
      <div className="msg msg-user">
        {editing ? (
          <div className="edit-box">
            <textarea
              ref={ta}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setEditing(false);
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && draft.trim()) {
                  setEditing(false);
                  p.onEdit(m.id, draft);
                }
              }}
              rows={1}
              aria-label="Edit your message"
            />
            <div className="edit-actions">
              <button type="button" className="btn ghost" onClick={() => setEditing(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={!draft.trim()}
                onClick={() => {
                  setEditing(false);
                  p.onEdit(m.id, draft);
                }}
              >
                Save &amp; send
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="bubble">{m.content}</div>
            <div className="msg-actions user-actions">
              <CopyButton text={m.content} label="Copy message" />
              {canEdit && (
                <button
                  type="button"
                  className="icon-btn sm"
                  title="Edit message"
                  aria-label="Edit message"
                  onClick={() => {
                    setDraft(m.content);
                    setEditing(true);
                  }}
                >
                  <Pencil size={16} />
                </button>
              )}
            </div>
          </>
        )}
      </div>
    );
  }

  const busy = p.streaming;
  const showActions = !busy && m.content;
  return (
    <div className="msg msg-ai">
      <div className="avatar" aria-hidden="true">
        <Logo size={28} />
      </div>
      <div className="msg-body">
        {busy && p.status && <StatusPill status={p.status.status} detail={p.status.detail} />}
        {m.content && (
          <div className={busy && p.status?.status === 'writing' ? 'is-writing' : undefined}>
            <Suspense fallback={<div className="md md-plain">{m.content}</div>}>
              <Markdown content={m.content} />
            </Suspense>
          </div>
        )}
        <Sources sources={m.sources} />
        {!busy && (m.status === 'stopped' || m.status === 'error') && m.content && (
          <div className="msg-note">{m.status === 'stopped' ? 'Response stopped.' : 'This response was interrupted.'}</div>
        )}
        {showActions && (
          <div className="msg-actions">
            <CopyButton text={m.content} label="Copy response" />
            {p.isLast && !p.generating && (
              <>
                <button type="button" className="icon-btn sm" title="Regenerate response" aria-label="Regenerate response" onClick={p.onRegenerate}>
                  <RefreshCw size={16} />
                </button>
                {(m.status === 'stopped' || m.status === 'error') && (
                  <button type="button" className="chip-btn" onClick={p.onContinue}>
                    <StepForward size={14} /> Continue
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
});
