import { useCallback, useEffect, useRef, useState } from 'react';
import { authenticatedFetch } from '../../../utils/api';
import {
  CLAUDE_MODELS,
  CLAUDE_EFFORT_LEVELS,
  getClaudeEffortOptions,
  CODEX_MODELS,
  CODEX_REASONING_EFFORTS,
  getCodexReasoningEffortOptions,
  CODEX_SPEED_OPTIONS,
  CURSOR_MODELS,
  GEMINI_MODELS
} from '../../../../shared/modelConstants';
import type { PendingPermissionRequest, PermissionMode, Provider } from '../types/types';
import type { Project, ProjectSession, SessionProvider } from '../../../types/app';
import { resolveCompactContinuationInfoForProject } from '../utils/compactContinuations';
import { storeSelectedProvider } from '../../../utils/appEvents';

const LEGACY_CODEX_MODEL_MIGRATIONS: Record<string, string> = {
  'gpt-5.5-codex': 'gpt-5.6-sol',
};
const CODEX_GPT56_DEFAULT_MIGRATION_KEY = 'codex-model-default-migrated-gpt-5.6';

const LEGACY_CLAUDE_MODEL_MIGRATIONS: Record<string, string> = {
  sonnet: 'claude-sonnet-4-6',
  'sonnet[1m]': 'claude-sonnet-4-6',
  opus: 'claude-opus-4-8',
  'opus[1m]': 'claude-opus-4-8',
  opusplan: 'claude-opus-4-8',
  haiku: 'claude-haiku-4-5-20251001',
  'claude-opus-4-5-20251101': 'claude-opus-4-8',
  'claude-opus-4-1-20250805': 'claude-opus-4-8',
  'claude-opus-4-8[1m]': 'claude-opus-4-8',
  'claude-sonnet-4-6[1m]': 'claude-sonnet-4-6',
};

const getValidatedClaudeModel = (value: string | null) => {
  const allowed = new Set(CLAUDE_MODELS.OPTIONS.map((option) => option.value));
  if (!value) {
    return CLAUDE_MODELS.DEFAULT;
  }
  const migrated = LEGACY_CLAUDE_MODEL_MIGRATIONS[value] || value;
  return allowed.has(migrated) ? migrated : CLAUDE_MODELS.DEFAULT;
};

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

// 会话专属模型的服务器端持久化键（复用 user_preferences KV，实现跨设备同步）
const sessionClaudeModelPrefKey = (sessionId: string) => `claude-model-${sessionId}`;

// 从服务器读取某会话的专属模型（跨设备一致的真正来源；失败/无记录返回 null）
async function fetchServerClaudeModel(sessionId: string): Promise<string | null> {
  try {
    const res = await authenticatedFetch('/api/settings/preferences');
    if (!res.ok) return null;
    const data = await res.json();
    const raw = data?.preferences?.[sessionClaudeModelPrefKey(sessionId)];
    if (typeof raw !== 'string' || !raw) return null;
    // 只接受合法 option（服务器只会写入校验过的值，这里再兜一层）
    const allowed = new Set(CLAUDE_MODELS.OPTIONS.map((option) => option.value));
    const migrated = LEGACY_CLAUDE_MODEL_MIGRATIONS[raw] || raw;
    return allowed.has(migrated) ? migrated : null;
  } catch {
    return null;
  }
}

