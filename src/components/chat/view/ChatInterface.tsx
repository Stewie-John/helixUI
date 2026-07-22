import React, { useCallback, useEffect, useRef, useState } from 'react';
import QuickSettingsPanel from '../../QuickSettingsPanel';
import { useWebSocket } from '../../../contexts/WebSocketContext';
import { useTasksSettings } from '../../../contexts/TasksSettingsContext';
import { useTranslation } from 'react-i18next';
import ChatMessagesPane from './subcomponents/ChatMessagesPane';
import ChatComposer from './subcomponents/ChatComposer';
import type { ChatInterfaceProps } from '../types/types';
import { useChatProviderState } from '../hooks/useChatProviderState';
import { useChatSessionState } from '../hooks/useChatSessionState';
import { useChatRealtimeHandlers } from '../hooks/useChatRealtimeHandlers';
import { useChatComposerState } from '../hooks/useChatComposerState';
import type { ChatMessage, Provider } from '../types/types';
import { useTodoProgress } from '../../../contexts/TodoProgressContext';
import { BUILTIN_PROVIDERS } from '../../../types/app';
import { getProviderLabel } from '../utils/providerLabels';

type PendingViewSession = {
  sessionId: string | null;
  startedAt: number;
};

const AUTO_COMPACT_ENABLED = true;
const AUTO_COMPACT_THRESHOLD = 0.95;
const AUTO_COMPACT_MIN_USED_TOKENS = 150000;
const AUTO_COMPACT_RECENT_MESSAGES = 8;
const COMPACT_SUMMARY_MAX_CHARS = 9000;
const DEFAULT_CONTEXT_WINDOW = 200000;

function readTokenNumber(value: unknown) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : 0;
}

function estimateUiTokens(text: string) {
  return text ? Math.max(1, Math.ceil(text.length / 4)) : 0;
}

