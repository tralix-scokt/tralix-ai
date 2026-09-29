import { useEffect, useState } from 'react';
import { Check, Clock, X } from 'lucide-react';
import type { Capabilities, Capability, UserProfile } from '../../../shared/types';
import { api } from '../lib/api';

interface Props {
  user: UserProfile;
  caps: Capabilities | null;
  onClose: () => void;
  onSaved: (u: UserProfile) => void;
  onDeleteAll: () => void;
}

const ROWS: [keyof Capabilities, string, string][] = [
  ['text', 'Text chat', 'Conversations, writing, coding help, learning'],
  ['webSearch', 'Live web search', 'Fresh news, sports, products and current events with sources'],
  ['weather', 'Weather', 'Real current conditions and forecasts'],
  ['memory', 'Memory across chats', 'Optional, with controls you manage'],
  ['imageGeneration', 'Image generation', 'Create images from text prompts'],
  ['imageUnderstanding', 'Image understanding', 'Analyse photos and documents'],
  ['voice', 'Voice', 'Talk with TRALIX AI'],
  ['video', 'Video understanding', 'Analyse video'],
];

function Badge({ cap }: { cap?: Capability }) {
  if (!cap) return null;
  if (cap.state === 'active')
    return (
      <span className="badge on">
        <Check size={12} /> Active
      </span>
    );
  if (cap.state === 'coming_soon')
    return (
      <span className="badge soon">
        <Clock size={12} /> Coming soon
      </span>
    );
  return <span className="badge off">Unavailable</span>;
}

export function SettingsModal({ user, caps, onClose, onSaved, onDeleteAll }: Props) {
  const [name, setName] = useState(user.displayName);
  const [instructions, setInstructions] = useState(user.customInstructions);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const dirty = name.trim() !== user.displayName || instructions !== user.customInstructions;

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      onSaved(await api.updateMe({ displayName: name.trim(), customInstructions: instructions }));
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal settings" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header className="modal-head">
          <h2 id="settings-title">Settings</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close settings">
            <X size={20} />
          </button>
        </header>
        <div className="modal-body">
          <section>
            <h3>Profile</h3>
            <label className="field">
              <span>Your name</span>
              <input value={name} maxLength={60} placeholder="What should TRALIX call you?" onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="field">
              <span>
                Custom instructions <em>{instructions.length}/2000</em>
              </span>
              <textarea
                rows={4}
                maxLength={2000}
                value={instructions}
                placeholder="e.g. Keep answers short. I'm a beginner programmer, so explain things step by step."
                onChange={(e) => setInstructions(e.target.value)}
              />
            </label>
            <p className="hint">Your name and instructions are sent with your messages so TRALIX AI can adapt to you. They apply to all your chats on this device.</p>
          </section>

          <section>
            <h3>Capabilities</h3>
            <ul className="cap-list">
              {ROWS.map(([key, label, desc]) => (
                <li key={key}>
                  <div>
                    <strong>{label}</strong>
                    <span>{caps?.[key]?.state === 'unavailable' && caps[key].detail ? caps[key].detail : desc}</span>
                  </div>
                  <Badge cap={caps?.[key]} />
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h3>Data</h3>
            <p className="hint">Conversations are stored on the TRALIX AI server and tied to this browser. Clearing your browser data will disconnect you from them.</p>
            <button type="button" className="btn danger-outline" onClick={onDeleteAll}>
              Delete all conversations
            </button>
          </section>

          <p className="about">TRALIX AI · V1 · Text-first assistant</p>
        </div>
        <footer className="modal-foot">
          {error && <span className="form-error">{error}</span>}
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn primary" disabled={!dirty || saving} onClick={save}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </footer>
      </div>
    </div>
  );
}
