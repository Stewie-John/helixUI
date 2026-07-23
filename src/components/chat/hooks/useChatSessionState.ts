import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';

import { api, authenticatedFetch } from '../../../utils/api';
import { useDeviceSettings } from '../../../hooks/useDeviceSettings';
import type { ChatMessage, Provider } from '../types/types';
import type { Project, ProjectSession } from '../../../types/app';
import { safeLocalStorage, serializeChatMessagesForStorage } from '../utils/chatStorage';
import {
  getProjectSessionProvider,
  rememberCompactContinuationSession,
  resolveCompactContinuationChainForProject,
  resolveCompactContinuationInfoForProject,
} from '../utils/compactContinuations';
import {
  convertCursorSessionMessages,
  convertSessionMessages,
  createCachedDiffCalculator,
  type DiffCalculator,
} from '../utils/messageTransforms';
import { publishTokenBudgetSnapshot } from '../utils/tokenBudgetEvents';
import { getPersistedActiveTurnStatus } from '../utils/activeTurnStatusStorage';
import { storeSelectedProvider } from '../../../utils/appEvents';

const MESSAGES_PER_PAGE = 20;
const INITIAL_VISIBLE_MESSAGES = 60;
const MOBILE_INITIAL_VISIBLE_MESSAGES = 20;
// 上划到顶时，每次额外向上“揭开”多少条已加载但被窗口截断的本地历史消息
const WINDOW_EXPAND_CHUNK = 40;
// 扩窗冷却：一次惯性甩动（触控板/触屏）会在数百毫秒内触发几十个 scroll 事件。
// 扩窗是同步 setState，且扩窗后的 restore 会把 scrollTop 推到很大的值，导致 topLoadLockRef
// 立刻被解锁（>20px），根本拦不住惯性 → 一次甩动连扩多次、restore 反复把视图拽回原处，
// 表现为「鬼打墙：循环相同内容 + 上下跳」。改用「时间冷却」：与 scrollTop 无关，
// 一次甩动只允许扩窗一次；冷却后用户若仍停在顶部附近，下一次刻意上滑再扩。
const WINDOW_EXPAND_COOLDOWN_MS = 350;
const LOAD_EARLIER_VISIBLE_MESSAGES = 60;
const MOBILE_LOAD_EARLIER_VISIBLE_MESSAGES = 20;
const PROCESSING_STORAGE_KEY = 'processing_sessions';
const CHAT_BOTTOM_THRESHOLD_PX = 24;  // 上滑锁定阈值：离底部 >24px 即判定为"用户已上滑"，敏感锁定
const USER_UPWARD_GESTURE_THRESHOLD_PX = 12;
const FOLLOW_BOTTOM_HEARTBEAT_MS = 180;

type SessionMessageLoadOptions = {
  silent?: boolean;
  signal?: AbortSignal;
  historyWindow?: number;
  expectedViewKey?: string | null;
};

const getRawSessionMessageKey = (message: any) => {
  const id = message?.id ?? message?.uuid ?? message?.messageId ?? message?.toolCallId;
  if (id !== undefined && id !== null && id !== '') return String(id);
  const content = message?.message?.content ?? message?.content ?? message?.output ?? '';
  return `${message?.type || ''}:${String(message?.timestamp || '')}:${String(content).slice(0, 160)}`;
};

const getRawSessionMessageRevision = (message: any) => {
  const summarize = (value: unknown) => {
    if (typeof value !== 'string') return value == null ? '' : typeof value;
    return `${value.length}:${value.slice(-96)}`;
  };
  return [
    getRawSessionMessageKey(message),
    summarize(message?.message?.content),
    summarize(message?.content),
    summarize(message?.output),
    summarize(message?.toolInput),
  ].join(':');
};

const getRawSessionPageRevision = (messages: any[]) =>
  messages.map(getRawSessionMessageRevision).join('|');

const mergeLatestRawSessionPage = (existing: any[], latest: any[]) => {
  if (latest.length === 0) return existing;
  if (existing.length === 0) return latest;
  const existingIndexByKey = new Map(
    existing.map((message, index) => [getRawSessionMessageKey(message), index]),
  );
  let firstExistingIndex = -1;
  for (const message of latest) {
    const index = existingIndexByKey.get(getRawSessionMessageKey(message));
    if (index !== undefined) {
      firstExistingIndex = index;
      break;
    }
  }
  if (firstExistingIndex >= 0) {
    return [...existing.slice(0, firstExistingIndex), ...latest];
  }

  const merged = [...existing];
  const known = new Set(existingIndexByKey.keys());
  for (const message of latest) {
    const key = getRawSessionMessageKey(message);
    if (!known.has(key)) {
      known.add(key);
      merged.push(message);
    }
  }
  return merged;
};

const getChatMessagesStorageKey = (projectName?: string | null, sessionId?: string | null) =>
  projectName && sessionId ? `chat_messages_${projectName}_${sessionId}` : null;

const RESTORED_SESSION_CACHE_VERSIONS: Record<string, string> = {
  'b57b7cc3-7d09-408c-9368-b786185c298e': 'codex-restore-20260529-0200',
};

const getRestoredSessionCacheVersion = (sessionId?: string | null) =>
  sessionId ? RESTORED_SESSION_CACHE_VERSIONS[sessionId] : undefined;

const isRestoredSession = (sessionId?: string | null) =>
  Boolean(getRestoredSessionCacheVersion(sessionId));

const getVersionedChatMessagesStorageKey = (projectName?: string | null, sessionId?: string | null) => {
  const storageKey = getChatMessagesStorageKey(projectName, sessionId);
  const restoreVersion = getRestoredSessionCacheVersion(sessionId);
  return storageKey && restoreVersion ? `${storageKey}_${restoreVersion}` : storageKey;
};

const getLegacyProjectChatMessagesStorageKey = (projectName?: string | null) =>
  projectName ? `chat_messages_${projectName}` : null;

function getStoredProcessingStartedAt(sessionId: string) {
  try {
    const raw = sessionStorage.getItem(PROCESSING_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const record = parsed.find((item) =>
      typeof item === 'string' ? item === sessionId : item?.id === sessionId
    );
    if (!record) return null;
    const startedAt = typeof record === 'string' ? null : Number(record.startedAt);
    return Number.isFinite(startedAt) ? startedAt : null;
  } catch { /* ignore */ }
  return null;
}

type PendingViewSession = {
  sessionId: string | null;
  startedAt: number;
};

const getMessageTime = (message: ChatMessage) => {
  const value = message.timestamp;
  if (typeof value === 'number') return value;
  const parsed = value ? Date.parse(String(value)) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
};

const getLocalUserMessageKey = (message: ChatMessage) => {
  if (message.type !== 'user') return null;
  if (typeof message.clientTs === 'number') {
    return `client:${message.clientTs}`;
  }
  return `fallback:${getMessageTime(message)}:${String(message.content || '')}`;
};

// 本地乐观 user 消息与服务端回写副本的内容+时间邻近兜底窗口。
// 服务端 JSONL 不保存前端的 clientTs（convertSessionMessages 产出的 user 消息无 clientTs），
// 故本地的 `client:${clientTs}` key 与服务端的 `fallback:${time}:${content}` key 永不相等。
// 平时 WS 流式不触发重载所以不显形；一旦断连/压缩触发 JSONL 重载，本地乐观副本会因 key
// 不匹配被误当作"服务端缺失"而与服务端副本同时显示 → 重复（尤其无 clientTs 的 BTW 消息）。
// 这里用"同内容且时间邻近"作为兜底对账：只丢弃确认服务端已有副本的本地乐观消息，
// 真正尚未回写的本地消息（无同内容服务端副本）仍保留，不影响"发送后立刻 Stop"的保护。
const LOCAL_USER_COVER_WINDOW_MS = 120000;

const getMessageStableId = (message: ChatMessage) => {
  const value =
    message.id ?? message.messageId ?? message.clientTs ?? message.queueId ??
    message.btwId ?? message.toolId ?? message.toolCallId ?? message.blobId ??
    message.rowid ?? message.sequence;
  return value === undefined || value === null || value === ''
    ? null
    : `${message.type}:${String(value)}`;
};

const getChatMessageDeduplicationKey = (message: ChatMessage) => {
  const timestamp = getMessageTime(message);
  if (!timestamp) return null;
  const content = String(message.content || '').trim();
  const toolInput = message.isToolUse ? JSON.stringify(message.toolInput ?? null) : '';
  const toolResult = message.isToolUse ? JSON.stringify(message.toolResult ?? null) : '';
  return [
    'exact',
    message.type,
    timestamp,
    content,
    message.isThinking ? 'thinking' : '',
    message.isToolUse ? String(message.toolName || '') : '',
    message.isToolUse ? String(message.toolCallId || message.toolId || '') : '',
    toolInput,
    toolResult,
  ].join('\u0000');
};

// Session refreshes can expose the same record through the logical rollout,
// runtime rollout, optimistic state, and persisted browser cache. Collapse only
// records with the same intrinsic ID or exact timestamp/content identity so a
// user intentionally sending the same text in separate turns remains visible.
const deduplicateChatMessages = (messages: ChatMessage[]): ChatMessage[] => {
  const seenIds = new Set<string>();
  const seenExactMessages = new Set<string>();
  return messages.filter((message) => {
    const stableId = getMessageStableId(message);
    const exactKey = getChatMessageDeduplicationKey(message);
    if (stableId && seenIds.has(stableId)) return false;
    if (exactKey && seenExactMessages.has(exactKey)) return false;
    if (stableId) seenIds.add(stableId);
    if (exactKey) seenExactMessages.add(exactKey);
    return true;
  });
};

const getTailWithLatestUserBoundary = (messages: ChatMessage[], limit: number): ChatMessage[] => {
  if (!Number.isFinite(limit) || messages.length <= limit) return messages;
  const tailStart = Math.max(0, messages.length - limit);
  let latestUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].type === 'user') {
      latestUserIndex = index;
      break;
    }
  }
  if (latestUserIndex < 0 || latestUserIndex >= tailStart) {
    return messages.slice(tailStart);
  }
  // A long-running turn can emit more tool records than the render window. Keep
  // its user boundary without rendering the entire generated tail.
  return [messages[latestUserIndex], ...messages.slice(tailStart)];
};

const serverCoversLocalMessage = (serverMessage: ChatMessage, localMessage: ChatMessage) => {
  const serverId = getMessageStableId(serverMessage);
  const localId = getMessageStableId(localMessage);
  if (serverId && localId && serverId === localId) return true;
  if (serverMessage.type !== localMessage.type) return false;

  const serverContent = String(serverMessage.content || '').trim();
  const localContent = String(localMessage.content || '').trim();
  const closeInTime = Math.abs(getMessageTime(serverMessage) - getMessageTime(localMessage)) < LOCAL_USER_COVER_WINDOW_MS;
  if (serverContent && localContent && closeInTime) {
    if (serverContent === localContent) return true;
    if (
      localMessage.type === 'assistant' &&
      serverContent.length >= localContent.length &&
      (serverContent.startsWith(localContent) || serverContent.endsWith(localContent))
    ) {
      return true;
    }
  }

  return Boolean(
    closeInTime &&
    localMessage.isToolUse &&
    serverMessage.toolName === localMessage.toolName &&
    JSON.stringify(serverMessage.toolInput ?? null) === JSON.stringify(localMessage.toolInput ?? null)
  );
};

