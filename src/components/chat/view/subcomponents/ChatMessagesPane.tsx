import i18n from '../../../../i18n/config.js';
import { useTranslation } from 'react-i18next';
import { useCallback, useEffect, useRef, useState, Component } from 'react';
import type { Dispatch, MouseEvent as ReactMouseEvent, RefObject, SetStateAction, TouchEvent as ReactTouchEvent } from 'react';
import type { ReactNode } from 'react';

import MessageComponent from './MessageComponent';
import CollapsibleAssistantTurn from './CollapsibleAssistantTurn';
import type { AssistantTurnItem } from './CollapsibleAssistantTurn';
import DNASpinner from '../../../tech/DNASpinner';
import ProviderSelectionEmptyState from './ProviderSelectionEmptyState';
import type { ChatMessage } from '../../types/types';
import type { Project, ProjectSession, SessionProvider } from '../../../../types/app';
import AssistantThinkingIndicator from './AssistantThinkingIndicator';
import { getIntrinsicMessageKey } from '../../utils/messageKeys';
import { useMessageAvatars } from '../../../../hooks/useMessageAvatars';

interface ChatMessagesPaneProps {
  scrollContainerRef: RefObject<HTMLDivElement>;
  onWheel: (e: { deltaY?: number }) => void;
  onTouchMove: (e: { deltaY?: number }) => void;
  isLoadingSessionMessages: boolean;
  chatMessages: ChatMessage[];
  queuedUserMessages?: ChatMessage[];
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  provider: SessionProvider;
  setProvider: (provider: SessionProvider) => void;
  textareaRef: RefObject<HTMLTextAreaElement>;
  claudeModel: string;
  setClaudeModel: (model: string) => void;
  cursorModel: string;
  setCursorModel: (model: string) => void;
  codexModel: string;
  setCodexModel: (model: string) => void;
  codexReasoningEffort: string;
  setCodexReasoningEffort: (effort: string) => void;
  codexSpeed: string;
  setCodexSpeed: (speed: string) => void;
  geminiModel: string;
  setGeminiModel: (model: string) => void;
  tasksEnabled: boolean;
  isTaskMasterInstalled: boolean | null;
  onShowAllTasks?: (() => void) | null;
  setInput: Dispatch<SetStateAction<string>>;
  isLoadingMoreMessages: boolean;
  hasMoreMessages: boolean;
  totalMessages: number;
  sessionMessagesCount: number;
  visibleMessageCount: number;
  visibleMessages: ChatMessage[];
  loadEarlierMessages: () => void;
  allMessagesLoaded: boolean;
  isLoadingAllMessages: boolean;
  createDiff: any;
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onShowSettings?: () => void;
  onGrantToolPermission: (suggestion: { entry: string; toolName: string }) => { success: boolean };
  autoExpandTools?: boolean;
  showRawParameters?: boolean;
  showThinking?: boolean;
  selectedProject: Project;
  isLoading: boolean;
  isCurrentTurnActive: boolean;
  onDeleteMessage?: (message: ChatMessage) => void;
  onEditMessage?: (message: ChatMessage, newContent: string) => void;
  onStartNewSession?: () => void;
  isUserScrolledUp?: boolean;
  onScrollToBottom?: () => void;
}

// ─── 单条消息错误边界（防止一条消息崩溃影响整个会话）────────────────────────
class MessageErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean; msg: string }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, msg: '' };
  }
  static getDerivedStateFromError(error: unknown) {
    return { hasError: true, msg: String(error) };
  }
  componentDidCatch(error: unknown, info: unknown) {
    console.error('[MessageErrorBoundary]', error, info);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="my-1 px-3 py-1.5 text-xs text-red-500 dark:text-red-400 bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800/40 rounded opacity-70">
          {i18n.t('chat:messageError.renderFailed', { error: this.state.msg })}
        </div>
      );
    }
    return this.props.children;
  }
}
// ─────────────────────────────────────────────────────────────────────────────

