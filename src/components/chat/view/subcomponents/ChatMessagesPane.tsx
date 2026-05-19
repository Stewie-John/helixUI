import { useTranslation } from 'react-i18next';
import { useCallback, useEffect, useRef, useState, Component } from 'react';
import type { Dispatch, MouseEvent as ReactMouseEvent, RefObject, SetStateAction } from 'react';
import type { ReactNode } from 'react';

import MessageComponent from './MessageComponent';
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
          ⚠ 消息渲染失败：{this.state.msg}
        </div>
      );
    }
    return this.props.children;
  }
}
// ─────────────────────────────────────────────────────────────────────────────

// ─── WeChat 风格滚动条 ────────────────────────────────────────────────────────
function ChatScrollbar({ containerRef }: { containerRef: RefObject<HTMLDivElement> }) {
  const [thumbTop, setThumbTop]       = useState(0);
  const [thumbHeight, setThumbHeight] = useState(40);
  const [visible, setVisible]         = useState(false);
  const [dragging, setDragging]       = useState(false);
  const trackRef   = useRef<HTMLDivElement>(null);
  const hideTimer  = useRef<ReturnType<typeof setTimeout>>();

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
    c.addEventListener('scroll', update, { passive: true });
    update();
    // 挂载时短暂显示 1.5s，让用户发现滚动条位置
    const initShow = setTimeout(() => update(), 200);
    return () => {
      c.removeEventListener('scroll', update);
      clearTimeout(initShow);
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
      c.scrollTop = Math.max(0, Math.min(scrollable, startTop + dy * ratio));
    };
    const onUp = () => {
      setDragging(false);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [containerRef]);

  // 点击轨道跳转
  const handleTrackClick = useCallback((e: ReactMouseEvent) => {
    if ((e.target as HTMLElement) !== trackRef.current) return;
    const c = containerRef.current;
    const track = trackRef.current;
    if (!c || !track) return;
    const rect     = track.getBoundingClientRect();
    const clickY   = e.clientY - rect.top;
    const scrollable = c.scrollHeight - c.clientHeight;
    c.scrollTop = (clickY / c.clientHeight) * scrollable;
  }, [containerRef]);

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
  onDeleteMessage,
  onEditMessage,
  onStartNewSession,
  isUserScrolledUp,
  onScrollToBottom,
}: ChatMessagesPaneProps) {
  const { t } = useTranslation('chat');

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
  // 面板上方消息全宽；与面板重叠超过一半的消息缩窄 marginRight；
  // 重叠不足一半的消息保持全宽（面板叠在上面，上层有内容可见）。
  const hudRectRef = useRef<{ left: number; right: number; top: number; bottom: number; width: number; height: number } | null>(null);
  const rafRef = useRef<number>(0);

  const updateAvoidance = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const hud = hudRectRef.current;
    const messages = container.querySelectorAll('.chat-message');
    if (!hud || messages.length === 0) {
      // 仅在有值时清除，避免无谓 DOM 写入
      messages.forEach(el => {
        const h = el as HTMLElement;
        if (h.style.marginRight) h.style.marginRight = '';
      });
      return;
    }
    const cRect = container.getBoundingClientRect();
    const avoidWidth = Math.round(cRect.right - hud.left + 16);
    if (avoidWidth <= 0) {
      messages.forEach(el => {
        const h = el as HTMLElement;
        if (h.style.marginRight) h.style.marginRight = '';
      });
      return;
    }
    const avoidPx = `${avoidWidth}px`;
    messages.forEach(el => {
      const h = el as HTMLElement;
      const rect = el.getBoundingClientRect();
      // 计算与面板的垂直重叠量
      const overlapTop = Math.max(rect.top, hud.top - 8);
      const overlapBot = Math.min(rect.bottom, hud.bottom + 8);
      const overlapH = Math.max(0, overlapBot - overlapTop);
      const msgH = rect.bottom - rect.top;
      // 降低阈值：只要有任何实质性重叠（≥8% 或绝对重叠 ≥12px）即触发避让
      // 原 40% 阈值对于长消息（代码块等）过于宽松，面板只遮住底部少量区域也不避让
      const want = (overlapH >= 12 || (overlapH > 0 && msgH > 0 && overlapH / msgH > 0.08)) ? avoidPx : '';
      // 仅在值改变时写入 DOM，避免触发不必要的 layout recalc → 滚动抖动
      if (h.style.marginRight !== want) h.style.marginRight = want;
    });
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
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(updateAvoidance);
    };
    container.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      container.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(rafRef.current);
    };
  }, [scrollContainerRef, updateAvoidance]);

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
        onTouchMove={onTouchMove}
        className="h-full overflow-y-scroll overflow-x-hidden px-0 py-3 sm:p-4 space-y-3 sm:space-y-4 [&::-webkit-scrollbar]:hidden"
        style={{
          scrollbarWidth: 'none',
          msOverflowStyle: 'none',
        }}
      >
        {isLoadingSessionMessages && chatMessages.length === 0 ? (
          <div className="text-center text-gray-500 dark:text-gray-400 mt-8">
            <div className="flex items-center justify-center space-x-2">
              {/* DNA 旋转加载动画 */}
              <div style={{ width: 18, height: 26, flexShrink: 0 }}>
                <DNASpinner size="sm" />
              </div>
              <p>{t('session.loading.sessionMessages')}</p>
            </div>
          </div>
        ) : chatMessages.length === 0 ? (
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
            geminiModel={geminiModel}
            setGeminiModel={setGeminiModel}
            tasksEnabled={tasksEnabled}
            isTaskMasterInstalled={isTaskMasterInstalled}
            onShowAllTasks={onShowAllTasks}
            setInput={setInput}
          />
        ) : (
          <>
            {/* 顶部：加载旧消息的 DNA spinner + 文字提示 */}
            {(isLoadingMoreMessages && !isLoadingAllMessages && !allMessagesLoaded) && (
              <div className="flex items-center justify-center gap-2 py-1.5">
                <DNASpinner size="sm" />
                <span className="text-xs text-muted-foreground tracking-wide">Loading...</span>
              </div>
            )}

            {/* 还有更多消息：仅显示总数，无 "scroll to load" 文字 */}
            {hasMoreMessages && !isLoadingMoreMessages && !allMessagesLoaded && totalMessages > 0 && (
              <div className="text-center text-gray-400 dark:text-gray-500 text-xs py-1.5 border-b border-gray-200/50 dark:border-gray-700/50">
                {t('session.messages.showingOf', { shown: sessionMessagesCount, total: totalMessages })}
              </div>
            )}

            {/* 全部加载完毕时，仅保留加载中 spinner，不弹任何浮层或按钮 */}

            {/* 旧的非分页视图兼容：仅保留静默计数，去掉所有按钮 */}
            {!hasMoreMessages && chatMessages.length > visibleMessageCount && (
              <div className="text-center text-gray-400 dark:text-gray-500 text-xs py-1.5 border-b border-gray-200/50 dark:border-gray-700/50">
                {t('session.messages.showingLast', { count: visibleMessageCount, total: chatMessages.length })}
              </div>
            )}

            {visibleMessages.map((message, index) => {
              const prevMessage = index > 0 ? visibleMessages[index - 1] : null;
              const key = getMessageKey(message);
              const userAvatarUrl = message.type === 'user' ? getAvatarFor(message) : null;
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
                    provider={provider}
                    onDeleteMessage={onDeleteMessage}
                    onEditMessage={onEditMessage}
                    onStartNewSession={onStartNewSession}
                    userAvatarUrl={userAvatarUrl}
                  />
                </MessageErrorBoundary>
              );
            })}
          </>
        )}

        {isLoading && <AssistantThinkingIndicator selectedProvider={provider} />}

        {/* 底部占位：当 ClaudeStatus 可见时留出空间，防止消息被状态栏遮挡 */}
        {isLoading && (
          <div style={{ height: 72 }} aria-hidden="true" />
        )}
      </div>

      {/* 微信风格浮动"回到底部"按钮 */}
      {isUserScrolledUp && chatMessages.length > 0 && onScrollToBottom && (
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
          回到底部
        </button>
      )}

      {/* WeChat 风格自定义滚动条（绝对定位于右侧） */}
      <ChatScrollbar containerRef={scrollContainerRef} />
    </div>
  );
}
