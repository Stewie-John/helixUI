import React, { useEffect, useRef } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { decodeHtmlEntities, formatUsageLimitText } from '../utils/chatFormatting';
import { safeLocalStorage } from '../utils/chatStorage';
import { rememberCompactContinuationSession, resolveCompactContinuationInfoForProject } from '../utils/compactContinuations';
import { publishTokenBudgetSnapshot } from '../utils/tokenBudgetEvents';
import { addSessionTokens, setLiveSessionTokens, clearLiveSessionTokens } from '../utils/sessionTokenTotals';
import {
  clearPersistedActiveTurnStatus,
  getPersistedActiveTurnStatus,
  persistActiveTurnStatus,
} from '../utils/activeTurnStatusStorage';
import type { ChatMessage, PermissionMode, PendingPermissionRequest } from '../types/types';
import type { Project, ProjectSession, SessionProvider } from '../../../types/app';

type PendingViewSession = {
  sessionId: string | null;
  startedAt: number;
};

type LatestChatMessage = {
  type?: string;
  data?: any;
  sessionId?: string;
  requestId?: string;
  toolName?: string;
  input?: unknown;
  context?: unknown;
  error?: string;
  tool?: string;
  exitCode?: number;
  isProcessing?: boolean;
  actualSessionId?: string;
  [key: string]: any;
};

type ClaudeStatusState = {
  text: string;
  tokens: number;
  inputTokens?: number;
  outputTokens?: number;
  startedAt?: number | string;
  can_interrupt: boolean;
};

interface UseChatRealtimeHandlersArgs {
  latestMessage: LatestChatMessage | null; // 保留向后兼容，主处理逻辑已切换为队列
  incomingMsgQueueRef?: React.MutableRefObject<any[]>;
  incomingMsgVersion?: number;
  // 卡死看门狗所需：isLoading 当前值、连接状态、发送通道
  isLoading?: boolean;
  isConnected?: boolean;
  sendMessage?: (message: Record<string, unknown>) => void;
  provider: SessionProvider;
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  setCurrentSessionId: (sessionId: string | null) => void;
  setChatMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  setIsLoading: (loading: boolean) => void;
  setCanAbortSession: (canAbort: boolean) => void;
  setClaudeStatus: Dispatch<SetStateAction<ClaudeStatusState | null>>;
  setTokenBudget: Dispatch<SetStateAction<Record<string, unknown> | null>>;
  setIsSystemSessionChange: (isSystemSessionChange: boolean) => void;
  setPendingPermissionRequests: Dispatch<SetStateAction<PendingPermissionRequest[]>>;
  pendingViewSessionRef: MutableRefObject<PendingViewSession | null>;
  systemSessionChangeTargetIdRef: MutableRefObject<string | null>;
  streamBufferRef: MutableRefObject<string>;
  streamTimerRef: MutableRefObject<number | null>;
  onSessionActive?: (sessionId?: string | null) => void;
  onSessionInactive?: (sessionId?: string | null) => void;
  onSessionProcessing?: (sessionId?: string | null) => void;
  onSessionNotProcessing?: (sessionId?: string | null) => void;
  onReplaceTemporarySession?: (sessionId?: string | null) => void;
  onNavigateToSession?: (sessionId: string) => void;
  setPermissionMode?: (mode: PermissionMode) => void;
  onContextOverflow?: () => void;
  isCompactContinuationRef?: MutableRefObject<boolean>;
  onCompactSessionCreated?: () => void;
  onCompactComplete?: () => void;
  onClaudeCompactStart?: () => void;        // Claude 原生压缩开始（session_id 中途变化）
  onClaudeNativeCompactComplete?: () => void; // Claude 回复结束（claude-complete 触发）
}

const appendStreamingChunk = (
  setChatMessages: Dispatch<SetStateAction<ChatMessage[]>>,
  chunk: string,
  newline = false,
) => {
  if (!chunk) {
    return;
  }

  setChatMessages((previous) => {
    const updated = [...previous];
    const lastIndex = updated.length - 1;
    const last = updated[lastIndex];
    if (last && last.type === 'assistant' && !last.isToolUse && last.isStreaming) {
      const nextContent = newline
        ? last.content
          ? `${last.content}\n${chunk}`
          : chunk
        : `${last.content || ''}${chunk}`;
      // Clone the message instead of mutating in place so React can reliably detect state updates.
      updated[lastIndex] = { ...last, content: nextContent };
    } else {
      updated.push({ type: 'assistant', content: chunk, timestamp: new Date(), isStreaming: true });
    }
    return updated;
  });
};

const finalizeStreamingMessage = (setChatMessages: Dispatch<SetStateAction<ChatMessage[]>>) => {
  setChatMessages((previous) => {
    const updated = [...previous];
    const lastIndex = updated.length - 1;
    const last = updated[lastIndex];
    if (last && last.type === 'assistant' && last.isStreaming) {
      // Clone the message instead of mutating in place so React can reliably detect state updates.
      updated[lastIndex] = { ...last, isStreaming: false };
    }
    return updated;
  });
};

const setLatestAssistantTurnCompletion = (
  setChatMessages: Dispatch<SetStateAction<ChatMessage[]>>,
  complete: boolean,
) => {
  setChatMessages((previous) => {
    let lastUserIndex = -1;
    for (let index = previous.length - 1; index >= 0; index -= 1) {
      if (previous[index].type === 'user') {
        lastUserIndex = index;
        break;
      }
    }
    let markerIndex = -1;
    for (let index = previous.length - 1; index > lastUserIndex; index -= 1) {
      if (previous[index].type !== 'user') {
        markerIndex = index;
        break;
      }
    }
    if (markerIndex < 0 || Boolean(previous[markerIndex].turnComplete) === complete) return previous;
    const updated = [...previous];
    const marker = updated[markerIndex];
    updated[markerIndex] = complete
      ? { ...marker, turnComplete: true, isStreaming: false }
      : { ...marker, turnComplete: false };
    return updated;
  });
};

const setRecoveredAssistantTurnCompletion = (
  setChatMessages: Dispatch<SetStateAction<ChatMessage[]>>,
) => {
  setChatMessages((previous) => {
    let lastUserIndex = -1;
    for (let index = previous.length - 1; index >= 0; index -= 1) {
      if (previous[index].type === 'user') {
        lastUserIndex = index;
        break;
      }
    }
    const currentTurn = previous.slice(lastUserIndex + 1);
    if (
      currentTurn.some((message) => message.type === 'error')
      || !currentTurn.some((message) => message.type === 'assistant')
    ) {
      return previous;
    }
    let markerIndex = -1;
    for (let index = previous.length - 1; index > lastUserIndex; index -= 1) {
      if (previous[index].type !== 'user') {
        markerIndex = index;
        break;
      }
    }
    if (markerIndex < 0 || previous[markerIndex].turnComplete) return previous;
    const updated = [...previous];
    updated[markerIndex] = { ...updated[markerIndex], turnComplete: true, isStreaming: false };
    return updated;
  });
};

// 整段助手消息的 text 块与"已流式渲染的气泡"去重/补全。
// 后端不再剥离整段消息的 text（断线会丢中途 delta），故这里把整段文本作为权威兜底：
//  - 若本回合内已有完全一致的助手文本气泡（正常流式已渲染）→ 跳过，避免重复；
//  - 若已有气泡是整段文本的【前缀】（断线丢了尾部 delta）或【后缀】（断线丢了开头
//    delta，气泡只剩句子尾部）→ 用完整文本替换该气泡，补回缺失的字；
//  - 若本回合内没有任何对应的助手文本气泡（delta 全丢）→ 追加该文本。
// 仅在「最近一个用户消息之后」的范围内匹配，绝不跨越用户消息，避免误并历史回复。
// 匹配自尾部向前、取最靠近的一个残缺气泡；残缺气泡必然短于全文，故 prefix/suffix
// 只会命中真正的同段残片，不会误并已完整渲染的其他段落。
const reconcileConsolidatedAssistantText = (
  previous: ChatMessage[],
  content: string,
): ChatMessage[] => {
  const incoming = content.trim();
  if (!incoming) return previous;
  let backfillIndex = -1;
  for (let i = previous.length - 1; i >= 0; i -= 1) {
    const m = previous[i];
    if (m.type === 'user') break; // 不跨越用户消息，限制在本回合
    if (m.type !== 'assistant' || m.isToolUse || m.isThinking || typeof m.content !== 'string') {
      continue;
    }
    const existing = m.content.trim();
    if (!existing) continue;
    if (existing === incoming) {
      return previous; // 流式已完整渲染：跳过，避免重复气泡
    }
    // 残缺气泡是全文的前缀（尾部丢失）或后缀（开头丢失）→ 视为同段残片，可回填。
    if (
      backfillIndex === -1 &&
      existing.length < incoming.length &&
      (incoming.startsWith(existing) || incoming.endsWith(existing))
    ) {
      backfillIndex = i; // 取最靠近尾部的一个残缺气泡
    }
  }
  if (backfillIndex !== -1) {
    const next = previous.slice();
    next[backfillIndex] = { ...next[backfillIndex], content, isStreaming: false };
    return next;
  }
  return [...previous, { type: 'assistant', content, timestamp: new Date() }];
};

const estimateTokenCount = (text: string) => {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
};

const stringifyCodexPayload = (payload: unknown) => {
  if (payload === null || payload === undefined || payload === '') return '';
  if (typeof payload === 'string') return payload;
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
};

const isContextOverflowError = (error: unknown) => {
  let text = '';
  if (typeof error === 'string') {
    text = error;
  } else {
    try {
      text = JSON.stringify(error);
    } catch {
      text = String(error ?? '');
    }
  }

  const normalized = text.toLowerCase();
  return (
    normalized.includes('context_length_exceeded') ||
    normalized.includes('exceeds the context window') ||
    normalized.includes('input exceeds the context') ||
    normalized.includes('context window of this model') ||
    normalized.includes('context length exceeded')
  );
};