function stringifyMessageContent(value: unknown) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncateForCompact(text: string, maxLength = 1200) {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, maxLength - 3)}...`;
}

function formatCompactMessage(message: import('../types/types').ChatMessage, index: number) {
  const role =
    message.type === 'user'
      ? 'User'
      : message.isToolUse
        ? `Tool:${message.toolName || 'unknown'}`
        : message.type === 'error'
          ? 'Error'
          : 'Assistant';
  const content =
    message.isToolUse
      ? stringifyMessageContent(message.toolInput || message.toolResult || message.content)
      : stringifyMessageContent(message.content || message.reasoning);
  if (!content.trim()) return '';
  return `${index + 1}. ${role}: ${truncateForCompact(content)}`;
}

function buildAutoCompactSummary(
  messages: import('../types/types').ChatMessage[],
  providerLabel: string,
  used: number,
  total: number,
) {
  const relevantMessages = messages.filter((message) =>
    !message.pending &&
    !message.sendFailed &&
    !message.isCompactSummary &&
    (message.content || message.reasoning || message.toolInput || message.toolResult),
  );
  const recentMessages = relevantMessages.slice(-AUTO_COMPACT_RECENT_MESSAGES);
  const olderMessages = relevantMessages.slice(0, -AUTO_COMPACT_RECENT_MESSAGES);
  const olderDigest = olderMessages
    .slice(-30)
    .map(formatCompactMessage)
    .filter(Boolean)
    .join('\n');
  const recentDigest = recentMessages
    .map((message, index) => formatCompactMessage(message, olderMessages.length + index))
    .filter(Boolean)
    .join('\n');

  const rawSummary = [
    `Provider: ${providerLabel}`,
    `Context usage before compaction: ${used.toLocaleString()} / ${total.toLocaleString()} tokens (${((used / total) * 100).toFixed(1)}%).`,
    'Continue the work from this compacted context. Preserve explicit user requirements, decisions, file paths, tool results, and unresolved tasks.',
    '',
    olderDigest ? 'Older conversation digest:' : '',
    olderDigest,
    '',
    recentDigest ? 'Most recent messages:' : '',
    recentDigest,
  ].filter(Boolean).join('\n');

  if (rawSummary.length <= COMPACT_SUMMARY_MAX_CHARS) {
    return rawSummary;
  }

  const headLength = Math.floor(COMPACT_SUMMARY_MAX_CHARS * 0.35);
  const tailLength = COMPACT_SUMMARY_MAX_CHARS - headLength - 80;
  return `${rawSummary.slice(0, headLength)}\n\n[...auto-compact omitted middle transcript...]\n\n${rawSummary.slice(-tailLength)}`;
}

function ChatInterface({
  selectedProject,
  selectedSession,
  newSessionNonce,
  ws,
  sendMessage,
  latestMessage,
  onFileOpen,
  onInputFocusChange,
  onSessionActive,
  onSessionInactive,
  onSessionProcessing,
  onSessionNotProcessing,
  processingSessions,
  activeSessions,
  onReplaceTemporarySession,
  onNavigateToSession,
  onShowSettings,
  autoExpandTools,
  showRawParameters,
  showThinking,
  autoScrollToBottom,
  sendByCtrlEnter,
  externalMessageUpdate,
  onShowAllTasks,
}: ChatInterfaceProps) {
  const { tasksEnabled, isTaskMasterInstalled } = useTasksSettings();
  const { t } = useTranslation('chat');
  // 入站消息队列，防止 React 18 批处理丢失中间消息
  const { incomingMsgQueueRef, incomingMsgVersion, isConnected } = useWebSocket();

  const streamBufferRef = useRef('');
  const streamTimerRef = useRef<number | null>(null);
  const pendingViewSessionRef = useRef<PendingViewSession | null>(null);
  // 串话修复：记录「系统替换会话 id（temp→real / system-init 导航）」的目标会话 id。
  // 仅当当前选中会话 == 该目标时，isSystemSessionChange 的「不清屏/不重载」豁免才生效；
  // 一旦用户在豁免窗口内切到无关会话，豁免立即作废，按真实切换正常加载，避免上一会话的
  // 乐观气泡残留到新会话视图（宝宝报告的「刚发出的消息出现在别的会话」）。null 时维持原行为。
  const systemSessionChangeTargetIdRef = useRef<string | null>(null);
  const [compactSummaryForNextTurn, setCompactSummaryForNextTurn] = useState<string | null>(null);
  const [queuedUserMessages, setQueuedUserMessages] = useState<ChatMessage[]>([]);
  const lastAutoCompactKeyRef = useRef<string | null>(null);
  // 压缩进行中标志：替代 currentSessionId=null 作为信号，避免导航守卫误触发
  const isCompactContinuationRef = useRef(false);
  // 跟踪当前压缩进度消息的 timestamp（用于 in-chat 更新）
  const compactMsgIdRef = useRef<number | null>(null);
  // Claude 原生压缩：是否已注入进行中指示器
  const claudeCompactIndicatorInjectedRef = useRef(false);

  const resetStreamingState = useCallback(() => {
    if (streamTimerRef.current) {
      clearTimeout(streamTimerRef.current);
      streamTimerRef.current = null;
    }
    streamBufferRef.current = '';
  }, []);

  const {
    provider,
    setProvider,
    cursorModel,
    setCursorModel,
    claudeModel,
    setClaudeModel,
    claudeEffort,
    setClaudeEffort,
    codexModel,
    setCodexModel,
    codexReasoningEffort,
    setCodexReasoningEffort,
    codexSpeed,
    setCodexSpeed,
    geminiModel,
    setGeminiModel,
    permissionMode,
    setPermissionMode,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    cyclePermissionMode,
  } = useChatProviderState({
    selectedSession,
    selectedProject,
  });

  const {
    chatMessages,
    setChatMessages,
    isLoading,
    setIsLoading,
    currentSessionId,
    setCurrentSessionId,
    sessionMessages,
    setSessionMessages,
    isLoadingSessionMessages,
    isLoadingMoreMessages,
    hasMoreMessages,
    totalMessages,
    isSystemSessionChange,
    setIsSystemSessionChange,
    canAbortSession,
    setCanAbortSession,
    isUserScrolledUp,
    setIsUserScrolledUp,
    tokenBudget,
    setTokenBudget,
    refreshTokenUsage,
    visibleMessageCount,
    visibleMessages,
    loadEarlierMessages,
    allMessagesLoaded,
    isLoadingAllMessages: isLoadingAllHistoryMessages,
    claudeStatus,
    setClaudeStatus,
    createDiff,
    scrollContainerRef,
    scrollToBottom,
    scrollToBottomAndReset,
    handleScroll,
    handleUserScrollIntent,
  } = useChatSessionState({
    selectedProject,
    selectedSession,
    ws,
    sendMessage,
    autoScrollToBottom,
    externalMessageUpdate,
    processingSessions,
    activeSessions,
    isConnected,
    resetStreamingState,
    pendingViewSessionRef,
    systemSessionChangeTargetIdRef,
  });

  const queueScopeKey = selectedSession?.id || currentSessionId || null;
  // The session registry is authoritative during reconnects. `isLoading` can
  // briefly be false while a refreshed view is still attached to a running turn.
  const isCurrentTurnActive = [currentSessionId, selectedSession?.id]
    .filter((id): id is string => Boolean(id))
    .some((id) => Boolean(activeSessions?.has(id) || processingSessions?.has(id)));
  const handleQueueMessage = useCallback(({
    id,
    text,
    sourceClientTs,
  }: { id: string; text: string; sourceClientTs?: number }) => {
    setQueuedUserMessages((previous) => {
      const duplicate = previous.some((message) =>
        message.queueId === id ||
        (sourceClientTs !== undefined && message.clientTs === sourceClientTs),
      );
      if (duplicate) return previous;
      return [...previous, {
        type: 'user',
        content: text,
        timestamp: new Date(),
        clientTs: sourceClientTs,
        pending: true,
        queuedStatus: 'queued',
        queueId: id,
        provider,
      }];
    });
    // Sending while reading history must not release the user's scroll lock.
    setTimeout(() => scrollToBottom(), 0);
  }, [provider, scrollToBottom]);

  const removeQueuedMessages = useCallback((ids: string[]) => {
    const queuedIds = new Set(ids);
    setQueuedUserMessages((previous) => previous.filter((message) => !queuedIds.has(message.queueId || '')));
  }, []);

  useEffect(() => {
    setQueuedUserMessages([]);
  }, [selectedProject?.name, selectedSession?.id]);

  const {
    input,
    setInput,
    textareaRef,
    inputHighlightRef,
    isTextareaExpanded,
    slashCommandsCount,
    filteredCommands,
    frequentCommands,
    commandQuery,
    showCommandMenu,
    selectedCommandIndex,
    resetCommandMenuState,
    handleCommandSelect,
    handleToggleCommandMenu,
    showFileDropdown,
    filteredFiles,
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    attachedImages,
    setAttachedImages,
    uploadingImages,
    imageErrors,
    getRootProps,
    getInputProps,
    isDragActive,
    openImagePicker,
    handleSubmit,
    handleInputChange,
    handleCompositionStart,
    handleCompositionEnd,
    handleKeyDown,
    handlePaste,
    handleTextareaClick,
    handleTextareaInput,
    syncInputOverlayScroll,
    handleClearInput,
    handleAbortSession,
    handleTranscript,
    handlePermissionDecision,
    handleGrantToolPermission,
    handleInputFocusChange,
    isInputFocused,
    programmaticSubmit,
  } = useChatComposerState({
    selectedProject,
    selectedSession,
    currentSessionId,
    provider,
    permissionMode,
    cyclePermissionMode,
    cursorModel,
    claudeModel,
    claudeEffort,
    codexModel,
    codexReasoningEffort,
    codexSpeed,
    geminiModel,
    isLoading,
    canAbortSession,
    tokenBudget,
    chatMessages,
    sendMessage,
    sendByCtrlEnter,
    onSessionActive,
    onSessionInactive,
    onSessionProcessing,
    onSessionNotProcessing,
    onInputFocusChange,
    onFileOpen,
    onShowSettings,
    compactSummaryForNextTurn,
    onCompactSummaryConsumed: () => setCompactSummaryForNextTurn(null),
    onStartVisualContinuation: () => {
      isCompactContinuationRef.current = true;
      try { sessionStorage.setItem('compactContinuationPending', '1'); } catch { /* ignore */ }
    },
    pendingViewSessionRef,
    // Composer submissions follow the bottom only when it is already unlocked.
    // The explicit “回到底部” button remains the sole reset action.
    scrollToBottomAndReset: scrollToBottom,
    setChatMessages,
    setSessionMessages,
    setIsLoading,
    setCanAbortSession,
    setClaudeStatus,
    setPendingPermissionRequests,
  });

  // 更新 in-chat 压缩进度消息
  const updateCompactProgress = useCallback((progress: number, done = false) => {
    const id = compactMsgIdRef.current;
    if (id === null) return;
    setChatMessages((prev) => prev.map((msg) =>
      msg.timestamp === id && msg.type === 'compact-progress'
        ? { ...msg, compactProgress: progress, compactDone: done }
        : msg
    ));
    if (done) compactMsgIdRef.current = null;
  }, [setChatMessages]);

  const applyAutoCompact = useCallback((source: 'auto-compact' | 'context-overflow' = 'auto-compact', force = false) => {
    // Claude 使用自身的原生压缩机制（isCompactSummary），不做 UI-side 压缩
    if (provider === 'claude') return false;
    if (!AUTO_COMPACT_ENABLED || (!force && compactSummaryForNextTurn) || chatMessages.length === 0) {
      return false;
    }

    const sourceSessionId = currentSessionId || selectedSession?.id;
    if (!sourceSessionId || sourceSessionId.startsWith('new-session-')) {
      return false;
    }

    const used = readTokenNumber(tokenBudget?.used) || estimateUiTokens(
      chatMessages
        .map((message) => stringifyMessageContent(message.content || message.reasoning || message.toolInput || message.toolResult))
        .join('\n'),
    );
    const total = readTokenNumber(tokenBudget?.total) || DEFAULT_CONTEXT_WINDOW;
    if (!force && provider === 'codex' && tokenBudget && used > total) {
      return false;
    }
    const compactKey = `${sourceSessionId}:${source}:${Math.floor((used / total) * 1000)}:${chatMessages.length}`;
    if (!force && lastAutoCompactKeyRef.current === compactKey) {
      return false;
    }

    const providerLabel = getProviderLabel(provider);
    const compactSummary = buildAutoCompactSummary(chatMessages, providerLabel, used, total);
    const compactedUsage = estimateUiTokens(compactSummary);
    lastAutoCompactKeyRef.current = compactKey;
    setCompactSummaryForNextTurn(compactSummary);
    // 不清除 currentSessionId：保留旧 session ID 以阻止导航守卫的 !currentSessionId 条件
    // 双重保护：ref（跨渲染）+ sessionStorage（跨 ref 被误清的情况）
    isCompactContinuationRef.current = true;
    try {
      sessionStorage.setItem('compactContinuationPending', '1');
      sessionStorage.setItem('compactContinuationSourceSessionId', sourceSessionId);
      if (selectedProject?.name) {
        sessionStorage.setItem('compactContinuationSourceProjectName', selectedProject.name);
      }
    } catch { /* ignore */ }
    setIsLoading(false);
    setCanAbortSession(false);
    setClaudeStatus(null);
    setPendingPermissionRequests([]);
    setTokenBudget({
      used: compactedUsage,
      total,
      provider,
      source,
      compactedFromSessionId: sourceSessionId,
      compactedAt: Date.now(),
    });
    try {
      sessionStorage.removeItem('pendingSessionId');
      sessionStorage.removeItem('cursorSessionId');
      sessionStorage.removeItem('task_start_time');
    } catch { /* ignore */ }

    // 里程碑1：客户端摘要生成完毕 → 注入 in-chat 进度条消息（10%），等待后续事件推进
    const compactMsgTimestamp = Date.now();
    compactMsgIdRef.current = compactMsgTimestamp;

    setChatMessages((previous) => {
      const recentMessages = previous
        .filter((message) => !message.pending && !message.sendFailed && !message.isCompactSummary)
        .slice(-AUTO_COMPACT_RECENT_MESSAGES);
      return [
        {
          type: 'assistant',
          content: compactSummary,
          timestamp: new Date(),
          isCompactSummary: true,
        },
        ...recentMessages,
        {
          type: 'compact-progress',
          compactProgress: 10,
          compactDone: false,
          timestamp: compactMsgTimestamp,
        },
      ];
    });
    return true;
  }, [
    chatMessages,
    compactSummaryForNextTurn,
    currentSessionId,
    provider,
    selectedSession?.id,
    selectedProject?.name,
    setCanAbortSession,
    setChatMessages,
    setClaudeStatus,
    setCurrentSessionId,
    setIsLoading,
    setPendingPermissionRequests,
    setTokenBudget,
    tokenBudget,
  ]);

  const handleContextOverflow = useCallback(() => {
    applyAutoCompact('context-overflow', true);
  }, [applyAutoCompact]);

  const guardedOnNavigateToSession = useCallback((targetSessionId: string) => {
    if (isCompactContinuationRef.current) return;
    try { if (sessionStorage.getItem('compactContinuationPending') === '1') return; } catch { /* ignore */ }
    onNavigateToSession?.(targetSessionId);
  }, [onNavigateToSession]);

  // ── Claude 原生压缩动画（两个真实信号驱动）────────────────────────────────
  // compact-start：压缩已完成，Claude 正在新 session 中回复 → 快速跳到 70%，缓慢爬向 92%
  // claude-complete：Claude 回复结束 → 跳到 100%，变绿
  const claudeCompactCrawlRafRef = useRef<number | null>(null);

  const handleClaudeCompactStart = useCallback(() => {
    if (claudeCompactIndicatorInjectedRef.current) return;
    claudeCompactIndicatorInjectedRef.current = true;
    const ts = Date.now();
    compactMsgIdRef.current = ts;
    setChatMessages((prev) => [
      ...prev,
      { type: 'compact-progress', compactProgress: 0, compactDone: false, timestamp: ts },
    ]);
    // compact-start 触发时压缩已完成，快速跳到 70%，再缓慢爬行到 92% 等 claude-complete
    setTimeout(() => {
      updateCompactProgress(70);
      const crawlStart = Date.now();
      const crawlDuration = 20000;
      const crawl = () => {
        const t = Math.min(1, (Date.now() - crawlStart) / crawlDuration);
        const p = Math.floor(70 + (1 - Math.pow(1 - t, 2)) * 22); // 70→92, ease-out
        updateCompactProgress(p);
        if (t < 1) claudeCompactCrawlRafRef.current = requestAnimationFrame(crawl);
      };
      claudeCompactCrawlRafRef.current = requestAnimationFrame(crawl);
    }, 400);
  }, [setChatMessages, updateCompactProgress]);

  const handleClaudeNativeCompactComplete = useCallback(() => {
    if (!claudeCompactIndicatorInjectedRef.current) return;
    if (claudeCompactCrawlRafRef.current !== null) {
      cancelAnimationFrame(claudeCompactCrawlRafRef.current);
      claudeCompactCrawlRafRef.current = null;
    }
    claudeCompactIndicatorInjectedRef.current = false;
    updateCompactProgress(100, true);
  }, [updateCompactProgress]);

  useChatRealtimeHandlers({
    latestMessage,
    provider,
    selectedProject,
    selectedSession,
    currentSessionId,
    setCurrentSessionId,
    setChatMessages,
    setIsLoading,
    setCanAbortSession,
    setClaudeStatus,
    setTokenBudget,
    setIsSystemSessionChange,
    setPendingPermissionRequests,
    pendingViewSessionRef,
    systemSessionChangeTargetIdRef,
    streamBufferRef,
    streamTimerRef,
    onSessionActive,
    onSessionInactive,
    onSessionProcessing,
    onSessionNotProcessing,
    onReplaceTemporarySession,
    onNavigateToSession: guardedOnNavigateToSession,
    setPermissionMode,
    onContextOverflow: handleContextOverflow,
    isCompactContinuationRef,
    onCompactSessionCreated: () => updateCompactProgress(50),
    onCompactComplete: () => updateCompactProgress(100, true),
    onClaudeCompactStart: handleClaudeCompactStart,
    onClaudeNativeCompactComplete: handleClaudeNativeCompactComplete,
    incomingMsgQueueRef,
    incomingMsgVersion,
    isLoading,
    isConnected,
    sendMessage,
  });

  useEffect(() => {
    setCompactSummaryForNextTurn(null);
    lastAutoCompactKeyRef.current = null;
  }, [selectedProject?.name, selectedSession?.id]);

  useEffect(() => {
    if (!AUTO_COMPACT_ENABLED && compactSummaryForNextTurn) {
      setCompactSummaryForNextTurn(null);
      lastAutoCompactKeyRef.current = null;
    }
  }, [compactSummaryForNextTurn]);

  useEffect(() => {
    // Claude 使用自身原生压缩，不做 UI-side 监控
    if (provider === 'claude') return;
    if (!AUTO_COMPACT_ENABLED || isLoading || compactSummaryForNextTurn || chatMessages.length === 0) {
      return;
    }

    // 与 applyAutoCompact 内部 fallback 保持一致：token-budget 缺失时（如 Cursor）用消息内容估算
    const used = readTokenNumber(tokenBudget?.used) || (!tokenBudget ? estimateUiTokens(
      chatMessages.map((m) => stringifyMessageContent(m.content || m.reasoning || m.toolInput || m.toolResult)).join('\n'),
    ) : 0);
    const total = readTokenNumber(tokenBudget?.total) || (!tokenBudget ? DEFAULT_CONTEXT_WINDOW : 0);
    if (provider === 'codex' && tokenBudget && used > total) {
      return;
    }
    const effectiveMinUsedTokens = Math.min(AUTO_COMPACT_MIN_USED_TOKENS, Math.floor(total * AUTO_COMPACT_THRESHOLD));

    if (!used || !total || used < effectiveMinUsedTokens || used / total < AUTO_COMPACT_THRESHOLD) {
      return;
    }

    applyAutoCompact('auto-compact');
  }, [
    applyAutoCompact,
    chatMessages,
    compactSummaryForNextTurn,
    isLoading,
    tokenBudget,
  ]);

  // 切换 session/project 时重置标志并取消爬行动画
  useEffect(() => {
    claudeCompactIndicatorInjectedRef.current = false;
    if (claudeCompactCrawlRafRef.current !== null) {
      cancelAnimationFrame(claudeCompactCrawlRafRef.current);
      claudeCompactCrawlRafRef.current = null;
    }
  }, [selectedSession?.id, selectedProject?.name]);

  // ── 提取最新 TodoWrite 任务列表，推送到全局 Progress 面板 ───────────
  const { setTodos, clearTodos } = useTodoProgress();
  useEffect(() => {
    // 找出最后一条 TodoWrite tool_use 消息
    for (let i = chatMessages.length - 1; i >= 0; i--) {
      const msg = chatMessages[i];
      if (msg.isToolUse && msg.toolName === 'TodoWrite' && msg.toolInput) {
        try {
          const input = typeof msg.toolInput === 'string'
            ? JSON.parse(msg.toolInput)
            : msg.toolInput;
          if (Array.isArray(input?.todos)) {
            setTodos(input.todos, currentSessionId);
            return;
          }
        } catch {
          // 解析失败则跳过
        }
      }
    }
    // 如果当前 session 没有任何 TodoWrite，则清空
    clearTodos();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatMessages, currentSessionId]);

  useEffect(() => {
    if (!isLoading || !canAbortSession) {
      return;
    }

    const handleGlobalEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.repeat || event.defaultPrevented) {
        return;
      }

      event.preventDefault();
      handleAbortSession();
    };

    document.addEventListener('keydown', handleGlobalEscape, { capture: true });
    return () => {
      document.removeEventListener('keydown', handleGlobalEscape, { capture: true });
    };
  }, [canAbortSession, handleAbortSession, isLoading]);

  const supportsLiveBtw = provider === 'claude' || provider === 'codex' || !BUILTIN_PROVIDERS.has(provider);

  useEffect(() => {
    return () => {
      resetStreamingState();
    };
  }, [resetStreamingState]);

  // 删除单条消息（用对象引用匹配，兼容 visibleMessages 切片场景）
  const handleDeleteMessage = useCallback((messageToDelete: import('../types/types').ChatMessage) => {
    setChatMessages((prev) => prev.filter((m) => m !== messageToDelete));
  }, [setChatMessages]);

  // 图片尺寸错误后新建会话：清空当前会话状态，下次发送消息时将自动创建新会话
  const handleStartNewSession = useCallback(() => {
    setChatMessages([]);
    setCurrentSessionId(null);
    setIsLoading(false);
    setCanAbortSession(false);
    setClaudeStatus(null);
    // 主动新建会话：清掉上一轮未采纳的新会话占位，否则 handleSubmit 的串话守卫会误拦本次新建
    pendingViewSessionRef.current = null;
    systemSessionChangeTargetIdRef.current = null;
  }, [setChatMessages, setCurrentSessionId, setIsLoading, setCanAbortSession, setClaudeStatus]);

  // 侧边栏「新建会话」按钮：通过自增的 newSessionNonce 强制重置聊天状态。
  // 当 selectedSession 已是 null（例如刚在全新会话里发过一轮消息）时，selectedSession?.id
  // 不变，加载 effect 不会重跑，导致点击「没反应」；此处直接复用图片错误时的重置路径。
  const prevNewSessionNonceRef = useRef(newSessionNonce);
  useEffect(() => {
    if (prevNewSessionNonceRef.current === newSessionNonce) return;
    prevNewSessionNonceRef.current = newSessionNonce;
    handleStartNewSession();
  }, [newSessionNonce, handleStartNewSession]);

  // 编辑消息
  const handleEditMessage = useCallback((messageToEdit: import('../types/types').ChatMessage, newContent: string) => {
    if (messageToEdit.type === 'user') {
      // 用户消息：截断该消息及之后的所有内容，重新发送
      setChatMessages((prev) => {
        const idx = prev.indexOf(messageToEdit);
        return idx === -1 ? prev : prev.slice(0, idx);
      });
      programmaticSubmit(newContent);
    } else {
      // Claude 消息：仅本地更新内容
      setChatMessages((prev) =>
        prev.map((m) => m === messageToEdit ? { ...m, content: newContent } : m)
      );
    }
  }, [setChatMessages, programmaticSubmit]);

  if (!selectedProject) {
    const selectedProviderLabel = getProviderLabel(provider);

    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center text-muted-foreground">
          <p className="text-sm">
            {t('projectSelection.startChatWithProvider', {
              provider: selectedProviderLabel,
              defaultValue: 'Select a project to start chatting with {{provider}}',
            })}
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="h-full flex flex-col">
        <div className="relative flex-1 min-h-0 overflow-hidden flex flex-col">
	        <ChatMessagesPane
          scrollContainerRef={scrollContainerRef}
          onWheel={handleUserScrollIntent}
          onTouchMove={handleUserScrollIntent}
          isLoadingSessionMessages={isLoadingSessionMessages}
          chatMessages={chatMessages}
          queuedUserMessages={queuedUserMessages}
          selectedSession={selectedSession}
          currentSessionId={currentSessionId}
          provider={provider}
          setProvider={(nextProvider) => {
            const previousProvider = provider;
            if (nextProvider !== previousProvider) {
              setChatMessages((previous) =>
                previous.map((message) =>
                  message.type === 'assistant' && !message.provider
                    ? { ...message, provider: previousProvider }
                    : message,
                ),
              );
            }
            setProvider(nextProvider as Provider);
          }}
          textareaRef={textareaRef}
          claudeModel={claudeModel}
          setClaudeModel={setClaudeModel}
          cursorModel={cursorModel}
          setCursorModel={setCursorModel}
          codexModel={codexModel}
          setCodexModel={setCodexModel}
          codexReasoningEffort={codexReasoningEffort}
          setCodexReasoningEffort={setCodexReasoningEffort}
          codexSpeed={codexSpeed}
          setCodexSpeed={setCodexSpeed}
          geminiModel={geminiModel}
          setGeminiModel={setGeminiModel}
          tasksEnabled={tasksEnabled}
          isTaskMasterInstalled={isTaskMasterInstalled}
          onShowAllTasks={onShowAllTasks}
          setInput={setInput}
          isLoadingMoreMessages={isLoadingMoreMessages}
          hasMoreMessages={hasMoreMessages}
          totalMessages={totalMessages}
          sessionMessagesCount={sessionMessages.length}
          visibleMessageCount={visibleMessageCount}
          visibleMessages={visibleMessages}
          loadEarlierMessages={loadEarlierMessages}
          allMessagesLoaded={allMessagesLoaded}
          isLoadingAllMessages={isLoadingAllHistoryMessages}
          createDiff={createDiff}
          onFileOpen={onFileOpen}
          onShowSettings={onShowSettings}
          onGrantToolPermission={handleGrantToolPermission}
          autoExpandTools={autoExpandTools}
          showRawParameters={showRawParameters}
          showThinking={showThinking}
          selectedProject={selectedProject}
          isLoading={isLoading}
          isCurrentTurnActive={isCurrentTurnActive}
          onDeleteMessage={handleDeleteMessage}
          onEditMessage={handleEditMessage}
          onStartNewSession={handleStartNewSession}
          isUserScrolledUp={isUserScrolledUp}
	          onScrollToBottom={scrollToBottomAndReset}
	        />
        </div>{/* end messages area wrapper */}

        <ChatComposer
          sessionId={currentSessionId || selectedSession?.id || null}
          pendingPermissionRequests={pendingPermissionRequests}
          handlePermissionDecision={handlePermissionDecision}
          handleGrantToolPermission={handleGrantToolPermission}
          claudeStatus={claudeStatus}
          isLoading={isLoading}
          onAbortSession={handleAbortSession}
          provider={provider}
          setProvider={(nextProvider) => setProvider(nextProvider as Provider)}
          permissionMode={permissionMode}
          onModeSwitch={cyclePermissionMode}
          tokenBudget={tokenBudget}
          onRefreshTokenUsage={refreshTokenUsage}
          slashCommandsCount={slashCommandsCount}
          onToggleCommandMenu={handleToggleCommandMenu}
          hasInput={Boolean(input.trim())}
          onClearInput={handleClearInput}
          isUserScrolledUp={isUserScrolledUp}
          hasMessages={chatMessages.length > 0}
          onScrollToBottom={scrollToBottomAndReset}
          onSubmit={handleSubmit}
          isDragActive={isDragActive}
          attachedImages={attachedImages}
          onRemoveImage={(index) =>
            setAttachedImages((previous) =>
              previous.filter((_, currentIndex) => currentIndex !== index),
            )
          }
          uploadingImages={uploadingImages}
          imageErrors={imageErrors}
          showFileDropdown={showFileDropdown}
          filteredFiles={filteredFiles}
          selectedFileIndex={selectedFileIndex}
          onSelectFile={selectFile}
          filteredCommands={filteredCommands}
          selectedCommandIndex={selectedCommandIndex}
          onCommandSelect={handleCommandSelect}
          onCloseCommandMenu={resetCommandMenuState}
          isCommandMenuOpen={showCommandMenu}
          frequentCommands={commandQuery ? [] : frequentCommands}
          getRootProps={getRootProps as (...args: unknown[]) => Record<string, unknown>}
          getInputProps={getInputProps as (...args: unknown[]) => Record<string, unknown>}
          openImagePicker={openImagePicker}
          inputHighlightRef={inputHighlightRef}
          renderInputWithMentions={renderInputWithMentions}
          textareaRef={textareaRef}
          input={input}
          onInputChange={handleInputChange}
          onCompositionStart={handleCompositionStart}
          onCompositionEnd={handleCompositionEnd}
          onTextareaClick={handleTextareaClick}
          onTextareaKeyDown={handleKeyDown}
          onTextareaPaste={handlePaste}
          onTextareaScrollSync={syncInputOverlayScroll}
          onTextareaInput={handleTextareaInput}
          onInputFocusChange={handleInputFocusChange}
          isInputFocused={isInputFocused}
          placeholder={t('input.placeholder', {
            provider: getProviderLabel(provider),
          })}
          isTextareaExpanded={isTextareaExpanded}
          sendByCtrlEnter={sendByCtrlEnter}
          onTranscript={handleTranscript}
          onBtwMessage={supportsLiveBtw ? (text: string) => {
            const targetSessionId = currentSessionId || selectedSession?.id || null;
            if (!targetSessionId || targetSessionId.startsWith('new-session-')) {
              return false;
            }
            // 将 BTW 消息立即显示在聊天记录中，状态先标「发送中」，
            // 等后端 btw-result 回执再更新为「已送达」或「未送达」（诚实回执）
            const btwId = Date.now() + Math.floor(Math.random() * 1000);
            setChatMessages((prev) => [
              ...prev,
              {
                type: 'user',
                content: text,
                timestamp: new Date(btwId),
                clientTs: btwId,
                provider,
                isBtw: true,
                btwId,
                btwStatus: 'pending',
              },
            ]);
            sendMessage({
              type: provider === 'codex' ? 'codex-steer' : 'claude-btw',
              sessionId: targetSessionId,
              message: text,
              clientTs: btwId,
            });
            return true;
          } : undefined}
          onQueueMessage={handleQueueMessage}
          onDequeueMessage={(id) => removeQueuedMessages([id])}
          onDiscardQueuedMessages={removeQueuedMessages}
          queueScopeKey={queueScopeKey}
          canDispatchQueuedMessage={Boolean(
            currentSessionId || (selectedSession?.id && !selectedSession.id.startsWith('new-session-')),
          )}
          claudeModel={claudeModel}
          setClaudeModel={setClaudeModel}
          claudeEffort={claudeEffort}
          setClaudeEffort={setClaudeEffort}
          cursorModel={cursorModel}
          setCursorModel={setCursorModel}
          codexModel={codexModel}
          setCodexModel={setCodexModel}
          codexReasoningEffort={codexReasoningEffort}
          setCodexReasoningEffort={setCodexReasoningEffort}
          codexSpeed={codexSpeed}
          setCodexSpeed={setCodexSpeed}
          geminiModel={geminiModel}
          setGeminiModel={setGeminiModel}
        />
      </div>

      <QuickSettingsPanel />
    </>
  );
}

export default React.memo(ChatInterface);
