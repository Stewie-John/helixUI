import { useCallback, useState } from 'react';

// sessionStorage key，持久化正在处理中的会话 ID
const STORAGE_KEY = 'processing_sessions';

function loadFromStorage(): Set<string> {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch { /* ignore */ }
  return new Set();
}

function saveToStorage(sessions: Set<string>) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...sessions]));
  } catch { /* ignore */ }
}

export function useSessionProtection() {
  const [activeSessions, setActiveSessions] = useState<Set<string>>(new Set());
  // 不从 sessionStorage 恢复：刷新后由服务器端 check-session-status → session-status 流程
  // 在 ~1s 内恢复真正活跃的会话状态，避免 Claude 已完成时出现"永久工作中"假象。
  // （同时解除 isLoading=true 对消息同步 effect 的门控，防止刷新后显示旧会话消息。）
  const [processingSessions, setProcessingSessions] = useState<Set<string>>(() => {
    // 清除刷新前遗留的 sessionStorage 数据，防止下次刷新再次出现假状态
    try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
    return new Set();
  });

  const markSessionAsActive = useCallback((sessionId?: string | null) => {
    if (!sessionId) {
      return;
    }

    setActiveSessions((prev) => new Set([...prev, sessionId]));
  }, []);

  const markSessionAsInactive = useCallback((sessionId?: string | null) => {
    if (!sessionId) {
      return;
    }

    setActiveSessions((prev) => {
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
