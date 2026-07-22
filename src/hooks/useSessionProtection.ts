import { useCallback, useEffect, useState } from 'react';

// sessionStorage key，持久化正在处理中的会话 ID
const STORAGE_KEY = 'processing_sessions';
const MAX_STORED_PROCESSING_AGE_MS = 2 * 60 * 60 * 1000;

type StoredProcessingSession = {
  id: string;
  startedAt: number;
};

function readStoredSessions(): StoredProcessingSession[] {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    const now = Date.now();
    const records = Array.isArray(parsed)
      ? parsed.map((item) =>
          typeof item === 'string'
            ? { id: item, startedAt: now }
            : { id: String(item?.id || ''), startedAt: Number(item?.startedAt || now) },
        )
      : [];
    return records.filter((record) =>
      record.id && Number.isFinite(record.startedAt) && now - record.startedAt < MAX_STORED_PROCESSING_AGE_MS
    );
  } catch { /* ignore */ }
  return [];
}

function loadFromStorage(): Set<string> {
  return new Set(readStoredSessions().map((session) => session.id));
}

function saveToStorage(sessions: Set<string>) {
  try {
    const previous = new Map(readStoredSessions().map((session) => [session.id, session.startedAt]));
    const records = [...sessions].map((id) => ({
      id,
      startedAt: previous.get(id) || Date.now(),
    }));
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(records));
  } catch { /* ignore */ }
}

export function useSessionProtection() {
  const [activeSessions, setActiveSessions] = useState<Set<string>>(new Set());
  // 刷新后先用本地处理中记录立即恢复状态栏，再由服务器 session-status 校正真假。
  const [processingSessions, setProcessingSessions] = useState<Set<string>>(() => loadFromStorage());

  useEffect(() => {
    const applySnapshot = (event: Event) => {
      const providers = (event as CustomEvent<Record<string, unknown>>).detail || {};
      const ids = new Set<string>();
      Object.values(providers).forEach((entries) => {
        if (!Array.isArray(entries)) return;
        entries.forEach((entry) => {
          if (typeof entry === 'string') {
            if (entry) ids.add(entry);
            return;
          }
          // Providers can expose a stable sidebar/view id and a different
          // runtime thread id after resume or compaction. They are aliases of
          // one active turn, so every identity must light the same UI state.
          [entry?.id, entry?.viewSessionId, entry?.logicalSessionId, entry?.runtimeThreadId]
            .map((value) => String(value || ''))
            .filter(Boolean)
            .forEach((id) => ids.add(id));
        });
      });
      const recentLocalIds = new Set(
        readStoredSessions()
          .filter((record) => Date.now() - record.startedAt < 30_000)
          .map((record) => record.id),
      );
      setActiveSessions((previous) => {
        const next = new Set(ids);
        for (const id of previous) {
          if (id.startsWith('new-session-') || recentLocalIds.has(id)) next.add(id);
        }
        return next;
      });
      setProcessingSessions((previous) => {
        const next = new Set(ids);
        for (const id of previous) {
          if (id.startsWith('new-session-') || recentLocalIds.has(id)) next.add(id);
        }
        saveToStorage(next);
        return next;
      });
    };
    window.addEventListener('helix:active-sessions-snapshot', applySnapshot);
    return () => window.removeEventListener('helix:active-sessions-snapshot', applySnapshot);
  }, []);

  const markSessionAsActive = useCallback((sessionId?: string | null) => {
    if (!sessionId) {
      return;
    }

    setActiveSessions((prev) => {
      if (prev.has(sessionId)) return prev;
      return new Set([...prev, sessionId]);
    });
  }, []);

  const markSessionAsInactive = useCallback((sessionId?: string | null) => {
    if (!sessionId) {
      return;
    }

    setActiveSessions((prev) => {
      if (!prev.has(sessionId)) return prev;
      const next = new Set(prev);
      next.delete(sessionId);
      return next;
    });
  }, []);

  const markSessionAsProcessing = useCallback((sessionId?: string | null) => {
    if (!sessionId) {
      return;
    }

    setProcessingSessions((prev) => {
      if (prev.has(sessionId)) return prev;
      const next = new Set([...prev, sessionId]);
      saveToStorage(next);
      return next;
    });
  }, []);

  const markSessionAsNotProcessing = useCallback((sessionId?: string | null) => {
    if (!sessionId) {
      return;
    }

    setProcessingSessions((prev) => {
      if (!prev.has(sessionId)) return prev;
      const next = new Set(prev);
      next.delete(sessionId);
      saveToStorage(next);
      return next;
    });
  }, []);

  const replaceTemporarySession = useCallback((realSessionId?: string | null) => {
    if (!realSessionId) {
      return;
    }

    setActiveSessions((prev) => {
      const next = new Set<string>();
      for (const sessionId of prev) {
        if (!sessionId.startsWith('new-session-')) {
          next.add(sessionId);
        }
      }
      next.add(realSessionId);
      return next;
    });
  }, []);

  return {
    activeSessions,
    processingSessions,
    markSessionAsActive,
    markSessionAsInactive,
    markSessionAsProcessing,
    markSessionAsNotProcessing,
    replaceTemporarySession,
  };
}