// ─── WeChat 风格滚动条 ────────────────────────────────────────────────────────
function ChatScrollbar({
  containerRef,
  onUserScrollUp,
}: {
  containerRef: RefObject<HTMLDivElement>;
  onUserScrollUp: () => void;
}) {
  const [thumbTop, setThumbTop]       = useState(0);
  const [thumbHeight, setThumbHeight] = useState(40);
  const [visible, setVisible]         = useState(false);
  const [dragging, setDragging]       = useState(false);
  const trackRef   = useRef<HTMLDivElement>(null);
  const hideTimer  = useRef<ReturnType<typeof setTimeout>>();
  const updateRaf  = useRef<number>(0);

  // 根据容器滚动位置更新 thumb
  const update = useCallback(() => {
    const c = containerRef.current;
    if (!c) return;
    const { scrollTop, scrollHeight, clientHeight } = c;
    if (scrollHeight <= clientHeight) { setVisible(false); return; }
    const trackH = clientHeight;
    const th = Math.max(28, (clientHeight / scrollHeight) * trackH);
    const maxTop = trackH - th;
    const scrollable = scrollHeight - clientHeight;
    setThumbHeight(th);
    setThumbTop(scrollable > 0 ? (scrollTop / scrollable) * maxTop : 0);
    setVisible(true);
    // 3 秒后自动淡出（非拖拽时）
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setVisible(false), 3000);
  }, [containerRef]);

  useEffect(() => {
    const c = containerRef.current;
    if (!c) return;
    const scheduleUpdate = () => {
      if (updateRaf.current) return;
      updateRaf.current = requestAnimationFrame(() => {
        updateRaf.current = 0;
        update();
      });
    };
    c.addEventListener('scroll', scheduleUpdate, { passive: true });
    update();
    // 挂载时短暂显示 1.5s，让用户发现滚动条位置
    const initShow = setTimeout(() => update(), 200);
    return () => {
      c.removeEventListener('scroll', scheduleUpdate);
      cancelAnimationFrame(updateRaf.current);
      clearTimeout(initShow);
      clearTimeout(hideTimer.current);
    };
  }, [containerRef, update]);

  // 拖拽 thumb
  const handleThumbMouseDown = useCallback((e: ReactMouseEvent) => {
    e.preventDefault();
    const c = containerRef.current;
    if (!c) return;
    const startY     = e.clientY;
    const startTop   = c.scrollTop;
    const trackH     = c.clientHeight;
    const scrollable = c.scrollHeight - c.clientHeight;
    const th         = Math.max(28, (c.clientHeight / c.scrollHeight) * trackH);
    const maxThumbTop = trackH - th;
    setDragging(true);
    setVisible(true);

    const onMove = (ev: MouseEvent) => {
      const dy    = ev.clientY - startY;
      const ratio = maxThumbTop > 0 ? scrollable / maxThumbTop : 0;
      const nextTop = Math.max(0, Math.min(scrollable, startTop + dy * ratio));
      if (nextTop < c.scrollTop) onUserScrollUp();
      c.scrollTop = nextTop;
    };
    const onUp = () => {
      setDragging(false);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [containerRef, onUserScrollUp]);

  // 点击轨道跳转
  const handleTrackClick = useCallback((e: ReactMouseEvent) => {
    if ((e.target as HTMLElement) !== trackRef.current) return;
    const c = containerRef.current;
    const track = trackRef.current;
    if (!c || !track) return;
    const rect     = track.getBoundingClientRect();
    const clickY   = e.clientY - rect.top;
    const scrollable = c.scrollHeight - c.clientHeight;
    const nextTop = (clickY / c.clientHeight) * scrollable;
    if (nextTop < c.scrollTop) onUserScrollUp();
    c.scrollTop = nextTop;
  }, [containerRef, onUserScrollUp]);

  return (
    <div
      ref={trackRef}
      onMouseDown={handleTrackClick}
      style={{
        position: 'absolute',
        right: 0,
        top: 0,
        bottom: 0,
        width: '10px',
        zIndex: 20,
        cursor: 'pointer',
        opacity: dragging ? 1 : visible ? 0.85 : 0,
        transition: 'opacity 0.3s',
        pointerEvents: visible || dragging ? 'auto' : 'none',
        backgroundColor: 'rgba(0,0,0,0.08)',
        borderRadius: '5px',
      }}
    >
      <div
        onMouseDown={handleThumbMouseDown}
        style={{
          position: 'absolute',
          left: '1px',
          right: '1px',
          top: thumbTop,
          height: thumbHeight,
          borderRadius: '4px',
          background: dragging ? 'rgba(80,80,80,0.9)' : 'rgba(120,120,120,0.75)',
          cursor: dragging ? 'grabbing' : 'grab',
          transition: dragging ? 'none' : 'background 0.2s',
          boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
        }}
      />
    </div>
  );
}
// ─────────────────────────────────────────────────────────────────────────────

export default function ChatMessagesPane({
  scrollContainerRef,
  onWheel,
  onTouchMove,
  isLoadingSessionMessages,
  chatMessages,
  queuedUserMessages = [],
  selectedSession,
  currentSessionId,
  provider,
  setProvider,
  textareaRef,
  claudeModel,
  setClaudeModel,
  cursorModel,
  setCursorModel,
  codexModel,
  setCodexModel,
  codexReasoningEffort,
  setCodexReasoningEffort,
  codexSpeed,
  setCodexSpeed,
  geminiModel,
  setGeminiModel,
  tasksEnabled,
  isTaskMasterInstalled,
  onShowAllTasks,
  setInput,
  isLoadingMoreMessages,
  hasMoreMessages,
  totalMessages,
  sessionMessagesCount,
  visibleMessageCount,
  visibleMessages,
  loadEarlierMessages,
  allMessagesLoaded,
  isLoadingAllMessages,
  createDiff,
  onFileOpen,
  onShowSettings,
  onGrantToolPermission,
  autoExpandTools,
  showRawParameters,
  showThinking,
  selectedProject,
  isLoading,
  isCurrentTurnActive,
  onDeleteMessage,
  onEditMessage,
  onStartNewSession,
  isUserScrolledUp,
  onScrollToBottom,
}: ChatMessagesPaneProps) {
  const { t } = useTranslation('chat');
  const renderedVisibleMessages = visibleMessages.flatMap((message) => {
    const content = String(message.content || '');
    if (message.type !== 'user' || !content.includes('<codex_internal_context')) {
      return [message];
    }

    // Codex may persist the goal envelope and the actual user request in one
    // record. Hide the envelope, but keep the request so turns remain legible.
    const marker = 'Current user request:';
    const markerIndex = content.lastIndexOf(marker);
    if (markerIndex < 0) {
      return [];
    }
    const visibleRequest = content.slice(markerIndex + marker.length).trim();
    return visibleRequest ? [{ ...message, content: visibleRequest }] : [];
  });
  const renderedQueuedUserMessages = queuedUserMessages.filter((queuedMessage) =>
    !chatMessages.some((message) =>
      message.type === 'user' &&
      String(message.content || '') === String(queuedMessage.content || '') &&
      Math.abs(new Date(message.timestamp).getTime() - new Date(queuedMessage.timestamp).getTime()) < 5000
    )
  );
  const hasRenderableMessages = chatMessages.length > 0 || renderedQueuedUserMessages.length > 0;

  // 多账号场景：按 (sessionId → message_ts → user_id) 给每条 user 消息挂上对应账号头像
  const { getAvatarFor, refreshAttributions } = useMessageAvatars(currentSessionId ?? selectedSession?.id ?? null);

  // 每当 user 消息数量增加（他人实时发送），重新拉取归属表确保头像正确
  const userMsgCount = chatMessages.filter(m => m.type === 'user').length;
  const prevUserMsgCount = useRef(userMsgCount);
  useEffect(() => {
    if (userMsgCount > prevUserMsgCount.current) {
      refreshAttributions();
    }
    prevUserMsgCount.current = userMsgCount;
  }, [userMsgCount, refreshAttributions]);

  // ── HUD 面板环绕避让（Word 风格）──────────────────────────────────
  // 当 HUD 面板出现在消息区域右侧时，给滚动容器补偿 paddingRight，
  // 避免右侧固定面板覆盖消息内容，减少逐条改 DOM 导致的滚动抖动。
  const hudRectRef = useRef<{ left: number; right: number; top: number; bottom: number; width: number; height: number } | null>(null);
  const rafRef = useRef<number>(0);
  const lastTouchYRef = useRef<number | null>(null);
  const lastHudPaddingRef = useRef(0);
  const [showReturnToBottom, setShowReturnToBottom] = useState(false);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || !isUserScrolledUp) {
      setShowReturnToBottom(false);
      return;
    }

    const updateVisibility = () => {
      const distance = Math.max(0, container.scrollHeight - container.scrollTop - container.clientHeight);
      // Hide before the button can cover the last few readable lines. This is
      // independent of the auto-scroll lock, which still requires an explicit
      // “回到底部” click to reset.
      const nearBottomDistance = Math.max(140, Math.min(240, container.clientHeight * 0.25));
      setShowReturnToBottom(distance > nearBottomDistance);
    };

    updateVisibility();
    container.addEventListener('scroll', updateVisibility, { passive: true });
    const observer = new ResizeObserver(updateVisibility);
    observer.observe(container);
    if (container.firstElementChild) observer.observe(container.firstElementChild);
    return () => {
      container.removeEventListener('scroll', updateVisibility);
      observer.disconnect();
    };
  }, [isUserScrolledUp, scrollContainerRef]);

  const updateAvoidance = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const hud = hudRectRef.current;

    if (!hud) {
      if (lastHudPaddingRef.current === 0) return;
      container.style.paddingRight = '';
      lastHudPaddingRef.current = 0;
      return;
    }

    const cRect = container.getBoundingClientRect();
    const avoidWidth = Math.max(0, Math.round(cRect.right - hud.left + 16));
    if (avoidWidth <= 0) {
      if (lastHudPaddingRef.current === 0) return;
      container.style.paddingRight = '';
      lastHudPaddingRef.current = 0;
      return;
    }

    if (lastHudPaddingRef.current === avoidWidth) return;
    container.style.paddingRight = `${avoidWidth}px`;
    lastHudPaddingRef.current = avoidWidth;
  }, [scrollContainerRef]);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ left: number; right: number; top: number; bottom: number; width: number; height: number } | null>).detail;
      hudRectRef.current = detail;
      updateAvoidance();
    };
    window.addEventListener('hud-panel-pos', handler);
    return () => window.removeEventListener('hud-panel-pos', handler);
  }, [updateAvoidance]);

  // 滚动时用 rAF 节流更新
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const onScroll = () => {
      if (!hudRectRef.current) return;
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(updateAvoidance);
    };
    container.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      container.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(rafRef.current);
    };
  }, [scrollContainerRef, updateAvoidance]);

  useEffect(() => {
    return () => {
      const container = scrollContainerRef.current;
      if (!container) return;
      if (lastHudPaddingRef.current > 0) {
        container.style.paddingRight = '';
        lastHudPaddingRef.current = 0;
      }
    };
  }, [scrollContainerRef]);

  const handleTouchStart = useCallback((e: ReactTouchEvent<HTMLDivElement>) => {
    lastTouchYRef.current = e.touches[0]?.clientY ?? null;
  }, []);

  const handleTouchMove = useCallback((e: ReactTouchEvent<HTMLDivElement>) => {
    const y = e.touches[0]?.clientY;
    if (y === undefined) return;
    if (lastTouchYRef.current !== null) {
      onTouchMove({ deltaY: lastTouchYRef.current - y });
    }
    lastTouchYRef.current = y;
  }, [onTouchMove]);

  const handleTouchEnd = useCallback(() => {
    lastTouchYRef.current = null;
  }, []);

  // MutationObserver：消息列表 DOM 变化（新消息、流式追加）时重算避让
  // 解决：新消息渲染后若无滚动，旧的避让计算不会更新的问题
  // subtree:false + 200ms 防抖：流式输出每帧产生大量 DOM 变化，
  // 只监听直接子节点（消息行增删），防抖降低 layout 计算频率，避免干扰滚动
  const mutationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const obs = new MutationObserver(() => {
      if (mutationTimerRef.current) clearTimeout(mutationTimerRef.current);
      mutationTimerRef.current = setTimeout(() => {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = requestAnimationFrame(updateAvoidance);
      }, 200);
    });
    obs.observe(container, { childList: true, subtree: false, characterData: false, attributes: false });
    return () => {
      obs.disconnect();
      if (mutationTimerRef.current) clearTimeout(mutationTimerRef.current);
    };
  }, [scrollContainerRef, updateAvoidance]);

  const messageKeyMapRef = useRef<WeakMap<ChatMessage, string>>(new WeakMap());
  // 稳定 ID → 已分配 key 的映射（解决流式更新时同一消息每次创建新对象导致 key 变化的问题）
  const intrinsicKeyToAllocatedRef = useRef<Map<string, string>>(new Map());
  const generatedMessageKeyCounterRef = useRef(0);

  const getMessageKey = useCallback((message: ChatMessage) => {
    // 同一对象引用直接返回缓存 key
    const existingKey = messageKeyMapRef.current.get(message);
    if (existingKey) return existingKey;

    const intrinsicKey = getIntrinsicMessageKey(message);

    if (intrinsicKey) {
      // 有稳定 ID（toolId / messageId 等）：流式更新中同一消息的新对象共用同一 key，
      // 防止 React 把它当作不同组件重新挂载，从而保留用户手动展开的折叠块状态
      const existing = intrinsicKeyToAllocatedRef.current.get(intrinsicKey);
      if (existing) {
        messageKeyMapRef.current.set(message, existing);
        return existing;
      }
      intrinsicKeyToAllocatedRef.current.set(intrinsicKey, intrinsicKey);
      messageKeyMapRef.current.set(message, intrinsicKey);
      return intrinsicKey;
    }

    // 无稳定 ID：每次生成唯一 key（仅影响极少数无 ID 的中间消息）
    generatedMessageKeyCounterRef.current += 1;
    const generatedKey = `message-generated-${generatedMessageKeyCounterRef.current}`;
    messageKeyMapRef.current.set(message, generatedKey);
    return generatedKey;
  }, []);

  return (
    // 外层 wrapper：relative 用于自定义滚动条的绝对定位
    <div className="flex-1 relative min-h-0 overflow-hidden">
      {/* 滚动容器：隐藏原生滚动条 */}
      <div
        ref={scrollContainerRef}
        data-scroll-container
        onWheel={onWheel}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchEnd}
        className="h-full overflow-y-scroll overflow-x-hidden px-0 py-3 sm:p-4 [&::-webkit-scrollbar]:hidden"
        style={{
          scrollbarWidth: 'none',
          msOverflowStyle: 'none',
          // 流式文本、工具折叠和分页会频繁改变子元素高度。禁用浏览器自动锚定，
          // 由聊天状态层在需要时明确恢复位置，避免阅读历史时出现不可预测的上下跳。
          overflowAnchor: 'none',
        }}
      >
        {/* 内容包裹层：flex-col + min-h-full 使消息锚定到容器底部
            当消息内容不足以填满容器时，顶部 flex-1 留白将消息推到底部；
            当内容超出容器高度时，flex-1 收缩为 0，恢复正常滚动 */}
        <div className="flex flex-col min-h-full">
          {!hasRenderableMessages ? (
            /* 空状态/加载中：占满全高并垂直居中 */
            <div className="flex-1 flex items-center justify-center">
              {isLoadingSessionMessages ? (
                <div className="text-center text-gray-500 dark:text-gray-400">
                  <div className="flex items-center justify-center space-x-2">
                    {/* DNA 旋转加载动画 */}
                    <div style={{ width: 18, height: 26, flexShrink: 0 }}>
                      <DNASpinner size="sm" />
                    </div>
                    <p>{t('session.loading.sessionMessages')}</p>
                  </div>
                </div>
              ) : (
                <ProviderSelectionEmptyState
                  selectedSession={selectedSession}
                  currentSessionId={currentSessionId}
                  provider={provider}
                  setProvider={setProvider}
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
                />
              )}
            </div>
          ) : (
            <>
              {/* 顶部弹性留白：消息少于容器高度时撑开，把消息推到底部 */}
              <div className="flex-1" aria-hidden="true" />

              {/* 消息列表区域 */}
              <div className="space-y-3 sm:space-y-4">
                {/* Fixed-height history status slot: background pagination may
                    toggle repeatedly while filling the viewport, but must not
                    move every message below it. */}
                <div className="h-8 shrink-0 flex items-center justify-center text-xs text-muted-foreground tracking-wide border-b border-transparent">
                  {isLoadingMoreMessages && !isLoadingAllMessages && !allMessagesLoaded ? (
                    <span className="flex items-center justify-center gap-2">
                      <DNASpinner size="sm" />
                      <span>Loading...</span>
                    </span>
                  ) : hasMoreMessages && !allMessagesLoaded && totalMessages > 0 ? (
                    <span>{t('session.messages.showingOf', { shown: sessionMessagesCount, total: totalMessages })}</span>
                  ) : !hasMoreMessages && chatMessages.length > visibleMessageCount ? (
                    <span>{t('session.messages.showingLast', { count: visibleMessageCount, total: chatMessages.length })}</span>
                  ) : null}
                </div>

                {(() => {
                  // 渲染单条消息（保持原有逐条渲染逻辑不变）
                  const renderMessageItem = ({ message, index }: AssistantTurnItem) => {
                    const prevMessage = index > 0 ? renderedVisibleMessages[index - 1] : null;
                    const key = getMessageKey(message);
                    const userAvatarUrl = message.type === 'user' ? getAvatarFor(message) : null;
                    const messageProvider = message.provider || selectedSession?.__provider || provider;
                    return (
                      <MessageErrorBoundary key={key}>
                        <MessageComponent
                          key={key}
                          message={message}
                          index={index}
                          prevMessage={prevMessage}
                          createDiff={createDiff}
                          onFileOpen={onFileOpen}
                          onShowSettings={onShowSettings}
                          onGrantToolPermission={onGrantToolPermission}
                          autoExpandTools={autoExpandTools}
                          showRawParameters={showRawParameters}
                          showThinking={showThinking}
                          selectedProject={selectedProject}
                          provider={messageProvider}
                          onDeleteMessage={onDeleteMessage}
                          onEditMessage={onEditMessage}
                          onStartNewSession={onStartNewSession}
                          userAvatarUrl={userAvatarUrl}
                        />
                      </MessageErrorBoundary>
                    );
                  };

                  // 按「回合」分组：user 消息单独渲染；其后连续的非 user 消息（助手回复、
                  // 工具调用、思考、通知等）聚合为一个可折叠的「回复块」。最新的回复块默认
                  // 展开，更早的默认折叠，从而默认只显示用户提问 + 最新回复，点击可展开/收起。
                  type Group =
                    | { kind: 'user'; message: ChatMessage; index: number }
                    | { kind: 'turn'; items: AssistantTurnItem[] };
                  const groups: Group[] = [];
                  let i = 0;
                  while (i < renderedVisibleMessages.length) {
                    const m = renderedVisibleMessages[i];
                    if (m.type === 'user') {
                      groups.push({ kind: 'user', message: m, index: i });
                      i++;
                    } else {
                      const turnItems: AssistantTurnItem[] = [];
                      while (i < renderedVisibleMessages.length && renderedVisibleMessages[i].type !== 'user') {
                        turnItems.push({ message: renderedVisibleMessages[i], index: i });
                        i++;
                      }
                      groups.push({ kind: 'turn', items: turnItems });
                    }
                  }
                  // 找到最后一个回复块的下标，用于标记「最新回复」默认展开
                  let lastTurnIdx = -1;
                  for (let g = groups.length - 1; g >= 0; g--) {
                    if (groups[g].kind === 'turn') { lastTurnIdx = g; break; }
                  }
                  return groups.map((group, g) => {
                    if (group.kind === 'user') {
                      return renderMessageItem({ message: group.message, index: group.index });
                    }
                    const turnKey = getMessageKey(group.items[0].message);
                    const hasLaterUser = groups
                      .slice(g + 1)
                      .some((laterGroup) => laterGroup.kind === 'user');
                    return (
                      <CollapsibleAssistantTurn
                        key={`turn-${turnKey}`}
                        items={group.items}
                        renderItem={renderMessageItem}
                        isLatest={g === lastTurnIdx}
                        isComplete={
                          hasLaterUser ||
                          g !== lastTurnIdx ||
                          (!isLoading && !isCurrentTurnActive &&
                            Boolean(group.items[group.items.length - 1]?.message.turnComplete))
                        }
                      />
                    );
                  });
                })()}

                {renderedQueuedUserMessages.map((message, index) => (
                  <MessageErrorBoundary key={message.queueId || `queued-${message.timestamp}-${index}`}>
                    <MessageComponent
                      message={message}
                      index={renderedVisibleMessages.length + index}
                      prevMessage={null}
                      createDiff={createDiff}
                      onFileOpen={onFileOpen}
                      onShowSettings={onShowSettings}
                      onGrantToolPermission={onGrantToolPermission}
                      autoExpandTools={autoExpandTools}
                      showRawParameters={showRawParameters}
                      showThinking={showThinking}
                      selectedProject={selectedProject}
                      provider={message.provider || provider}
                      userAvatarUrl={getAvatarFor(message)}
                    />
                  </MessageErrorBoundary>
                ))}

                {isLoading && <AssistantThinkingIndicator selectedProvider={provider} />}

                {/* 底部占位：当 ClaudeStatus 可见时留出空间，防止消息被状态栏遮挡 */}
                {isLoading && (
                  <div style={{ height: 72 }} aria-hidden="true" />
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* 微信风格浮动"回到底部"按钮 */}
      {isUserScrolledUp && showReturnToBottom && chatMessages.length > 0 && onScrollToBottom && (
        <button
          onClick={onScrollToBottom}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 z-30
            flex items-center gap-1.5 px-4 py-2
            bg-primary/90 hover:bg-primary text-primary-foreground
            rounded-full shadow-lg backdrop-blur-sm
            transition-all duration-200 hover:scale-105 hover:shadow-xl
            text-xs font-medium"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
          </svg>
          {t('input.scrollToBottom')}
        </button>
      )}

      {/* WeChat 风格自定义滚动条（绝对定位于右侧） */}
      <ChatScrollbar
        containerRef={scrollContainerRef}
        onUserScrollUp={() => onWheel({ deltaY: -100 })}
      />
    </div>
  );
}
