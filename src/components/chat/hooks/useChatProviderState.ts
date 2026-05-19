import { useCallback, useEffect, useRef, useState } from 'react';
import { authenticatedFetch } from '../../../utils/api';
import { CLAUDE_MODELS, CODEX_MODELS, CURSOR_MODELS, GEMINI_MODELS } from '../../../../shared/modelConstants';
import type { PendingPermissionRequest, PermissionMode, Provider } from '../types/types';
import type { ProjectSession, SessionProvider } from '../../../types/app';

// 服务器端偏好设置键名
const PREF_KEY_PERMISSION_MODE = 'defaultPermissionMode';

// 从服务器读取全局默认权限模式（fire-and-forget，失败不阻塞 UI）
async function fetchServerPermissionMode(): Promise<PermissionMode | null> {
  try {
    const res = await authenticatedFetch('/api/settings/preferences');
    if (!res.ok) return null;
    const data = await res.json();
    const mode = data?.preferences?.[PREF_KEY_PERMISSION_MODE];
    if (mode === 'default' || mode === 'acceptEdits' || mode === 'bypassPermissions' || mode === 'plan') {
      return mode as PermissionMode;
    }
    return null;
  } catch {
    return null;
  }
}

// 保存全局默认权限模式到服务器（fire-and-forget）
function saveServerPermissionMode(mode: PermissionMode): void {
  authenticatedFetch(`/api/settings/preferences/${PREF_KEY_PERMISSION_MODE}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: mode }),
  }).catch((err) => {
    console.warn('[permissionMode] Failed to save to server:', err);
  });
}

interface UseChatProviderStateArgs {
  selectedSession: ProjectSession | null;
}

export function useChatProviderState({ selectedSession }: UseChatProviderStateArgs) {
  // 初始值：先用 localStorage 全局默认键，实际同步在下方 useEffect 中完成
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(() => {
    const globalDefault = localStorage.getItem('permission-mode-global') as PermissionMode | null;
    return globalDefault || 'default';
  });
  const [pendingPermissionRequests, setPendingPermissionRequests] = useState<PendingPermissionRequest[]>([]);
  const [provider, setProvider] = useState<SessionProvider>(() => {
    return (localStorage.getItem('selected-provider') as SessionProvider) || 'claude';
  });
  const [cursorModel, setCursorModel] = useState<string>(() => {
    return localStorage.getItem('cursor-model') || CURSOR_MODELS.DEFAULT;
  });
  const [claudeModel, setClaudeModel] = useState<string>(() => {
    // 优先读取会话专属模型，回退到全局默认
    const sessionId = selectedSession?.id;
    if (sessionId) {
      return localStorage.getItem(`claude-model-${sessionId}`)
        || localStorage.getItem('claude-model')
        || CLAUDE_MODELS.DEFAULT;
    }
    return localStorage.getItem('claude-model') || CLAUDE_MODELS.DEFAULT;
  });
  const [codexModel, setCodexModel] = useState<string>(() => {
    return localStorage.getItem('codex-model') || CODEX_MODELS.DEFAULT;
  });
  const [geminiModel, setGeminiModel] = useState<string>(() => {
    return localStorage.getItem('gemini-model') || GEMINI_MODELS.DEFAULT;
  });

  const lastProviderRef = useRef(provider);

  // 首次挂载时从服务器拉取全局默认权限模式（跨设备同步）
  useEffect(() => {
    fetchServerPermissionMode().then((serverMode) => {
      if (serverMode) {
        // 写入本地缓存，下次刷新立即生效，无需等待网络
        localStorage.setItem('permission-mode-global', serverMode);
        // 仅当当前会话没有专属记录时才更新显示值
        const sessionSpecific = selectedSession?.id
          ? localStorage.getItem(`permissionMode-${selectedSession.id}`)
          : null;
        if (!sessionSpecific) {
          setPermissionMode(serverMode);
        }
      }
    });
    // 只在组件挂载时执行一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selectedSession?.id) {
      return;
    }

    // 优先级：1. 会话专属记录  2. localStorage 全局缓存  3. 'default'
    const sessionSpecific = localStorage.getItem(`permissionMode-${selectedSession.id}`);
    const globalDefault = localStorage.getItem('permission-mode-global') as PermissionMode | null;
    setPermissionMode((sessionSpecific as PermissionMode) || globalDefault || 'default');

    // 切换会话时加载该会话专属的模型选择（无则回退全局默认）
    const sessionModel = localStorage.getItem(`claude-model-${selectedSession.id}`);
    const globalModel = localStorage.getItem('claude-model') || CLAUDE_MODELS.DEFAULT;
    setClaudeModel(sessionModel || globalModel);
  }, [selectedSession?.id]);

  useEffect(() => {
    if (!selectedSession?.__provider || selectedSession.__provider === provider) {
      return;
    }

    setProvider(selectedSession.__provider);
    localStorage.setItem('selected-provider', selectedSession.__provider);
  }, [provider, selectedSession]);

  useEffect(() => {
    if (lastProviderRef.current === provider) {
      return;
    }
    setPendingPermissionRequests([]);
    lastProviderRef.current = provider;
  }, [provider]);

  useEffect(() => {
    setPendingPermissionRequests((previous) =>
      previous.filter((request) => !request.sessionId || request.sessionId === selectedSession?.id),
    );
  }, [selectedSession?.id]);

  useEffect(() => {
    if (provider !== 'cursor') {
      return;
    }

    authenticatedFetch('/api/cursor/config')
      .then((response) => response.json())
      .then((data) => {
        if (!data.success || !data.config?.model?.modelId) {
          return;
        }

        const modelId = data.config.model.modelId as string;
        if (!localStorage.getItem('cursor-model')) {
          setCursorModel(modelId);
        }
      })
      .catch((error) => {
        console.error('Error loading Cursor config:', error);
      });
  }, [provider]);

  const cyclePermissionMode = useCallback(() => {
    const modes: PermissionMode[] =
      provider === 'codex'
        ? ['default', 'acceptEdits', 'bypassPermissions']
        : ['default', 'acceptEdits', 'bypassPermissions', 'plan'];

    const currentIndex = modes.indexOf(permissionMode);
    const nextIndex = (currentIndex + 1) % modes.length;
    const nextMode = modes[nextIndex];
    setPermissionMode(nextMode);

    // 1. 保存到会话专属 localStorage（用于同设备会话切换）
    if (selectedSession?.id) {
      localStorage.setItem(`permissionMode-${selectedSession.id}`, nextMode);
    }
    // 2. 保存到全局 localStorage 缓存（用于新会话的初始值，同设备快速生效）
    localStorage.setItem('permission-mode-global', nextMode);
    // 3. 保存到服务器数据库（跨设备持久化，fire-and-forget）
    saveServerPermissionMode(nextMode);
  }, [permissionMode, provider, selectedSession?.id]);

  // 会话隔离的模型 setter：保存到会话专属键，同时更新全局默认键（供新会话继承）
  const setClaudeModelForSession = useCallback((model: string) => {
    setClaudeModel(model);
    if (selectedSession?.id) {
      localStorage.setItem(`claude-model-${selectedSession.id}`, model);
    }
    localStorage.setItem('claude-model', model); // 全局默认，供新会话继承
  }, [selectedSession?.id]);

  return {
    provider,
    setProvider,
    cursorModel,
    setCursorModel,
    claudeModel,
    setClaudeModel: setClaudeModelForSession,
    codexModel,
    setCodexModel,
    geminiModel,
    setGeminiModel,
    permissionMode,
    setPermissionMode,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    cyclePermissionMode,
  };
}
