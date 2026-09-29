import { useEffect, useMemo, useRef, useState } from 'react';
import { MoreHorizontal, PanelLeftClose, Pencil, Search, Settings, SquarePen, Trash2, X } from 'lucide-react';
import type { ConversationSummary, UserProfile } from '../../../shared/types';
import { Logo } from './Logo';

interface Props {
  conversations: ConversationSummary[];
  activeId: string | null;
  loading: boolean;
  query: string;
  onQuery: (q: string) => void;
  user: UserProfile | null;
  onNew: () => void;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (c: ConversationSummary) => void;
  onSettings: () => void;
  onClose: () => void;
}

function group(conversations: ConversationSummary[]) {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const day = 86_400_000;
  const buckets: [string, ConversationSummary[]][] = [
    ['Today', []],
    ['Yesterday', []],
    ['Previous 7 days', []],
    ['Previous 30 days', []],
    ['Older', []],
  ];
  for (const c of conversations) {
    const age = startOfDay.getTime() - c.updatedAt;
    const i = age <= 0 ? 0 : age <= day ? 1 : age <= 7 * day ? 2 : age <= 30 * day ? 3 : 4;
    buckets[i][1].push(c);
  }
  return buckets.filter(([, list]) => list.length);
}

function Item(p: {
  c: ConversationSummary;
  active: boolean;
  onSelect: () => void;
  onRename: (t: string) => void;
  onDelete: () => void;
}) {
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(p.c.title);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const close = (e: PointerEvent) => !wrap.current?.contains(e.target as Node) && setMenu(false);
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [menu]);

  const commit = () => {
    setEditing(false);
    const t = value.trim();
    if (t && t !== p.c.title) p.onRename(t);
  };

  if (editing)
    return (
      <div className="conv-item editing">
        <input
          autoFocus
          value={value}
          maxLength={100}
          aria-label="Conversation title"
          onChange={(e) => setValue(e.target.value)}
          onFocus={(e) => e.target.select()}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') {
              setValue(p.c.title);
              setEditing(false);
            }
          }}
        />
      </div>
    );

  return (
    <div ref={wrap} className={`conv-item ${p.active ? 'active' : ''} ${menu ? 'menu-open' : ''}`}>
      <button type="button" className="conv-main" onClick={p.onSelect} title={p.c.title}>
        <span className="conv-title">{p.c.title}</span>
      </button>
      <button type="button" className="conv-more" aria-label="Conversation options" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
        <MoreHorizontal size={18} />
      </button>
      {menu && (
        <div className="menu" role="menu">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenu(false);
              setValue(p.c.title);
              setEditing(true);
            }}
          >
            <Pencil size={15} /> Rename
          </button>
          <button
            type="button"
            role="menuitem"
            className="danger"
            onClick={() => {
              setMenu(false);
              p.onDelete();
            }}
          >
            <Trash2 size={15} /> Delete
          </button>
        </div>
      )}
    </div>
  );
}

export function Sidebar(p: Props) {
  const groups = useMemo(() => group(p.conversations), [p.conversations]);
  const initial = (p.user?.displayName || 'G').trim().charAt(0).toUpperCase();
  return (
    <div className="sidebar-inner">
      <div className="sidebar-head">
        <div className="brand">
          <Logo size={30} />
          <span className="brand-name">TRALIX <b>AI</b></span>
        </div>
        <button type="button" className="icon-btn" onClick={p.onClose} aria-label="Close sidebar" title="Close sidebar">
          <PanelLeftClose size={20} className="desktop-only" />
          <X size={20} className="mobile-only" />
        </button>
      </div>

      <button type="button" className="new-chat" onClick={p.onNew}>
        <SquarePen size={18} />
        <span>New chat</span>
      </button>

      <div className="search">
        <Search size={16} />
        <input
          type="search"
          placeholder="Search conversations"
          aria-label="Search conversations"
          value={p.query}
          onChange={(e) => p.onQuery(e.target.value)}
        />
        {p.query && (
          <button type="button" className="search-clear" aria-label="Clear search" onClick={() => p.onQuery('')}>
            <X size={14} />
          </button>
        )}
      </div>

      <nav className="conv-list" aria-label="Conversations">
        {p.loading && !p.conversations.length && (
          <div className="skeletons" aria-hidden="true">
            {[80, 60, 72, 50].map((w, i) => (
              <div key={i} className="skeleton" style={{ width: `${w}%` }} />
            ))}
          </div>
        )}
        {!p.loading && !p.conversations.length && (
          <p className="empty-list">{p.query ? 'No conversations match your search.' : 'Your conversations will appear here.'}</p>
        )}
        {groups.map(([label, list]) => (
          <div key={label} className="conv-group">
            <h3>{label}</h3>
            {list.map((c) => (
              <Item
                key={c.id}
                c={c}
                active={c.id === p.activeId}
                onSelect={() => p.onSelect(c.id)}
                onRename={(t) => p.onRename(c.id, t)}
                onDelete={() => p.onDelete(c)}
              />
            ))}
          </div>
        ))}
      </nav>

      <div className="sidebar-foot">
        <button type="button" className="profile" onClick={p.onSettings}>
          <span className="profile-avatar">{initial}</span>
          <span className="profile-text">
            <span className="profile-name">{p.user?.displayName || 'Guest'}</span>
            <span className="profile-sub">Settings &amp; profile</span>
          </span>
          <Settings size={18} className="profile-gear" />
        </button>
      </div>
    </div>
  );
}
