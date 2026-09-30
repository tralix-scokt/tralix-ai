import { lazy, memo, Suspense, useEffect, useRef, useState } from 'react';
import {
  Check,
  Copy,
  Download,
  ExternalLink,
  Globe,
  Pencil,
  RefreshCw,
  Sparkles,
  StepForward,
  Video,
} from 'lucide-react';
import type { AiStatus, Attachment, ChatMessage, Source } from '../../../shared/types';
import { copyText } from '../lib/clipboard';
import { Logo } from './Logo';

// Markdown + syntax highlighting is loaded on demand
const Markdown = lazy(() => import('./Markdown').then((m) => ({ default: m.Markdown })));

const domain = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

function StatusPill({ status, detail }: { status: AiStatus; detail?: string }) {
  let label = 'Thinking…';
  if (status === 'generating_image') {
    label = detail || 'Generating image…';
  } else if (status === 'searching') {
    label = detail ? `Searching the web for “${detail}”…` : 'Searching…';
  } else if (status === 'writing') {
    label = 'Writing…';
  }

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

function MessageAttachments({ attachments }: { attachments?: Attachment[] }) {
  if (!attachments || !attachments.length) return null;
  return (
    <div className="msg-attachments">
      {attachments.map((att) => {
        const isImg = att.mimeType.startsWith('image/');
        const isVid = att.mimeType.startsWith('video/');
        return (
          <div key={att.id} className="msg-attachment-item">
            {isImg && (
              <a href={att.url} target="_blank" rel="noopener noreferrer" className="msg-attachment-link">
                <img src={att.url} alt={att.filename} className="msg-attachment-image" />
              </a>
            )}
            {isVid && (
              <div className="msg-attachment-video">
                <div className="video-icon-wrap">
                  <Video size={18} />
                </div>
                <div className="video-meta">
                  <span className="video-title">{att.filename}</span>
                  <span className="video-note">Analysed from sampled frames</span>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function GeneratedImageCard({
  imageUrl,
  prompt,
  onRegenerate,
}: {
  imageUrl: string;
  prompt: string;
  onRegenerate: () => void;
}) {
  const downloadUrl = `${imageUrl}?download=1`;
  return (
    <div className="generated-image-card">
      <div className="image-wrap">
        <img src={imageUrl} alt={prompt || 'Generated image'} className="generated-image-preview" />
      </div>
      <div className="image-card-actions">
        <a href={downloadUrl} download className="btn sm secondary" title="Download image to device">
          <Download size={14} /> Download
        </a>
        <button type="button" className="btn sm ghost" onClick={onRegenerate} title="Regenerate image">
          <RefreshCw size={14} /> Regenerate
        </button>
      </div>
    </div>
  );
}

function Sources({ sources }: { sources: Source[] }) {
  const [open, setOpen] = useState(false);
  const webSources = sources.filter((s) => !s.url.startsWith('/api/images/'));
  if (!webSources.length) return null;
  return (
    <div className="sources">
      <button type="button" className="sources-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <Globe size={14} />
        <span>
          {webSources.length} source{webSources.length === 1 ? '' : 's'}
        </span>
      </button>
      <div className={`sources-list ${open ? 'open' : ''}`}>
        {(open ? webSources : webSources.slice(0, 3)).map((s, i) => (
          <a key={s.url} className="source-chip" href={s.url} target="_blank" rel="noopener noreferrer nofollow" title={s.title}>
            <span className="source-index">{i + 1}</span>
            <span className="source-text">
              <span className="source-title">{s.title}</span>
              <span className="source-domain">{domain(s.url)}</span>
            </span>
            <ExternalLink size={12} className="source-ext" />
          </a>
        ))}
        {!open && webSources.length > 3 && (
          <button type="button" className="source-more" onClick={() => setOpen(true)}>
            +{webSources.length - 3} more
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

  // Extract generated image URLs if present in message content
  const generatedImageMatch = /!\[(.*?)\]\((\/api\/images\/[0-9a-f-]+)\)/i.exec(m.content);

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
            <MessageAttachments attachments={m.attachments} />
            {m.content && <div className="bubble">{m.content}</div>}
            <div className="msg-actions user-actions">
              {m.content && <CopyButton text={m.content} label="Copy message" />}
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

        {generatedImageMatch && !busy && (
          <GeneratedImageCard
            imageUrl={generatedImageMatch[2]}
            prompt={generatedImageMatch[1]}
            onRegenerate={p.onRegenerate}
          />
        )}

        <Sources sources={m.sources} />
        {!busy && (m.status === 'stopped' || m.status === 'error') && m.content && (
          <div className="msg-note">
            {m.status === 'stopped' ? 'Response stopped.' : 'This response was interrupted.'}
          </div>
        )}
        {showActions && (
          <div className="msg-actions">
            <CopyButton text={m.content} label="Copy response" />
            {p.isLast && !p.generating && (
              <>
                <button
                  type="button"
                  className="icon-btn sm"
                  title="Regenerate response"
                  aria-label="Regenerate response"
                  onClick={p.onRegenerate}
                >
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
