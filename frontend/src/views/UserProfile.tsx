import { useEffect, useState } from 'preact/hooks';
import { useHashLocation } from 'wouter/use-hash-location';
import { ArrowLeft, Loader2, Mail, UserRound, CalendarDays, FilePenLine } from 'lucide-preact';
import { useAuth } from '../auth';
import { getUserProfile, avatarUrl, type UserProfileRead } from '../api';
import { Avatar } from '../components/Avatar';
import { fmtDate } from './settings-shared';
import type { UserRole } from '../api';

const ROLE_CONFIG: Record<UserRole, { label: string; color: string }> = {
  admin: { label: 'Admin', color: '#f59e0b' },
  editor: { label: 'Editor', color: '#3b82f6' },
  viewer: { label: 'Viewer', color: '#6b7280' },
};

/**
 * Public profile of another member (read-only). Any authenticated user may
 * view it; the email is withheld server-side when the owner opted out.
 */
export function UserProfile({ params }: { params: { id: string } }) {
  const userId = params?.id;
  const { user } = useAuth();
  const [, setLocation] = useHashLocation();
  const [data, setData] = useState<UserProfileRead | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setNotFound(false);
    setData(null);
    if (!userId) {
      setNotFound(true);
      setLoading(false);
      return;
    }
    getUserProfile(userId)
      .then((d) => {
        if (cancelled) return;
        setData(d);
      })
      .catch(() => {
        if (!cancelled) setNotFound(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [userId]);

  if (loading) {
    return (
      <div class="page-container">
        <div class="inline-loading" role="status">
          <Loader2 width={16} height={16} class="icon spin" /> Loading profile…
        </div>
      </div>
    );
  }

  if (notFound || !data) {
    return (
      <div class="page-container">
        <div class="panel" style="max-width:520px;margin:2rem auto;text-align:center;padding:2rem">
          <UserRound width={28} height={28} class="icon" style="margin:0 auto 8px" />
          <h2 class="panel-title" style="justify-content:center">User not found</h2>
          <p class="settings-hint" style="margin:4px 0 16px">This member may have been removed.</p>
          <button class="btn" onClick={() => setLocation('/team')}>
            <ArrowLeft width={14} height={14} /> Back
          </button>
        </div>
      </div>
    );
  }

  const { id, username, role, createdAt, profile } = data;
  const displayName = profile.displayName || username;
  const isMe = user?.id === id;
  const cfg = ROLE_CONFIG[role] || ROLE_CONFIG.viewer;
  const email = profile.email;
  const emailHidden = profile.emailVisible === false && !isMe;

  return (
    <div class="page-container">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px">
        <button
          class="btn-ghost sm"
          onClick={() => (isMe ? setLocation('/profile') : setLocation('/team'))}
          aria-label="Back"
        >
          <ArrowLeft width={14} height={14} /> Back
        </button>
        {isMe && (
          <button class="btn-primary sm" onClick={() => setLocation('/profile')}>
            <FilePenLine width={14} height={14} /> Edit profile
          </button>
        )}
      </div>

      <div class="panel" style="max-width:640px;padding:24px">
        <div style="display:flex;align-items:center;gap:18px;flex-wrap:wrap">
          <Avatar
            name={displayName}
            avatar={avatarUrl(id, profile.avatarExt)}
            size={64}
            title={displayName}
          />
          <div style="flex:1;min-width:200px">
            <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
              <h1 style="font-size:1.35rem;margin:0;font-weight:700">{displayName}</h1>
              <span style={{
                fontSize: '0.75rem',
                padding: '0.175rem 0.5rem',
                borderRadius: 6,
                background: `${cfg.color}22`,
                color: cfg.color,
                fontWeight: 600,
              }}>
                {cfg.label}{role === 'editor' ? ' · global' : ''}
              </span>
              {isMe && <span style="font-size:0.75rem;color:var(--text-secondary)">(you)</span>}
            </div>
            <div style="font-size:0.8125rem;color:var(--text-secondary);margin-top:2px">@{username}</div>
          </div>
        </div>

        <div style="height:1px;background:var(--border);margin:20px 0" />

        <div style="display:flex;flex-direction:column;gap:12px">
          <div class="settings-row">
            <span class="field-label"><Mail width={14} height={14} /> Email</span>
            <span style="color:var(--text)">
              {emailHidden ? (
                <span style="color:var(--text-secondary)" title="Hidden by the owner">Hidden</span>
              ) : email ? (
                email
              ) : (
                <span style="color:var(--text-secondary)">—</span>
              )}
            </span>
          </div>
          <div class="settings-row">
            <span class="field-label"><UserRound width={14} height={14} /> Bio</span>
            <span style="color:var(--text);white-space:pre-wrap">{profile.bio || <span style="color:var(--text-secondary)">—</span>}</span>
          </div>
          <div class="settings-row">
            <span class="field-label"><CalendarDays width={14} height={14} /> Joined</span>
            <span style="color:var(--text-secondary)">{fmtDate(createdAt)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}