// 保存某会话的专属模型到服务器（fire-and-forget）
function saveServerClaudeModel(sessionId: string, model: string): void {
  authenticatedFetch(`/api/settings/preferences/${sessionClaudeModelPrefKey(sessionId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: model }),
  }).catch((err) => {
    console.warn('[claudeModel] Failed to save session model to server:', err);
  });
}

// 派发模型变更事件，通知 HUD 面板即时刷新（同标签页 storage 事件不触发，故用自定义事件）
function dispatchClaudeModelChanged(sessionId: string | null, model: string): void {
  try {
    window.dispatchEvent(new CustomEvent('claude-model-changed', {
      detail: { sessionId, model },
    }));
  } catch {
    // 忽略：事件派发失败不影响模型切换本身
  }
}

function syncCodexDefaultModel(model: string): void {
  authenticatedFetch('/api/codex/config/model', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model }),
  }).then((response) => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    window.dispatchEvent(new CustomEvent('codex-model-changed', { detail: { model } }));
  }).catch((error) => {
    console.warn('[codexModel] Failed to sync Codex CLI default model:', error);
  });
}

interface UseChatProviderStateArgs {
  selectedSession: ProjectSession | null;
  selectedProject?: Project | null;
}

const getValidatedCodexReasoningEffort = (value: string | null, model?: string) => {
  const allowed = new Set(getCodexReasoningEffortOptions(model).map((option) => option.value));
  if (!value || !allowed.has(value)) {
    return CODEX_REASONING_EFFORTS.DEFAULT;
  }
  return value;
};

const getValidatedCodexSpeed = (value: string | null) => {
  const allowed = new Set(CODEX_SPEED_OPTIONS.OPTIONS.map((option) => option.value));
  if (!value || !allowed.has(value)) {
    return CODEX_SPEED_OPTIONS.DEFAULT;
  }
  return value;
};

const resolveCodexReasoningEffort = (sessionId: string | null, model?: string) => {
  const sessionValue = sessionId ? localStorage.getItem(`codex-reasoning-effort-${sessionId}`) : null;
  return getValidatedCodexReasoningEffort(sessionValue || localStorage.getItem('codex-reasoning-effort'), model);
};

const resolveCodexSpeed = (sessionId: string | null) => {
  const sessionValue = sessionId ? localStorage.getItem(`codex-speed-${sessionId}`) : null;
  return getValidatedCodexSpeed(sessionValue || localStorage.getItem('codex-speed'));
};

// Claude 思考强度（effort）：根据所选模型校验，非法/不支持则回落到 DEFAULT('high')
const getValidatedClaudeEffort = (value: string | null, model: string) => {
  const allowed = new Set(getClaudeEffortOptions(model).map((option) => option.value));
  if (!value || !allowed.has(value)) {
    return CLAUDE_EFFORT_LEVELS.DEFAULT;
  }
  return value;
};

// 会话隔离解析：优先会话专属键，其次全局键，再校验当前模型是否支持
const resolveClaudeEffort = (sessionId: string | null, model: string) => {
  const sessionValue = sessionId ? localStorage.getItem(`claude-effort-${sessionId}`) : null;
  return getValidatedClaudeEffort(sessionValue || localStorage.getItem('claude-effort'), model);
};

export function useChatProviderState({ selectedSession, selectedProject }: UseChatProviderStateArgs) {
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
    // 默认 Sonnet 4.6；仅当该会话有「专属记录」时才用之，不再继承上次的全局选择。
    const sessionId = selectedSession?.id;
    if (sessionId) {
      return getValidatedClaudeModel(localStorage.getItem(`claude-model-${sessionId}`));
    }
    return CLAUDE_MODELS.DEFAULT; // 新对话默认 Sonnet 4.6
  });
  const [claudeEffort, setClaudeEffort] = useState<string>(() => {
    const sessionId = selectedSession?.id || null;
    const initialModel = sessionId
      ? getValidatedClaudeModel(localStorage.getItem(`claude-model-${sessionId}`))
      : CLAUDE_MODELS.DEFAULT;
    return resolveClaudeEffort(sessionId, initialModel);
  });
  const [codexModel, setCodexModelState] = useState<string>(() => {
    const configuredModels = new Set(CODEX_MODELS.OPTIONS.map((option) => option.value));
    const stored = localStorage.getItem('codex-model');
    if (!stored) {
      localStorage.setItem(CODEX_GPT56_DEFAULT_MIGRATION_KEY, '1');
      return CODEX_MODELS.DEFAULT;
    }

    const shouldUpgradeOldDefault =
      stored === 'gpt-5.5' &&
      localStorage.getItem(CODEX_GPT56_DEFAULT_MIGRATION_KEY) !== '1';
    const migrated = shouldUpgradeOldDefault
      ? CODEX_MODELS.DEFAULT
      : LEGACY_CODEX_MODEL_MIGRATIONS[stored] || stored;
    if (migrated !== stored) {
      localStorage.setItem('codex-model', migrated);
    }
    localStorage.setItem(CODEX_GPT56_DEFAULT_MIGRATION_KEY, '1');

    if (configuredModels.has(migrated)) {
      return migrated;
    }

    localStorage.setItem('codex-model', CODEX_MODELS.DEFAULT);
    return CODEX_MODELS.DEFAULT;
  });
  const [codexReasoningEffort, setCodexReasoningEffort] = useState<string>(() => {
    const resolved = resolveCodexReasoningEffort(selectedSession?.id || null, codexModel);
    localStorage.setItem('codex-reasoning-effort', resolved);
    return resolved;
  });
  const [codexSpeed, setCodexSpeed] = useState<string>(() => {
    const resolved = resolveCodexSpeed(selectedSession?.id || null);
    localStorage.setItem('codex-speed', resolved);
    return resolved;
  });
  const [geminiModel, setGeminiModel] = useState<string>(() => {
    return localStorage.getItem('gemini-model') || GEMINI_MODELS.DEFAULT;
  });

  const lastProviderRef = useRef(provider);
  // 记录上一次的会话 id，用于区分「新对话刚创建为正式会话」(需沿用所选模型) 与「打开/切换已有会话」(默认 Sonnet 4.6)
  const prevClaudeSessionIdRef = useRef<string | null | undefined>(selectedSession?.id);

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
    const activeSessionId = selectedSession?.id;
    const prevSessionId = prevClaudeSessionIdRef.current;
    prevClaudeSessionIdRef.current = activeSessionId;

    if (!activeSessionId) {
      // 新对话：强制默认 Sonnet 4.6，不继承上次选择
      setClaudeModel(CLAUDE_MODELS.DEFAULT);
      localStorage.setItem('claude-model', CLAUDE_MODELS.DEFAULT);
      dispatchClaudeModelChanged(null, CLAUDE_MODELS.DEFAULT);
      setClaudeEffort(resolveClaudeEffort(null, CLAUDE_MODELS.DEFAULT));
      setCodexReasoningEffort(resolveCodexReasoningEffort(null, codexModel));
      setCodexSpeed(resolveCodexSpeed(null));
      return;
    }

    // 优先级：1. 会话专属记录  2. localStorage 全局缓存  3. 'default'
    const sessionSpecific = localStorage.getItem(`permissionMode-${activeSessionId}`);
    const globalDefault = localStorage.getItem('permission-mode-global') as PermissionMode | null;
    setPermissionMode((sessionSpecific as PermissionMode) || globalDefault || 'default');

    // 模型解析规则：
    //  1) 有「会话专属记录」→ 用之（手动选过 / 服务器同步过）
    //  2) 否则若刚从「新对话」转为正式会话（prev 无 id）→ 沿用进入对话时所选模型（全局键承接 carry）
    //  3) 否则（打开/切换已有会话）→ 默认 Sonnet 4.6，不继承
    const sessionModel = localStorage.getItem(`claude-model-${activeSessionId}`);
    const cameFromNewChat = !prevSessionId;
    let resolvedClaudeModel: string;
    if (sessionModel) {
      resolvedClaudeModel = getValidatedClaudeModel(sessionModel);
    } else if (cameFromNewChat) {
      resolvedClaudeModel = getValidatedClaudeModel(localStorage.getItem('claude-model'));
      // 新对话所选模型固化到该会话，并同步到服务器（跨设备）
      if (resolvedClaudeModel !== CLAUDE_MODELS.DEFAULT) {
        saveServerClaudeModel(activeSessionId, resolvedClaudeModel);
      }
    } else {
      resolvedClaudeModel = CLAUDE_MODELS.DEFAULT;
    }
    setClaudeModel(resolvedClaudeModel);
    localStorage.setItem(`claude-model-${activeSessionId}`, resolvedClaudeModel);
    localStorage.setItem('claude-model', resolvedClaudeModel);
    dispatchClaudeModelChanged(activeSessionId, resolvedClaudeModel);

    let cancelled = false;
    // 异步拉取服务器端该会话的模型（跨设备同步的权威来源）。
    // 若与本地不同则覆盖：更新 state（同时驱动「发送给后端的模型」，保证显示==实际使用）+ 本地缓存 + 通知 HUD。
    void fetchServerClaudeModel(activeSessionId).then((serverModel) => {
      // 防竞态：会话已切换则丢弃这次结果
      if (cancelled || selectedSession?.id !== activeSessionId || !serverModel) return;
      if (serverModel === resolvedClaudeModel) return;
      setClaudeModel(serverModel);
      localStorage.setItem(`claude-model-${activeSessionId}`, serverModel);
      localStorage.setItem('claude-model', serverModel);
      dispatchClaudeModelChanged(activeSessionId, serverModel);
    });

    // Claude 思考强度：按会话隔离解析，并校验对当前模型是否可用
    setClaudeEffort(resolveClaudeEffort(activeSessionId, resolvedClaudeModel));

    const sessionReasoningEffort = resolveCodexReasoningEffort(activeSessionId, codexModel);
    const sessionSpeed = resolveCodexSpeed(activeSessionId);
    setCodexReasoningEffort(sessionReasoningEffort);
    setCodexSpeed(sessionSpeed);

    return () => {
      cancelled = true;
    };
  }, [selectedSession?.id]);

  useEffect(() => {
    const continuationInfo = resolveCompactContinuationInfoForProject(selectedProject, selectedSession?.id);
    const storedProvider = localStorage.getItem('selected-provider') as SessionProvider | null;
    const effectiveProvider = (
      continuationInfo.provider ||
      (continuationInfo.isContinuation ? storedProvider : null) ||
      selectedSession?.__provider
    ) as SessionProvider | undefined;

    if (!effectiveProvider || effectiveProvider === provider) {
      return;
    }

    setProvider(effectiveProvider);
    storeSelectedProvider(effectiveProvider);
  }, [selectedProject, selectedSession?.id, selectedSession?.__provider]);

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

    // 仅保存到会话专属键 —— 每个对话的权限模式完全隔离，不影响其他对话
    if (selectedSession?.id) {
      localStorage.setItem(`permissionMode-${selectedSession.id}`, nextMode);
    }
  }, [permissionMode, provider, selectedSession?.id]);

  // 会话隔离的模型 setter：保存到会话专属键，同时更新全局默认键（供新会话继承）
  const setClaudeModelForSession = useCallback((model: string) => {
    const resolved = getValidatedClaudeModel(model);
    setClaudeModel(resolved);
    if (selectedSession?.id) {
      localStorage.setItem(`claude-model-${selectedSession.id}`, resolved);
    }
    localStorage.setItem('claude-model', resolved); // 全局默认，供新会话继承
    // 通知 HUD 面板即时刷新模型显示（中途换模型零延迟生效）
    dispatchClaudeModelChanged(selectedSession?.id ?? null, resolved);
    // 持久化到服务器，实现跨设备一致（fire-and-forget）
    if (selectedSession?.id) {
      saveServerClaudeModel(selectedSession.id, resolved);
    }
  }, [selectedSession?.id]);

  // 会话隔离的 Claude 思考强度 setter
  const setClaudeEffortForSession = useCallback((effort: string) => {
    const resolved = getValidatedClaudeEffort(effort, claudeModel);
    setClaudeEffort(resolved);
    if (selectedSession?.id) {
      localStorage.setItem(`claude-effort-${selectedSession.id}`, resolved);
    }
    localStorage.setItem('claude-effort', resolved); // 全局默认，供新会话继承
  }, [selectedSession?.id, claudeModel]);

  // 切换模型后，若当前强度不被新模型支持则回落到 DEFAULT（如 opus→sonnet 失去 xhigh）
  useEffect(() => {
    const allowed = new Set(getClaudeEffortOptions(claudeModel).map((o) => o.value));
    if (!allowed.has(claudeEffort)) {
      const fallback = CLAUDE_EFFORT_LEVELS.DEFAULT;
      setClaudeEffort(fallback);
      if (selectedSession?.id) {
        localStorage.setItem(`claude-effort-${selectedSession.id}`, fallback);
      }
      localStorage.setItem('claude-effort', fallback);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claudeModel]);

  const setCodexReasoningEffortForSession = useCallback((effort: string) => {
    const resolved = getValidatedCodexReasoningEffort(effort, codexModel);
    setCodexReasoningEffort(resolved);
    if (selectedSession?.id) {
      localStorage.setItem(`codex-reasoning-effort-${selectedSession.id}`, resolved);
    }
    localStorage.setItem('codex-reasoning-effort', resolved);
  }, [selectedSession?.id, codexModel]);

  useEffect(() => {
    const resolved = getValidatedCodexReasoningEffort(codexReasoningEffort, codexModel);
    if (resolved === codexReasoningEffort) return;
    setCodexReasoningEffort(resolved);
    if (selectedSession?.id) {
      localStorage.setItem(`codex-reasoning-effort-${selectedSession.id}`, resolved);
    }
    localStorage.setItem('codex-reasoning-effort', resolved);
  }, [codexModel, codexReasoningEffort, selectedSession?.id]);

  const setCodexSpeedForSession = useCallback((speed: string) => {
    const resolved = getValidatedCodexSpeed(speed);
    setCodexSpeed(resolved);
    if (selectedSession?.id) {
      localStorage.setItem(`codex-speed-${selectedSession.id}`, resolved);
    }
    localStorage.setItem('codex-speed', resolved);
  }, [selectedSession?.id]);

  const setCodexModelForSession = useCallback((model: string) => {
    const allowed = new Set(CODEX_MODELS.OPTIONS.map((option) => option.value));
    const resolved = allowed.has(model) ? model : CODEX_MODELS.DEFAULT;
    setCodexModelState(resolved);
    localStorage.setItem('codex-model', resolved);
    syncCodexDefaultModel(resolved);
  }, []);

  return {
    provider,
    setProvider,
    cursorModel,
    setCursorModel,
    claudeModel,
    setClaudeModel: setClaudeModelForSession,
    claudeEffort,
    setClaudeEffort: setClaudeEffortForSession,
    codexModel,
    setCodexModel: setCodexModelForSession,
    codexReasoningEffort,
    setCodexReasoningEffort: setCodexReasoningEffortForSession,
    codexSpeed,
    setCodexSpeed: setCodexSpeedForSession,
    geminiModel,
    setGeminiModel,
    permissionMode,
    setPermissionMode,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    cyclePermissionMode,
  };
}
