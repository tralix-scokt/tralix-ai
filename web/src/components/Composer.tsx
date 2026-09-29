import { useEffect, useRef } from 'react';
import { ArrowUp, Square } from 'lucide-react';

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onStop: () => void;
  generating: boolean;
  disabled?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
}

const isTouch = () => window.matchMedia('(pointer: coarse)').matches;

export function Composer({ value, onChange, onSend, onStop, generating, disabled, placeholder, autoFocus }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);

  useEffect(() => {
    if (autoFocus && !isTouch()) ref.current?.focus();
  }, [autoFocus]);

  const canSend = !!value.trim() && !generating && !disabled;

  return (
    <div className="composer-wrap">
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSend) onSend();
        }}
      >
        <textarea
          ref={ref}
          value={value}
          rows={1}
          enterKeyHint="send"
          placeholder={placeholder ?? 'Message TRALIX AI'}
          aria-label="Message TRALIX AI"
          maxLength={12000}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            // Desktop: Enter sends, Shift+Enter = newline. Touch keyboards: Enter = newline.
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !isTouch()) {
              e.preventDefault();
              if (canSend) onSend();
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
      <p className="disclaimer">TRALIX AI can make mistakes. Check important information.</p>
    </div>
  );
}