const mergeMissingLocalUserMessages = (
  serverMessages: ChatMessage[],
  localMessages: ChatMessage[],
): ChatMessage[] => {
  serverMessages = deduplicateChatMessages(serverMessages);
  localMessages = deduplicateChatMessages(localMessages);
  // A transient empty/failed refresh must never blank an already rendered
  // conversation. Keep the local snapshot and let the next successful refresh
  // reconcile it.
  if (serverMessages.length === 0 && localMessages.length > 0) {
    return localMessages;
  }
  const serverUserKeys = new Set(
    serverMessages
      .map(getLocalUserMessageKey)
      .filter((key): key is string => Boolean(key)),
  );
  // 按内容索引服务端 user 消息的时间戳，供无精确 key 命中的本地乐观消息做邻近对账
  const serverUserTimesByContent = new Map<string, number[]>();
  for (const message of serverMessages) {
    if (message.type !== 'user') continue;
    const content = String(message.content || '');
    const times = serverUserTimesByContent.get(content);
    if (times) {
      times.push(getMessageTime(message));
    } else {
      serverUserTimesByContent.set(content, [getMessageTime(message)]);
    }
  }

  const missingLocalUsers = localMessages.filter((message) => {
    const key = getLocalUserMessageKey(message);
    if (key === null) return false;
    if (serverUserKeys.has(key)) return false; // 精确 key 命中：服务端已有，丢弃本地副本
    // 兜底：服务端已有同内容且时间邻近的 user 消息 → 视为已回写，丢弃本地乐观副本，避免重复
    const serverTimes = serverUserTimesByContent.get(String(message.content || ''));
    if (
      serverTimes &&
      serverTimes.some((t) => Math.abs(t - getMessageTime(message)) < LOCAL_USER_COVER_WINDOW_MS)
    ) {
      return false;
    }
    return true;
  });

  // Provider failures are client-visible terminal events and are often not
  // written to the provider's session transcript. Keep them through a JSONL
  // reload so a successful reload cannot erase the reason a turn failed.
  const missingLocalErrors = localMessages.filter((message) => {
    if (message.type !== 'error') return false;
    const content = String(message.content || '');
    const timestamp = getMessageTime(message);
    return !serverMessages.some((serverMessage) =>
      serverMessage.type === 'error' &&
      String(serverMessage.content || '') === content &&
      Math.abs(getMessageTime(serverMessage) - timestamp) < LOCAL_USER_COVER_WINDOW_MS
    );
  });

  const retainedKeys = new Set([...missingLocalUsers, ...missingLocalErrors]);
  const coveredLocalMessages = localMessages.map((localMessage) =>
    serverMessages.some((serverMessage) => serverCoversLocalMessage(serverMessage, localMessage)),
  );
  let lastCoveredLocalIndex = -1;
  for (let index = coveredLocalMessages.length - 1; index >= 0; index -= 1) {
    if (coveredLocalMessages[index]) {
      lastCoveredLocalIndex = index;
      break;
    }
  }

  for (let index = 0; index < localMessages.length; index += 1) {
    const localMessage = localMessages[index];
    if (retainedKeys.has(localMessage)) continue;
    const isTransient = Boolean(
      localMessage.pending ||
      localMessage.isStreaming ||
      localMessage.isThinking ||
      localMessage.isToolUse ||
      localMessage.deliveryStatus === 'sending' ||
      localMessage.btwStatus === 'pending'
    );
    // JSONL notifications can arrive between the WebSocket's final chunk and
    // the provider's durable write. Preserve every uncovered message after the
    // last server-confirmed item, including a just-completed assistant reply.
    // A later refresh removes the local copy only after the server snapshot
    // demonstrably contains it.
    const isUncommittedTail = index > lastCoveredLocalIndex && !coveredLocalMessages[index];
    if ((isTransient || isUncommittedTail) && !coveredLocalMessages[index]) {
      retainedKeys.add(localMessage);
    }
  }

  const retainedLocalMessages = Array.from(retainedKeys);
  if (retainedLocalMessages.length === 0) {
    return serverMessages;
  }

  return deduplicateChatMessages(
    [...serverMessages, ...retainedLocalMessages].sort((a, b) => getMessageTime(a) - getMessageTime(b)),
  );
};

const stampAssistantProvider = (messages: ChatMessage[], provider: string): ChatMessage[] =>
  messages.map((message) =>
    message.type === 'assistant' && !message.provider
      ? { ...message, provider }
      : message,
  );

const mergeVisibleContinuationMessages = (
  visibleMessages: any[],
  visibleProvider: string,
  continuationMessageGroups: Array<{ messages: any[]; provider: string }>,
) => {
  const convertedVisible = stampAssistantProvider(convertSessionMessages(visibleMessages), visibleProvider);
  const convertedContinuation = continuationMessageGroups.flatMap((group) =>
    stampAssistantProvider(convertSessionMessages(group.messages), group.provider),
  );

  return [...convertedVisible, ...convertedContinuation]
    .map((message, index) => ({ message, index }))
    .sort((a, b) => {
      const diff = getMessageTime(a.message) - getMessageTime(b.message);
      return diff === 0 ? a.index - b.index : diff;
    })
    .map((entry) => entry.message);
};

interface UseChatSessionStateArgs {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  ws: WebSocket | null;
  sendMessage: (message: unknown) => void;
  autoScrollToBottom?: boolean;
  externalMessageUpdate?: number;
  processingSessions?: Set<string>;
  activeSessions?: Set<string>;
  isConnected?: boolean;
  resetStreamingState: () => void;
  pendingViewSessionRef: MutableRefObject<PendingViewSession | null>;
  systemSessionChangeTargetIdRef: MutableRefObject<string | null>;
}

interface ScrollRestoreState {
  height: number;
  // top：在 async 请求完成后、setChatMessages 之前记录的实时 scrollTop。
  // 与浏览器 scroll-anchoring 配合使用绝对赋值（container.scrollTop = top + diff），
  // 避免"我们 += diff + 浏览器也 += diff"的双重叠加跳动。
  top: number;
}

