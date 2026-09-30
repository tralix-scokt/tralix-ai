import { useEffect, useState } from 'react';
import {
  Brain,
  Check,
  Clock,
  Download,
  KeyRound,
  LogOut,
  Pencil,
  ShieldAlert,
  Trash2,
  User,
  X,
  Zap,
} from 'lucide-react';
import type { Capabilities, Capability, MemoryItem, UserProfile } from '../../../shared/types';
import { api } from '../lib/api';

interface Props {
  user: UserProfile;
  caps: Capabilities | null;
  onClose: () => void;
  onSaved: (u: UserProfile) => void;
  onDeleteAll: () => void;
  onLogout: () => void;
  initialTab?: 'profile' | 'account' | 'memory' | 'capabilities';
}

const ROWS: [keyof Capabilities, string, string][] = [
  ['text', 'Text chat', 'Conversations, writing, reasoning, and coding assistance'],
  ['imageUnderstanding', 'Image understanding', 'Analyse photos and documents (NVIDIA Vision)'],
  ['video', 'Video understanding', 'Analyse video content via server-sampled frames'],
  ['imageGeneration', 'Image generation', 'Generate images via prompt (FLUX.1-schnell)'],
  ['memory', 'Memory across chats', 'Persistent personal facts and preferences'],
  ['webSearch', 'Live web search', 'Fresh news and current events with verified sources'],
  ['weather', 'Weather', 'Real current conditions and forecasts via Open-Meteo'],
  ['voice', 'Voice interaction', 'Audio conversation with TRALIX AI'],
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

export function SettingsModal({
  user,
  caps,
  onClose,
  onSaved,
  onDeleteAll,
  onLogout,
  initialTab = 'profile',
}: Props) {
  const [activeTab, setActiveTab] = useState<'profile' | 'account' | 'memory' | 'capabilities'>(initialTab);

  // Profile state
  const [name, setName] = useState(user.displayName);
  const [instructions, setInstructions] = useState(user.customInstructions);
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileMsg, setProfileMsg] = useState('');

  // Memory state
  const [memoryEnabled, setMemoryEnabled] = useState(user.memoryEnabled);
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [loadingMemories, setLoadingMemories] = useState(false);
  const [editingMemoryId, setEditingMemoryId] = useState<string | null>(null);
  const [memoryDraft, setMemoryDraft] = useState('');
  const [newMemoryText, setNewMemoryText] = useState('');

  // Account state
  const [authMode, setAuthMode] = useState<'login' | 'signup'>('signup');
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authName, setAuthName] = useState('');
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState('');

  // Password change state
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [pwLoading, setPwLoading] = useState(false);
  const [pwMsg, setPwMsg] = useState('');

  const [error, setError] = useState('');

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);

  // Load memories when memory tab is opened
  useEffect(() => {
    if (activeTab === 'memory') {
      setLoadingMemories(true);
      api
        .listMemories()
        .then((res) => {
          setMemories(res.memories);
          setMemoryEnabled(res.enabled);
        })
        .catch(() => undefined)
        .finally(() => setLoadingMemories(false));
    }
  }, [activeTab]);

  const saveProfile = async () => {
    setSavingProfile(true);
    setError('');
    setProfileMsg('');
    try {
      const updated = await api.updateMe({ displayName: name.trim(), customInstructions: instructions });
      onSaved(updated);
      setProfileMsg('Profile saved successfully.');
      setTimeout(() => setProfileMsg(''), 3000);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSavingProfile(false);
    }
  };

  const toggleMemory = async () => {
    const next = !memoryEnabled;
    setMemoryEnabled(next);
    try {
      const updated = await api.updateMe({ memoryEnabled: next });
      onSaved(updated);
    } catch (e) {
      setMemoryEnabled(!next);
      setError((e as Error).message);
    }
  };

  const saveEditedMemory = async (id: string) => {
    if (!memoryDraft.trim()) return;
    try {
      const updated = await api.updateMemory(id, memoryDraft.trim());
      setMemories((prev) => prev.map((m) => (m.id === id ? updated : m)));
      setEditingMemoryId(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const deleteMemory = async (id: string) => {
    try {
      await api.deleteMemory(id);
      setMemories((prev) => prev.filter((m) => m.id !== id));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const clearAllMemories = async () => {
    if (!confirm('Clear all saved memories across chats?')) return;
    try {
      await api.clearAllMemories();
      setMemories([]);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const addManualMemory = async () => {
    if (!newMemoryText.trim()) return;
    try {
      const added = await api.addMemory(newMemoryText.trim());
      setMemories((prev) => [added, ...prev]);
      setNewMemoryText('');
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthLoading(true);
    setAuthError('');
    try {
      let res;
      if (authMode === 'signup') {
        res = await api.signup({
          email: authEmail.trim(),
          password: authPassword,
          displayName: authName.trim() || undefined,
        });
      } else {
        res = await api.login({
          email: authEmail.trim(),
          password: authPassword,
        });
      }
      onSaved(res.user);
      setName(res.user.displayName);
      setAuthPassword('');
      setAuthEmail('');
      setProfileMsg(`Signed in as ${res.user.email}`);
    } catch (err) {
      setAuthError((err as Error).message);
    } finally {
      setAuthLoading(false);
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPwLoading(true);
    setPwMsg('');
    try {
      const res = await api.changePassword({ currentPassword: currentPw, newPassword: newPw });
      setPwMsg(res.message);
      setCurrentPw('');
      setNewPw('');
    } catch (err) {
      setPwMsg((err as Error).message);
    } finally {
      setPwLoading(false);
    }
  };

  const handleDeleteAccount = async () => {
    if (!confirm('Are you absolutely sure you want to permanently delete your account and all data? This cannot be undone.')) {
      return;
    }
    try {
      await api.deleteAccount();
      onLogout();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const isAnonymous = !user.email;

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal settings" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header className="modal-head">
          <h2 id="settings-title">Settings</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close settings">
            <X size={20} />
          </button>
        </header>

        {/* Tab Navigation */}
        <nav className="settings-tabs" role="tablist">
          <button
            type="button"
            className={`settings-tab ${activeTab === 'profile' ? 'active' : ''}`}
            onClick={() => setActiveTab('profile')}
            role="tab"
            aria-selected={activeTab === 'profile'}
          >
            <User size={16} /> Profile
          </button>
          <button
            type="button"
            className={`settings-tab ${activeTab === 'account' ? 'active' : ''}`}
            onClick={() => setActiveTab('account')}
            role="tab"
            aria-selected={activeTab === 'account'}
          >
            <KeyRound size={16} /> Account
          </button>
          <button
            type="button"
            className={`settings-tab ${activeTab === 'memory' ? 'active' : ''}`}
            onClick={() => setActiveTab('memory')}
            role="tab"
            aria-selected={activeTab === 'memory'}
          >
            <Brain size={16} /> Memory
          </button>
          <button
            type="button"
            className={`settings-tab ${activeTab === 'capabilities' ? 'active' : ''}`}
            onClick={() => setActiveTab('capabilities')}
            role="tab"
            aria-selected={activeTab === 'capabilities'}
          >
            <Zap size={16} /> Capabilities
          </button>
        </nav>

        <div className="modal-body">
          {error && <div className="notice error">{error}</div>}

          {/* PROFILE TAB */}
          {activeTab === 'profile' && (
            <section>
              <label className="field">
                <span>Your name</span>
                <input
                  value={name}
                  maxLength={60}
                  placeholder="What should TRALIX call you?"
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <label className="field">
                <span>
                  Custom instructions <em>{instructions.length}/2000</em>
                </span>
                <textarea
                  rows={4}
                  maxLength={2000}
                  value={instructions}
                  placeholder="e.g. Keep answers concise. I develop from Safari on iPhone."
                  onChange={(e) => setInstructions(e.target.value)}
                />
              </label>
              <p className="hint">
                Your name and instructions adapt TRALIX AI's style across all chats on this account.
              </p>
              {profileMsg && <div className="form-success">{profileMsg}</div>}
              <button
                type="button"
                className="btn primary"
                disabled={savingProfile}
                onClick={saveProfile}
                style={{ marginTop: '0.75rem' }}
              >
                {savingProfile ? 'Saving…' : 'Save profile'}
              </button>
            </section>
          )}

          {/* ACCOUNT TAB */}
          {activeTab === 'account' && (
            <div className="account-section">
              {isAnonymous ? (
                <section className="auth-box">
                  <h3>Save your chats with an account</h3>
                  <p className="hint">
                    You are currently using an anonymous session. Create an account to access your chats and
                    memories on any device.
                  </p>
                  <div className="auth-toggle">
                    <button
                      type="button"
                      className={`btn sm ${authMode === 'signup' ? 'primary' : 'ghost'}`}
                      onClick={() => setAuthMode('signup')}
                    >
                      Sign up
                    </button>
                    <button
                      type="button"
                      className={`btn sm ${authMode === 'login' ? 'primary' : 'ghost'}`}
                      onClick={() => setAuthMode('login')}
                    >
                      Log in
                    </button>
                  </div>
                  <form onSubmit={handleAuth} className="auth-form">
                    {authMode === 'signup' && (
                      <label className="field">
                        <span>Display Name (optional)</span>
                        <input
                          type="text"
                          value={authName}
                          placeholder="Your name"
                          onChange={(e) => setAuthName(e.target.value)}
                        />
                      </label>
                    )}
                    <label className="field">
                      <span>Email</span>
                      <input
                        type="email"
                        required
                        value={authEmail}
                        placeholder="you@example.com"
                        onChange={(e) => setAuthEmail(e.target.value)}
                      />
                    </label>
                    <label className="field">
                      <span>Password</span>
                      <input
                        type="password"
                        required
                        minLength={8}
                        value={authPassword}
                        placeholder="At least 8 characters"
                        onChange={(e) => setAuthPassword(e.target.value)}
                      />
                    </label>
                    {authError && <div className="form-error">{authError}</div>}
                    <button type="submit" className="btn primary" disabled={authLoading}>
                      {authLoading ? 'Processing…' : authMode === 'signup' ? 'Create Account' : 'Log In'}
                    </button>
                  </form>
                </section>
              ) : (
                <>
                  <section>
                    <h3>Account Info</h3>
                    <p>
                      Logged in as <strong>{user.email}</strong>
                    </p>
                    <button type="button" className="btn secondary sm" onClick={onLogout}>
                      <LogOut size={14} /> Log out
                    </button>
                  </section>

                  <section>
                    <h3>Change Password</h3>
                    <form onSubmit={handleChangePassword} className="auth-form">
                      <label className="field">
                        <span>Current password</span>
                        <input
                          type="password"
                          required
                          value={currentPw}
                          onChange={(e) => setCurrentPw(e.target.value)}
                        />
                      </label>
                      <label className="field">
                        <span>New password</span>
                        <input
                          type="password"
                          required
                          minLength={8}
                          value={newPw}
                          placeholder="At least 8 characters"
                          onChange={(e) => setNewPw(e.target.value)}
                        />
                      </label>
                      {pwMsg && <div className="hint">{pwMsg}</div>}
                      <button type="submit" className="btn primary sm" disabled={pwLoading}>
                        {pwLoading ? 'Updating…' : 'Update password'}
                      </button>
                    </form>
                  </section>
                </>
              )}

              <section>
                <h3>Data Export &amp; Cleanup</h3>
                <p className="hint">
                  Export all your conversations, messages, and memories as a portable JSON file.
                </p>
                <button type="button" className="btn secondary sm" onClick={api.exportData}>
                  <Download size={14} /> Export my data
                </button>
                <div style={{ marginTop: '1rem' }}>
                  <button type="button" className="btn danger-outline sm" onClick={onDeleteAll}>
                    <Trash2 size={14} /> Delete all conversations
                  </button>
                </div>
                {!isAnonymous && (
                  <div style={{ marginTop: '0.75rem' }}>
                    <button type="button" className="btn danger-outline sm" onClick={handleDeleteAccount}>
                      <ShieldAlert size={14} /> Delete account and all data
                    </button>
                  </div>
                )}
              </section>
            </div>
          )}

          {/* MEMORY TAB */}
          {activeTab === 'memory' && (
            <div className="memory-section">
              <div className="toggle-row">
                <div>
                  <strong>Cross-chat memory</strong>
                  <p className="hint">
                    Extracts and remembers durable facts and preferences (name, projects, interests) across chats.
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={memoryEnabled}
                  className={`switch-btn ${memoryEnabled ? 'checked' : ''}`}
                  onClick={toggleMemory}
                >
                  <span className="switch-thumb" />
                </button>
              </div>

              {memoryEnabled && (
                <>
                  <div className="add-memory-box">
                    <input
                      type="text"
                      value={newMemoryText}
                      placeholder="Add a fact (e.g. 'I work with Python and React')"
                      maxLength={1000}
                      onChange={(e) => setNewMemoryText(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && addManualMemory()}
                    />
                    <button type="button" className="btn primary sm" disabled={!newMemoryText.trim()} onClick={addManualMemory}>
                      Add
                    </button>
                  </div>

                  <div className="memory-list-head">
                    <strong>Remembered facts ({memories.length})</strong>
                    {memories.length > 0 && (
                      <button type="button" className="btn ghost sm danger-text" onClick={clearAllMemories}>
                        Clear all
                      </button>
                    )}
                  </div>

                  {loadingMemories ? (
                    <p className="hint">Loading memories…</p>
                  ) : memories.length === 0 ? (
                    <p className="hint empty-memory">
                      No memories stored yet. TRALIX AI will automatically save durable facts as you chat, or you
                      can add them above.
                    </p>
                  ) : (
                    <ul className="memory-items-list">
                      {memories.map((m) => (
                        <li key={m.id} className="memory-item">
                          {editingMemoryId === m.id ? (
                            <div className="edit-memory-row">
                              <input
                                value={memoryDraft}
                                onChange={(e) => setMemoryDraft(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') saveEditedMemory(m.id);
                                  if (e.key === 'Escape') setEditingMemoryId(null);
                                }}
                                autoFocus
                              />
                              <button type="button" className="btn primary sm" onClick={() => saveEditedMemory(m.id)}>
                                Save
                              </button>
                              <button type="button" className="btn ghost sm" onClick={() => setEditingMemoryId(null)}>
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <>
                              <span className="memory-text">{m.content}</span>
                              <div className="memory-actions">
                                <button
                                  type="button"
                                  className="icon-btn sm"
                                  title="Edit memory"
                                  onClick={() => {
                                    setEditingMemoryId(m.id);
                                    setMemoryDraft(m.content);
                                  }}
                                >
                                  <Pencil size={14} />
                                </button>
                                <button
                                  type="button"
                                  className="icon-btn sm"
                                  title="Delete memory"
                                  onClick={() => deleteMemory(m.id)}
                                >
                                  <Trash2 size={14} />
                                </button>
                              </div>
                            </>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </div>
          )}

          {/* CAPABILITIES TAB */}
          {activeTab === 'capabilities' && (
            <section>
              <h3>Capabilities (V2)</h3>
              <ul className="cap-list">
                {ROWS.map(([key, label, desc]) => (
                  <li key={key}>
                    <div>
                      <strong>{label}</strong>
                      <span>
                        {caps?.[key]?.state === 'unavailable' && caps[key].detail
                          ? caps[key].detail
                          : caps?.[key]?.state === 'active' && caps[key].detail
                            ? `${desc} (${caps[key].detail})`
                            : desc}
                      </span>
                    </div>
                    <Badge cap={caps?.[key]} />
                  </li>
                ))}
              </ul>
            </section>
          )}

          <p className="about">TRALIX AI · V2 · Vision, Video &amp; Memory Enabled</p>
        </div>

        <footer className="modal-foot">
          <button type="button" className="btn ghost" onClick={onClose}>
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}
