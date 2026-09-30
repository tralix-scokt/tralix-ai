import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Paperclip, Square, Video, X } from 'lucide-react';
import type { Attachment } from '../../../shared/types';
import { api } from '../lib/api';

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSend: (attachments: Attachment[]) => void;
  onStop: () => void;
  generating: boolean;
  disabled?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  visionEnabled?: boolean;
}

const isTouch = () => typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;

export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  generating,
  disabled,
  placeholder,
  autoFocus,
  visionEnabled = false,
}: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);

  useEffect(() => {
    if (autoFocus && !isTouch()) ref.current?.focus();
  }, [autoFocus]);

  const canSend = (!!value.trim() || attachments.length > 0) && !generating && !disabled && !uploading;

  const handleSend = () => {
    if (!canSend) return;
    const attsToSend = [...attachments];
    setAttachments([]);
    setUploadError(null);
    onSend(attsToSend);
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || !files.length) return;

    if (attachments.length + files.length > 5) {
      setUploadError('Maximum 5 files per message.');
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    setUploading(true);
    setUploadError(null);

    try {
      const fileList = Array.from(files);
      const uploaded = await api.uploadFiles(fileList);
      setAttachments((prev) => [...prev, ...uploaded]);
    } catch (err) {
      setUploadError((err as Error).message || 'Failed to upload files.');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  return (
    <div className="composer-wrap">
      {attachments.length > 0 && (
        <div className="composer-attachments" role="region" aria-label="Attached files">
          {attachments.map((att) => (
            <div key={att.id} className="attachment-chip">
              {att.mimeType.startsWith('image/') ? (
                <img src={att.url} alt={att.filename} className="attachment-thumb" />
              ) : (
                <div className="attachment-icon">
                  <Video size={16} />
                </div>
              )}
              <span className="attachment-name" title={att.filename}>
                {att.filename}
              </span>
              <button
                type="button"
                className="attachment-remove"
                onClick={() => removeAttachment(att.id)}
                aria-label={`Remove ${att.filename}`}
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      {uploading && (
        <div className="upload-progress-bar" role="status">
          <div className="upload-spinner" />
          <span>Uploading media…</span>
        </div>
      )}

      {uploadError && (
        <div className="upload-error" role="alert">
          <span>{uploadError}</span>
          <button type="button" className="icon-btn sm" onClick={() => setUploadError(null)}>
            <X size={14} />
          </button>
        </div>
      )}

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          handleSend();
        }}
      >
        <input
          type="file"
          ref={fileInputRef}
          accept="image/*,video/*"
          multiple
          onChange={handleFileChange}
          style={{ display: 'none' }}
          aria-hidden="true"
        />

        <button
          type="button"
          className={`attach-btn ${!visionEnabled ? 'unavailable' : ''}`}
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled || !visionEnabled || uploading}
          title={
            visionEnabled
              ? 'Attach photo or video (Camera roll & camera)'
              : 'Photo & video understanding not configured on server'
          }
          aria-label={
            visionEnabled
              ? 'Attach photo or video'
              : 'Photo & video understanding not configured on server'
          }
        >
          <Paperclip size={20} />
        </button>

        <textarea
          ref={ref}
          value={value}
          rows={1}
          enterKeyHint="send"
          placeholder={placeholder ?? (visionEnabled ? 'Message or ask about a photo/video…' : 'Message TRALIX AI…')}
          aria-label="Message TRALIX AI"
          maxLength={12000}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !isTouch()) {
              e.preventDefault();
              handleSend();
            }
          }}
        />
        {generating ? (
          <button type="button" className="send-btn stop" onClick={onStop} aria-label="Stop generating" title="Stop generating">
            <Square size={16} fill="currentColor" />
          </button>
        ) : (
          <button type="submit" className="send-btn" disabled={!canSend} aria-label="Send message" title="Send message">
            <ArrowUp size={20} strokeWidth={2.4} />
          </button>
        )}
      </form>
      <p className="disclaimer">TRALIX AI V2 · Photos, videos &amp; memory. Check important information.</p>
    </div>
  );
}
