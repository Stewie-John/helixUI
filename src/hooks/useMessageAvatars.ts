// 多账号共享数据时按消息归属（attribution）渲染头像。
// 数据流：
// 1) /api/user/avatars  → Map<userId, avatarUrl|null>（所有活跃账号的头像，登录时加载一次）
// 2) /api/sessions/:id/attributions → [{message_ts, user_id}]（当前会话内每条 user 消息的归属）
// 3) getAvatarFor(message) 用 message.timestamp / message.clientTs 作 key 查 user_id，再查 avatarUrl
// 兜底：未匹配到归属时回退到当前登录用户的头像（多为本地刚提交、JSONL 还未落盘的消息）。
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../utils/api';
import { useAuth } from '../contexts/AuthContext';

interface ChatMessageLike {
  type?: string;
  timestamp?: string | number | Date;
  clientTs?: number;
}

type AvatarMap = Map<number, string | null>;
type AttributionMap = Map<number, number>; // message_ts(ms) → user_id

let cachedAvatars: AvatarMap | null = null;
let avatarsPromise: Promise<AvatarMap> | null = null;

async function fetchAvatarsOnce(): Promise<AvatarMap> {
  if (cachedAvatars) return cachedAvatars;
  if (avatarsPromise) return avatarsPromise;
  avatarsPromise = (async () => {
    try {
      const res = await api.user.listAvatars();
      if (!res.ok) return new Map();
      const data = await res.json();
      const map: AvatarMap = new Map();
      if (Array.isArray(data?.users)) {
        for (const u of data.users) {
          if (typeof u?.id === 'number') {
            map.set(u.id, typeof u.avatar_url === 'string' ? u.avatar_url : null);
          }
        }
      }
      cachedAvatars = map;
      return map;
    } catch {
      return new Map();
    } finally {
      avatarsPromise = null;
    }
  })();
  return avatarsPromise;
}

// 模块级失效，调用方在 user.avatar_url 变化时清空缓存（账号切换 / 自己刚改头像）
export function invalidateAvatarsCache() {
  cachedAvatars = null;
}

function tsKey(ts: string | number | Date | undefined): number | null {
  if (ts == null) return null;
  if (typeof ts === 'number') return Number.isFinite(ts) ? ts : null;
  if (ts instanceof Date) return ts.getTime();
  const parsed = Date.parse(ts);
  return Number.isFinite(parsed) ? parsed : null;
}

export function useMessageAvatars(sessionId: string | null | undefined) {
  const auth = useAuth() as unknown as { user: { id?: number; avatar_url?: string | null } | null };
  const { user } = auth;
  const [avatars, setAvatars] = useState<AvatarMap>(() => cachedAvatars ?? new Map());
  const [attributions, setAttributions] = useState<AttributionMap>(new Map());

  // 加载所有账号的头像（用于按 user_id 渲染）
  useEffect(() => {
    let cancelled = false;
    fetchAvatarsOnce().then((m) => {
      if (!cancelled) setAvatars(new Map(m));
    });
    return () => { cancelled = true; };
  }, []);

  // 自己改头像后即时同步
  useEffect(() => {
    if (!user?.id) return;
    setAvatars((prev) => {
      const cur = prev.get(user.id!) ?? undefined;
      if (cur === user.avatar_url) return prev;
      const next = new Map(prev);
      next.set(user.id!, user.avatar_url ?? null);
      // 更新缓存让其他 hook 实例同步
      if (cachedAvatars) cachedAvatars.set(user.id!, user.avatar_url ?? null);
      return next;
    });
  }, [user?.id, user?.avatar_url]);

  // 切换会话时拉这次会话的归属表；新 user 消息到来时也刷新（避免他人消息回退到本人头像）
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  const fetchAttributions = useRef(async (sid: string | null | undefined) => {
    if (!sid) { setAttributions(new Map()); return; }
    try {
      const res = await api.attributions.getBySession(sid);
      if (!res.ok) return;
      const data = await res.json();
      if (sessionIdRef.current !== sid) return; // 已切换会话，丢弃
      const map: AttributionMap = new Map();
      if (Array.isArray(data?.attributions)) {
        for (const row of data.attributions) {
          if (typeof row?.message_ts === 'number' && typeof row?.user_id === 'number') {
            map.set(row.message_ts, row.user_id);
          }
        }
      }
      setAttributions(map);
    } catch { /* ignore */ }
  }).current;

  useEffect(() => {
    fetchAttributions(sessionId);
  }, [sessionId, fetchAttributions]);

  // 暴露查找函数（按 message → avatarUrl）
  const fallback = user?.avatar_url ?? null;
  const fallbackId = user?.id;

  const getAvatarFor = useMemo(() => {
    return (message: ChatMessageLike): string | null => {
      const candidates: number[] = [];
      const ct = typeof message.clientTs === 'number' ? message.clientTs : null;
      const tsk = tsKey(message.timestamp);
      if (ct != null) candidates.push(ct);
      if (tsk != null && tsk !== ct) candidates.push(tsk);

      for (const k of candidates) {
        const uid = attributions.get(k);
        if (uid != null) {
          const a = avatars.get(uid);
          return a ?? null;
        }
      }
      // 兜底：多数情况下是本人刚提交、JSONL 还未落盘
      if (fallbackId != null) {
        const a = avatars.get(fallbackId);
        if (a !== undefined) return a;
      }
      return fallback;
    };
  }, [attributions, avatars, fallback, fallbackId]);

  const refreshAttributions = () => fetchAttributions(sessionIdRef.current);

  return { getAvatarFor, refreshAttributions };
}
