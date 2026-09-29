import { useEffect, useRef } from 'react';
import { AlertTriangle, Globe } from 'lucide-react';
import type { Capabilities } from '../../../shared/types';

const PROMPTS = [
  'Explain quantum computing simply',
  'Help me build an app',
  'What’s happening in technology today?',
  'Help me write something',
  'Teach me something interesting',
];

interface Props {
  name: string;
  caps: Capabilities | null;
  disabled: boolean;
  onPick: (prompt: string) => void;
  onOpenSettings: () => void;
}

export function Welcome({ name, caps, disabled, onPick, onOpenSettings }: Props) {
  const orb = useRef<HTMLDivElement>(null);

  // The orb's glow gently follows the pointer.
  useEffect(() => {
    const el = orb.current;
    if (!el || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let raf = 0;
    const move = (e: PointerEvent) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const r = el.getBoundingClientRect();
        const dx = (e.clientX - (r.left + r.width / 2)) / window.innerWidth;
        const dy = (e.clientY - (r.top + r.height / 2)) / window.innerHeight;
        el.style.setProperty('--dx', `${(dx * 26).toFixed(1)}px`);
        el.style.setProperty('--dy', `${(dy * 26).toFixed(1)}px`);
      });
    };
    window.addEventListener('pointermove', move, { passive: true });
    return () => {
      window.removeEventListener('pointermove', move);
      cancelAnimationFrame(raf);
    };
  }, []);

  const textDown = caps && caps.text.state !== 'active';
  return (
    <div className="welcome">
      <div className="orb" ref={orb} aria-hidden="true">
        <div className="orb-glow" />
        <div className="orb-ring r1" />
        <div className="orb-ring r2" />
        <div className="orb-core">
          <span>T</span>
        </div>
      </div>
      <h1 className="welcome-title">TRALIX AI</h1>
      <p className="welcome-sub">{name ? `Hi ${name}. ` : ''}How can I help you today?</p>

      {textDown && (
        <div className="notice warn" role="alert">
          <AlertTriangle size={18} />
          <div>
            <strong>TRALIX AI isn’t connected to an AI model yet.</strong>
            <span>The server administrator needs to add an API key and model name. See the README for setup.</span>
          </div>
        </div>
      )}

      <div className="prompt-grid">
        {PROMPTS.map((p, i) => (
          <button key={p} type="button" className="prompt-card" style={{ animationDelay: `${120 + i * 70}ms` }} disabled={disabled} onClick={() => onPick(p)}>
            {p}
          </button>
        ))}
      </div>

      {caps && (
        <button type="button" className="live-indicator" onClick={onOpenSettings} title="View capabilities">
          <Globe size={14} />
          {caps.webSearch.state === 'active' ? (
            <span>
              <i className="dot on" /> Live web knowledge on
            </span>
          ) : (
            <span>
              <i className="dot off" /> Live web search not configured
            </span>
          )}
        </button>
      )}
    </div>
  );
}