export function useChatSessionState({
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
}: UseChatSessionStateArgs) {
  const { isMobile } = useDeviceSettings({ trackPWA: false });
  const initialVisibleMessages = isMobile ? MOBILE_INITIAL_VISIBLE_MESSAGES : INITIAL_VISIBLE_MESSAGES;
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>(() => {
    const storageKey = getVersionedChatMessagesStorageKey(selectedProject?.name, selectedSession?.id);
    if (typeof window !== 'undefined' && storageKey) {
      const saved = safeLocalStorage.getItem(storageKey);
      if (saved) {
        try {
          return deduplicateChatMessages(JSON.parse(saved) as ChatMessage[]);
        } catch {
          console.error('Failed to parse saved chat messages, resetting');
          safeLocalStorage.removeItem(storageKey);
          return [];
        }
      }
      return [];
    }
    return [];
  });
  const [isLoading, setIsLoading] = useState(false);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(selectedSession?.id || null);
  const [sessionMessages, setSessionMessages] = useState<any[]>([]);
  const visibleSessionStorageKeyRef = useRef(getVersionedChatMessagesStorageKey(selectedProject?.name, selectedSession?.id));
  const [isLoadingSessionMessages, setIsLoadingSessionMessages] = useState(false);
  const [isLoadingMoreMessages, setIsLoadingMoreMessages] = useState(false);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [totalMessages, setTotalMessages] = useState(0);
  const [isSystemSessionChange, setIsSystemSessionChange] = useState(false);
  const isSystemSessionChangeRef = useRef(false);
  const [canAbortSession, setCanAbortSession] = useState(false);
  const [isUserScrolledUp, setIsUserScrolledUp] = useState(false);
  const isUserScrolledUpRef = useRef(false);
  // 标记由代码触发的滚动，避免 handleScroll 把它误认为用户滚动
  const programmaticScrollTimeRef = useRef<number>(0);  // 时间戳：最近一次代码触发滚动的时刻
  const followBottomFrameRef = useRef<number | null>(null);
  // 兜底识别真实的“向上查看历史”动作。wheel/touch 的 delta 在滚动条拖拽、键盘导航
  // 和流式更新竞争时并不可靠；实际 scrollTop 下降才是唯一不依赖输入设备的信号。
  const lastObservedScrollTopRef = useRef<number | null>(null);
  const fetchInitialTokenUsageRef = useRef<(() => Promise<void>) | null>(null);
  const [tokenBudget, setTokenBudget] = useState<Record<string, unknown> | null>(null);
  const [visibleMessageCount, setVisibleMessageCount] = useState(initialVisibleMessages);
  const [claudeStatus, setClaudeStatus] = useState<{ text: string; tokens: number; inputTokens?: number; outputTokens?: number; startedAt?: number | string; can_interrupt: boolean } | null>(null);
  const [allMessagesLoaded, setAllMessagesLoaded] = useState(false);
  const [isLoadingAllMessages, setIsLoadingAllMessages] = useState(false);
  const [loadAllJustFinished, setLoadAllJustFinished] = useState(false);
  const [showLoadAllOverlay, setShowLoadAllOverlay] = useState(false);
  const userScrollIntentRef = useRef(false);
  const upwardGestureDistanceRef = useRef(0);
  const upwardGestureResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previousChatMessagesLengthRef = useRef(chatMessages.length);
  const chatStorageTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chatStorageIdleRef = useRef<number | null>(null);
  const pendingChatStorageRef = useRef<{ key: string; messages: ChatMessage[] } | null>(null);
  const lastPersistedUserKeyRef = useRef<string | null>(null);
  const hasPendingUserMessage = useMemo(
    () => chatMessages.some((message) => message.type === 'user' && message.pending),
    [chatMessages],
  );
  // Keep session-switch guards initialized before any effect that captures
  // them. This avoids temporal-dead-zone failures in optimized browser bundles.
  const isSystemChangeExemptionValid = useCallback(
    (sessionId?: string | null) => {
      const target = systemSessionChangeTargetIdRef.current;
      return target == null || target === sessionId;
    },
    [systemSessionChangeTargetIdRef],
  );

  const scrollContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const legacyKey = getLegacyProjectChatMessagesStorageKey(selectedProject?.name);
    if (legacyKey) {
      safeLocalStorage.removeItem(legacyKey);
    }
  }, [selectedProject?.name]);

  useEffect(() => {
    if (!isMobile) return;
    setVisibleMessageCount((previousCount) =>
      previousCount > MOBILE_INITIAL_VISIBLE_MESSAGES ? MOBILE_INITIAL_VISIBLE_MESSAGES : previousCount,
    );
  }, [isMobile]);

  useEffect(() => {
    const storageKey = getVersionedChatMessagesStorageKey(selectedProject?.name, selectedSession?.id);
    if (visibleSessionStorageKeyRef.current === storageKey) {
      return;
    }

    visibleSessionStorageKeyRef.current = storageKey;
    // 仅当本次 system-change 的目标正是当前选中会话时才豁免重载（保留乐观气泡）；
    // 若用户在豁免窗口内切到无关会话，则照常从该会话的 localStorage 重载，避免串话。
    if (isSystemSessionChangeRef.current && isSystemChangeExemptionValid(selectedSession?.id)) {
      return;
    }

    setSessionMessages([]);
    if (!storageKey) {
      setChatMessages([]);
      return;
    }

    const saved = safeLocalStorage.getItem(storageKey);
    if (!saved) {
      setChatMessages([]);
      return;
    }

    try {
      setChatMessages(deduplicateChatMessages(JSON.parse(saved) as ChatMessage[]));
    } catch {
      safeLocalStorage.removeItem(storageKey);
      setChatMessages([]);
    }
  }, [selectedProject?.name, selectedSession?.id]);

  // ── 发送状态管理 ───────────────────────────────────────────────
  // isLoading 变为 false（响应结束）→ 清除所有 pending 标记
  useEffect(() => {
    if (!isLoading) {
      setChatMessages(prev => {
        if (!prev.some(m => m.pending)) return prev;
        return prev.map(m => m.pending ? { ...m, pending: false } : m);
      });
    }
  }, [isLoading]);

  // A brief socket reconnect does not mean the command was lost. WebSocketContext
  // retains unacknowledged commands and replays them after reconnecting; only its
  // acknowledgement timeout is allowed to mark a message as failed.
  const isLoadingSessionRef = useRef(false);
  const sessionLoadCountRef = useRef(0);
  const isLoadingMoreRef = useRef(false);
  const allMessagesLoadedRef = useRef(false);
  const topLoadLockRef = useRef(false);
  // 上次扩窗时间戳：用于惯性甩动的时间冷却，避免一次甩动连续扩窗造成「鬼打墙」
  const lastWindowExpandTimeRef = useRef(0);
  const pendingScrollRestoreRef = useRef<ScrollRestoreState | null>(null);
  // 本地窗口扩展（揭开已加载历史）的滚动位置补偿，独立于服务端分页的 pendingScrollRestoreRef
  const pendingWindowRestoreRef = useRef<ScrollRestoreState | null>(null);
  // 供 handleScroll 等事件回调读取最新值（避免 stale closure）
  const chatMessagesLengthRef = useRef(chatMessages.length);
  const visibleMessageCountRef = useRef(initialVisibleMessages);
  const pendingInitialScrollRef = useRef(true);
  const messagesOffsetRef = useRef(0);
  const scrollPositionRef = useRef({ height: 0, top: 0 });
  const loadAllFinishedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadAllOverlayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 防止后台 session 永久占用 loading 状态：记录最近一次收到真实消息的时间
  const lastRealMessageTimeRef = useRef<number>(0);
  // 超时计时器：isLoading=true 后若 90s 内无新消息则自动清除
  const staleLoadingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastLoadedSessionKeyRef = useRef<string | null>(null);
  // 记录当前正在加载的 session ID，用于过期检查（避免旧请求覆盖新会话的消息）
  const activeLoadSessionIdRef = useRef<string | null>(null);
  // Bug2 修复：externalMessageUpdate 是一次性信号，若被 transient guard
  // （activeSessions / hasPendingUserMessage）跳过则永久丢失，导致消息被"吞掉"需手动刷新。
  // 用一个 nonce 在 guard 命中时安排有限次重试，重新触发重载 effect（读取新鲜的 guard 值）。
  const [externalReloadNonce, setExternalReloadNonce] = useState(0);
  const externalReloadRetryRef = useRef(0);
  const externalReloadRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const externalReloadInFlightRef = useRef(false);
  const externalReloadQueuedRef = useRef(false);
  const prevExternalUpdateRef = useRef(0);
  const prevSessionMessagesLengthRef = useRef(0);
  // 跟踪最新 sessionMessages（用于 loadOlderMessages 闭包，避免 stale closure）
  const sessionMessagesRef = useRef<any[]>([]);
  // 标记：loadOlderMessages 已原子更新 chatMessages，sync useEffect 应跳过本次
  const skipSyncRef = useRef(false);

  const createDiff = useMemo<DiffCalculator>(() => createCachedDiffCalculator(), []);

  const beginSessionLoad = useCallback(() => {
    sessionLoadCountRef.current += 1;
    if (sessionLoadCountRef.current === 1) setIsLoadingSessionMessages(true);
  }, []);

  const endSessionLoad = useCallback(() => {
    sessionLoadCountRef.current = Math.max(0, sessionLoadCountRef.current - 1);
    if (sessionLoadCountRef.current === 0) setIsLoadingSessionMessages(false);
  }, []);

  const loadSessionMessages = useCallback(
    async (
      projectName: string,
      sessionId: string,
      loadMore = false,
      provider: Provider | string = 'claude',
      options: SessionMessageLoadOptions = {},
    ) => {
      if (!projectName || !sessionId) {
        return [] as any[];
      }

      const isFirstPage = !loadMore;
      const showLoadingState = !options.silent;
      if (isFirstPage && showLoadingState) {
        beginSessionLoad();
      } else if (loadMore && showLoadingState) {
        setIsLoadingMoreMessages(true);
      }

      try {
        const currentOffset = loadMore ? messagesOffsetRef.current : 0;
        const response = await (api.sessionMessages as any)(
          projectName,
          sessionId,
          MESSAGES_PER_PAGE,
          currentOffset,
          provider,
          { signal: options.signal },
        );
        if (!response.ok) {
          throw new Error('Failed to load session messages');
        }

        let data = await response.json();

        // Large history requests may finish after the user has selected another
        // conversation. Never let a stale response mutate the new view.
        if (
          options.expectedViewKey !== undefined &&
          visibleSessionStorageKeyRef.current !== options.expectedViewKey
        ) {
          return [];
        }

        // provider 兜底重试：claude 端点查无内容时，该会话很可能是被误判的 codex 会话
        // （例如 shell 里刚新建、尚未进入 codex 索引，或 __provider 元数据缺失而回退成了默认 'claude'）。
        // 此时自动改用 codex 端点重试一次；若 codex 有内容则采用之。对真正为空的 claude 会话仅多一次无害请求。
        if (
          isFirstPage &&
          provider === 'claude' &&
          Number(data.total || 0) === 0 &&
          (!data.messages || data.messages.length === 0)
        ) {
          try {
            const codexResponse = await (api.sessionMessages as any)(
              projectName,
              sessionId,
              MESSAGES_PER_PAGE,
              0,
              'codex',
              { signal: options.signal },
            );
            if (codexResponse.ok) {
              const codexData = await codexResponse.json();
              if (
                options.expectedViewKey !== undefined &&
                visibleSessionStorageKeyRef.current !== options.expectedViewKey
              ) {
                return [];
              }
              if (Number(codexData.total || 0) > 0 || (codexData.messages && codexData.messages.length > 0)) {
                data = codexData;
              }
            }
          } catch {
            /* 忽略重试失败，保持原 claude 空结果 */
          }
        }
        if (isFirstPage && data.tokenUsage) {
          setTokenBudget((previous) => (
            previous?.used === data.tokenUsage.used && previous?.total === data.tokenUsage.total
              ? previous
              : data.tokenUsage
          ));
        }

        if (data.hasMore !== undefined) {
          const loadedCount = data.messages?.length || 0;
          const nextHasMore = Boolean(data.hasMore);
          const nextTotal = Number(data.total || 0);
          setHasMoreMessages((previous) => previous === nextHasMore ? previous : nextHasMore);
          setTotalMessages((previous) => previous === nextTotal ? previous : nextTotal);
          if (!options.silent) {
            messagesOffsetRef.current = currentOffset + loadedCount;
          }
          return data.messages || [];
        }

        const messages = data.messages || [];
        setHasMoreMessages(false);
        setTotalMessages(messages.length);
        messagesOffsetRef.current = messages.length;
        return messages;
      } catch (error) {
        if (options.signal?.aborted) return [];
        console.error('Error loading session messages:', error);
        return [];
      } finally {
        if (isFirstPage && showLoadingState) {
          endSessionLoad();
        } else if (loadMore && showLoadingState) {
          setIsLoadingMoreMessages(false);
        }
      }
    },
    [beginSessionLoad, endSessionLoad],
  );

  const loadCompleteSessionMessages = useCallback(
    async (
      projectName: string,
      sessionId: string,
      provider: Provider | string = 'claude',
      options: SessionMessageLoadOptions = {},
    ) => {
      if (!projectName || !sessionId) {
        return [] as any[];
      }

      if (!options.silent) beginSessionLoad();

      try {
        const response = await (api.sessionMessages as any)(
          projectName,
          sessionId,
          options.historyWindow ?? null,
          0,
          provider,
          {
            signal: options.signal,
            fullTranscript: options.historyWindow === undefined,
          },
        );
        if (!response.ok) {
          throw new Error('Failed to load complete session messages');
        }

        const data = await response.json();
        return Array.isArray(data.messages) ? data.messages : Array.isArray(data) ? data : [];
      } catch (error) {
        if (options.signal?.aborted) return [];
        console.error('Error loading complete session messages:', error);
        return [];
      } finally {
        if (!options.silent) endSessionLoad();
      }
    },
    [beginSessionLoad, endSessionLoad],
  );

  const loadCursorSessionMessages = useCallback(async (projectPath: string, sessionId: string) => {
    if (!projectPath || !sessionId) {
      return [] as ChatMessage[];
    }

    beginSessionLoad();
    try {
      const url = `/api/cursor/sessions/${encodeURIComponent(sessionId)}?projectPath=${encodeURIComponent(projectPath)}`;
      const response = await authenticatedFetch(url);
      if (!response.ok) {
        return [];
      }

      const data = await response.json();
      const blobs = (data?.session?.messages || []) as any[];
      return convertCursorSessionMessages(blobs, projectPath);
    } catch (error) {
      console.error('Error loading Cursor session messages:', error);
      return [];
    } finally {
      endSessionLoad();
    }
  }, [beginSessionLoad, endSessionLoad]);

  // 保持 sessionMessagesRef 与 sessionMessages 同步（供 loadOlderMessages 异步闭包使用）
  useEffect(() => {
    sessionMessagesRef.current = sessionMessages;
  }, [sessionMessages]);

  const convertedMessages = useMemo(() => {
    const messageProvider = (
      isRestoredSession(selectedSession?.id) ? 'claude' :
      selectedSession?.__provider ||
      getProjectSessionProvider(selectedProject, selectedSession?.id) ||
      'claude'
    ) as Provider;
    return stampAssistantProvider(convertSessionMessages(sessionMessages), messageProvider);
  }, [selectedProject, selectedSession?.__provider, selectedSession?.id, sessionMessages]);

  const scrollToBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) {
      return;
    }
    // 用户已上滑浏览历史时，绝对不自动跳底部（即使 Claude 正在工作 / 流式输出 / 外部更新）。
    // 仅 scrollToBottomAndReset（用户点击"回到底部"按钮 + composer 主动提交）会先清 ref 再调本函数。
    if (isUserScrolledUpRef.current || userScrollIntentRef.current) {
      return;
    }
    // 用时间戳标记：150ms 窗口内连续触发的 scroll 事件均视为代码行为，
    // 避免快速连续调用时第二次的事件被误判为用户滚动
    programmaticScrollTimeRef.current = Date.now();
    container.scrollTop = container.scrollHeight;
    lastObservedScrollTopRef.current = container.scrollTop;
    requestAnimationFrame(() => {
      if (!scrollContainerRef.current || isUserScrolledUpRef.current || userScrollIntentRef.current) {
        return;
      }
      programmaticScrollTimeRef.current = Date.now();
      scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
      lastObservedScrollTopRef.current = scrollContainerRef.current.scrollTop;
    });
  }, []);

  const scrollToBottomAndReset = useCallback(() => {
    // 用户主动点击"回到底部"：立即重置上滑标记，恢复 auto-scroll
    isUserScrolledUpRef.current = false;
    userScrollIntentRef.current = false;
    setIsUserScrolledUp(false);
    scrollToBottom();
    if (allMessagesLoaded) {
      setVisibleMessageCount(initialVisibleMessages);
      setAllMessagesLoaded(false);
      allMessagesLoadedRef.current = false;
    }
  }, [allMessagesLoaded, initialVisibleMessages, scrollToBottom]);

const isNearBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) {
      return false;
    }
    const { scrollTop, scrollHeight, clientHeight } = container;
    // 采用更小阈值，避免“只上划一丢丢”就被判为“接近底部”。
    const threshold = CHAT_BOTTOM_THRESHOLD_PX;
    const distanceFromBottom = Math.max(0, scrollHeight - scrollTop - clientHeight);
    return distanceFromBottom <= threshold;
  }, []);

  const loadOlderMessages = useCallback(
    async (container: HTMLDivElement) => {
      if (!container || isLoadingMoreRef.current || isLoadingMoreMessages) {
        return false;
      }
      if (allMessagesLoadedRef.current) return false;
      if (!hasMoreMessages || !selectedSession || !selectedProject) {
        return false;
      }

      const sessionProvider = selectedSession.__provider || 'claude';
      if (sessionProvider === 'cursor') {
        return false;
      }

      const requestViewKey = getVersionedChatMessagesStorageKey(
        selectedProject.name,
        selectedSession.id,
      );

      isLoadingMoreRef.current = true;
      const previousScrollHeight = container.scrollHeight;
      const previousScrollTop = container.scrollTop;

      try {
        // One server page contains raw rollout records, not necessarily one UI
        // message per record. Tool deltas from a single turn can fill an entire
        // page and previously made "Showing N" grow without revealing anything.
        // Read a bounded group of pages until the converted chat actually grows.
        let newSessionMessages = sessionMessagesRef.current;
        const previousVisibleLength = convertSessionMessages(newSessionMessages).length;
        let loadedRawCount = 0;
        let addedVisibleCount = 0;
        for (let page = 0; page < 6; page += 1) {
          const moreMessages = await loadSessionMessages(
            selectedProject.name,
            selectedSession.id,
            true,
            sessionProvider,
            { expectedViewKey: requestViewKey },
          );
          if (visibleSessionStorageKeyRef.current !== requestViewKey) return false;
          if (moreMessages.length === 0) break;
          loadedRawCount += moreMessages.length;
          newSessionMessages = [...moreMessages, ...newSessionMessages];
          addedVisibleCount = Math.max(
            0,
            convertSessionMessages(newSessionMessages).length - previousVisibleLength,
          );
          if (
            addedVisibleCount >= LOAD_EARLIER_VISIBLE_MESSAGES ||
            moreMessages.length < MESSAGES_PER_PAGE ||
            messagesOffsetRef.current >= totalMessages
          ) {
            break;
          }
        }

        if (loadedRawCount === 0) {
          return false;
        }

        if (visibleSessionStorageKeyRef.current !== requestViewKey) return false;

        // 原子更新：同时设置 sessionMessages + chatMessages，避免两次渲染的中间态导致页面跳动
        // （若只更新 sessionMessages，sync useEffect 会在下一帧才更新 chatMessages，
        //   useLayoutEffect 此时已晚，浏览器会先绘制中间状态）
        const newChatMessages = stampAssistantProvider(
          convertSessionMessages(newSessionMessages),
          sessionProvider,
        );

        // 保存 height（用于计算 diff）和当前 scrollTop（async 完成后的实时值，
        // 含用户在请求期间的任何滚动）。使用绝对赋值 top+diff，避免与浏览器
        // scroll-anchoring 叠加产生双倍跳动。
        pendingScrollRestoreRef.current = { height: previousScrollHeight, top: container.scrollTop };

        // 标记跳过 sync useEffect，避免 chatMessages 被重复覆盖
        skipSyncRef.current = true;

        setSessionMessages(newSessionMessages);
        // Pagination can finish after a new user message was optimistically
        // rendered. Replacing the list with the older server snapshot used to
        // erase that user bubble and visually join two assistant turns. Use the
        // same reconciliation as every other refresh so pending users, errors,
        // and the current streaming tail survive until the server covers them.
        setChatMessages((previous) =>
          mergeMissingLocalUserMessages(newChatMessages, previous),
        );
        prevSessionMessagesLengthRef.current = newSessionMessages.length;
        setVisibleMessageCount((previousCount) => previousCount + addedVisibleCount);
        return true;
      } finally {
        isLoadingMoreRef.current = false;
      }
    },
    [hasMoreMessages, isLoadingMoreMessages, loadSessionMessages, selectedProject, selectedSession, totalMessages],
  );

  // 同步最新值到 ref，供 handleScroll（passive scroll 回调）读取，避免闭包读到旧值
  useEffect(() => {
    chatMessagesLengthRef.current = chatMessages.length;
  }, [chatMessages.length]);
  useEffect(() => {
    visibleMessageCountRef.current = visibleMessageCount;
  }, [visibleMessageCount]);

  // 揭开本地已加载、但被 visibleMessageCount 窗口截断的更早历史。
  // 关键修复：纯上划（无新消息）时窗口此前永不扩张，导致上划到第 60 条就“撞墙”卡死。
  // 这里在到顶时主动扩窗，并通过 pendingWindowRestoreRef + useLayoutEffect 补偿滚动位置，避免跳动。
  const expandVisibleWindow = useCallback((container: HTMLDivElement) => {
    if (visibleMessageCountRef.current >= chatMessagesLengthRef.current) {
      return false;
    }
    pendingWindowRestoreRef.current = { height: container.scrollHeight, top: container.scrollTop };
    setVisibleMessageCount((previousCount) =>
      Math.min(chatMessagesLengthRef.current, previousCount + WINDOW_EXPAND_CHUNK),
    );
    return true;
  }, []);

  const handleScroll = useCallback(async () => {
    const container = scrollContainerRef.current;
    if (!container) {
      return;
    }

    const currentScrollTop = container.scrollTop;
    lastObservedScrollTopRef.current = currentScrollTop;
    const isProgrammatic = (Date.now() - programmaticScrollTimeRef.current) < 150;

    // Do not infer user intent from scrollTop decreasing. Streaming tool rows,
    // loading placeholders and font/layout changes can shrink the document and
    // make the browser clamp scrollTop upward without any user interaction.
    // Wheel/touch and the custom scrollbar report real upward intent directly.

    // 忽略代码触发的滚动：150ms 时间窗口内的 scroll 事件均视为程序行为
    if (isProgrammatic) {
      // 程序滚动绝不能解除用户的历史浏览锁；只有用户手动滚到底部才可解除。
      return;
    }

    // Layout growth can move the viewport away from the bottom without any
    // user action. Only the upward movement/gesture checks above may lock
    // bottom-follow mode.

    // 历史消息揭示：用户主动滑到顶部时始终响应，不因 isLoading 阻断
    // （Claude 工作期间用户仍可上划查看历史）
    // 两级来源：①本地已加载但被窗口截断的历史（visibleMessageCount < chatMessages.length）→ 优先扩窗；
    //          ②本地已全部渲染、且服务端还有更早的页（!allMessagesLoaded）→ 再向服务端分页拉取。
    const hasWindowedHistory = visibleMessageCountRef.current < chatMessagesLengthRef.current;
    const canLoadFromServer = !allMessagesLoadedRef.current;
    if (hasWindowedHistory || canLoadFromServer) {
      const scrolledNearTop = container.scrollTop < 100;
      if (!scrolledNearTop) {
        topLoadLockRef.current = false;
        return;
      }

      if (topLoadLockRef.current) {
        if (container.scrollTop > 20) {
          topLoadLockRef.current = false;
        }
        return;
      }

      // 优先揭开本地窗口截断的历史：纯前端、零网络，修复“上划撞墙”
      if (hasWindowedHistory) {
        // 惯性甩动时间冷却：一次甩动只扩窗一次。冷却期内的连发 scroll 事件直接忽略，
        // 防止扩窗+restore 反复把视图拽回原处（鬼打墙：循环相同内容 + 上下跳）。
        if (Date.now() - lastWindowExpandTimeRef.current < WINDOW_EXPAND_COOLDOWN_MS) {
          return;
        }
        if (expandVisibleWindow(container)) {
          lastWindowExpandTimeRef.current = Date.now();
          topLoadLockRef.current = true;
        }
        return;
      }

      // 本地已全部渲染 → 再向服务端拉取更早的页
      const didLoad = await loadOlderMessages(container);
      if (didLoad) {
        topLoadLockRef.current = true;
      }
    }
  }, [loadOlderMessages, expandVisibleWindow]);

  // wheel/touchmove and the custom scrollbar report user intent before changing
  // the viewport. Lock immediately so a concurrent stream update cannot pull the
  // reader back to the bottom.
  // 真正的 scroll 事件监听器（line 738）会在滚动完成后正确更新状态。
  const handleUserScrollIntent = useCallback((e: { deltaY?: number }) => {
    if (e.deltaY === undefined || e.deltaY === 0) {
      return;
    }

    if (e.deltaY > 0) {
      upwardGestureDistanceRef.current = 0;
      return;
    }

    // Mac trackpads commonly emit a tiny opposite-direction tail after a
    // downward gesture. Treating a single -1px event as user intent permanently
    // disabled bottom-follow. Require a small, deliberate upward gesture while
    // still locking well before the viewport visibly leaves the latest output.
    upwardGestureDistanceRef.current += Math.min(Math.abs(e.deltaY), USER_UPWARD_GESTURE_THRESHOLD_PX);
    if (upwardGestureResetTimerRef.current) {
      clearTimeout(upwardGestureResetTimerRef.current);
    }
    upwardGestureResetTimerRef.current = setTimeout(() => {
      upwardGestureDistanceRef.current = 0;
      upwardGestureResetTimerRef.current = null;
    }, 140);

    if (upwardGestureDistanceRef.current >= USER_UPWARD_GESTURE_THRESHOLD_PX) {
      userScrollIntentRef.current = true;
      upwardGestureDistanceRef.current = 0;
      if (!isUserScrolledUpRef.current) {
        isUserScrolledUpRef.current = true;
        setIsUserScrolledUp(true);
      }
    }
  }, []);

  useEffect(() => () => {
    if (upwardGestureResetTimerRef.current) {
      clearTimeout(upwardGestureResetTimerRef.current);
    }
  }, []);

  // 上滑锁定由 handleScroll 管理（用户滚回底部时自动解锁），无需此处额外重置。

  useLayoutEffect(() => {
    if (!pendingScrollRestoreRef.current || !scrollContainerRef.current) {
      return;
    }

    const { height, top: savedTop } = pendingScrollRestoreRef.current;
    const container = scrollContainerRef.current;
    const scrollDiff = container.scrollHeight - height;
    // 使用绝对赋值（savedTop + scrollDiff）而非相对赋值（+= scrollDiff）。
    // 原因：浏览器 overflow-anchor 在 DOM 更新后会自动调整 scrollTop（+=diff），
    // 若我们再做 +=diff 则双重叠加，视觉上跳动 2 倍高度。
    // 绝对赋值是幂等的：
    //   - 浏览器已锚定（scrollTop = savedTop+diff）→ 我们设同值 → 无变化
    //   - 浏览器未锚定（scrollTop = savedTop）→ 我们设 savedTop+diff → 正确
    if (scrollDiff > 0) {
      programmaticScrollTimeRef.current = Date.now();
      container.scrollTop = savedTop + scrollDiff;
      lastObservedScrollTopRef.current = container.scrollTop;
    }
    pendingScrollRestoreRef.current = null;
  }, [chatMessages.length]);

  // 本地窗口扩展（揭开已加载历史）后的滚动位置补偿。
  // 与上面的服务端分页补偿同理（绝对赋值 savedTop+diff，幂等且不与 overflow-anchor 叠加），
  // 但 keys 在 visibleMessageCount —— 因为扩窗时 chatMessages.length 不变、只有渲染条数变。
  useLayoutEffect(() => {
    if (!pendingWindowRestoreRef.current || !scrollContainerRef.current) {
      return;
    }
    const { height, top: savedTop } = pendingWindowRestoreRef.current;
    const container = scrollContainerRef.current;
    const scrollDiff = container.scrollHeight - height;
    if (scrollDiff > 0) {
      programmaticScrollTimeRef.current = Date.now();
      container.scrollTop = savedTop + scrollDiff;
      lastObservedScrollTopRef.current = container.scrollTop;
    }
    pendingWindowRestoreRef.current = null;
  }, [visibleMessageCount]);

  const isInitialLoadRef = useRef(true);

  // 同步 isSystemSessionChange state → ref，让 session change effect 读取最新值（兜底）
  useEffect(() => {
    isSystemSessionChangeRef.current = isSystemSessionChange;
  }, [isSystemSessionChange]);

  // 同步写 ref + 异步写 state 的包装器。
  // 根因修复（消息被吞）：temp→real 会话 id 切换时，setIsSystemSessionChange(true) 与
  // selectedSession.id 变更可能落在同一次 commit。React 按定义顺序执行 effect——
  // session 切换 effect（上方第 282 行）先于 ref-sync effect（紧邻上方）运行，
  // 此刻 isSystemSessionChangeRef.current 仍为旧值 false → 守卫不生效 →
  // 该 effect 用新 session id 的（空）localStorage 覆盖 chatMessages，吞掉刚发出的乐观 user 气泡。
  // 这里在调用点同步翻转 ref，保证守卫在同一 commit 的任何 effect 读取时已是最新值，消除竞态。
  const markSystemSessionChange = useCallback((value: boolean) => {
    isSystemSessionChangeRef.current = value;
    setIsSystemSessionChange(value);
    // 复位标志时一并清掉目标，避免目标 id 残留到下一次切换造成误判
    if (!value) {
      systemSessionChangeTargetIdRef.current = null;
    }
  }, [systemSessionChangeTargetIdRef]);

  useEffect(() => {
    pendingInitialScrollRef.current = true;
    // 切换 session 时先锁定历史加载，防止初始渲染时 scrollTop=0 误触发。
    // 待 scrollToBottom 执行后（见下方 effect）再解锁。
    topLoadLockRef.current = true;
    pendingScrollRestoreRef.current = null;
    lastObservedScrollTopRef.current = null;
    prevSessionMessagesLengthRef.current = 0;
    isInitialLoadRef.current = true;
    setVisibleMessageCount(initialVisibleMessages);
    // 系统生成的 session ID 替换（temp→real）不重置滚动状态：
    // 否则用户在等待响应时上滑的位置会被强制拉回底部。
    if (!isSystemSessionChangeRef.current) {
      setIsUserScrolledUp(false);
      isUserScrolledUpRef.current = false;
      userScrollIntentRef.current = false;
    }
  }, [initialVisibleMessages, selectedProject?.name, selectedSession?.id]);

  useEffect(() => {
    if (!pendingInitialScrollRef.current || !scrollContainerRef.current || isLoadingSessionMessages) {
      return;
    }

    if (chatMessages.length === 0) {
      pendingInitialScrollRef.current = false;
      return;
    }

    pendingInitialScrollRef.current = false;
    setTimeout(() => {
      // 初始加载不强制覆盖用户已发起的上滑操作
      if (!isUserScrolledUpRef.current && !userScrollIntentRef.current) {
        scrollToBottom();
      }
      // scrollToBottom 执行后解锁：此时 scrollTop 已为最大值，
      // handleScroll 检测到 scrolledNearTop=false 也会自动清锁，但提前清更保险
      topLoadLockRef.current = false;
    }, 200);
  }, [chatMessages.length, isLoadingSessionMessages, scrollToBottom]);

  useEffect(() => {
    if (!selectedProject?.name) return;
    try {
      const sourceProjectName = sessionStorage.getItem('compactContinuationSourceProjectName');
      if (sourceProjectName && sourceProjectName !== selectedProject.name) {
        sessionStorage.removeItem('compactContinuationPending');
        sessionStorage.removeItem('compactContinuationSourceSessionId');
        sessionStorage.removeItem('compactContinuationSourceProjectName');
      }
    } catch {
      // ignore sessionStorage failures
    }
  }, [selectedProject?.name]);

  useEffect(() => {
    const loadMessages = async () => {
      if (selectedSession && selectedProject) {
        const continuationInfo = isRestoredSession(selectedSession.id)
          ? { sessionId: selectedSession.id, provider: 'claude', isContinuation: false }
          : resolveCompactContinuationInfoForProject(selectedProject, selectedSession.id);
        const visibleProvider = (
          isRestoredSession(selectedSession.id) ? 'claude' :
          selectedSession.__provider ||
          getProjectSessionProvider(selectedProject, selectedSession.id) ||
          'claude'
        ) as Provider;
        const runtimeSessionId = continuationInfo.sessionId || selectedSession.id;
        const provider = (continuationInfo.provider || visibleProvider) as Provider;
        if (continuationInfo.isContinuation && continuationInfo.provider) {
          storeSelectedProvider(String(continuationInfo.provider));
        }
        isLoadingSessionRef.current = true;

        // 串话修复：把 isSystemSessionChange 的「不清屏/不加载」豁免收紧为绑定目标会话。
        // 当本次 system-change 有明确目标（temp→real / system-init 导航）且用户已切到无关会话时，
        // 豁免作废 → 按真实切换正常清屏并加载目标会话，避免上一会话的乐观气泡残留串话。
        const effectiveSystemSessionChange =
          isSystemSessionChange && isSystemChangeExemptionValid(selectedSession.id);
        if (isSystemSessionChange && !effectiveSystemSessionChange) {
          // 目标与选中不符：豁免失效，复位标志与目标，防止后续切换继续被误豁免
          markSystemSessionChange(false);
        }

        // sessionChanged 表示用户切换了 session（selectedSession.id 真的变了）。
        // 仅当 selectedSession.id 与上次加载的 session 不同时才触发，
        // 防止压缩续集（currentSessionId='B', selectedSession.id='A'）误触发清屏。
        const restoreVersion = getRestoredSessionCacheVersion(selectedSession.id);
        const sessionKey = [
          selectedSession.id,
          runtimeSessionId,
          selectedProject.name,
          provider,
          restoreVersion || '',
        ].join(':');
        const lastSelectedSessionId = lastLoadedSessionKeyRef.current?.split(':')[0] ?? null;
        const sessionChanged = currentSessionId !== null &&
          currentSessionId !== selectedSession.id &&
          lastSelectedSessionId !== null &&
          lastSelectedSessionId !== selectedSession.id;
        if (sessionChanged) {
          if (!effectiveSystemSessionChange) {
            resetStreamingState();
            pendingViewSessionRef.current = null;
            setChatMessages([]);
            setSessionMessages([]);
            setClaudeStatus(null);
            setCanAbortSession(false);
          }

          messagesOffsetRef.current = 0;
          setHasMoreMessages(false);
          setTotalMessages(0);
          setVisibleMessageCount(initialVisibleMessages);
          setAllMessagesLoaded(false);
          allMessagesLoadedRef.current = false;
          setIsLoadingAllMessages(false);
          setLoadAllJustFinished(false);
          setShowLoadAllOverlay(false);
          if (loadAllOverlayTimerRef.current) clearTimeout(loadAllOverlayTimerRef.current);
          if (loadAllFinishedTimerRef.current) clearTimeout(loadAllFinishedTimerRef.current);
          setTokenBudget(null);
          setIsLoading(false);

          // 直接调用 sendMessage（内部有队列，WS 未就绪时自动缓存并在重连后发出）
          sendMessage({
            type: 'check-session-status',
            sessionId: runtimeSessionId,
            provider,
            viewSessionId: selectedSession.id,
          });
        } else if (currentSessionId === null) {
          messagesOffsetRef.current = 0;
          setHasMoreMessages(false);
          setTotalMessages(0);

          sendMessage({
            type: 'check-session-status',
            sessionId: runtimeSessionId,
            provider,
            viewSessionId: selectedSession.id,
          });
        }

        // Skip loading if session+project+provider hasn't changed
        if (lastLoadedSessionKeyRef.current === sessionKey) {
          // WS 重连后此分支会被触发（ws 变化），需要补发 check-session-status
          sendMessage({
            type: 'check-session-status',
            sessionId: runtimeSessionId,
            provider,
            viewSessionId: selectedSession.id,
          });
          setTimeout(() => {
            isLoadingSessionRef.current = false;
          }, 250);
          return;
        }

        // 标记本次正在加载的 session，用于 await 后过期检查
        const loadTargetId = selectedSession.id;
        activeLoadSessionIdRef.current = loadTargetId;

        if (provider === 'cursor') {
          setCurrentSessionId(runtimeSessionId);
          sessionStorage.setItem('cursorSessionId', runtimeSessionId);

          if (!effectiveSystemSessionChange) {
            const projectPath = selectedProject.fullPath || selectedProject.path || '';
            const converted = await loadCursorSessionMessages(projectPath, runtimeSessionId);
            // 过期检查：若 await 期间已切换到其他 session，丢弃结果
            if (activeLoadSessionIdRef.current !== loadTargetId) return;
            setSessionMessages([]);
            setChatMessages((previous) => mergeMissingLocalUserMessages(converted, previous));
          } else {
            markSystemSessionChange(false);
          }
        } else {
          setCurrentSessionId(runtimeSessionId);

          if (!effectiveSystemSessionChange) {
            if (continuationInfo.isContinuation) {
              const continuationChain = resolveCompactContinuationChainForProject(selectedProject, selectedSession.id);
              const [visibleMessages, ...continuationMessageSets] = await Promise.all([
                loadCompleteSessionMessages(
                  selectedProject.name,
                  selectedSession.id,
                  visibleProvider,
                  { historyWindow: 120 },
                ),
                ...continuationChain.map((entry) =>
                  loadCompleteSessionMessages(
                    selectedProject.name,
                    entry.sessionId,
                    entry.provider as Provider,
                    { historyWindow: 120 },
                  ),
                ),
              ]);
              // 过期检查：若 await 期间已切换到其他 session，丢弃结果
              if (activeLoadSessionIdRef.current !== loadTargetId) return;
              const mergedMessages = mergeVisibleContinuationMessages(
                visibleMessages,
                visibleProvider,
                continuationMessageSets.map((messages, index) => ({
                  messages,
                  provider: String(continuationChain[index]?.provider || provider),
                })),
              );
              setSessionMessages([]);
              setChatMessages((previous) => mergeMissingLocalUserMessages(mergedMessages, previous));
              setHasMoreMessages(false);
              setTotalMessages(mergedMessages.length);
              messagesOffsetRef.current = mergedMessages.length;
              prevSessionMessagesLengthRef.current = 0;
            } else {
              const messages = await loadSessionMessages(
                selectedProject.name,
                selectedSession.id,
                false,
                visibleProvider,
              );
              // 过期检查：若 await 期间已切换到其他 session，丢弃结果
              if (activeLoadSessionIdRef.current !== loadTargetId) return;
              // Commit the initial transcript atomically. Relying on the
              // sessionMessages sync effect leaves the conversation blank when
              // a stale/running status keeps isLoading true, even though the
              // transcript request already completed successfully.
              skipSyncRef.current = true;
              setSessionMessages(messages);
              setChatMessages((previous) => mergeMissingLocalUserMessages(
                stampAssistantProvider(convertSessionMessages(messages), visibleProvider),
                previous,
              ));
              prevSessionMessagesLengthRef.current = messages.length;
            }
          } else {
            markSystemSessionChange(false);
          }
        }

        // Update the last loaded session key
        lastLoadedSessionKeyRef.current = sessionKey;
      } else {
        if (!isSystemSessionChange) {
          resetStreamingState();
          pendingViewSessionRef.current = null;
          setChatMessages([]);
          setSessionMessages([]);
          setClaudeStatus(null);
          setCanAbortSession(false);
          setIsLoading(false);
        }

        // During system-driven navigation to a newly created session, the project
        // index may not contain that session yet. Preserve currentSessionId so
        // the next turn can resume instead of starting another Codex session.
        if (!isSystemSessionChange) {
          setCurrentSessionId(null);
          sessionStorage.removeItem('cursorSessionId');
        }
        messagesOffsetRef.current = 0;
        setHasMoreMessages(false);
        setTotalMessages(0);
        setTokenBudget(null);
        lastLoadedSessionKeyRef.current = null;
      }

      setTimeout(() => {
        isLoadingSessionRef.current = false;
      }, 250);
    };

    loadMessages();
  }, [
    // Intentionally exclude currentSessionId: this effect sets it and should not retrigger another full load.
    isSystemSessionChange,
    loadCompleteSessionMessages,
    loadCursorSessionMessages,
    loadSessionMessages,
    pendingViewSessionRef,
    resetStreamingState,
    selectedProject,
    selectedSession?.id, // Only depend on session ID, not the entire object
    sendMessage,
    ws,
  ]);

  useEffect(() => {
    if (!externalMessageUpdate || !selectedSession || !selectedProject) {
      return;
    }

    // 真实的外部更新（externalMessageUpdate 自增）到来时，重置重试预算。
    // nonce 自身的自增不会改变 externalMessageUpdate，因此不会误重置。
    if (prevExternalUpdateRef.current !== externalMessageUpdate) {
      prevExternalUpdateRef.current = externalMessageUpdate;
      externalReloadRetryRef.current = 0;
    }

    const scheduleExternalReloadRetry = () => {
      // transient guard 命中：安排有限次延迟重试，让消息无需手动刷新即可补显。
      if (externalReloadRetryRef.current >= 8) return;
      externalReloadRetryRef.current += 1;
      if (externalReloadRetryTimerRef.current) {
        clearTimeout(externalReloadRetryTimerRef.current);
      }
      externalReloadRetryTimerRef.current = setTimeout(() => {
        externalReloadRetryTimerRef.current = null;
        setExternalReloadNonce((n) => n + 1);
      }, 700);
    };

    const reloadExternalMessages = async () => {
      if (externalReloadInFlightRef.current) {
        externalReloadQueuedRef.current = true;
        return;
      }
      externalReloadInFlightRef.current = true;
      try {
        const continuationInfo = isRestoredSession(selectedSession.id)
          ? { sessionId: selectedSession.id, provider: 'claude', isContinuation: false }
          : resolveCompactContinuationInfoForProject(selectedProject, selectedSession.id);
        const visibleProvider = (
          isRestoredSession(selectedSession.id) ? 'claude' :
          selectedSession.__provider ||
          getProjectSessionProvider(selectedProject, selectedSession.id) ||
          'claude'
        ) as Provider;
        const runtimeSessionId = continuationInfo.sessionId || selectedSession.id;
        const provider = (continuationInfo.provider || visibleProvider) as Provider;
        const loadTargetId = runtimeSessionId;
        activeLoadSessionIdRef.current = loadTargetId;
        if (activeSessions?.has(loadTargetId) || hasPendingUserMessage) {
          // transient：session 仍 active 或乐观用户消息未清。这是短暂窗口，
          // 安排重试，避免一次性信号被永久丢弃（Bug2：消息被吞需手动刷新）。
          scheduleExternalReloadRetry();
          return;
        }

        // 压缩续集场景：currentSessionId 指向新 session B，但 selectedSession.id 仍是旧 A。
        // 此时不应重载 A 的磁盘消息——会覆盖压缩摘要和 B 的回复，导致对话"跳回原始状态"。
        if (currentSessionId !== null && currentSessionId !== loadTargetId) {
          return;
        }

        if (provider === 'cursor') {
          const projectPath = selectedProject.fullPath || selectedProject.path || '';
          const converted = await loadCursorSessionMessages(projectPath, runtimeSessionId);
          if (activeLoadSessionIdRef.current !== loadTargetId) return;
          setSessionMessages([]);
          setChatMessages((previous) => mergeMissingLocalUserMessages(converted, previous));
          return;
        }

        if (continuationInfo.isContinuation) {
          const continuationChain = resolveCompactContinuationChainForProject(selectedProject, selectedSession.id);
          const [visibleMessages, ...continuationMessageSets] = await Promise.all([
            loadCompleteSessionMessages(
              selectedProject.name,
              selectedSession.id,
              visibleProvider,
              { silent: true, historyWindow: 120 },
            ),
            ...continuationChain.map((entry) =>
              loadCompleteSessionMessages(
                selectedProject.name,
                entry.sessionId,
                entry.provider as Provider,
                { silent: true, historyWindow: 120 },
              ),
            ),
          ]);
          if (activeLoadSessionIdRef.current !== loadTargetId) return;
          const mergedMessages = mergeVisibleContinuationMessages(
            visibleMessages,
            visibleProvider,
            continuationMessageSets.map((messages, index) => ({
              messages,
              provider: String(continuationChain[index]?.provider || provider),
            })),
          );
          setSessionMessages([]);
          setChatMessages((previous) => mergeMissingLocalUserMessages(mergedMessages, previous));
          return;
        }

        const messages = await loadSessionMessages(
          selectedProject.name,
          runtimeSessionId,
          false,
          provider,
          { silent: true },
        );
        if (activeLoadSessionIdRef.current !== loadTargetId) return;
        const mergedRawMessages = mergeLatestRawSessionPage(sessionMessagesRef.current, messages);
        setSessionMessages(mergedRawMessages);
        messagesOffsetRef.current = mergedRawMessages.length;
        // 外部更新（JSONL 文件变化）时直接同步到 chatMessages。
        // 不加 isLoading 门控：
        // - 终端启动的会话：JSONL 是唯一真相来源，应立即显示新消息
        // - claudecodeui 发起的会话：externalMessageUpdate 在 session active 期间不触发，
        //   仅在完成后（600ms 补偿）才触发，此时 isLoading 已为 false，门控无意义
        // 移除此门控修复了终端会话打开后 8 秒内消息不刷新的问题
        const converted = stampAssistantProvider(convertSessionMessages(mergedRawMessages), provider);
        setChatMessages((previous) => mergeMissingLocalUserMessages(converted, previous));
        prevSessionMessagesLengthRef.current = mergedRawMessages.length;

        const shouldAutoScroll = Boolean(autoScrollToBottom)
          && !isUserScrolledUpRef.current
          && !userScrollIntentRef.current;
        if (shouldAutoScroll) {
          setTimeout(() => {
            if (!isUserScrolledUpRef.current && !userScrollIntentRef.current) scrollToBottom();
          }, 200);
        }
      } catch (error) {
        console.error('Error reloading messages from external update:', error);
      } finally {
        externalReloadInFlightRef.current = false;
        if (externalReloadQueuedRef.current) {
          externalReloadQueuedRef.current = false;
          setExternalReloadNonce((nonce) => nonce + 1);
        }
      }
    };

    reloadExternalMessages();
  }, [
    autoScrollToBottom,
    currentSessionId,
    externalMessageUpdate,
    externalReloadNonce,
    activeSessions,
    hasPendingUserMessage,
    loadCursorSessionMessages,
    loadCompleteSessionMessages,
    loadSessionMessages,
    scrollToBottom,
    selectedProject,
    selectedSession,
  ]);

  useEffect(() => {
    return () => {
      if (externalReloadRetryTimerRef.current) {
        clearTimeout(externalReloadRetryTimerRef.current);
        externalReloadRetryTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (selectedSession?.id) {
      pendingViewSessionRef.current = null;
    }
  }, [pendingViewSessionRef, selectedSession?.id]);


  useEffect(() => {
    if (
      sessionMessages.length !== prevSessionMessagesLengthRef.current &&
      !isLoading
    ) {
      if (skipSyncRef.current) {
        skipSyncRef.current = false;
        prevSessionMessagesLengthRef.current = sessionMessages.length;
        return;
      }
      if (isInitialLoadRef.current || sessionMessages.length === 0 || sessionMessages.length > prevSessionMessagesLengthRef.current) {
        // 保护本地已提交但服务端 JSONL 尚未回写的 user 消息。
        // 典型场景：发送后立刻 Stop，后端可能还没写入 user 行，不能用服务端空列表覆盖本地提问。
        setChatMessages((prev) => {
          return mergeMissingLocalUserMessages(convertedMessages, prev);
        });
        isInitialLoadRef.current = false;
      }
      prevSessionMessagesLengthRef.current = sessionMessages.length;
    }
  }, [convertedMessages, sessionMessages.length, isLoading, setChatMessages]);

  useEffect(() => {
    const storageKey = getVersionedChatMessagesStorageKey(selectedProject?.name, selectedSession?.id);
    if (!storageKey || chatMessages.length === 0) return;

    const cacheSnapshot = getTailWithLatestUserBoundary(chatMessages, 50);
    pendingChatStorageRef.current = { key: storageKey, messages: cacheSnapshot };
    const latestUser = [...chatMessages].reverse().find((message) => message.type === 'user');
    const latestUserKey = latestUser ? getLocalUserMessageKey(latestUser) : null;

    const persistLatestSnapshot = () => {
      const pending = pendingChatStorageRef.current;
      if (!pending) return;
      safeLocalStorage.setItem(
        pending.key,
        serializeChatMessagesForStorage(pending.messages),
      );
    };

    // A submitted/steered user message is the turn boundary. Persist it
    // synchronously so a disconnect or navigation cannot visually swallow it.
    if (latestUserKey && latestUserKey !== lastPersistedUserKeyRef.current) {
      lastPersistedUserKeyRef.current = latestUserKey;
      persistLatestSnapshot();
    }

    // Do not debounce by cancelling on every streamed token. That postponed the
    // cache write until the whole turn ended. Keep one throttle timer and let it
    // persist the newest snapshot when it fires.
    if (!chatStorageTimerRef.current) {
      chatStorageTimerRef.current = setTimeout(() => {
        const persistSnapshot = () => {
          persistLatestSnapshot();
          chatStorageIdleRef.current = null;
        };
        if ('requestIdleCallback' in window) {
          chatStorageIdleRef.current = window.requestIdleCallback(persistSnapshot, { timeout: 1000 });
        } else {
          persistSnapshot();
        }
        chatStorageTimerRef.current = null;
      }, isMobile ? 1500 : 600);
    }
  }, [chatMessages, isMobile, selectedProject?.name, selectedSession?.id]);

  useEffect(() => {
    return () => {
      if (chatStorageTimerRef.current) {
        clearTimeout(chatStorageTimerRef.current);
        chatStorageTimerRef.current = null;
      }
      if (chatStorageIdleRef.current !== null && 'cancelIdleCallback' in window) {
        window.cancelIdleCallback(chatStorageIdleRef.current);
        chatStorageIdleRef.current = null;
      }
      const pending = pendingChatStorageRef.current;
      if (pending) {
        safeLocalStorage.setItem(
          pending.key,
          serializeChatMessagesForStorage(pending.messages),
        );
      }
    };
  }, []);

  useEffect(() => {
    if (!selectedProject || !selectedSession?.id || selectedSession.id.startsWith('new-session-')) {
      setTokenBudget(null);
      return;
    }

    // Reset immediately only when the session identity changes. This effect also
    // runs after project-list refreshes; clearing there made the context gauge
    // briefly fall to 0% before the same session's fetch returned.
    setTokenBudget(null);

    const continuationInfo = isRestoredSession(selectedSession.id)
      ? { sessionId: selectedSession.id, provider: 'claude', isContinuation: false }
      : resolveCompactContinuationInfoForProject(selectedProject, selectedSession.id);
    const tokenUsageSessionId = continuationInfo.sessionId || selectedSession.id;
    const sessionProvider =
      continuationInfo.provider ||
      (isRestoredSession(selectedSession.id) ? 'claude' : selectedSession.__provider) ||
      getProjectSessionProvider(selectedProject, selectedSession.id) ||
      'claude';

    const fetchInitialTokenUsage = async () => {
      try {
        const params = new URLSearchParams({ provider: String(sessionProvider) });
        const projectName = encodeURIComponent(selectedProject.name);
        const sessionId = encodeURIComponent(tokenUsageSessionId);
        const url = `/api/projects/${projectName}/sessions/${sessionId}/token-usage?${params.toString()}`;
        const response = await authenticatedFetch(url);
        if (response.ok) {
          const data = await response.json();
          const budget = data?.unsupported ? null : {
            ...data,
            provider: sessionProvider,
            sessionId: tokenUsageSessionId,
            source: 'initial-token-usage',
            updatedAt: Date.now(),
          };
          setTokenBudget(budget);
          if (budget) publishTokenBudgetSnapshot(budget);
        } else {
          setTokenBudget(null);
        }
      } catch (error) {
        console.error('Failed to fetch initial token usage:', error);
      }
    };

    fetchInitialTokenUsageRef.current = fetchInitialTokenUsage;
    fetchInitialTokenUsage();
  }, [selectedProject?.name, selectedSession?.id, selectedSession?.__provider]);

  // 手动刷新：重新拉取当前 session 的 token 用量
  const refreshTokenUsage = useCallback(async () => {
    await fetchInitialTokenUsageRef.current?.();
  }, []);

  // 自动刷新只作为 WS 丢失事件的低频兜底。隐藏标签页和工作中的
  // session 都不扫描 rollout 文件。
  useEffect(() => {
    if (!selectedProject || !selectedSession?.id || selectedSession.id.startsWith('new-session-')) return;
    const id = window.setInterval(() => {
      if (!isLoading && document.visibilityState === 'visible') {
        fetchInitialTokenUsageRef.current?.();
      }
    }, 5 * 60 * 1000);
    return () => clearInterval(id);
  }, [selectedProject, selectedSession?.id, isLoading]);

  // 用户上滑阅读时，只按新增消息数量扩展窗口，避免长会话把完整历史一次性挂回 DOM。
  useEffect(() => {
    const previousLength = previousChatMessagesLengthRef.current;
    const added = Math.max(0, chatMessages.length - previousLength);
    previousChatMessagesLengthRef.current = chatMessages.length;

    if (
      isUserScrolledUp &&
      added > 0 &&
      visibleMessageCount !== Infinity &&
      chatMessages.length > visibleMessageCount
    ) {
      setVisibleMessageCount((previousCount) =>
        Math.min(chatMessages.length, previousCount + added),
      );
    }
  }, [chatMessages.length, isUserScrolledUp, visibleMessageCount]);

  const visibleMessages = useMemo(() => {
    return getTailWithLatestUserBoundary(chatMessages, visibleMessageCount);
  }, [chatMessages, visibleMessageCount]);

  // 记录上一次滚动位置（仅在非自动滚动模式时）
  useEffect(() => {
    if (!autoScrollToBottom && scrollContainerRef.current) {
      const container = scrollContainerRef.current;
      scrollPositionRef.current = {
        height: container.scrollHeight,
        top: container.scrollTop,
      };
    }
  });

  // 新消息及流式内容每次增长时的滚动策略。不能只依赖 length：
  // 流式生成会持续替换最后一条消息，但消息条数通常保持不变。
  useLayoutEffect(() => {
    if (!scrollContainerRef.current || chatMessages.length === 0) {
      return;
    }

    if (isLoadingMoreRef.current || isLoadingMoreMessages || pendingScrollRestoreRef.current) {
      return;
    }

    if (autoScrollToBottom) {
      // 未锁定即处于“跟随最新内容”模式。内容增长后旧 scrollTop 已不再
      // 几何贴底，因此这里不能再用 isNearBottom() 作为前置条件。
      if (!isUserScrolledUpRef.current && !userScrollIntentRef.current) {
        scrollToBottom();
      }
      return;
    }

    // 非自动滚动模式：维持滚动位置
    const container = scrollContainerRef.current;
    const prevHeight = scrollPositionRef.current.height;
    const prevTop = scrollPositionRef.current.top;
    const newHeight = container.scrollHeight;
    const heightDiff = newHeight - prevHeight;

    if (heightDiff > 0 && prevTop > 0) {
      programmaticScrollTimeRef.current = Date.now();
      container.scrollTop = prevTop + heightDiff;
      lastObservedScrollTopRef.current = container.scrollTop;
    }
  }, [autoScrollToBottom, chatMessages, isLoadingMoreMessages, scrollToBottom]);

  // `chatMessages` is not a complete signal for rendered-height changes. A
  // streaming message can grow in place, and tool rows, markdown, fonts or
  // images can finish layout without replacing the messages array. Follow the
  // actual content height while bottom-follow mode is unlocked so the latest
  // line remains visible throughout a turn.
  useEffect(() => {
    const container = scrollContainerRef.current;
    const content = container?.firstElementChild;
    if (!container || !content || typeof ResizeObserver === 'undefined') return;

    const followLatest = () => {
      if (
        !autoScrollToBottom ||
        isUserScrolledUpRef.current ||
        userScrollIntentRef.current ||
        isLoadingMoreRef.current ||
        pendingScrollRestoreRef.current ||
        pendingWindowRestoreRef.current
      ) {
        return;
      }
      if (followBottomFrameRef.current !== null) return;
      followBottomFrameRef.current = requestAnimationFrame(() => {
        followBottomFrameRef.current = null;
        if (
          !isUserScrolledUpRef.current &&
          !userScrollIntentRef.current &&
          !isLoadingMoreRef.current &&
          !pendingScrollRestoreRef.current &&
          !pendingWindowRestoreRef.current
        ) {
          scrollToBottom();
        }
      });
    };

    const observer = new ResizeObserver(followLatest);
    observer.observe(container);
    observer.observe(content);
    const mutations = new MutationObserver(followLatest);
    mutations.observe(content, { subtree: true, childList: true, characterData: true });
    followLatest();
    return () => {
      observer.disconnect();
      mutations.disconnect();
      if (followBottomFrameRef.current !== null) {
        cancelAnimationFrame(followBottomFrameRef.current);
        followBottomFrameRef.current = null;
      }
    };
  }, [autoScrollToBottom, scrollToBottom]);

  // ResizeObserver is the primary signal, but Safari can coalesce or defer its
  // callbacks while markdown, fonts and tool rows are changing rapidly. Keep a
  // cheap geometry-based fallback whenever bottom-follow is unlocked. Do not
  // gate this on `isLoading`/activeSessions: those protocol states can briefly
  // lag behind a stream or reconnect while the rendered content still grows.
  useEffect(() => {
    if (!autoScrollToBottom) return;

    const keepLatestVisible = () => {
      const container = scrollContainerRef.current;
      if (
        !container ||
        isUserScrolledUpRef.current ||
        userScrollIntentRef.current ||
        isLoadingMoreRef.current ||
        pendingScrollRestoreRef.current ||
        pendingWindowRestoreRef.current
      ) {
        return;
      }
      const distance = container.scrollHeight - container.scrollTop - container.clientHeight;
      if (distance > 1) scrollToBottom();
    };

    keepLatestVisible();
    const timer = window.setInterval(keepLatestVisible, FOLLOW_BOTTOM_HEARTBEAT_MS);
    document.addEventListener('visibilitychange', keepLatestVisible);
    window.addEventListener('focus', keepLatestVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', keepLatestVisible);
      window.removeEventListener('focus', keepLatestVisible);
    };
  }, [autoScrollToBottom, scrollToBottom]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) {
      return;
    }

    // scroll 和 wheel 都设为 passive:true：
    // 浏览器无需等待 JS 回调完成即可立即执行原生滚动，彻底消除流式输出时的卡顿/卡死问题。
    // handleUserScrollIntent / handleScroll 均不调用 preventDefault()，passive 安全。
    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      container.removeEventListener('scroll', handleScroll);
    };
  }, [handleScroll]);

  // 当内容高度不足以填满滚动容器时，自动加载更多历史消息。
  // 场景：会话消息数少（刚压缩后）或容器够大，用户无法向上滚动触发分页。
  useEffect(() => {
    if (!hasMoreMessages || isLoadingMoreMessages || !scrollContainerRef.current) {
      return;
    }
    const container = scrollContainerRef.current;
    const frameId = requestAnimationFrame(() => {
      // scrollHeight ≤ clientHeight 说明内容填不满，用户无法上滑触发加载
      if (container.scrollHeight <= container.clientHeight + 20) {
        loadOlderMessages(container);
      }
    });
    return () => cancelAnimationFrame(frameId);
  }, [hasMoreMessages, chatMessages.length, isLoadingMoreMessages, loadOlderMessages]);

  useEffect(() => {
    const activeViewSessionId = currentSessionId || selectedSession?.id;
    if (!activeViewSessionId || !processingSessions) {
      return;
    }

    // 切换会话时 currentSessionId 可能仍是旧值，selectedSession?.id 已是新目标。
    // 两者都检查，避免因 currentSessionId 滞后导致状态栏被错误隐藏。
    const candidateIds = Array.from(new Set([currentSessionId, selectedSession?.id].filter(Boolean) as string[]));
    // processingSessions 是客户端持久化状态，可能在 WS 断开期间过期而未被清除。
    // 只有当 WS 真正断开时（isConnected===false），才依赖它显示 Reconnecting，
    // 避免刷新后/重连后用过期数据误触横幅。WS 连接中时只信任服务端推送的 activeSessions。
    const isDisconnected = isConnected === false;
    const shouldBeProcessing = candidateIds.some(
      (id) => Boolean(activeSessions?.has(id)) || (isDisconnected && processingSessions.has(id))
    );
    if (shouldBeProcessing) {
      setIsLoading(true);
      setCanAbortSession(true);
      const startedAt = getStoredProcessingStartedAt(activeViewSessionId);
      const restored = candidateIds
        .map((id) => getPersistedActiveTurnStatus(id))
        .find(Boolean);
      setClaudeStatus((previous) => {
        const inputTokens = Math.max(previous?.inputTokens || 0, restored?.inputTokens || 0);
        const outputTokens = Math.max(previous?.outputTokens || 0, restored?.outputTokens || 0);
        return {
          text: restored?.text || previous?.text || (isDisconnected ? 'Reconnecting to running session' : 'Working in background'),
          tokens: Math.max(previous?.tokens || 0, restored?.tokens || 0, inputTokens + outputTokens),
          inputTokens,
          outputTokens,
          startedAt: restored?.startedAt || previous?.startedAt || startedAt || Date.now(),
          can_interrupt: restored?.can_interrupt ?? previous?.can_interrupt ?? true,
        };
      });
      // 开始工作时立即隐藏 "Load all" 浮层，避免干扰
      if (loadAllOverlayTimerRef.current) clearTimeout(loadAllOverlayTimerRef.current);
      setShowLoadAllOverlay(false);
      // 不设超时清除：loading 生命周期由 processingSessions 移除（session-complete /
      // claude-complete / session-status isProcessing=false）驱动，由 session-status
      // handler 的 90s stale 计时器兜底，确保刷新后 Claude 工作期间 loading 持续可见。
    } else {
      if (hasPendingUserMessage) {
        return;
      }
      // session 已从 processingSessions 中移除（工作完成或超时清除）
      setIsLoading(false);
      setCanAbortSession(false);
    }
    // 注意：isLoading 不在依赖项中，防止 clearLoadingIndicators() 将 isLoading 设为
    // false 后 effect 重入、看到 processingSessions 仍有 session 又将其设回 true 的竞态循环。
    // effect 只应响应 processingSessions 实体变化，而非 loading 状态的联动。
  }, [activeSessions, currentSessionId, hasPendingUserMessage, isConnected, processingSessions, selectedSession?.id]);

  // 刷新后轮询机制：session 正在处理（processingSessions 记录）且不在 activeSessions（非 WS 流式）时，
  // 单飞、静默地读取最新一页，弥补 Claude "思考" 期间无 changedFile 事件的显示延迟。
  // 关键守卫：activeSessions.has(sessionId) → 说明 WS 流式传输正在进行，JSONL 滞后于
  // 流式消息，此时若用 JSONL 覆盖 chatMessages 会清除当前正在显示的流式内容，不能轮询。
  useEffect(() => {
    const sessionId = selectedSession?.id;
    if (!sessionId || !selectedProject || !processingSessions?.has(sessionId)) return;
    // 流式传输中（claudecodeui 发起的活跃 session）跳过轮询，避免覆盖流式消息
    if (activeSessions?.has(sessionId)) return;

    const projectName = selectedProject.name;
    const provider = selectedSession.__provider || 'claude';
    if (provider === 'cursor') return; // cursor 不用 JSONL

    let stopped = false;
    let timerId: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;

    function scheduleNextPoll(delay = 6000) {
      if (stopped) return;
      timerId = setTimeout(pollLatestPage, delay);
    }

    async function pollLatestPage() {
      if (stopped) return;
      if (document.visibilityState !== 'visible') {
        scheduleNextPoll(12000);
        return;
      }
      // 安全检查：若已切换到其他 session（activeLoadSessionIdRef 已更新），跳过
      if (activeLoadSessionIdRef.current !== sessionId) return;
      // 流式传输在轮询期间启动时也要跳过（activeSessions 是实时 Set）
      if (activeSessions?.has(sessionId)) return;
      controller = new AbortController();
      try {
        const messages = await loadSessionMessages(
          projectName,
          sessionId,
          false,
          provider,
          { silent: true, signal: controller.signal },
        );
        // 双重检查：await 期间 session 可能已切换或流式传输已启动
        if (stopped || activeLoadSessionIdRef.current !== sessionId) return;
        if (activeSessions?.has(sessionId) || messages.length === 0) return;
        const currentTail = sessionMessagesRef.current.slice(-messages.length);
        if (getRawSessionPageRevision(messages) === getRawSessionPageRevision(currentTail)) return;
        const mergedMessages = mergeLatestRawSessionPage(sessionMessagesRef.current, messages);
        skipSyncRef.current = true;
        setSessionMessages(mergedMessages);
        messagesOffsetRef.current = mergedMessages.length;
        setChatMessages((previous) =>
          mergeMissingLocalUserMessages(convertSessionMessages(mergedMessages), previous),
        );
        prevSessionMessagesLengthRef.current = mergedMessages.length;
      } catch (_e) {
        // 忽略轮询错误，不中断轮询
      } finally {
        controller = null;
        scheduleNextPoll();
      }
    }

    scheduleNextPoll(2000);

    return () => {
      stopped = true;
      if (timerId) clearTimeout(timerId);
      controller?.abort();
    };
  }, [
    selectedSession?.id,
    selectedSession?.__provider,
    selectedProject?.name,
    processingSessions,
    activeSessions,
    loadSessionMessages,
  ]);

  // WS 重连后一次性 JSONL 重载（修复 A）。
  // 根因：WS 闪断重连期间，onopen 只 flush 出站队列、不重载会话；断连窗口内服务端
  // 流式推送的内容会丢失，直到用户手动刷新页面重新拉 JSONL 才显示。这里在 isConnected
  // false→true 跳变时对当前 session 做一次 JSONL 重载，把断连期间错过的消息补回。
  // 关键：保留正在进行的流式 assistant 尾巴——仅当 JSONL 最后一条不是已提交的 assistant
  // 时才把前端流式尾巴接回（否则会与 JSONL 落盘的同一条 assistant 重复）。
  const prevConnectedRef = useRef(isConnected);
  useEffect(() => {
    const was = prevConnectedRef.current;
    prevConnectedRef.current = isConnected;
    if (was || !isConnected) return; // 仅 false→true 跳变触发

    const sessionId = selectedSession?.id;
    if (!sessionId || !selectedProject) return;
    const provider = selectedSession.__provider || 'claude';
    if (provider === 'cursor') return; // cursor 不用 JSONL
    const projectName = selectedProject.name;

    let cancelled = false;
    (async () => {
      try {
        const messages = await loadSessionMessages(
          projectName,
          sessionId,
          false,
          provider,
          { silent: true },
        );
        if (cancelled || activeLoadSessionIdRef.current !== sessionId) return;
        if (messages.length === 0) return;
        const mergedRawMessages = mergeLatestRawSessionPage(sessionMessagesRef.current, messages);
        const converted = convertSessionMessages(mergedRawMessages);
        skipSyncRef.current = true;
        setSessionMessages(mergedRawMessages);
        messagesOffsetRef.current = mergedRawMessages.length;
        setChatMessages((previous) => {
          const merged = mergeMissingLocalUserMessages(converted, previous);
          // 保留正在进行的流式 assistant 尾巴（JSONL 尚未落盘该条时）
          const lastPrev = previous[previous.length - 1];
          const lastConverted = converted[converted.length - 1];
          const jsonlEndsWithAssistant = lastConverted?.type === 'assistant';
          if (lastPrev?.isStreaming && lastPrev.type === 'assistant' && !jsonlEndsWithAssistant) {
            return [...merged, lastPrev];
          }
          return merged;
        });
        prevSessionMessagesLengthRef.current = mergedRawMessages.length;
      } catch (_e) {
        // 忽略重载错误
      }
    })();
    return () => { cancelled = true; };
  }, [
    isConnected,
    selectedSession?.id,
    selectedSession?.__provider,
    selectedProject?.name,
    loadSessionMessages,
  ]);

  // Show "Load all" overlay after a batch finishes loading, persist for 2s then hide
  const prevLoadingRef = useRef(false);
  useEffect(() => {
    const wasLoading = prevLoadingRef.current;
    prevLoadingRef.current = isLoadingMoreMessages;

    if (wasLoading && !isLoadingMoreMessages && hasMoreMessages && !isLoading) {
      if (loadAllOverlayTimerRef.current) clearTimeout(loadAllOverlayTimerRef.current);
      setShowLoadAllOverlay(true);
      loadAllOverlayTimerRef.current = setTimeout(() => {
        setShowLoadAllOverlay(false);
      }, 2000);
    }
    if (!hasMoreMessages && !isLoadingMoreMessages) {
      if (loadAllOverlayTimerRef.current) clearTimeout(loadAllOverlayTimerRef.current);
      setShowLoadAllOverlay(false);
    }
    return () => {
      if (loadAllOverlayTimerRef.current) clearTimeout(loadAllOverlayTimerRef.current);
    };
  }, [isLoadingMoreMessages, hasMoreMessages]);

  const loadAllMessages = useCallback(async () => {
    if (!selectedSession || !selectedProject) return;
    if (isLoadingAllMessages) return;
    const continuationInfo = isRestoredSession(selectedSession.id)
      ? { sessionId: selectedSession.id, provider: 'claude', isContinuation: false }
      : resolveCompactContinuationInfoForProject(selectedProject, selectedSession.id);
    const visibleProvider = (
      isRestoredSession(selectedSession.id) ? 'claude' :
      selectedSession.__provider ||
      getProjectSessionProvider(selectedProject, selectedSession.id) ||
      'claude'
    ) as Provider;
    const runtimeSessionId = continuationInfo.sessionId || selectedSession.id;
    const sessionProvider = (continuationInfo.provider || visibleProvider) as Provider;
    if (sessionProvider === 'cursor') {
      setVisibleMessageCount(Infinity);
      setAllMessagesLoaded(true);
      allMessagesLoadedRef.current = true;
      setLoadAllJustFinished(true);
      if (loadAllFinishedTimerRef.current) clearTimeout(loadAllFinishedTimerRef.current);
      loadAllFinishedTimerRef.current = setTimeout(() => {
        setLoadAllJustFinished(false);
        setShowLoadAllOverlay(false);
      }, 1000);
      return;
    }

    const requestSessionId = runtimeSessionId;

    allMessagesLoadedRef.current = true;
    isLoadingMoreRef.current = true;
    setIsLoadingAllMessages(true);
    setShowLoadAllOverlay(true);

    const container = scrollContainerRef.current;
    const previousScrollHeight = container ? container.scrollHeight : 0;
    const previousScrollTop = container ? container.scrollTop : 0;

    try {
      if (continuationInfo.isContinuation) {
        const continuationChain = resolveCompactContinuationChainForProject(selectedProject, selectedSession.id);
        const [visibleMessages, ...continuationMessageSets] = await Promise.all([
          loadCompleteSessionMessages(selectedProject.name, selectedSession.id, visibleProvider),
          ...continuationChain.map((entry) =>
            loadCompleteSessionMessages(selectedProject.name, entry.sessionId, entry.provider as Provider),
          ),
        ]);

        if (currentSessionId !== requestSessionId) return;

        const mergedMessages = mergeVisibleContinuationMessages(
          visibleMessages,
          visibleProvider,
          continuationMessageSets.map((messages, index) => ({
            messages,
            provider: String(continuationChain[index]?.provider || sessionProvider),
          })),
        );

        if (container) {
          pendingScrollRestoreRef.current = { height: previousScrollHeight, top: container.scrollTop };
        }

        setSessionMessages([]);
        setChatMessages((previous) => mergeMissingLocalUserMessages(mergedMessages, previous));
        setHasMoreMessages(false);
        setTotalMessages(mergedMessages.length);
        messagesOffsetRef.current = mergedMessages.length;
        setVisibleMessageCount(Infinity);
        setAllMessagesLoaded(true);

        setLoadAllJustFinished(true);
        if (loadAllFinishedTimerRef.current) clearTimeout(loadAllFinishedTimerRef.current);
        loadAllFinishedTimerRef.current = setTimeout(() => {
          setLoadAllJustFinished(false);
          setShowLoadAllOverlay(false);
        }, 1000);
        return;
      }

      const response = await (api.sessionMessages as any)(
        selectedProject.name,
        requestSessionId,
        null,
        0,
        sessionProvider,
      );

      if (currentSessionId !== requestSessionId) return;

      if (response.ok) {
        const data = await response.json();
        const allMessages = data.messages || data;

        if (container) {
          pendingScrollRestoreRef.current = { height: previousScrollHeight, top: container.scrollTop };
        }

        setSessionMessages(Array.isArray(allMessages) ? allMessages : []);
        setHasMoreMessages(false);
        setTotalMessages(Array.isArray(allMessages) ? allMessages.length : 0);
        messagesOffsetRef.current = Array.isArray(allMessages) ? allMessages.length : 0;

        setVisibleMessageCount(Infinity);
        setAllMessagesLoaded(true);

        setLoadAllJustFinished(true);
        if (loadAllFinishedTimerRef.current) clearTimeout(loadAllFinishedTimerRef.current);
        loadAllFinishedTimerRef.current = setTimeout(() => {
          setLoadAllJustFinished(false);
          setShowLoadAllOverlay(false);
        }, 1000);
      } else {
        allMessagesLoadedRef.current = false;
        setShowLoadAllOverlay(false);
      }
    } catch (error) {
      console.error('Error loading all messages:', error);
      allMessagesLoadedRef.current = false;
      setShowLoadAllOverlay(false);
    } finally {
      isLoadingMoreRef.current = false;
      setIsLoadingAllMessages(false);
    }
  }, [selectedSession, selectedProject, isLoadingAllMessages, currentSessionId, loadCompleteSessionMessages]);

  const loadEarlierMessages = useCallback(() => {
    const amount = isMobile ? MOBILE_LOAD_EARLIER_VISIBLE_MESSAGES : LOAD_EARLIER_VISIBLE_MESSAGES;
    setVisibleMessageCount((previousCount) => previousCount + amount);
  }, [isMobile]);

  return {
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
    setIsSystemSessionChange: markSystemSessionChange,
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
    loadAllMessages,
    allMessagesLoaded,
    isLoadingAllMessages,
    loadAllJustFinished,
    showLoadAllOverlay,
    claudeStatus,
    setClaudeStatus,
    createDiff,
    scrollContainerRef,
    scrollToBottom,
    scrollToBottomAndReset,
    isNearBottom,
    handleScroll,
    handleUserScrollIntent,
    loadSessionMessages,
    loadCursorSessionMessages,
  };
}
