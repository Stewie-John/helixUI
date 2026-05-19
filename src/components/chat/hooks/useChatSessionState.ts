import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';

import { api, authenticatedFetch } from '../../../utils/api';
import type { ChatMessage, Provider } from '../types/types';
import type { Project, ProjectSession } from '../../../types/app';
import { safeLocalStorage } from '../utils/chatStorage';
import {
  convertCursorSessionMessages,
  convertSessionMessages,
  createCachedDiffCalculator,
  type DiffCalculator,
} from '../utils/messageTransforms';

const MESSAGES_PER_PAGE = 20;
const INITIAL_VISIBLE_MESSAGES = 100;

type PendingViewSession = {
  sessionId: string | null;
  startedAt: number;
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
  resetStreamingState: () => void;
  pendingViewSessionRef: MutableRefObject<PendingViewSession | null>;
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
  resetStreamingState,
  pendingViewSessionRef,
}: UseChatSessionStateArgs) {
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>(() => {
    if (typeof window !== 'undefined' && selectedProject) {
      const saved = safeLocalStorage.getItem(`chat_messages_${selectedProject.name}`);
      if (saved) {
        try {
          return JSON.parse(saved) as ChatMessage[];
        } catch {
          console.error('Failed to parse saved chat messages, resetting');
          safeLocalStorage.removeItem(`chat_messages_${selectedProject.name}`);
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
  const programmaticScrollRef = useRef(false);
  const [tokenBudget, setTokenBudget] = useState<Record<string, unknown> | null>(null);
  const [visibleMessageCount, setVisibleMessageCount] = useState(INITIAL_VISIBLE_MESSAGES);
  const [claudeStatus, setClaudeStatus] = useState<{ text: string; tokens: number; inputTokens?: number; outputTokens?: number; can_interrupt: boolean } | null>(null);
  const [allMessagesLoaded, setAllMessagesLoaded] = useState(false);
  const [isLoadingAllMessages, setIsLoadingAllMessages] = useState(false);
  const [loadAllJustFinished, setLoadAllJustFinished] = useState(false);
  const [showLoadAllOverlay, setShowLoadAllOverlay] = useState(false);

  const scrollContainerRef = useRef<HTMLDivElement>(null);

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

  // WS 断线时将未响应的 pending 消息标记为 sendFailed
  useEffect(() => {
    if (!ws) return;
    const handleClose = () => {
      setChatMessages(prev => {
        if (!prev.some(m => m.pending)) return prev;
        return prev.map(m =>
          m.pending ? { ...m, pending: false, sendFailed: true } : m
        );
      });
    };
    ws.addEventListener('close', handleClose);
    return () => ws.removeEventListener('close', handleClose);
  }, [ws]);
  const isLoadingSessionRef = useRef(false);
  const isLoadingMoreRef = useRef(false);
  const allMessagesLoadedRef = useRef(false);
  const topLoadLockRef = useRef(false);
  const pendingScrollRestoreRef = useRef<ScrollRestoreState | null>(null);
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
  // 跟踪最新 sessionMessages（用于 loadOlderMessages 闭包，避免 stale closure）
  const sessionMessagesRef = useRef<any[]>([]);
  // 标记：loadOlderMessages 已原子更新 chatMessages，sync useEffect 应跳过本次
  const skipSyncRef = useRef(false);

  const createDiff = useMemo<DiffCalculator>(() => createCachedDiffCalculator(), []);

  const loadSessionMessages = useCallback(
    async (projectName: string, sessionId: string, loadMore = false, provider: Provider | string = 'claude') => {
      if (!projectName || !sessionId) {
        return [] as any[];
      }

      const isInitialLoad = !loadMore;
      if (isInitialLoad) {
        setIsLoadingSessionMessages(true);
      } else {
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
        );
        if (!response.ok) {
          throw new Error('Failed to load session messages');
        }

        const data = await response.json();
        if (isInitialLoad && data.tokenUsage) {
          setTokenBudget(data.tokenUsage);
        }

        if (data.hasMore !== undefined) {
          const loadedCount = data.messages?.length || 0;
          setHasMoreMessages(Boolean(data.hasMore));
          setTotalMessages(Number(data.total || 0));
          messagesOffsetRef.current = currentOffset + loadedCount;
          return data.messages || [];
        }

        const messages = data.messages || [];
        setHasMoreMessages(false);
        setTotalMessages(messages.length);
        messagesOffsetRef.current = messages.length;
        return messages;
      } catch (error) {
        console.error('Error loading session messages:', error);
        return [];
      } finally {
        if (isInitialLoad) {
          setIsLoadingSessionMessages(false);
        } else {
          setIsLoadingMoreMessages(false);
        }
      }
    },
    [],
  );

  const loadCursorSessionMessages = useCallback(async (projectPath: string, sessionId: string) => {
    if (!projectPath || !sessionId) {
      return [] as ChatMessage[];
    }

    setIsLoadingSessionMessages(true);
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
      setIsLoadingSessionMessages(false);
    }
  }, []);

  // 保持 sessionMessagesRef 与 sessionMessages 同步（供 loadOlderMessages 异步闭包使用）
  useEffect(() => {
    sessionMessagesRef.current = sessionMessages;
  }, [sessionMessages]);

  const convertedMessages = useMemo(() => {
    return convertSessionMessages(sessionMessages);
  }, [sessionMessages]);

  const scrollToBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) {
      return;
    }
    // 用户已上滑浏览历史时，绝对不自动跳底部（即使 Claude 正在工作 / 流式输出 / 外部更新）。
    // 仅 scrollToBottomAndReset（用户点击"回到底部"按钮 + composer 主动提交）会先清 ref 再调本函数。
    if (isUserScrolledUpRef.current) {
      return;
    }
    programmaticScrollRef.current = true;
    container.scrollTop = container.scrollHeight;
  }, []);

  const scrollToBottomAndReset = useCallback(() => {
    // 用户主动点击"回到底部"：立即重置上滑标记，恢复 auto-scroll
    isUserScrolledUpRef.current = false;
    setIsUserScrolledUp(false);
    scrollToBottom();
    if (allMessagesLoaded) {
      setVisibleMessageCount(INITIAL_VISIBLE_MESSAGES);
      setAllMessagesLoaded(false);
      allMessagesLoadedRef.current = false;
    }
  }, [allMessagesLoaded, scrollToBottom]);

  const isNearBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) {
      return false;
    }
    const { scrollTop, scrollHeight, clientHeight } = container;
    // 用户处于上滑模式时用 5px 严格阈值：防止内容高度接近视口高度时
    // 滑到顶部仍被误判为"接近底部"，导致 auto-scroll 把用户拽回底部。
    const threshold = isUserScrolledUpRef.current ? 5 : 50;
    return scrollHeight - scrollTop - clientHeight < threshold;
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

      isLoadingMoreRef.current = true;
      const previousScrollHeight = container.scrollHeight;
      const previousScrollTop = container.scrollTop;

      try {
        const moreMessages = await loadSessionMessages(
          selectedProject.name,
          selectedSession.id,
          true,
          sessionProvider,
        );

        if (moreMessages.length === 0) {
          return false;
        }

        // 原子更新：同时设置 sessionMessages + chatMessages，避免两次渲染的中间态导致页面跳动
        // （若只更新 sessionMessages，sync useEffect 会在下一帧才更新 chatMessages，
        //   useLayoutEffect 此时已晚，浏览器会先绘制中间状态）
        const newSessionMessages = [...moreMessages, ...sessionMessagesRef.current];
        const newChatMessages = convertSessionMessages(newSessionMessages);

        // 保存 height（用于计算 diff）和当前 scrollTop（async 完成后的实时值，
        // 含用户在请求期间的任何滚动）。使用绝对赋值 top+diff，避免与浏览器
        // scroll-anchoring 叠加产生双倍跳动。
        pendingScrollRestoreRef.current = { height: previousScrollHeight, top: container.scrollTop };

        // 标记跳过 sync useEffect，避免 chatMessages 被重复覆盖
        skipSyncRef.current = true;

        setSessionMessages(newSessionMessages);
        setChatMessages(newChatMessages);
        prevSessionMessagesLengthRef.current = newSessionMessages.length;
        setVisibleMessageCount((previousCount) => previousCount + moreMessages.length);
        return true;
      } finally {
        isLoadingMoreRef.current = false;
      }
    },
    [hasMoreMessages, isLoadingMoreMessages, loadSessionMessages, selectedProject, selectedSession],
  );

  const handleScroll = useCallback(async () => {
    const container = scrollContainerRef.current;
    if (!container) {
      return;
    }

    // 忽略代码触发的滚动，不更新 isUserScrolledUpRef
    if (programmaticScrollRef.current) {
      programmaticScrollRef.current = false;
      return;
    }

    const nearBottom = isNearBottom();
    const scrolledUp = !nearBottom;
    // 仅在值真正改变时更新 state，避免无意义的 re-render 引发抖动
    if (scrolledUp !== isUserScrolledUpRef.current) {
      isUserScrolledUpRef.current = scrolledUp;
      setIsUserScrolledUp(scrolledUp);
    }

    // 历史消息加载：用户主动滑到顶部时始终响应，不因 isLoading 阻断
    // （Claude 工作期间用户仍可上划查看历史）
    if (!allMessagesLoadedRef.current) {
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

      const didLoad = await loadOlderMessages(container);
      if (didLoad) {
        topLoadLockRef.current = true;
      }
    }
  }, [isNearBottom, loadOlderMessages]);

  // 用户主动滚动意图检测：wheel/touchmove 在滚动位置更新之前触发，
  // 此时 isNearBottom() 返回的是旧位置。如果用户正从底部向上滚，
  // handleScroll 会错误地认为仍在底部（ref=false），导致 rAF 里的
  // scrollToBottom 抢在 scroll 事件之前执行，把用户拉回底部。
  // 解决：检测到向上滚动意图时立即锁定 ref=true，阻止一切自动滚动。
  // 真正的 scroll 事件监听器（line 738）会在滚动完成后正确更新状态。
  const handleUserScrollIntent = useCallback((e: { deltaY?: number }) => {
    // 仅在向上滚动时锁定（deltaY < 0 = 鼠标滚轮向上 / 触摸上滑）
    if (e.deltaY !== undefined && e.deltaY < 0) {
      if (!isUserScrolledUpRef.current) {
        isUserScrolledUpRef.current = true;
        setIsUserScrolledUp(true);
      }
    }
  }, []);

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
      container.scrollTop = savedTop + scrollDiff;
    }
    pendingScrollRestoreRef.current = null;
  }, [chatMessages.length]);

  const prevSessionMessagesLengthRef = useRef(0);
  const isInitialLoadRef = useRef(true);

  // 同步 isSystemSessionChange state → ref，让 session change effect 读取最新值
  useEffect(() => {
    isSystemSessionChangeRef.current = isSystemSessionChange;
  }, [isSystemSessionChange]);

  useEffect(() => {
    pendingInitialScrollRef.current = true;
    // 切换 session 时先锁定历史加载，防止初始渲染时 scrollTop=0 误触发。
    // 待 scrollToBottom 执行后（见下方 effect）再解锁。
    topLoadLockRef.current = true;
    pendingScrollRestoreRef.current = null;
    prevSessionMessagesLengthRef.current = 0;
    isInitialLoadRef.current = true;
    setVisibleMessageCount(INITIAL_VISIBLE_MESSAGES);
    // 系统生成的 session ID 替换（temp→real）不重置滚动状态：
    // 否则用户在等待响应时上滑的位置会被强制拉回底部。
    if (!isSystemSessionChangeRef.current) {
      setIsUserScrolledUp(false);
      isUserScrolledUpRef.current = false;
    }
  }, [selectedProject?.name, selectedSession?.id]);

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
      if (!isUserScrolledUpRef.current) {
        scrollToBottom();
      }
      // scrollToBottom 执行后解锁：此时 scrollTop 已为最大值，
      // handleScroll 检测到 scrolledNearTop=false 也会自动清锁，但提前清更保险
      topLoadLockRef.current = false;
    }, 200);
  }, [chatMessages.length, isLoadingSessionMessages, scrollToBottom]);

  useEffect(() => {
    const loadMessages = async () => {
      if (selectedSession && selectedProject) {
        const provider = (localStorage.getItem('selected-provider') as Provider) || 'claude';
        isLoadingSessionRef.current = true;

        const sessionChanged = currentSessionId !== null && currentSessionId !== selectedSession.id;
        if (sessionChanged) {
          if (!isSystemSessionChange) {
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
          setVisibleMessageCount(INITIAL_VISIBLE_MESSAGES);
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
            sessionId: selectedSession.id,
            provider,
          });
        } else if (currentSessionId === null) {
          messagesOffsetRef.current = 0;
          setHasMoreMessages(false);
          setTotalMessages(0);

          sendMessage({
            type: 'check-session-status',
            sessionId: selectedSession.id,
            provider,
          });
        }

        // Skip loading if session+project+provider hasn't changed
        const sessionKey = `${selectedSession.id}:${selectedProject.name}:${provider}`;
        if (lastLoadedSessionKeyRef.current === sessionKey) {
          // WS 重连后此分支会被触发（ws 变化），需要补发 check-session-status
          sendMessage({
            type: 'check-session-status',
            sessionId: selectedSession.id,
            provider,
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
          setCurrentSessionId(selectedSession.id);
          sessionStorage.setItem('cursorSessionId', selectedSession.id);

          if (!isSystemSessionChange) {
            const projectPath = selectedProject.fullPath || selectedProject.path || '';
            const converted = await loadCursorSessionMessages(projectPath, selectedSession.id);
            // 过期检查：若 await 期间已切换到其他 session，丢弃结果
            if (activeLoadSessionIdRef.current !== loadTargetId) return;
            setSessionMessages([]);
            setChatMessages(converted);
          } else {
            setIsSystemSessionChange(false);
          }
        } else {
          setCurrentSessionId(selectedSession.id);

          if (!isSystemSessionChange) {
            const messages = await loadSessionMessages(
              selectedProject.name,
              selectedSession.id,
              false,
              selectedSession.__provider || 'claude',
            );
            // 过期检查：若 await 期间已切换到其他 session，丢弃结果
            if (activeLoadSessionIdRef.current !== loadTargetId) return;
            setSessionMessages(messages);
          } else {
            setIsSystemSessionChange(false);
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

        setCurrentSessionId(null);
        sessionStorage.removeItem('cursorSessionId');
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

    const reloadExternalMessages = async () => {
      try {
        const provider = (localStorage.getItem('selected-provider') as Provider) || 'claude';
        const loadTargetId = selectedSession.id;
        activeLoadSessionIdRef.current = loadTargetId;

        if (provider === 'cursor') {
          const projectPath = selectedProject.fullPath || selectedProject.path || '';
          const converted = await loadCursorSessionMessages(projectPath, selectedSession.id);
          if (activeLoadSessionIdRef.current !== loadTargetId) return;
          setSessionMessages([]);
          setChatMessages(converted);
          return;
        }

        const messages = await loadSessionMessages(
          selectedProject.name,
          selectedSession.id,
          false,
          selectedSession.__provider || 'claude',
        );
        if (activeLoadSessionIdRef.current !== loadTargetId) return;
        setSessionMessages(messages);
        // 外部更新（JSONL 文件变化）时直接同步到 chatMessages。
        // 不加 isLoading 门控：
        // - 终端启动的会话：JSONL 是唯一真相来源，应立即显示新消息
        // - claudecodeui 发起的会话：externalMessageUpdate 在 session active 期间不触发，
        //   仅在完成后（600ms 补偿）才触发，此时 isLoading 已为 false，门控无意义
        // 移除此门控修复了终端会话打开后 8 秒内消息不刷新的问题
        const converted = convertSessionMessages(messages);
        setChatMessages(converted);
        prevSessionMessagesLengthRef.current = messages.length;

        const shouldAutoScroll = Boolean(autoScrollToBottom) && isNearBottom();
        if (shouldAutoScroll) {
          setTimeout(() => {
            if (!isUserScrolledUpRef.current) scrollToBottom();
          }, 200);
        }
      } catch (error) {
        console.error('Error reloading messages from external update:', error);
      }
    };

    reloadExternalMessages();
  }, [
    autoScrollToBottom,
    externalMessageUpdate,
    isNearBottom,
    loadCursorSessionMessages,
    loadSessionMessages,
    scrollToBottom,
    selectedProject,
    selectedSession,
  ]);

  useEffect(() => {
    if (selectedSession?.id) {
      pendingViewSessionRef.current = null;
    }
  }, [pendingViewSessionRef, selectedSession?.id]);


  useEffect(() => {
    // Only sync sessionMessages to chatMessages when:
    // 1. Not currently loading (to avoid overwriting user's just-sent message)
    // 2. SessionMessages actually changed (including from non-empty to empty)
    // 3. Either it's initial load OR sessionMessages increased (new messages from server)
    if (
      sessionMessages.length !== prevSessionMessagesLengthRef.current &&
      !isLoading
    ) {
      // loadOlderMessages 已原子更新 chatMessages，本次跳过避免重复覆盖
      if (skipSyncRef.current) {
        skipSyncRef.current = false;
        prevSessionMessagesLengthRef.current = sessionMessages.length;
        return;
      }
      // Only update if this is initial load, sessionMessages grew, or was cleared to empty
      if (isInitialLoadRef.current || sessionMessages.length === 0 || sessionMessages.length > prevSessionMessagesLengthRef.current) {
        setChatMessages(convertedMessages);
        isInitialLoadRef.current = false;
      }
      prevSessionMessagesLengthRef.current = sessionMessages.length;
    }
  }, [convertedMessages, sessionMessages.length, isLoading, setChatMessages]);

  useEffect(() => {
    if (selectedProject && chatMessages.length > 0) {
      safeLocalStorage.setItem(`chat_messages_${selectedProject.name}`, JSON.stringify(chatMessages));
    }
  }, [chatMessages, selectedProject]);

  useEffect(() => {
    if (!selectedProject || !selectedSession?.id || selectedSession.id.startsWith('new-session-')) {
      setTokenBudget(null);
      return;
    }

    const sessionProvider = selectedSession.__provider || 'claude';
    if (sessionProvider !== 'claude') {
      return;
    }

    const fetchInitialTokenUsage = async () => {
      try {
        const url = `/api/projects/${selectedProject.name}/sessions/${selectedSession.id}/token-usage`;
        const response = await authenticatedFetch(url);
        if (response.ok) {
          const data = await response.json();
          setTokenBudget(data);
        } else {
          setTokenBudget(null);
        }
      } catch (error) {
        console.error('Failed to fetch initial token usage:', error);
      }
    };

    fetchInitialTokenUsage();
  }, [selectedProject, selectedSession?.id, selectedSession?.__provider]);

  // 用户上滑阅读时，自动扩展 visibleMessageCount 跟住新增消息，
  // 防止顶部已显示的消息因 slice 被裁切消失
  useEffect(() => {
    if (isUserScrolledUp && chatMessages.length > visibleMessageCount) {
      setVisibleMessageCount(chatMessages.length);
    }
  }, [chatMessages.length, isUserScrolledUp, visibleMessageCount]);

  const visibleMessages = useMemo(() => {
    if (chatMessages.length <= visibleMessageCount) {
      return chatMessages;
    }
    return chatMessages.slice(-visibleMessageCount);
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

  // 新消息到来时的滚动策略
  useEffect(() => {
    if (!scrollContainerRef.current || chatMessages.length === 0) {
      return;
    }

    if (isLoadingMoreRef.current || isLoadingMoreMessages || pendingScrollRestoreRef.current) {
      return;
    }

    if (autoScrollToBottom) {
      // 用户明确要求：任何时候都不自动跳底部，新消息静默追加，用户自行决定何时查看。
      return;
    }

    // 非自动滚动模式：维持滚动位置
    const container = scrollContainerRef.current;
    const prevHeight = scrollPositionRef.current.height;
    const prevTop = scrollPositionRef.current.top;
    const newHeight = container.scrollHeight;
    const heightDiff = newHeight - prevHeight;

    if (heightDiff > 0 && prevTop > 0) {
      programmaticScrollRef.current = true;
      container.scrollTop = prevTop + heightDiff;
    }
  }, [autoScrollToBottom, chatMessages.length, isLoadingMoreMessages, scrollToBottom]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) {
      return;
    }

    // scroll 和 wheel 都设为 passive:true：
    // 浏览器无需等待 JS 回调完成即可立即执行原生滚动，彻底消除流式输出时的卡顿/卡死问题。
    // handleUserScrollIntent / handleScroll 均不调用 preventDefault()，passive 安全。
    container.addEventListener('scroll', handleScroll, { passive: true });
    container.addEventListener('wheel', handleUserScrollIntent, { passive: true });
    return () => {
      container.removeEventListener('scroll', handleScroll);
      container.removeEventListener('wheel', handleUserScrollIntent);
    };
  }, [handleScroll, handleUserScrollIntent]);

  useEffect(() => {
    const activeViewSessionId = selectedSession?.id || currentSessionId;
    if (!activeViewSessionId || !processingSessions) {
      return;
    }

    const shouldBeProcessing = processingSessions.has(activeViewSessionId);
    if (shouldBeProcessing) {
      setIsLoading(true);
      setCanAbortSession(true);
      // 开始工作时立即隐藏 "Load all" 浮层，避免干扰
      if (loadAllOverlayTimerRef.current) clearTimeout(loadAllOverlayTimerRef.current);
      setShowLoadAllOverlay(false);
      // 不设超时清除：loading 生命周期由 processingSessions 移除（session-complete /
      // claude-complete / session-status isProcessing=false）驱动，由 session-status
      // handler 的 90s stale 计时器兜底，确保刷新后 Claude 工作期间 loading 持续可见。
    } else {
      // session 已从 processingSessions 中移除（工作完成或超时清除）
      setIsLoading(false);
      setCanAbortSession(false);
    }
    // 注意：isLoading 不在依赖项中，防止 clearLoadingIndicators() 将 isLoading 设为
    // false 后 effect 重入、看到 processingSessions 仍有 session 又将其设回 true 的竞态循环。
    // effect 只应响应 processingSessions 实体变化，而非 loading 状态的联动。
  }, [currentSessionId, processingSessions, selectedSession?.id]);

  // 刷新后轮询机制：session 正在处理（processingSessions 记录）且不在 activeSessions（非 WS 流式）时，
  // 每 4s 主动读取 JSONL，弥补 Claude "思考" 期间无 changedFile 事件的显示延迟。
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

    const intervalId = setInterval(async () => {
      // 安全检查：若已切换到其他 session（activeLoadSessionIdRef 已更新），跳过
      if (activeLoadSessionIdRef.current !== sessionId) return;
      // 流式传输在轮询期间启动时也要跳过（activeSessions 是实时 Set）
      if (activeSessions?.has(sessionId)) return;
      try {
        const messages = await loadSessionMessages(projectName, sessionId, false, provider);
        // 双重检查：await 期间 session 可能已切换或流式传输已启动
        if (activeLoadSessionIdRef.current !== sessionId) return;
        if (activeSessions?.has(sessionId)) return;
        // 仅在有新消息时更新，避免无意义 re-render
        if (messages.length <= sessionMessagesRef.current.length) return;
        // 原子更新，与 reloadExternalMessages 保持一致
        skipSyncRef.current = true;
        setSessionMessages(messages);
        setChatMessages(convertSessionMessages(messages));
        prevSessionMessagesLengthRef.current = messages.length;
      } catch (_e) {
        // 忽略轮询错误，不中断轮询
      }
    }, 4000);

    return () => clearInterval(intervalId);
  }, [
    selectedSession?.id,
    selectedSession?.__provider,
    selectedProject?.name,
    processingSessions,
    activeSessions,
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
    const sessionProvider = selectedSession.__provider || 'claude';
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

    const requestSessionId = selectedSession.id;

    allMessagesLoadedRef.current = true;
    isLoadingMoreRef.current = true;
    setIsLoadingAllMessages(true);
    setShowLoadAllOverlay(true);

    const container = scrollContainerRef.current;
    const previousScrollHeight = container ? container.scrollHeight : 0;
    const previousScrollTop = container ? container.scrollTop : 0;

    try {
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
  }, [selectedSession, selectedProject, isLoadingAllMessages, currentSessionId]);

  const loadEarlierMessages = useCallback(() => {
    setVisibleMessageCount((previousCount) => previousCount + 100);
  }, []);

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
    setIsSystemSessionChange,
    canAbortSession,
    setCanAbortSession,
    isUserScrolledUp,
    setIsUserScrolledUp,
    tokenBudget,
    setTokenBudget,
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