const parseStartedAt = (startedAt: unknown) => {
  if (typeof startedAt === 'number' && Number.isFinite(startedAt)) return startedAt;
  if (typeof startedAt === 'string' && startedAt.trim()) {
    const numeric = Number(startedAt);
    if (Number.isFinite(numeric)) return numeric;
    const parsed = Date.parse(startedAt);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const persistProcessingStartedAt = (sessionId: string, startedAt: unknown) => {
  const parsedStartedAt = parseStartedAt(startedAt);
  if (!parsedStartedAt) return;
  try {
    const raw = sessionStorage.getItem('processing_sessions');
    const parsed = raw ? JSON.parse(raw) : [];
    const records = Array.isArray(parsed)
      ? parsed.map((item) =>
          typeof item === 'string'
            ? { id: item, startedAt: parsedStartedAt }
            : { id: String(item?.id || ''), startedAt: Number(item?.startedAt || parsedStartedAt) },
        )
      : [];
    const index = records.findIndex((record) => record.id === sessionId);
    if (index >= 0) {
      records[index] = { ...records[index], startedAt: parsedStartedAt };
    } else {
      records.push({ id: sessionId, startedAt: parsedStartedAt });
    }
    sessionStorage.setItem('processing_sessions', JSON.stringify(records.filter((record) => record.id)));
  } catch { /* ignore */ }
};

const getDefaultContextWindow = (provider: SessionProvider) => {
  if (provider === 'gemini') return 1_000_000;
  if (provider === 'codex') return Number(import.meta.env.VITE_CODEX_CONTEXT_WINDOW) || 1_050_000;
  if (provider === 'cursor') return 200_000;
  return Number(import.meta.env.VITE_CONTEXT_WINDOW) || 200_000;
};

const readPositiveNumber = (...values: unknown[]) => {
  for (const value of values) {
    const numberValue = Number(value);
    if (Number.isFinite(numberValue) && numberValue > 0) {
      return numberValue;
    }
  }
  return 0;
};

const readNumber = (value: unknown) => {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : 0;
};

const buildTokenBudgetFromStatus = (
  statusInfo: ClaudeStatusState,
  statusData: Record<string, any> | string,
  provider: SessionProvider,
  sessionId: string | undefined,
) => {
  const structuredStatus = statusData && typeof statusData === 'object' ? statusData : {};
  // Only trust structured token usage from provider payloads.
  // Do not use UI-side estimates (statusInfo.tokens / input+output), which can spike and
  // make the context usage indicator inaccurate.
  const used = readPositiveNumber(
    structuredStatus.used,
    structuredStatus.totalUsed,
    structuredStatus.total_tokens,
    structuredStatus.token_count,
  );
  if (!used) {
    return null;
  }

  const total =
    readPositiveNumber(
      structuredStatus.total,
      structuredStatus.contextWindow,
      structuredStatus.context_window,
      structuredStatus.model_context_window,
    ) || getDefaultContextWindow(provider);

  return {
    used,
    total,
    provider,
    sessionId,
    source: 'status',
  };
};

const mergeTokenBudget = (
  previousBudget: Record<string, unknown> | null,
  incomingBudget: Record<string, unknown>,
) => {
  const previousSessionId = typeof previousBudget?.sessionId === 'string' ? previousBudget.sessionId : null;
  const previousProvider = typeof previousBudget?.provider === 'string' ? previousBudget.provider : null;
  const incomingSessionId = typeof incomingBudget.sessionId === 'string' ? incomingBudget.sessionId : null;
  const incomingProvider = typeof incomingBudget.provider === 'string' ? incomingBudget.provider : null;
  const sameSession = Boolean(previousSessionId && incomingSessionId && previousSessionId === incomingSessionId);
  const sameProvider = Boolean(previousProvider && incomingProvider && previousProvider === incomingProvider);
  const inheritsCurrentSession = Boolean(previousSessionId && !incomingSessionId && sameProvider);

  // Session-scoped token budgets must not be merged across sessions, even when
  // they come from the same provider. Background completions can otherwise pull
  // the visible context meter backward or forward for the active conversation.
  if (previousBudget && previousSessionId && incomingSessionId && previousSessionId !== incomingSessionId) {
    return previousBudget;
  }

  // If budget belongs to another conversation/provider, replace only when no prior budget exists.
  // This prevents cross-session/provider noise from driving the current context meter.
  if (previousBudget && !sameSession && !sameProvider) {
    return previousBudget;
  }

  const previousUsed = Number(previousBudget?.used || 0);
  const incomingUsed = Number(incomingBudget.used || 0);
  // Monotonic growth only makes sense within one concrete session.
  // Across different sessions (even same provider), keep the incoming value so
  // old high-water marks don't pin the meter at 100%.
  const used = sameSession || inheritsCurrentSession
    ? Math.max(previousUsed, incomingUsed)
    : incomingUsed;

  return {
    ...previousBudget,
    ...incomingBudget,
    sessionId: incomingSessionId || previousSessionId || undefined,
    used,
  };
};

// 卡死看门狗：静默（无任何真实 SDK 活动）超过此阈值才向后端对账，避免误伤健康的流式/长工具。
// 取 12s：claude-status 在思考/工具执行期会周期性刷新 lastRealActivity，健康 turn 几乎不会静默 12s；
// 且需 >8s（session-status=false 分支的 recentlyActive 宽限窗）才能即时清状态，否则还要再等 6s。
// 即便长思考期误触发轮询，后端也只会回 isProcessing=true（无害、不清），不会造成"工作中"闪烁。
const STUCK_WATCHDOG_SILENCE_MS = 12000;
// 看门狗轮询间隔（5s）：配合 12s 静默阈值，把"claude-complete 丢失→工作中残留"的最坏清除延迟
// 从原来的 ~30-40s 压到 ~12-17s，显著更"及时"。
const STUCK_WATCHDOG_POLL_MS = 5000;

export function useChatRealtimeHandlers({
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
  onNavigateToSession,
  setPermissionMode,
  onContextOverflow,
  isCompactContinuationRef,
  onCompactSessionCreated,
  onCompactComplete,
  onClaudeCompactStart,
  onClaudeNativeCompactComplete,
  incomingMsgQueueRef,
  incomingMsgVersion,
  isLoading,
  isConnected,
  sendMessage,
}: UseChatRealtimeHandlersArgs) {
  const lastProcessedMessageRef = useRef<LatestChatMessage | null>(null);
  // 记录最近一次收到真实内容消息的时间，用于检测 stale loading 状态
  const lastRealActivityRef = useRef<number>(0);
  // True after this live socket has observed the command/turn. An idle poll must
  // be confirmed twice before it may recover a missed terminal provider event.
  const authoritativeTurnInFlightRef = useRef(false);
  // Monotonic client timestamp for the newest command visible in this tab.
  // Terminal events from an older queued/steered turn must not close it.
  const currentTurnClientTsRef = useRef(0);
  // 超时计时器：session-status 触发 isLoading=true 后，若 10min 内无真实消息则自动清除
  const staleLoadingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idleStatusConfirmationRef = useRef<{ sessionId: string; firstSeenAt: number } | null>(null);
  // 跟踪上一次的 currentSessionId，用于检测 session 切换并重置哨兵
  const prevCurrentSessionIdRef = useRef<string | null>(currentSessionId);
  // 压缩会话别名：Claude 原生压缩会在 turn 中途把 session_id 换成新 id，
  // 后端随之用新 id 发送后续流式块与 claude-complete。此 Map 记录「新 id → 当前视图旧 id」，
  // 让会话过滤器把这些新 id 消息仍归属到当前视图（避免输出冻结 + 工作中状态残留）。
  const compactSessionAliasRef = useRef<Map<string, string>>(new Map());

  // 关键修复：session 切换时重置 lastRealActivityRef 哨兵。
  // 哨兵值 -1 在上一 session 完成时设置，用于防止延迟消息重新点亮 loading。
  // 但切换到新活跃 session 时若不重置，新 session 的 session-status isProcessing=true
  // 会被哨兵拦截（break），导致工作中状态永远不显示。
  useEffect(() => {
    if (prevCurrentSessionIdRef.current !== currentSessionId && currentSessionId !== null) {
      prevCurrentSessionIdRef.current = currentSessionId;
      if (lastRealActivityRef.current === -1) {
        lastRealActivityRef.current = 0;
      }
      const restoredTurn = getPersistedActiveTurnStatus(currentSessionId);
      currentTurnClientTsRef.current = Number(
        restoredTurn?.startedAt ? new Date(restoredTurn.startedAt).getTime() : 0,
      );
      // 切换会话：清空上一个会话遗留的压缩别名，防止误把新视图消息归属错乱
      compactSessionAliasRef.current.clear();
    }
  }, [currentSessionId]);

  useEffect(() => {
    if (isConnected === false) {
      authoritativeTurnInFlightRef.current = false;
      idleStatusConfirmationRef.current = null;
    }
  }, [isConnected]);

  // 卡死自愈看门狗（修复「消息发不出去、左侧时间戳不变 just now」）。
  // 根因：claude-complete 在 WS 闪断窗口内丢失、且 WS 句柄引用未变化（无 onclose→重连，
  // 因此 useChatSessionState 里依赖 ws 的 check-session-status 补发也不会触发）时，前端没有
  // 任何途径重新向后端对账，isLoading 永久卡死；而 handleSubmit 的 guard（isLoading 为真即
  // 直接 return）会静默吞掉用户的新消息——表现为点发送毫无反应、乐观追加与时间戳都不更新。
  // 这里在「已连接 + isLoading 为真 + 确曾有过真实 SDK 活动但已静默超过阈值」时，定时补发
  // check-session-status。后端权威响应 session-status=false（会话已结束）会经既有分支调用
  // clearLoadingIndicators 解锁 UI，从而自愈；若仍 isProcessing=true 则保持 loading（正确）。
  // 仅在 lastRealActivityRef>0（确有过输出）后才触发，避免打扰「刚提交、正等待首包」的正常等待。
  useEffect(() => {
    if (!isLoading || !isConnected || !sendMessage) return;
    const sessionId = currentSessionId || selectedSession?.id;
    if (!sessionId) return;
    const intervalId = setInterval(() => {
      const lastAct = lastRealActivityRef.current;
      if (lastAct <= 0) return; // -1=已清理；0=尚无真实活动（正常等待首包，勿打扰）
      if (Date.now() - lastAct < STUCK_WATCHDOG_SILENCE_MS) return;
      sendMessage({
        type: 'check-session-status',
        sessionId,
        provider,
        viewSessionId: selectedSession?.id || currentSessionId || sessionId,
      });
    }, STUCK_WATCHDOG_POLL_MS);
    return () => clearInterval(intervalId);
  }, [isLoading, isConnected, sendMessage, currentSessionId, selectedSession?.id, provider]);
  // 累计真实 token 用量（来自 Anthropic API message_start / message_delta 流式事件）
  const realTokensRef = useRef<{ input: number; output: number; cacheRead: number; cacheCreation: number }>({
    input: 0, output: 0, cacheRead: 0, cacheCreation: 0,
  });
  const realTokensSessionIdRef = useRef<string | null>(null);
  const estimatedOutputTextRef = useRef('');
  const claudeUsageByMessageRef = useRef<Map<string, {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
  }>>(new Map());

  useEffect(() => {
    // 队列模式：批量消费所有入站消息，防止 React 18 批处理时中间消息被 setLatestMessage 覆盖丢失
    const messagesToProcess: LatestChatMessage[] =
      incomingMsgQueueRef && incomingMsgQueueRef.current.length > 0
        ? (incomingMsgQueueRef.current.splice(0) as LatestChatMessage[])
        : [];

    if (messagesToProcess.length === 0) {
      // 降级：无队列/队列为空时，单条处理 latestMessage（向后兼容）
      if (!latestMessage || lastProcessedMessageRef.current === latestMessage) return;
      lastProcessedMessageRef.current = latestMessage;
      messagesToProcess.push(latestMessage);
    } else {
      // 更新哨兵为队列末尾消息，防止 latestMessage dep 变化时触发重复处理
      lastProcessedMessageRef.current = messagesToProcess[messagesToProcess.length - 1];
    }

    for (const _msg of messagesToProcess) {
    const latestMessage = _msg; // 局部遮蔽外层同名参数，以下现有代码无需改动

    const messageData = latestMessage.data?.message || latestMessage.data;
    const structuredMessageData =
      messageData && typeof messageData === 'object' ? (messageData as Record<string, any>) : null;
    const rawStructuredData =
      latestMessage.data && typeof latestMessage.data === 'object'
        ? (latestMessage.data as Record<string, any>)
        : null;

    const globalMessageTypes = ['projects_updated', 'taskmaster-project-updated', 'session-created'];
    const isGlobalMessage = globalMessageTypes.includes(String(latestMessage.type));
    const lifecycleMessageTypes = new Set([
      'claude-complete',
      'codex-complete',
      'cursor-result',
      'session-aborted',
      'claude-error',
      'cursor-error',
      'codex-error',
      'gemini-error',
    ]);

    const isClaudeSystemInit =
      latestMessage.type === 'claude-response' &&
      structuredMessageData &&
      structuredMessageData.type === 'system' &&
      structuredMessageData.subtype === 'init';

    const isCursorSystemInit =
      latestMessage.type === 'cursor-system' &&
      rawStructuredData &&
      rawStructuredData.type === 'system' &&
      rawStructuredData.subtype === 'init';

    const systemInitSessionId = isClaudeSystemInit
      ? structuredMessageData?.session_id
      : isCursorSystemInit
        ? rawStructuredData?.session_id
        : null;

    const isCompactContinuationPending =
      typeof window !== 'undefined' &&
      sessionStorage.getItem('compactContinuationPending') === '1';
    const selectedRuntimeSessionId = selectedSession?.id
      ? (resolveCompactContinuationInfoForProject(selectedProject, selectedSession.id).sessionId || selectedSession.id)
      : null;
    // A selected sidebar session is authoritative. Pending state is only
    // relevant while no durable session is selected; stale pending state must
    // never route a background turn into the visible transcript.
    const activeViewSessionId =
      selectedRuntimeSessionId || pendingViewSessionRef.current?.sessionId || currentSessionId || null;

    const incomingViewSessionId = (latestMessage as any).viewSessionId as string | null | undefined;
    const selectedViewSessionId = selectedSession?.id || null;
    if (
      incomingViewSessionId &&
      selectedViewSessionId &&
      incomingViewSessionId !== selectedViewSessionId
    ) {
      if (latestMessage.sessionId && lifecycleMessageTypes.has(String(latestMessage.type))) {
        onSessionInactive?.(latestMessage.sessionId);
        onSessionNotProcessing?.(latestMessage.sessionId);
      }
      continue;
    }

    // 压缩会话别名注册：后端在 Claude 原生压缩改 session_id 时广播 session-id-changed{from,to}。
    // 若 from 属于当前视图（含 runtime/pending/current 各身份），就把 to→activeViewSessionId 记入别名表，
    // 这样后续带新 id（to）的流式块与 claude-complete 仍能归属到本视图。它是控制消息，注册完即返回。
    if (latestMessage.type === 'session-id-changed') {
      const fromId = (latestMessage as any).from;
      const toId = (latestMessage as any).to;
      const viewOwnsFrom =
        fromId &&
        (fromId === activeViewSessionId ||
          fromId === currentSessionId ||
          fromId === selectedRuntimeSessionId ||
          fromId === selectedSession?.id ||
          compactSessionAliasRef.current.get(fromId));
      if (viewOwnsFrom && toId) {
        // 归一化到当前视图主键，便于后续比较（多次压缩链式映射也指向同一主键）
        const canonical = compactSessionAliasRef.current.get(fromId) || activeViewSessionId || fromId;
        compactSessionAliasRef.current.set(toId, canonical);
      }
      return;
    }

    // 命令送达回执（按 clientTs=ackId 定位用户消息，与 sessionId 无关）：
    //   command-ack         → 消息确认抵达后端，标记 delivered（清除「发送中」）
    //   command-undelivered → 送达超时（僵尸连接，消息已丢），标记 failed，提示用户重发
    //   command-rejected    → 后端拒绝不一致 sessionId，标记 failed 并补一条错误消息
    if (
      latestMessage.type === 'command-ack' ||
      latestMessage.type === 'command-undelivered' ||
      latestMessage.type === 'command-rejected'
    ) {
      const ackId = (latestMessage as any).ackId;
      const delivered = latestMessage.type === 'command-ack';
      if (typeof ackId === 'number') {
        setChatMessages((prev) => prev.map((m) =>
          m.clientTs === ackId && m.type === 'user'
            ? { ...m, deliveryStatus: delivered ? 'delivered' : 'failed' }
            : m
        ));
      }
      if (delivered) {
        const ackViewSessionId = (latestMessage as any).viewSessionId as string | null | undefined;
        const ackSessionId = (latestMessage as any).sessionId as string | null | undefined;
        const belongsToCurrentView =
          !ackViewSessionId ||
          !selectedSession?.id ||
          ackViewSessionId === selectedSession.id;
        if (belongsToCurrentView) {
          const lifecycleSessionId = ackSessionId || ackViewSessionId || currentSessionId;
          markLiveTurnActivity(lifecycleSessionId);
          setCanAbortSession(true);
          const ackStartedAt = Number((latestMessage as any).startedAt || ackId || Date.now());
          currentTurnClientTsRef.current = Math.max(currentTurnClientTsRef.current, ackStartedAt);
          setClaudeStatus((previous) => previous || {
            text: 'Starting task',
            tokens: 0,
            inputTokens: 0,
            outputTokens: 0,
            startedAt: ackStartedAt,
            can_interrupt: true,
          });
          if (lifecycleSessionId) {
            persistActiveTurnStatus(lifecycleSessionId, {
              text: 'Starting task',
              startedAt: ackStartedAt,
              can_interrupt: true,
            });
          }
        }
      }
      if (latestMessage.type === 'command-rejected') {
        setChatMessages((prev) => [
          ...prev,
          {
            type: 'error',
            content: 'Command was blocked because the browser and server disagreed on the target session. Please click the conversation again and resend.',
            timestamp: new Date(),
          },
        ]);
      }
      continue;
    }
    // 将入站消息的 sessionId 经别名解析为「视图主键」，用于归属判断（不改变后台用真实 id 的处理）
    const aliasedViewSessionId =
      latestMessage.sessionId
        ? (compactSessionAliasRef.current.get(latestMessage.sessionId) || latestMessage.sessionId)
        : latestMessage.sessionId;

    // 串话修复：仅当本标签页确实在等待自己发起的新会话（pendingViewSessionRef 存在且
    // sessionId 尚未落定）时，才允许在 activeViewSessionId 未就绪的瞬间放行 system-init。
    // 否则一个停在"新对话"空白页、并无任何待定请求的标签页会误采纳别的会话广播来的
    // system-init，把别人的对话内容渲染进来（串话根因之二）。
    const hasPendingNewSession =
      Boolean(pendingViewSessionRef.current) && !pendingViewSessionRef.current?.sessionId;
    const isSystemInitForView =
      systemInitSessionId &&
      (systemInitSessionId === activeViewSessionId ||
        (!activeViewSessionId && hasPendingNewSession));
    const shouldBypassSessionFilter = isGlobalMessage || Boolean(isSystemInitForView);
    const pendingNewSessionRequestId =
      typeof window !== 'undefined' ? sessionStorage.getItem('pendingNewSessionRequestId') : null;
    const isCorrelatedNewSessionError =
      pendingNewSessionRequestId !== null &&
      pendingNewSessionRequestId === (latestMessage as any).newSessionRequestId &&
      (latestMessage.type === 'claude-error' ||
        latestMessage.type === 'cursor-error' ||
        latestMessage.type === 'codex-error' ||
        latestMessage.type === 'gemini-error');
    const isUnscopedError =
      !latestMessage.sessionId &&
      (latestMessage.type === 'error' ||
        (pendingViewSessionRef.current &&
          !pendingViewSessionRef.current.sessionId &&
          (latestMessage.type === 'claude-error' ||
        latestMessage.type === 'cursor-error' ||
        latestMessage.type === 'codex-error' ||
            latestMessage.type === 'gemini-error')));

    const handleBackgroundLifecycle = (sessionId?: string) => {
      if (!sessionId) {
        return;
      }
      onSessionInactive?.(sessionId);
      onSessionNotProcessing?.(sessionId);
    };

    const collectSessionIds = (...sessionIds: Array<string | null | undefined>) =>
      Array.from(
        new Set(
          sessionIds.filter((sessionId): sessionId is string => typeof sessionId === 'string' && sessionId.length > 0),
        ),
      );

    const clearLoadingIndicators = () => {
      // 每轮结束前把真实 token 用量累加到 session 级别持久化计数
      const sid = realTokensSessionIdRef.current || currentSessionId;
      if (sid) {
        const r = realTokensRef.current;
        const outTokens = r.output > 0 ? r.output : 0;
        // input 含 cache_read + cache_creation，反映实际消耗的完整上下文量
        const inTokens = (r.input || 0) + (r.cacheRead || 0) + (r.cacheCreation || 0);
        if (inTokens > 0 || outTokens > 0) {
          addSessionTokens(sid, inTokens, outTokens);
        }
        // 本轮用量已落库，清零「在途」实时值，避免与持久值叠加重复计数
        clearLiveSessionTokens(sid);
      }
      setIsLoading(false);
      setCanAbortSession(false);
      setClaudeStatus(null);
      clearPersistedActiveTurnStatus(sid);
      realTokensRef.current = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
      realTokensSessionIdRef.current = null;
      estimatedOutputTextRef.current = '';
      claudeUsageByMessageRef.current.clear();
      // 哨兵值 -1：会话已完成，拒绝所有延迟到达的 claude-status，防止"完成后重新显示工作中"
      lastRealActivityRef.current = -1;
      authoritativeTurnInFlightRef.current = false;
      idleStatusConfirmationRef.current = null;
      // 清除所有 stale 超时，防止旧计时器在新会话开始后误触发清除
      if (staleLoadingTimerRef.current) {
        clearTimeout(staleLoadingTimerRef.current);
        staleLoadingTimerRef.current = null;
      }
      // 本轮结束：清空压缩会话别名，避免跨轮/跨会话残留导致误归属
      compactSessionAliasRef.current.clear();
    };

    const markSessionsAsCompleted = (...sessionIds: Array<string | null | undefined>) => {
      const normalizedSessionIds = collectSessionIds(...sessionIds);
      normalizedSessionIds.forEach((sessionId) => {
        onSessionInactive?.(sessionId);
        onSessionNotProcessing?.(sessionId);
      });
    };

    function markLiveTurnActivity(sessionId?: string | null) {
      const incomingTurnClientTs = Number((latestMessage as any).turnClientTs || 0);
      if (incomingTurnClientTs > 0) {
        currentTurnClientTsRef.current = Math.max(currentTurnClientTsRef.current, incomingTurnClientTs);
      }
      authoritativeTurnInFlightRef.current = true;
      idleStatusConfirmationRef.current = null;
      lastRealActivityRef.current = Date.now();
      setIsLoading(true);
      // A resumed/compacted provider thread may differ from the stable sidebar
      // view id. Mark every alias atomically so the session-state effect cannot
      // immediately turn the work bar back off after a valid stream event.
      collectSessionIds(
        sessionId,
        incomingViewSessionId,
        activeViewSessionId,
        selectedSession?.id,
        selectedRuntimeSessionId,
      ).forEach((activeId) => {
        onSessionActive?.(activeId);
        onSessionProcessing?.(activeId);
      });
      if (staleLoadingTimerRef.current) {
        clearTimeout(staleLoadingTimerRef.current);
        staleLoadingTimerRef.current = null;
      }
    }

    function newestCurrentTurnClientTs() {
      const sessionIds = [currentSessionId, selectedSession?.id, activeViewSessionId];
      const persistedStartedAt = sessionIds.reduce((newest, sessionId) => {
        const status = getPersistedActiveTurnStatus(sessionId);
        const startedAt = status?.startedAt ? new Date(status.startedAt).getTime() : 0;
        return Math.max(newest, Number.isFinite(startedAt) ? startedAt : 0);
      }, 0);
      return Math.max(currentTurnClientTsRef.current, persistedStartedAt);
    }

    function isStaleTerminalTurn() {
      const terminalTurnClientTs = Number((latestMessage as any).turnClientTs || 0);
      return terminalTurnClientTs > 0 && terminalTurnClientTs < newestCurrentTurnClientTs();
    }

    if (!shouldBypassSessionFilter && !isCorrelatedNewSessionError) {
      if (!activeViewSessionId) {
        if (latestMessage.sessionId && lifecycleMessageTypes.has(String(latestMessage.type))) {
          handleBackgroundLifecycle(latestMessage.sessionId);
        }
        // 无活跃视图时也需同步 session-status 到 processingSessions
        if (latestMessage.type === 'session-status' && latestMessage.sessionId) {
          if ((latestMessage as any).isProcessing) {
            onSessionProcessing?.(latestMessage.sessionId);
          } else {
            onSessionInactive?.(latestMessage.sessionId);
            onSessionNotProcessing?.(latestMessage.sessionId);
          }
        }
        if (!isUnscopedError) {
          return;
        }
      }

      if (!latestMessage.sessionId && !isUnscopedError) {
        return;
      }

      // 用别名解析后的视图主键判断归属：压缩产生的新 id 经别名映射回当前视图主键后即匹配，
      // 从而让压缩后的流式块与 claude-complete 正常归属本视图（不再被当成后台消息丢弃）。
      if (!isUnscopedError && aliasedViewSessionId !== activeViewSessionId) {
        if (latestMessage.sessionId && lifecycleMessageTypes.has(String(latestMessage.type))) {
          handleBackgroundLifecycle(latestMessage.sessionId);
        }
        // session-status 不在 lifecycleMessageTypes 里，需要单独处理：
        // 当后台 session 的状态响应到达时，同步更新 processingSessions，
        // 防止切换回该 session 时出现假"工作中"状态。
        if (latestMessage.type === 'session-status' && latestMessage.sessionId) {
          if ((latestMessage as any).isProcessing) {
            onSessionProcessing?.(latestMessage.sessionId);
          } else {
            onSessionInactive?.(latestMessage.sessionId);
            onSessionNotProcessing?.(latestMessage.sessionId);
          }
        }
        return;
      }
    }

    switch (latestMessage.type) {
      case 'turn-accepted': {
        const acceptedSessionId = latestMessage.sessionId || activeViewSessionId;
        markLiveTurnActivity(acceptedSessionId);
        setLatestAssistantTurnCompletion(setChatMessages, false);
        setCanAbortSession(false);
        const acceptedStartedAt = (latestMessage as any).startedAt || Date.now();
        if (acceptedSessionId) {
          persistProcessingStartedAt(acceptedSessionId, acceptedStartedAt);
        }
        setClaudeStatus((previous) => ({
          text: 'Starting task',
          tokens: Number(previous?.tokens || 0),
          inputTokens: Number(previous?.inputTokens || 0),
          outputTokens: Number(previous?.outputTokens || 0),
          startedAt: acceptedStartedAt,
          can_interrupt: false,
        }));
        break;
      }

      case 'compact-start':
        // Claude 原生压缩真实开始信号（服务端检测到 session_id 中途变化）
        onClaudeCompactStart?.();
        break;

      case 'compact-complete':
        // Claude 原生压缩真实结束信号（PostCompact 钩子）——收尾压缩动画到 100%，
        // 随后进入正常流式生成。若该信号缺失，claude-complete 兜底收尾（见下方守卫，幂等）。
        onClaudeNativeCompactComplete?.();
        break;

      case 'compact-retry':
        // 压缩被网络中断，服务端正在自动重试——保持 loading/compact 动画继续运转
        console.log(`[compact-retry] attempt ${latestMessage.attempt}/3, session=${latestMessage.sessionId}`);
        setIsLoading(true);
        break;

      case 'session-created': {
        // 重放消息（断线期间发生）不触发 session 导航——当前 session 已经正确
        if ((latestMessage as any)._replayed) break;
        // 串话根因修复：session-created 是服务端广播消息，会发给所有连接的客户端。
        // 只有发起本次新会话请求的标签页持有匹配的 newSessionRequestId 才能采纳，
        // 否则其他处于"新对话"状态（!currentSessionId）的标签页会误采纳别人的会话。
        const incomingReqId = (latestMessage as any).newSessionRequestId;
        if (incomingReqId) {
          const myReqId =
            typeof window !== 'undefined'
              ? sessionStorage.getItem('pendingNewSessionRequestId')
              : null;
          if (incomingReqId !== myReqId) {
            // 不是本标签页发起的新会话——忽略，避免串话
            break;
          }
          // 已匹配并即将采纳，清除 pending，防止后续广播被重复采纳
          if (typeof window !== 'undefined') {
            sessionStorage.removeItem('pendingNewSessionRequestId');
          }
        }
        // Claude：原始逻辑——只在没有当前 session 时处理（原生压缩不跳转）
        // 其他模型：还需处理 UI-side compact continuation 场景
        const shouldHandleSessionCreated = provider === 'claude'
          ? Boolean(latestMessage.sessionId) && (!currentSessionId || isCompactContinuationRef?.current)
          : Boolean(latestMessage.sessionId) && (!currentSessionId || isCompactContinuationRef?.current);

        if (shouldHandleSessionCreated) {
          const createdSessionId = String(latestMessage.sessionId);
          sessionStorage.setItem('pendingSessionId', createdSessionId);
          const pendingSessionId = pendingViewSessionRef.current?.sessionId || null;
          const shouldReplacePendingSession =
            !pendingSessionId ||
            pendingSessionId.startsWith('new-session-') ||
            /^codex-\d+$/.test(pendingSessionId);

          if (pendingViewSessionRef.current && shouldReplacePendingSession) {
            pendingViewSessionRef.current.sessionId = createdSessionId;
          }

          setIsSystemSessionChange(true);
          // 绑定本次 system-change 的目标会话，串话守卫据此放行真实切换
          systemSessionChangeTargetIdRef.current = createdSessionId;
          onReplaceTemporarySession?.(createdSessionId);
          if (isCompactContinuationRef?.current) {
            const continuationSourceSessionId =
              sessionStorage.getItem('compactContinuationSourceSessionId') ||
              selectedSession?.id ||
              currentSessionId;
            const continuationSourceProjectName =
              sessionStorage.getItem('compactContinuationSourceProjectName') ||
              selectedProject?.name;
            if (
              !continuationSourceProjectName ||
              !selectedProject?.name ||
              continuationSourceProjectName === selectedProject.name
            ) {
              rememberCompactContinuationSession(
                continuationSourceSessionId,
                createdSessionId,
                (latestMessage as any).provider || provider,
                continuationSourceProjectName,
              );
              onCompactSessionCreated?.();
            } else {
              sessionStorage.removeItem('compactContinuationPending');
              sessionStorage.removeItem('compactContinuationSourceSessionId');
              sessionStorage.removeItem('compactContinuationSourceProjectName');
              isCompactContinuationRef.current = false;
            }
          }

          setPendingPermissionRequests((previous) =>
            previous.map((request) =>
              request.sessionId ? request : { ...request, sessionId: createdSessionId },
            ),
          );
        }
        break;
      }

      case 'token-budget':
        if (latestMessage.data) {
          const statusSessionId = latestMessage.sessionId;
          const isTokenBudgetForCurrentSession = statusSessionId
            ? statusSessionId === activeViewSessionId
            : false;
          const rawData = latestMessage.data as Record<string, any>;
          const budgetProvider = (latestMessage as any).provider || provider;

          const incomingBudget = {
            ...rawData,
            provider: budgetProvider,
            sessionId: latestMessage.sessionId,
            source: 'token-budget',
          };
          setTokenBudget((previousBudget) => mergeTokenBudget(previousBudget, incomingBudget));
          publishTokenBudgetSnapshot(incomingBudget);

          if (!isTokenBudgetForCurrentSession) {
            break;
          }

          const used = readNumber(rawData.used);
          if (!used) {
            break;
          }

          const incomingInputTokens = Math.max(
            readNumber(rawData.inputTokens),
            readNumber(rawData.input_tokens),
            readNumber(rawData.input),
            readNumber(rawData.cacheReadTokens),
            readNumber(rawData.cacheReadInputTokens),
            readNumber(rawData.cache_read_tokens),
            readNumber(rawData.cache_read_input_tokens),
            readNumber(rawData.cacheCreationTokens),
            readNumber(rawData.cache_creation_input_tokens),
          );

          let incomingOutputTokens = Math.max(
            readNumber(rawData.outputTokens),
            readNumber(rawData.output_tokens),
            readNumber(rawData.output),
            readNumber(rawData.reasoningOutputTokens),
            readNumber(rawData.reasoning_output_tokens),
          );

          if (!incomingOutputTokens && incomingInputTokens) {
            const inferredOutput = used - incomingInputTokens;
            if (Number.isFinite(inferredOutput) && inferredOutput > 0) {
              incomingOutputTokens = inferredOutput;
            }
          }

          if (!incomingInputTokens && !incomingOutputTokens) {
            break;
          }

          if (budgetProvider === 'codex' && statusSessionId) {
            const previousReal = realTokensSessionIdRef.current === statusSessionId
              ? realTokensRef.current
              : { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
            realTokensRef.current = {
              input: Math.max(previousReal.input, incomingInputTokens),
              output: Math.max(previousReal.output, incomingOutputTokens),
              // Codex cached input is a subset of input_tokens, not an extra charge.
              cacheRead: 0,
              cacheCreation: 0,
            };
            realTokensSessionIdRef.current = statusSessionId;
            setLiveSessionTokens(
              statusSessionId,
              realTokensRef.current.input,
              realTokensRef.current.output,
            );
          }

          // Codex token-budget is the full context/billing snapshot. It belongs
          // in the context gauge and session totals, not the per-turn status row.
          if (budgetProvider !== 'codex') {
            setClaudeStatus((previous) => {
              if (!previous) {
                return previous;
              }
              const prevInput = readNumber(previous.inputTokens);
              const prevOutput = readNumber(previous.outputTokens);
              const inputTokens = Math.max(prevInput, incomingInputTokens);
              const outputTokens = Math.max(prevOutput, incomingOutputTokens);

              return {
                ...previous,
                tokens: Math.max(readNumber(previous.tokens), used, inputTokens + outputTokens),
                inputTokens,
                outputTokens,
              };
            });
          }

          // 使用量 ≥ 95% 时同步预设导航守卫（仅非 Claude 模型，Claude 使用原生压缩不需要守卫）
          const total = readNumber(rawData.total);
          if (budgetProvider !== 'claude' && total > 0 && used / total >= 0.95 && isCompactContinuationRef && !isCompactContinuationRef.current) {
            isCompactContinuationRef.current = true;
            try { sessionStorage.setItem('compactContinuationPending', '1'); } catch { /* ignore */ }
          }
        }
        break;

      case 'claude-response': {
        const responseSessionId = latestMessage.sessionId || activeViewSessionId;
        markLiveTurnActivity(responseSessionId);
        // Any real event after a terminal marker proves that marker arrived out
        // of order. Remove it immediately; the real terminal event will restore it.
        setLatestAssistantTurnCompletion(setChatMessages, false);
        // 有真实 SDK 输出说明后端确实在干活：强制点亮"工作中"状态栏。
        // 修复"后端还在吐结果、但前端状态栏消失"——例如断线重连后只重放 claude-response、
        // 或上一轮 clearLoadingIndicators 把 isLoading 置 false 后新一轮内容又流入时，
        // 仅靠 session-status/claude-status 不足以可靠点亮。只要有真实内容流入就必须显示。
        setIsLoading(true);
        // 有真实 SDK 输出说明会话正常运行，清除 "Reconnecting" 绝对时间戳
        if (staleLoadingTimerRef.current) {
          clearTimeout(staleLoadingTimerRef.current);
          staleLoadingTimerRef.current = null;
        }
        // 若状态文本仍是"Reconnecting to running session"，有真实输出后立即清除这个误导性文本
        setClaudeStatus((previous) => {
          if (!previous || previous.text !== 'Reconnecting to running session') return previous;
          return { ...previous, text: 'Working...' };
        });
        if (messageData && typeof messageData === 'object' && messageData.type) {
          if (messageData.type === 'content_block_delta' && messageData.delta?.text) {
            const decodedText = decodeHtmlEntities(messageData.delta.text);
            estimatedOutputTextRef.current += decodedText;
            const estimatedOutputTokens = estimateTokenCount(estimatedOutputTextRef.current);
            // 流式输出期间始终更新估算 outputTokens（实时增长效果）；
            // 真实值（message 事件末尾）到来后精度自动修正，估算不再覆盖真实值。
            if (estimatedOutputTokens > 0) {
              setClaudeStatus((previous) => {
                if (!previous) return previous;
                // 真实 output 已到且更大时，保留精确值不降级
                if (realTokensRef.current.output > 0 && realTokensRef.current.output >= estimatedOutputTokens) return previous;
                const inputTokens = previous.inputTokens ?? 0;
                const outputTokens = Math.max(previous.outputTokens ?? 0, estimatedOutputTokens);
                return {
                  ...previous,
                  text: previous.text === 'Reconnecting to running session' ? 'Writing response' : (previous.text || 'Writing response'),
                  tokens: Math.max(previous.tokens || 0, inputTokens + outputTokens),
                  inputTokens,
                  outputTokens,
                };
              });
            }
            streamBufferRef.current += decodedText;
            if (!streamTimerRef.current) {
              streamTimerRef.current = window.setTimeout(() => {
                const chunk = streamBufferRef.current;
                streamBufferRef.current = '';
                streamTimerRef.current = null;
                appendStreamingChunk(setChatMessages, chunk, false);
              }, 16);
            }
            return;
          }

          if (messageData.type === 'content_block_stop') {
            if (streamTimerRef.current) {
              clearTimeout(streamTimerRef.current);
              streamTimerRef.current = null;
            }
            const chunk = streamBufferRef.current;
            streamBufferRef.current = '';
            appendStreamingChunk(setChatMessages, chunk, false);
            finalizeStreamingMessage(setChatMessages);
            return;
          }

          // Claude Agent SDK 每轮响应完成后发送 SDKAssistantMessage，
          // 其内部 .message 为 BetaMessage（type='message'），包含本轮真实 token 用量。
          // 注：后端已开启 includePartialMessages，文本块通过 content_block_delta 实时流式下发，
          // 整段 assistant 消息的 text 块已在后端 transformMessage 中剥离（去重），此处仅取 usage。
          if (messageData.type === 'message' && messageData.usage) {
            const u = messageData.usage;
            const messageUsage = {
              input: Number(u.input_tokens || 0),
              output: Number(u.output_tokens || 0),
              cacheRead: Number(u.cache_read_input_tokens || 0),
              cacheCreation: Number(u.cache_creation_input_tokens || 0),
            };
            const usageMessageId = String(
              messageData.id ||
              messageData.message_id ||
              `legacy-${messageUsage.input}-${messageUsage.output}-${messageUsage.cacheRead}-${messageUsage.cacheCreation}`
            );
            const previousMessageUsage = claudeUsageByMessageRef.current.get(usageMessageId);
            claudeUsageByMessageRef.current.set(usageMessageId, {
              input: Math.max(previousMessageUsage?.input || 0, messageUsage.input),
              output: Math.max(previousMessageUsage?.output || 0, messageUsage.output),
              cacheRead: Math.max(previousMessageUsage?.cacheRead || 0, messageUsage.cacheRead),
              cacheCreation: Math.max(previousMessageUsage?.cacheCreation || 0, messageUsage.cacheCreation),
            });
            const accumulatedUsage = Array.from(claudeUsageByMessageRef.current.values());
            const inputTotal = accumulatedUsage.reduce(
              (maximum, usage) => Math.max(maximum, usage.input + usage.cacheRead + usage.cacheCreation),
              0,
            );
            const outputTotal = accumulatedUsage.reduce((sum, usage) => sum + usage.output, 0);
            const total = inputTotal + outputTotal;
            if (total > 0) {
              realTokensRef.current = {
                input: Math.max(
                  realTokensRef.current.input + realTokensRef.current.cacheRead + realTokensRef.current.cacheCreation,
                  inputTotal,
                ),
                output: Math.max(realTokensRef.current.output, outputTotal),
                cacheRead: 0,
                cacheCreation: 0,
              };
              realTokensSessionIdRef.current = currentSessionId;
              setClaudeStatus((previous) => ({
                text: previous?.text || 'Working...',
                tokens: Math.max(previous?.tokens || 0, total),
                inputTokens: Math.max(previous?.inputTokens || 0, inputTotal),
                outputTokens: Math.max(previous?.outputTokens || 0, outputTotal),
                startedAt: previous?.startedAt,
                can_interrupt: true,
              }));
              // 实时镜像本轮在途用量到 HUD 的 ↑/↓（与轮末 addSessionTokens 的口径一致），
              // 让数字在一轮进行中就持续跳动，而非整轮固定到结束才更新
              if (currentSessionId) {
                setLiveSessionTokens(currentSessionId, inputTotal, outputTotal);
              }
            }
          }
        }

        // 仅在用户没有正在浏览的 session 时才自动跳转，绝不打断用户当前界面
        // isCompactContinuationRef 是 ref（不受渲染周期影响），作为最后一道保险
        if (
          structuredMessageData?.type === 'system' &&
          structuredMessageData.subtype === 'init' &&
          structuredMessageData.session_id &&
          !currentSessionId &&
          isSystemInitForView &&
          !isCompactContinuationPending &&
          !isCompactContinuationRef?.current
        ) {
          setIsSystemSessionChange(true);
          systemSessionChangeTargetIdRef.current = String(structuredMessageData.session_id);
          onNavigateToSession?.(structuredMessageData.session_id);
          return;
        }

        if (
          structuredMessageData?.type === 'system' &&
          structuredMessageData.subtype === 'init' &&
          structuredMessageData.session_id &&
          currentSessionId &&
          structuredMessageData.session_id === currentSessionId &&
          isSystemInitForView
        ) {
          return;
        }

        if (structuredMessageData && Array.isArray(structuredMessageData.content)) {
          const parentToolUseId = rawStructuredData?.parentToolUseId;

          structuredMessageData.content.forEach((part: any) => {
            if (part.type === 'tool_use') {
              const toolInput = part.input ? JSON.stringify(part.input, null, 2) : '';

              // Check if this is a child tool from a subagent
              if (parentToolUseId) {
                setChatMessages((previous) =>
                  previous.map((message) => {
                    if (message.toolId === parentToolUseId && message.isSubagentContainer) {
                      const childTool = {
                        toolId: part.id,
                        toolName: part.name,
                        toolInput: part.input,
                        toolResult: null,
                        timestamp: new Date(),
                      };
                      const existingChildren = message.subagentState?.childTools || [];
                      return {
                        ...message,
                        subagentState: {
                          childTools: [...existingChildren, childTool],
                          currentToolIndex: existingChildren.length,
                          isComplete: false,
                        },
                      };
                    }
                    return message;
                  }),
                );
                return;
              }

              // Check if this is a Task tool (subagent container)
              const isSubagentContainer = part.name === 'Task';

              setChatMessages((previous) => [
                ...previous,
                {
                  type: 'assistant',
                  content: '',
                  timestamp: new Date(),
                  isToolUse: true,
                  toolName: part.name,
                  toolInput,
                  toolId: part.id,
                  toolResult: null,
                  isSubagentContainer,
                  subagentState: isSubagentContainer
                    ? { childTools: [], currentToolIndex: -1, isComplete: false }
                    : undefined,
                },
              ]);
              return;
            }

            if (part.type === 'text' && part.text?.trim()) {
              let content = decodeHtmlEntities(part.text);
              content = formatUsageLimitText(content);
              setChatMessages((previous) => reconcileConsolidatedAssistantText(previous, content));
            }
          });
        } else if (structuredMessageData && typeof structuredMessageData.content === 'string' && structuredMessageData.content.trim()) {
          let content = decodeHtmlEntities(structuredMessageData.content);
          content = formatUsageLimitText(content);
          setChatMessages((previous) => reconcileConsolidatedAssistantText(previous, content));
        }

        if (structuredMessageData?.role === 'user' && Array.isArray(structuredMessageData.content)) {
          const parentToolUseId = rawStructuredData?.parentToolUseId;

          structuredMessageData.content.forEach((part: any) => {
            if (part.type !== 'tool_result') {
              return;
            }

            setChatMessages((previous) =>
              previous.map((message) => {
                // Handle child tool results (route to parent's subagentState)
                if (parentToolUseId && message.toolId === parentToolUseId && message.isSubagentContainer) {
                  return {
                    ...message,
                    subagentState: {
                      ...message.subagentState!,
                      childTools: message.subagentState!.childTools.map((child) => {
                        if (child.toolId === part.tool_use_id) {
                          return {
                            ...child,
                            toolResult: {
                              content: part.content,
                              isError: part.is_error,
                              timestamp: new Date(),
                            },
                          };
                        }
                        return child;
                      }),
                    },
                  };
                }

                // Handle normal tool results (including parent Task tool completion)
                if (message.isToolUse && message.toolId === part.tool_use_id) {
                  const result = {
                    ...message,
                    toolResult: {
                      content: part.content,
                      isError: part.is_error,
                      timestamp: new Date(),
                    },
                  };
                  // Mark subagent as complete when parent Task receives its result
                  if (message.isSubagentContainer && message.subagentState) {
                    result.subagentState = {
                      ...message.subagentState,
                      isComplete: true,
                    };
                  }
                  return result;
                }
                return message;
              }),
            );
          });
        }
        break;
      }

      case 'claude-output': {
        const cleaned = String(latestMessage.data || '');
        if (cleaned.trim()) {
          streamBufferRef.current += streamBufferRef.current ? `\n${cleaned}` : cleaned;
          if (!streamTimerRef.current) {
            streamTimerRef.current = window.setTimeout(() => {
              const chunk = streamBufferRef.current;
              streamBufferRef.current = '';
              streamTimerRef.current = null;
              appendStreamingChunk(setChatMessages, chunk, true);
            }, 16);
          }
        }
        break;
      }

      case 'claude-interactive-prompt':
        // Interactive prompts are parsed/rendered as text in the UI.
        // Normalize to string to keep ChatMessage.content shape consistent.
        {
          const interactiveContent =
            typeof latestMessage.data === 'string'
              ? latestMessage.data
              : JSON.stringify(latestMessage.data ?? '', null, 2);
          setChatMessages((previous) => [
            ...previous,
            {
              type: 'assistant',
              content: interactiveContent,
              timestamp: new Date(),
              isInteractivePrompt: true,
            },
          ]);
        }
        break;

      case 'claude-permission-request':
        if (provider !== 'claude' || !latestMessage.requestId) {
          break;
        }
        {
          const requestId = latestMessage.requestId;

          setPendingPermissionRequests((previous) => {
            if (previous.some((request) => request.requestId === requestId)) {
              return previous;
            }
            return [
              ...previous,
              {
                requestId,
                toolName: latestMessage.toolName || 'UnknownTool',
                input: latestMessage.input,
                context: latestMessage.context,
                sessionId: latestMessage.sessionId || null,
                receivedAt: new Date(),
              },
            ];
          });
        }

        setIsLoading(true);
        setCanAbortSession(true);
        setClaudeStatus((previous) => ({
          text: 'Waiting for permission',
          tokens: previous?.tokens || 0,
          inputTokens: previous?.inputTokens,
          outputTokens: previous?.outputTokens,
          startedAt: previous?.startedAt,
          can_interrupt: true,
        }));
        break;

      case 'claude-permission-cancelled':
        if (!latestMessage.requestId) {
          break;
        }
        setPendingPermissionRequests((previous) =>
          previous.filter((request) => request.requestId !== latestMessage.requestId),
        );
        break;

      case 'btw-result': {
        // Prefer the unique client timestamp; text matching remains for older servers.
        // A failed live injection is not discarded: move it into ChatComposer's
        // per-session queue so it is sent normally after the running turn.
        const ok = latestMessage.success !== false;
        const btwText = latestMessage.message;
        const btwClientTs = latestMessage.clientTs;
        let updated = false;
        setChatMessages((previous) => {
          const next = previous.flatMap((m) => {
            if (updated || !m.isBtw || m.btwStatus !== 'pending') return m;
            if (typeof btwClientTs === 'number' && m.clientTs !== btwClientTs) return m;
            if (typeof btwClientTs !== 'number' && typeof btwText === 'string' && m.content !== btwText) return m;
            updated = true;
            return ok ? { ...m, btwStatus: 'sent' as const } : [];
          });
          return next;
        });
        if (!ok && typeof btwText === 'string' && btwText.trim()) {
          window.dispatchEvent(new CustomEvent('helix:queue-failed-followup', {
            detail: { text: btwText, clientTs: btwClientTs },
          }));
        }
        break;
      }

      case 'claude-error': {
        if (isStaleTerminalTurn()) break;
        const claudeErrorSessionId = latestMessage.sessionId || currentSessionId;
        clearLoadingIndicators();
        markSessionsAsCompleted(claudeErrorSessionId, currentSessionId, selectedSession?.id);
        const isImageDimensionError = typeof latestMessage.error === 'string' &&
          (latestMessage.error.includes('image') || latestMessage.error.includes('Image')) &&
          (latestMessage.error.includes('dimension') || latestMessage.error.includes('2000'));
        setChatMessages((previous) => [
          ...previous,
          {
            type: 'error',
            content: `Error: ${latestMessage.error}`,
            timestamp: new Date(),
            ...(isImageDimensionError ? { isImageDimensionError: true } : {}),
          },
        ]);
        if (isContextOverflowError(latestMessage.error || latestMessage.data)) {
          onContextOverflow?.();
        }
        break;
      }

      case 'cursor-system':
        try {
          const cursorData = latestMessage.data;
          if (
            cursorData &&
            cursorData.type === 'system' &&
            cursorData.subtype === 'init' &&
            cursorData.session_id
          ) {
            if (!isSystemInitForView) {
              return;
            }

            // 仅在用户没有正在浏览的 session 时才自动跳转
            if (!currentSessionId && !isCompactContinuationRef?.current) {
              setIsSystemSessionChange(true);
              systemSessionChangeTargetIdRef.current = String(cursorData.session_id);
              if (!isCompactContinuationPending) {
                onNavigateToSession?.(cursorData.session_id);
              }
              return;
            }
          }
        } catch (error) {
          console.warn('Error handling cursor-system message:', error);
        }
        break;

      case 'cursor-user':
        break;

      case 'cursor-tool-use':
        setChatMessages((previous) => [
          ...previous,
          {
            type: 'assistant',
            content: `Using tool: ${latestMessage.tool} ${latestMessage.input ? `with ${latestMessage.input}` : ''
              }`,
            timestamp: new Date(),
            isToolUse: true,
            toolName: latestMessage.tool,
            toolInput: latestMessage.input,
          },
        ]);
        break;

      case 'cursor-error': {
        const cursorErrorSessionId = latestMessage.sessionId || currentSessionId;
        clearLoadingIndicators();
        markSessionsAsCompleted(cursorErrorSessionId, currentSessionId, selectedSession?.id);
        setChatMessages((previous) => [
          ...previous,
          {
            type: 'error',
            content: `Cursor error: ${latestMessage.error || 'Unknown error'}`,
            timestamp: new Date(),
          },
        ]);
        if (isContextOverflowError(latestMessage.error || latestMessage.data)) {
          onContextOverflow?.();
        }
        break;
      }

      case 'cursor-result': {
        const cursorCompletedSessionId = latestMessage.sessionId || currentSessionId;
        const pendingCursorSessionId = sessionStorage.getItem('pendingSessionId');

        clearLoadingIndicators();
        markSessionsAsCompleted(
          cursorCompletedSessionId,
          currentSessionId,
          selectedSession?.id,
          pendingCursorSessionId,
        );

        try {
          const resultData = latestMessage.data || {};
          const textResult = typeof resultData.result === 'string' ? resultData.result : '';

          if (streamTimerRef.current) {
            clearTimeout(streamTimerRef.current);
            streamTimerRef.current = null;
          }
          const pendingChunk = streamBufferRef.current;
          streamBufferRef.current = '';

          setChatMessages((previous) => {
            const updated = [...previous];
            const lastIndex = updated.length - 1;
            const last = updated[lastIndex];
            if (last && last.type === 'assistant' && !last.isToolUse && last.isStreaming) {
              const finalContent =
                textResult && textResult.trim()
                  ? textResult
                  : `${last.content || ''}${pendingChunk || ''}`;
              // Clone the message instead of mutating in place so React can reliably detect state updates.
              updated[lastIndex] = { ...last, content: finalContent, isStreaming: false };
            } else if (textResult && textResult.trim()) {
              updated.push({
                type: resultData.is_error ? 'error' : 'assistant',
                content: textResult,
                timestamp: new Date(),
                isStreaming: false,
              });
            }
            return updated;
          });
          if (!resultData.is_error) {
            setLatestAssistantTurnCompletion(setChatMessages, true);
          }
        } catch (error) {
          console.warn('Error handling cursor-result message:', error);
        }

        if (
          cursorCompletedSessionId &&
          cursorCompletedSessionId === pendingCursorSessionId &&
          (isCompactContinuationPending || isCompactContinuationRef?.current)
        ) {
          setCurrentSessionId(cursorCompletedSessionId);
          setIsSystemSessionChange(true);
          sessionStorage.removeItem('pendingSessionId');
          sessionStorage.removeItem('compactContinuationPending');
          sessionStorage.removeItem('compactContinuationSourceSessionId');
          sessionStorage.removeItem('compactContinuationSourceProjectName');
          if (isCompactContinuationRef) {
            isCompactContinuationRef.current = false;
          }
          onCompactComplete?.();
          if (window.refreshProjects) {
            setTimeout(() => window.refreshProjects?.(), 500);
          }
        } else if (cursorCompletedSessionId && !currentSessionId && cursorCompletedSessionId === pendingCursorSessionId) {
          setCurrentSessionId(cursorCompletedSessionId);
          sessionStorage.removeItem('pendingSessionId');
          sessionStorage.removeItem('compactContinuationPending');
          sessionStorage.removeItem('compactContinuationSourceSessionId');
          sessionStorage.removeItem('compactContinuationSourceProjectName');
          if (window.refreshProjects) {
            setTimeout(() => window.refreshProjects?.(), 500);
          }
        }
        break;
      }

      case 'cursor-output':
        try {
          const raw = String(latestMessage.data ?? '');
          const cleaned = raw
            .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
            .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
            .trim();

          if (cleaned) {
            streamBufferRef.current += streamBufferRef.current ? `\n${cleaned}` : cleaned;
            if (!streamTimerRef.current) {
              streamTimerRef.current = window.setTimeout(() => {
                const chunk = streamBufferRef.current;
                streamBufferRef.current = '';
                streamTimerRef.current = null;
                appendStreamingChunk(setChatMessages, chunk, true);
              }, 16);
            }
          }
        } catch (error) {
          console.warn('Error handling cursor-output message:', error);
        }
        break;

      case 'claude-complete': {
        const terminalTurnClientTs = Number((latestMessage as any).turnClientTs || 0);
        const newestTurnClientTs = newestCurrentTurnClientTs();
        if (terminalTurnClientTs > 0 && terminalTurnClientTs < newestTurnClientTs) {
          break;
        }
        const pendingSessionId = sessionStorage.getItem('pendingSessionId');
        const completedSessionId =
          latestMessage.sessionId || currentSessionId || pendingSessionId;

        if (latestMessage.exitCode === 0) {
          finalizeStreamingMessage(setChatMessages);
          setLatestAssistantTurnCompletion(setChatMessages, true);
        }
        clearLoadingIndicators();
        markSessionsAsCompleted(
          completedSessionId,
          currentSessionId,
          selectedSession?.id,
          pendingSessionId,
        );

        // Claude：原始逻辑——只在没有当前 session 时才更新 session ID
        if (
          pendingSessionId &&
          latestMessage.exitCode === 0 &&
          (isCompactContinuationPending || isCompactContinuationRef?.current)
        ) {
          setCurrentSessionId(pendingSessionId);
          setIsSystemSessionChange(true);
          sessionStorage.removeItem('pendingSessionId');
          sessionStorage.removeItem('compactContinuationPending');
          sessionStorage.removeItem('compactContinuationSourceSessionId');
          sessionStorage.removeItem('compactContinuationSourceProjectName');
          onCompactComplete?.();
        } else if (pendingSessionId && !currentSessionId && latestMessage.exitCode === 0) {
          setCurrentSessionId(pendingSessionId);
          sessionStorage.removeItem('pendingSessionId');
          sessionStorage.removeItem('compactContinuationPending');
          sessionStorage.removeItem('compactContinuationSourceSessionId');
          sessionStorage.removeItem('compactContinuationSourceProjectName');
        }
        // Claude 原生压缩完成：通知前端将进度条推到 100%
        onClaudeNativeCompactComplete?.();
        // 清除 compact ref（对非 Claude 的 compact continuation 场景兜底）
        if (isCompactContinuationRef) {
          isCompactContinuationRef.current = false;
        }

        if (selectedProject && latestMessage.exitCode === 0) {
          safeLocalStorage.removeItem(`chat_messages_${selectedProject.name}`);
        }
        setPendingPermissionRequests([]);
        break;
      }

      case 'codex-response': {
        const codexData = latestMessage.data;
        if (!codexData) {
          break;
        }
        markLiveTurnActivity(latestMessage.sessionId || activeViewSessionId);
        if (codexData.type !== 'turn_complete') {
          setLatestAssistantTurnCompletion(setChatMessages, false);
        }
        setClaudeStatus((previous) => {
          if (!previous || previous.text !== 'Reconnecting to running session') return previous;
          return { ...previous, text: 'Working...' };
        });

        const makeToolResult = (content: unknown, isError = false) => {
          if (content === null || content === undefined || content === '') {
            return null;
          }
          return {
            content,
            isError,
            timestamp: new Date(),
          };
        };

        const upsertCodexToolMessage = (
          toolId: string,
          nextMessage: Omit<ChatMessage, 'timestamp'> & { timestamp?: Date },
        ) => {
          setChatMessages((previous) => {
            const existingIndex = previous.findIndex((message) => message.isToolUse && message.toolId === toolId);
            const timestamp = previous[existingIndex]?.timestamp || nextMessage.timestamp || new Date();
            const message = {
              ...nextMessage,
              timestamp,
              toolId,
              isToolUse: true,
            } as ChatMessage;

            if (existingIndex === -1) {
              return [...previous, message];
            }

            const updated = [...previous];
            updated[existingIndex] = {
              ...updated[existingIndex],
              ...message,
              timestamp,
            };
            return updated;
          });
        };

        const upsertCodexTextMessage = (
          itemId: string,
          content: string,
          extra: Partial<ChatMessage> = {},
        ) => {
          if (!content.trim()) return;
          setChatMessages((previous) => {
            const existingIndex = previous.findIndex((message) => (message as any).codexItemId === itemId);
            const timestamp = existingIndex >= 0 ? previous[existingIndex].timestamp : new Date();
            const message = {
              type: 'assistant',
              content,
              timestamp,
              ...(extra as any),
              codexItemId: itemId,
            } as ChatMessage;

            if (existingIndex === -1) {
              return [...previous, message];
            }

            const updated = [...previous];
            updated[existingIndex] = {
              ...updated[existingIndex],
              ...message,
              timestamp,
            };
            return updated;
          });
        };

        if (codexData.type === 'item') {
          switch (codexData.itemType) {
            case 'agent_message':
              if (codexData.message?.content?.trim()) {
                const content = decodeHtmlEntities(codexData.message.content);
                upsertCodexTextMessage(
                  codexData.itemId || `codex-agent-${content.slice(0, 24)}`,
                  content,
                );
              }
              break;

            case 'reasoning':
              if (codexData.message?.content?.trim()) {
                const content = decodeHtmlEntities(codexData.message.content);
                upsertCodexTextMessage(
                  codexData.itemId || `codex-reasoning-${content.slice(0, 24)}`,
                  content,
                  { isThinking: true } as Partial<ChatMessage>,
                );
              }
              break;

            case 'command_execution':
              if (codexData.command) {
                const isError = codexData.status === 'failed' || Number(codexData.exitCode || 0) > 0;
                upsertCodexToolMessage(codexData.itemId || `codex-command-${codexData.command}`, {
                  type: 'assistant',
                  content: '',
                  toolName: 'Exec command',
                  toolInput: {
                    command: codexData.command,
                    status: codexData.status,
                  },
                  toolResult: makeToolResult(codexData.output, isError),
                  exitCode: codexData.exitCode,
                  codexStatus: codexData.status,
                });
              }
              break;

            case 'file_change':
              if (codexData.changes?.length > 0) {
                const changesList = codexData.changes
                  .map((change: { kind: string; path: string }) => `${change.kind}: ${change.path}`)
                  .join('\n');
                upsertCodexToolMessage(codexData.itemId || `codex-file-change-${changesList}`, {
                  type: 'assistant',
                  content: '',
                  toolName: 'Editing',
                  toolInput: {
                    changes: codexData.changes,
                    status: codexData.status,
                  },
                  toolResult: makeToolResult(`Status: ${codexData.status}`, codexData.status === 'failed'),
                  codexStatus: codexData.status,
                });
              }
              break;

            case 'mcp_tool_call':
              upsertCodexToolMessage(
                codexData.itemId || `codex-mcp-${codexData.server}-${codexData.tool}`,
                {
                  type: 'assistant',
                  content: '',
                  toolName: 'MCP tool',
                  toolInput: {
                    server: codexData.server,
                    tool: codexData.tool,
                    arguments: codexData.arguments ?? {},
                    status: codexData.status,
                  },
                  toolResult: makeToolResult(
                    codexData.result
                      ? stringifyCodexPayload(codexData.result)
                      : codexData.error?.message,
                    Boolean(codexData.error),
                  ),
                  codexStatus: codexData.status,
                },
              );
              break;

            case 'web_search':
              upsertCodexToolMessage(codexData.itemId || `codex-web-search-${codexData.query}`, {
                type: 'assistant',
                content: '',
                toolName: 'Web search',
                toolInput: { query: codexData.query, status: codexData.status },
                toolResult: makeToolResult(
                  codexData.status === 'completed' ? 'Search completed' : null,
                  false,
                ),
                codexStatus: codexData.status,
              });
              break;

            case 'todo_list': {
              const todos = Array.isArray(codexData.items)
                ? codexData.items.map((item: { text?: string; completed?: boolean }) => ({
                    content: item.text || '',
                    status: item.completed ? 'completed' : 'pending',
                  }))
                : [];
              upsertCodexToolMessage(codexData.itemId || 'codex-todo-list', {
                type: 'assistant',
                content: '',
                toolName: 'TodoWrite',
                toolInput: { todos, status: codexData.status },
                toolResult: makeToolResult('Todo list updated', false),
                codexStatus: codexData.status,
              });
              break;
            }

            case 'error': {
              // 错误正文回退链：优先 message.content；为空时序列化 message，再退到整个 payload，
              // 最后兜底一句提示——绝不静默吞掉，确保前端永远能看到“到底报了什么错”。
              const errorContent =
                codexData.message?.content ||
                stringifyCodexPayload(codexData.message) ||
                stringifyCodexPayload(codexData) ||
                'Codex 返回了错误事件，但未携带错误正文';
              setChatMessages((previous) => [
                ...previous,
                {
                  type: 'error',
                  content: errorContent,
                  timestamp: new Date(),
                },
              ]);
              break;
            }

            default:
              console.log('[Codex] Unhandled item type:', codexData.itemType, codexData);
          }
        }

        if (codexData.type === 'turn_complete') {
          const usage = codexData.usage as Record<string, unknown> | undefined;
          if (usage) {
            const input = Number(usage.input_tokens || usage.prompt_tokens || usage.total_input_tokens || 0);
            const output = Number(usage.output_tokens || 0);
            if (input > 0 || output > 0) {
              const usageSessionId = latestMessage.sessionId || currentSessionId;
              realTokensRef.current = {
                input: Math.max(realTokensRef.current.input, input),
                output: Math.max(realTokensRef.current.output, output),
                cacheRead: 0,
                cacheCreation: 0,
              };
              realTokensSessionIdRef.current = usageSessionId || null;
              if (usageSessionId) {
                setLiveSessionTokens(
                  usageSessionId,
                  realTokensRef.current.input,
                  realTokensRef.current.output,
                );
              }
            }
          }
          // `codex-complete` is emitted after the app-server notification loop
          // has fully drained. Do not close the UI on this earlier usage event.
        }

        if (codexData.type === 'turn_failed') {
          if (isStaleTerminalTurn()) break;
          clearLoadingIndicators();
          markSessionsAsCompleted(latestMessage.sessionId, currentSessionId, selectedSession?.id);
          setChatMessages((previous) => [
            ...previous,
            {
              type: 'error',
              // error 可能是对象（无 .message 字段），回退序列化整个 error，避免只显示笼统的 "Turn failed"
              content:
                codexData.error?.message ||
                stringifyCodexPayload(codexData.error) ||
                'Turn failed',
              timestamp: new Date(),
            },
          ]);
        }

        // 顶层 error 事件（后端 transformCodexEvent 的 `{type:'error', message}`）此前没有任何分支，
        // 会被静默吞掉 —— 这是“红色报错被吞”的主因。这里补上，确保顶层错误也能渲染出来。
        if (codexData.type === 'error') {
          const topLevelError =
            (typeof codexData.message === 'string' && codexData.message) ||
            stringifyCodexPayload(codexData.message) ||
            stringifyCodexPayload(codexData) ||
            'Codex 返回了未知错误';
          setChatMessages((previous) => [
            ...previous,
            {
              type: 'error',
              content: topLevelError,
              timestamp: new Date(),
            },
          ]);
          if (isContextOverflowError(codexData.message ?? codexData)) {
            onContextOverflow?.();
          }
        }
        break;
      }

      case 'codex-complete': {
        const terminalTurnClientTs = Number((latestMessage as any).turnClientTs || 0);
        const newestTurnClientTs = newestCurrentTurnClientTs();
        if (terminalTurnClientTs > 0 && terminalTurnClientTs < newestTurnClientTs) {
          break;
        }
        const codexPendingSessionId = sessionStorage.getItem('pendingSessionId');
        const codexActualSessionId = latestMessage.actualSessionId || codexPendingSessionId;
        const codexCompletedSessionId =
          latestMessage.sessionId || currentSessionId || codexPendingSessionId;

        finalizeStreamingMessage(setChatMessages);
        setLatestAssistantTurnCompletion(setChatMessages, true);
        clearLoadingIndicators();
        markSessionsAsCompleted(
          codexCompletedSessionId,
          codexActualSessionId,
          currentSessionId,
          selectedSession?.id,
          codexPendingSessionId,
        );

        if (
          codexPendingSessionId &&
          codexActualSessionId &&
          (isCompactContinuationPending || isCompactContinuationRef?.current)
        ) {
          setCurrentSessionId(codexActualSessionId);
          setIsSystemSessionChange(true);
          sessionStorage.removeItem('pendingSessionId');
          sessionStorage.removeItem('compactContinuationPending');
          sessionStorage.removeItem('compactContinuationSourceSessionId');
          sessionStorage.removeItem('compactContinuationSourceProjectName');
          if (isCompactContinuationRef) {
            isCompactContinuationRef.current = false;
          }
          onCompactComplete?.();
        } else if (codexPendingSessionId && !currentSessionId && !isCompactContinuationRef?.current) {
          setCurrentSessionId(codexActualSessionId);
          setIsSystemSessionChange(true);
          if (codexActualSessionId && !isCompactContinuationPending) {
            onNavigateToSession?.(codexActualSessionId);
          }
          sessionStorage.removeItem('pendingSessionId');
          sessionStorage.removeItem('compactContinuationPending');
          sessionStorage.removeItem('compactContinuationSourceSessionId');
          sessionStorage.removeItem('compactContinuationSourceProjectName');
        }

        if (selectedProject) {
          safeLocalStorage.removeItem(`chat_messages_${selectedProject.name}`);
        }
        break;
      }

      case 'codex-error': {
        if (isStaleTerminalTurn()) break;
        const codexErrorSessionId = latestMessage.sessionId || currentSessionId;
        clearLoadingIndicators();
        markSessionsAsCompleted(codexErrorSessionId, currentSessionId, selectedSession?.id);
        setChatMessages((previous) => [
          ...previous,
          {
            type: 'error',
            content: latestMessage.error || 'An error occurred with Codex',
            timestamp: new Date(),
          },
        ]);
        if (isContextOverflowError(latestMessage.error || latestMessage.data)) {
          onContextOverflow?.();
        }
        break;
      }

      case 'error': {
        // This is a connection-scoped server error (for example a command
        // dispatch failure before a provider can create a session). It has no
        // session id by design, so render it instead of silently dropping it.
        const errorContent =
          latestMessage.error ||
          latestMessage.message ||
          stringifyCodexPayload(latestMessage.data) ||
          'The server rejected the chat request without an error message.';
        setChatMessages((previous) => [
          ...previous,
          {
            type: 'error',
            content: String(errorContent),
            timestamp: new Date(),
            localOnly: true,
          },
        ]);
        break;
      }

      case 'gemini-response': {
        const geminiData = latestMessage.data;

        if (geminiData && geminiData.type === 'message' && typeof geminiData.content === 'string') {
          const content = decodeHtmlEntities(geminiData.content);

          if (content) {
            streamBufferRef.current += streamBufferRef.current ? `\n${content}` : content;
          }

          if (!geminiData.isPartial) {
            // Immediate flush and finalization for the last chunk
            if (streamTimerRef.current) {
              clearTimeout(streamTimerRef.current);
              streamTimerRef.current = null;
            }
            const chunk = streamBufferRef.current;
            streamBufferRef.current = '';

            if (chunk) {
              appendStreamingChunk(setChatMessages, chunk, true);
            }
            finalizeStreamingMessage(setChatMessages);
          } else if (!streamTimerRef.current && streamBufferRef.current) {
            streamTimerRef.current = window.setTimeout(() => {
              const chunk = streamBufferRef.current;
              streamBufferRef.current = '';
              streamTimerRef.current = null;

              if (chunk) {
                appendStreamingChunk(setChatMessages, chunk, true);
              }
            }, 16);
          }
        }
        break;
      }

      case 'gemini-error': {
        const geminiErrorSessionId = latestMessage.sessionId || currentSessionId;
        clearLoadingIndicators();
        markSessionsAsCompleted(geminiErrorSessionId, currentSessionId, selectedSession?.id);
        setChatMessages((previous) => [
          ...previous,
          {
            type: 'error',
            content: latestMessage.error || 'An error occurred with Gemini',
            timestamp: new Date(),
          },
        ]);
        if (isContextOverflowError(latestMessage.error || latestMessage.data)) {
          onContextOverflow?.();
        }
        break;
      }

      case 'gemini-tool-use':
        setChatMessages((previous) => [
          ...previous,
          {
            type: 'assistant',
            content: '',
            timestamp: new Date(),
            isToolUse: true,
            toolName: latestMessage.toolName,
            toolInput: latestMessage.parameters ? JSON.stringify(latestMessage.parameters, null, 2) : '',
            toolId: latestMessage.toolId,
            toolResult: null,
          }
        ]);
        break;

      case 'gemini-tool-result':
        setChatMessages((previous) =>
          previous.map((message) => {
            if (message.isToolUse && message.toolId === latestMessage.toolId) {
              return {
                ...message,
                toolResult: {
                  content: latestMessage.output || `Status: ${latestMessage.status}`,
                  isError: latestMessage.status === 'error',
                  timestamp: new Date(),
                },
              };
            }
            return message;
          }),
        );
        break;

      case 'session-aborted': {
        const pendingSessionId =
          typeof window !== 'undefined' ? sessionStorage.getItem('pendingSessionId') : null;
        const abortedSessionId = latestMessage.sessionId || currentSessionId;
        const abortSucceeded = latestMessage.success !== false;

        if (abortSucceeded) {
          clearLoadingIndicators();
          markSessionsAsCompleted(abortedSessionId, currentSessionId, selectedSession?.id, pendingSessionId);
          if (pendingSessionId && (!abortedSessionId || pendingSessionId === abortedSessionId)) {
            sessionStorage.removeItem('pendingSessionId');
            sessionStorage.removeItem('compactContinuationPending');
            sessionStorage.removeItem('compactContinuationSourceSessionId');
            sessionStorage.removeItem('compactContinuationSourceProjectName');
          }

          setPendingPermissionRequests([]);
          setChatMessages((previous) => [
            ...previous,
            {
              type: 'assistant',
              content: 'Session interrupted by user.',
              timestamp: new Date(),
            },
          ]);
        } else {
          setChatMessages((previous) => [
            ...previous,
            {
              type: 'error',
              content: 'Stop request failed. The session is still running.',
              timestamp: new Date(),
            },
          ]);
        }
        break;
      }

      case 'session-status': {
        const statusSessionId = latestMessage.sessionId;
        if (!statusSessionId) {
          break;
        }

        const aliasedStatusSessionId =
          compactSessionAliasRef.current.get(statusSessionId) || statusSessionId;
        const isCurrentSession =
          aliasedStatusSessionId === currentSessionId ||
          aliasedStatusSessionId === selectedRuntimeSessionId ||
          aliasedStatusSessionId === activeViewSessionId ||
          statusSessionId === currentSessionId ||
          statusSessionId === selectedRuntimeSessionId ||
          (selectedSession && statusSessionId === selectedSession.id);

        if (latestMessage.isProcessing) {
          onSessionProcessing?.(statusSessionId);
          if (isCurrentSession) {
            // 刷新/重连后服务端确认当前查看的会话仍在运行：必须同时加入 activeSessions（实时流式集合）。
            // 否则加载 effect 在 WS 连接态只信任 activeSessions，会反复算出 shouldBeProcessing=false
            // 并 setIsLoading(false)，与本分支的 setIsLoading(true) 互相打架，导致状态栏"一闪一闪"。
            onSessionActive?.(statusSessionId);
            // The authoritative active response is itself real activity. Seed
            // the watchdog clock so a refreshed tab keeps polling even when a
            // long Codex command emits no stream events until it exits. This
            // also recovers the completion if the old socket receives it.
            markLiveTurnActivity(statusSessionId);
            setCanAbortSession(true);
            if (latestMessage.startedAt) {
              try {
                const parsedStartedAt = parseStartedAt(latestMessage.startedAt);
                if (Number.isFinite(parsedStartedAt)) {
                  sessionStorage.setItem('task_start_time', String(parsedStartedAt));
                }
              } catch { /* ignore */ }
              persistProcessingStartedAt(statusSessionId, latestMessage.startedAt);
            }
            setClaudeStatus((previous) => {
              const statusText = String(latestMessage.statusText || '').trim() || 'Working in background';
              const restoredInput = Math.max(
                Number(previous?.inputTokens || 0),
                Number(latestMessage.inputTokens || 0),
              );
              const restoredOutput = Math.max(
                Number(previous?.outputTokens || 0),
                Number(latestMessage.outputTokens || 0),
              );
              return {
                text: statusText,
                tokens: Math.max(Number(previous?.tokens || 0), restoredInput + restoredOutput),
                inputTokens: restoredInput,
                outputTokens: restoredOutput,
                startedAt: latestMessage.startedAt || Date.now(),
                can_interrupt: true,
              };
            });
            persistActiveTurnStatus(statusSessionId, {
              text: String(latestMessage.statusText || '').trim() || 'Working in background',
              tokens: Number(latestMessage.inputTokens || 0) + Number(latestMessage.outputTokens || 0),
              inputTokens: Number(latestMessage.inputTokens || 0),
              outputTokens: Number(latestMessage.outputTokens || 0),
              startedAt: latestMessage.startedAt || Date.now(),
              can_interrupt: true,
            });
          }
          break;
        }

        if (isStaleTerminalTurn()) break;

        // A single idle result can race with runtime-id adoption or compaction.
        // Once this tab has observed the turn, require a second server result
        // after a quiet interval. Any new stream event cancels this confirmation.
        if (isCurrentSession && authoritativeTurnInFlightRef.current) {
          const now = Date.now();
          const pendingIdle = idleStatusConfirmationRef.current;
          if (
            !pendingIdle
            || pendingIdle.sessionId !== statusSessionId
            || now - pendingIdle.firstSeenAt < 1500
          ) {
            if (!pendingIdle || pendingIdle.sessionId !== statusSessionId) {
              idleStatusConfirmationRef.current = { sessionId: statusSessionId, firstSeenAt: now };
            }
            if (staleLoadingTimerRef.current) clearTimeout(staleLoadingTimerRef.current);
            staleLoadingTimerRef.current = setTimeout(() => {
              staleLoadingTimerRef.current = null;
              sendMessage?.({
                type: 'check-session-status',
                sessionId: statusSessionId,
                provider,
                viewSessionId: selectedSession?.id || currentSessionId || statusSessionId,
              });
            }, 2500);
            break;
          }
        }

        idleStatusConfirmationRef.current = null;
        markSessionsAsCompleted(
          statusSessionId,
          currentSessionId,
          selectedSession?.id,
          selectedRuntimeSessionId,
          activeViewSessionId,
        );
        if (isCurrentSession) {
          finalizeStreamingMessage(setChatMessages);
          setRecoveredAssistantTurnCompletion(setChatMessages);
          clearLoadingIndicators();
        }
        break;
      }

      case 'claude-status': {
        // 只处理当前 session 的状态消息，避免后台 session 触发假工作动画
        const claudeStatusSessionId = latestMessage.sessionId;
        if (claudeStatusSessionId) {
          const aliasedClaudeStatusSessionId =
            compactSessionAliasRef.current.get(claudeStatusSessionId) || claudeStatusSessionId;
          const isCurrentStatusSession =
            aliasedClaudeStatusSessionId === activeViewSessionId ||
            claudeStatusSessionId === activeViewSessionId;
          if (!isCurrentStatusSession) {
            break;
          }
        } else {
          // 没有 sessionId 的 claude-status 无法验证归属，忽略以防误触发 loading
          break;
        }

        const statusData = latestMessage.data;
        if (!statusData) {
          break;
        }
        const statusProvider = (latestMessage as any).provider || provider;

        // 哨兵检测：会话已完成（-1），拒绝延迟到达的 claude-status，防止完成后重新显示工作中
        if (lastRealActivityRef.current === -1) {
          break;
        }

        markLiveTurnActivity(claudeStatusSessionId);

        // stale 检测：距上次真实消息超过 120s，忽略此状态消息
        if (lastRealActivityRef.current > 0) {
          const elapsed = Date.now() - lastRealActivityRef.current;
          if (elapsed > 120000) {
            break;
          }
        }

        const statusInfo: { text: string; tokens: number; can_interrupt: boolean; inputTokens?: number; outputTokens?: number; startedAt?: number | string } = {
          text: 'Working...',
          tokens: 0,
          can_interrupt: true,
        };

        if (statusData.message) {
          statusInfo.text = statusData.message;
        } else if (statusData.status) {
          statusInfo.text = statusData.status;
        } else if (typeof statusData === 'string') {
          statusInfo.text = statusData;
        }

        if (statusData.tokens) {
          statusInfo.tokens = statusData.tokens;
        } else if (statusData.token_count) {
          statusInfo.tokens = statusData.token_count;
        }

        // Codex exposes both directly typed text and the authoritative per-turn
        // model usage. The status row must use the latter so tool-heavy turns and
        // refresh recovery do not collapse back to a tiny prompt estimate.
        const acceptsTurnUsage = statusProvider !== 'codex'
          || statusData.usageScope === 'turn-billing'
          || statusData.usageScope === 'turn-direct';
        const streamedInputTokens = acceptsTurnUsage
          ? Number(
            statusProvider === 'codex'
              ? (statusData.billingInputTokens ?? statusData.inputTokens ?? statusData.input_tokens ?? 0)
              : (statusData.inputTokens ?? statusData.input_tokens ?? 0),
          )
          : 0;
        const streamedOutputTokens = Number(
          statusProvider === 'codex'
            ? (statusData.billingOutputTokens ?? statusData.outputTokens ?? statusData.output_tokens ?? 0)
            : (statusData.outputTokens ?? statusData.output_tokens ?? 0),
        );
        if (streamedInputTokens > 0 || streamedOutputTokens > 0) {
          statusInfo.inputTokens = streamedInputTokens;
          statusInfo.outputTokens = streamedOutputTokens;
          if (statusInfo.tokens === 0) {
            statusInfo.tokens = streamedInputTokens + streamedOutputTokens;
          }
        }

        if (
          statusProvider === 'codex'
          && claudeStatusSessionId
          && (streamedInputTokens > 0 || streamedOutputTokens > 0)
        ) {
          const previousReal = realTokensSessionIdRef.current === claudeStatusSessionId
            ? realTokensRef.current
            : { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
          realTokensRef.current = {
            input: Math.max(previousReal.input, streamedInputTokens),
            output: Math.max(previousReal.output, streamedOutputTokens),
            cacheRead: 0,
            cacheCreation: 0,
          };
          realTokensSessionIdRef.current = claudeStatusSessionId;
          setLiveSessionTokens(
            claudeStatusSessionId,
            realTokensRef.current.input,
            realTokensRef.current.output,
          );
        }

        if (statusData.can_interrupt !== undefined) {
          statusInfo.can_interrupt = statusData.can_interrupt;
        }
        if (statusData.startedAt || latestMessage.startedAt) {
          statusInfo.startedAt = statusData.startedAt || latestMessage.startedAt;
        }

        // 保留已有的真实 token 细分数据（避免被 claude-status 覆盖后丢失 ↑↓ 显示）
        const rt = realTokensRef.current;
        if (statusProvider !== 'codex' && (rt.input > 0 || rt.output > 0)) {
          const inputTotal = rt.input + rt.cacheRead + rt.cacheCreation;
          statusInfo.inputTokens = Math.max(statusInfo.inputTokens || 0, inputTotal);
          statusInfo.outputTokens = Math.max(statusInfo.outputTokens || 0, rt.output);
          statusInfo.tokens = Math.max(
            statusInfo.tokens,
            (statusInfo.inputTokens || 0) + (statusInfo.outputTokens || 0),
          );
        }

        persistActiveTurnStatus(claudeStatusSessionId, statusInfo);

        // 更新活动时间戳：工具执行期间定期到达的 claude-status 也是服务器活跃的证明，
        // 避免长时间工具执行（>30s无 claude-response）时 stale 检测误拒后续状态消息
        lastRealActivityRef.current = Date.now();
        if (claudeStatusSessionId && statusInfo.startedAt) {
          const parsedStartedAt = parseStartedAt(statusInfo.startedAt);
          if (parsedStartedAt) {
            try {
              sessionStorage.setItem('task_start_time', String(parsedStartedAt));
            } catch { /* ignore */ }
            persistProcessingStartedAt(claudeStatusSessionId, parsedStartedAt);
          }
        }

        const statusBudget = buildTokenBudgetFromStatus(
          statusInfo,
          statusData,
          statusProvider,
          claudeStatusSessionId,
        );
        if (statusBudget) {
          setTokenBudget((previousBudget) => mergeTokenBudget(previousBudget, statusBudget));
          publishTokenBudgetSnapshot(statusBudget);
        }

        setClaudeStatus((previous) => {
          const previousStartedAt = parseStartedAt(previous?.startedAt);
          const incomingStartedAt = parseStartedAt(statusInfo.startedAt);
          const baseline = incomingStartedAt !== null
            && previousStartedAt !== null
            && incomingStartedAt > previousStartedAt + 500
            ? null
            : previous;
          const inputTokens = Math.max(baseline?.inputTokens || 0, statusInfo.inputTokens || 0);
          const outputTokens = Math.max(baseline?.outputTokens || 0, statusInfo.outputTokens || 0);
          return {
            ...statusInfo,
            tokens: Math.max(baseline?.tokens || 0, statusInfo.tokens, inputTokens + outputTokens),
            inputTokens,
            outputTokens,
            startedAt: statusInfo.startedAt || baseline?.startedAt,
          };
        });
        setIsLoading(true);
        setCanAbortSession(statusInfo.can_interrupt);

        // 不再用本地短超时关闭工作栏。长时间工具执行可能几分钟没有新事件，
        // 是否结束应由 complete/error/session-status=false 决定。
        if (staleLoadingTimerRef.current) clearTimeout(staleLoadingTimerRef.current);
        staleLoadingTimerRef.current = null;
        break;
      }

      case 'pending-permissions-response': {
        // Server returned pending permissions for this session
        const permSessionId = latestMessage.sessionId;
        const isCurrentPermSession =
          permSessionId === activeViewSessionId;
        if (permSessionId && !isCurrentPermSession) {
          break;
        }
        const serverRequests = latestMessage.data || [];
        setPendingPermissionRequests(serverRequests);
        break;
      }

      // 服务端广播：其他设备/标签发送命令时同步权限模式，保持多端显示一致
      case 'permission-mode-sync': {
        const syncMode = latestMessage.permissionMode as PermissionMode;
        const syncSessionId = latestMessage.sessionId as string;
        if (!syncMode || !syncSessionId) break;
        // 持久化到 localStorage，切换 session 时也能读到最新值
        safeLocalStorage.setItem(`permissionMode-${syncSessionId}`, syncMode);
        // 当前正在查看该 session，直接更新 React 状态
        if (syncSessionId === selectedSession?.id && setPermissionMode) {
          setPermissionMode(syncMode);
        }
        break;
      }

      default:
        break;
    }
    } // end for (const _msg of messagesToProcess)
  }, [
    latestMessage,
    incomingMsgVersion,
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
    onSessionActive,
    onSessionInactive,
    onSessionProcessing,
    onSessionNotProcessing,
    onReplaceTemporarySession,
    onNavigateToSession,
    onContextOverflow,
    setPermissionMode,
    isCompactContinuationRef,
    onCompactSessionCreated,
    onCompactComplete,
  ]);
}
