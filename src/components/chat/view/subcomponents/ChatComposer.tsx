import CommandMenu from './CommandMenu';
import MicButton from '../../../mic-button/view/MicButton';
import ImageAttachment from './ImageAttachment';
import PermissionRequestsBanner from './PermissionRequestsBanner';
import ChatInputControls from './ChatInputControls';
import ClaudeStatus from './ClaudeStatus';
import SidebarProgress from '../../../sidebar/view/subcomponents/SidebarProgress';
import GoalStatusBar from './GoalStatusBar';
import { useTranslation } from 'react-i18next';
import { useEffect, useRef, useState } from 'react';

// 输入框内嵌缩略图：图片粘贴后显示在输入框内左侧
function InlineImagePreview({ file, onRemove }: { file: File; onRemove: () => void }) {
  const { t } = useTranslation('chat');
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);
  if (!url) return null;
  return (
    <div className="relative group flex-shrink-0" style={{ width: 34, height: 34 }}>
      <img src={url} alt={file.name} className="w-full h-full object-cover rounded-md" />
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onRemove(); }}
        className="absolute -top-1 -right-1 w-4 h-4 bg-black/80 text-white rounded-full text-[10px] leading-none flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity z-10"
        title={t('input.removeImage')}
      >×</button>
    </div>
  );
}
import { getProviderLabel } from '../../utils/providerLabels';


import type {
  ChangeEvent,
  ClipboardEvent,
  CompositionEvent,
  FormEvent,
  KeyboardEvent,
  MouseEvent,
  ReactNode,
  RefObject,
  TouchEvent,
} from 'react';
import type { PendingPermissionRequest, PermissionMode, Provider } from '../../types/types';

interface MentionableFile {
  name: string;
  path: string;
}

interface SlashCommand {
  name: string;
  description?: string;
  namespace?: string;
  path?: string;
  type?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

interface ChatComposerProps {
  sessionId?: string | null;
  pendingPermissionRequests: PendingPermissionRequest[];
  handlePermissionDecision: (
    requestIds: string | string[],
    decision: { allow?: boolean; message?: string; rememberEntry?: string | null; updatedInput?: unknown },
  ) => void;
  handleGrantToolPermission: (suggestion: { entry: string; toolName: string }) => { success: boolean };
  claudeStatus: { text: string; tokens: number; inputTokens?: number; outputTokens?: number; startedAt?: number | string; can_interrupt: boolean } | null;
  isLoading: boolean;
  onAbortSession: () => void;
  provider: Provider | string;
  setProvider?: (provider: Provider) => void;
  permissionMode: PermissionMode | string;
  onModeSwitch: () => void;
  tokenBudget: { used?: number; total?: number; updatedAt?: number } | null;
  onRefreshTokenUsage?: () => void | Promise<void>;
  slashCommandsCount: number;
  onToggleCommandMenu: () => void;
  hasInput: boolean;
  onClearInput: () => void;
  isUserScrolledUp: boolean;
  hasMessages: boolean;
  onScrollToBottom: () => void;
  onSubmit: (
    event: FormEvent<HTMLFormElement> | MouseEvent<HTMLButtonElement> | TouchEvent<HTMLButtonElement>,
  ) => boolean | void | Promise<boolean | void>;
  isDragActive: boolean;
  attachedImages: File[];
  onRemoveImage: (index: number) => void;
  uploadingImages: Map<string, number>;
  imageErrors: Map<string, string>;
  showFileDropdown: boolean;
  filteredFiles: MentionableFile[];
  selectedFileIndex: number;
  onSelectFile: (file: MentionableFile) => void;
  filteredCommands: SlashCommand[];
  selectedCommandIndex: number;
  onCommandSelect: (command: SlashCommand, index: number, isHover: boolean) => void;
  onCloseCommandMenu: () => void;
  isCommandMenuOpen: boolean;
  frequentCommands: SlashCommand[];
  getRootProps: (...args: unknown[]) => Record<string, unknown>;
  getInputProps: (...args: unknown[]) => Record<string, unknown>;
  openImagePicker: () => void;
  inputHighlightRef: RefObject<HTMLDivElement>;
  renderInputWithMentions: (text: string) => ReactNode;
  textareaRef: RefObject<HTMLTextAreaElement>;
  input: string;
  onInputChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  onCompositionStart: (event: CompositionEvent<HTMLTextAreaElement>) => void;
  onCompositionEnd: (event: CompositionEvent<HTMLTextAreaElement>) => void;
  onTextareaClick: (event: MouseEvent<HTMLTextAreaElement>) => void;
  onTextareaKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onTextareaPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  onTextareaScrollSync: (target: HTMLTextAreaElement) => void;
  onTextareaInput: (event: FormEvent<HTMLTextAreaElement>) => void;
  onInputFocusChange?: (focused: boolean) => void;
  isInputFocused?: boolean;
  placeholder: string;
  isTextareaExpanded: boolean;
  sendByCtrlEnter?: boolean;
  onTranscript: (text: string, isFinal?: boolean) => void;
  onBtwMessage?: (text: string) => boolean;
  onQueueMessage?: (message: { id: string; text: string; sourceClientTs?: number }) => void;
  onDequeueMessage?: (id: string) => void;
  onDiscardQueuedMessages?: (ids: string[]) => void;
  queueScopeKey?: string | null;
  canDispatchQueuedMessage?: boolean;
  claudeModel?: string;
  setClaudeModel?: (model: string) => void;
  claudeEffort?: string;
  setClaudeEffort?: (effort: string) => void;
  cursorModel?: string;
  setCursorModel?: (model: string) => void;
  codexModel?: string;
  setCodexModel?: (model: string) => void;
  codexReasoningEffort?: string;
  setCodexReasoningEffort?: (effort: string) => void;
  codexSpeed?: string;
  setCodexSpeed?: (speed: string) => void;
  geminiModel?: string;
  setGeminiModel?: (model: string) => void;
}

export default function ChatComposer({
  sessionId,
  pendingPermissionRequests,
  handlePermissionDecision,
  handleGrantToolPermission,
  claudeStatus,
  isLoading,
  onAbortSession,
  provider,
  setProvider,
  permissionMode,
  onModeSwitch,
  tokenBudget,
  onRefreshTokenUsage,
  slashCommandsCount,
  onToggleCommandMenu,
  hasInput,
  onClearInput,
  isUserScrolledUp,
  hasMessages,
  onScrollToBottom,
  onSubmit,
  isDragActive,
  attachedImages,
  onRemoveImage,
  uploadingImages,
  imageErrors,
  showFileDropdown,
  filteredFiles,
  selectedFileIndex,
  onSelectFile,
  filteredCommands,
  selectedCommandIndex,
  onCommandSelect,
  onCloseCommandMenu,
  isCommandMenuOpen,
  frequentCommands,
  getRootProps,
  getInputProps,
  openImagePicker,
  inputHighlightRef,
  renderInputWithMentions,
  textareaRef,
  input,
  onInputChange,
  onCompositionStart,
  onCompositionEnd,
  onTextareaClick,
  onTextareaKeyDown,
  onTextareaPaste,
  onTextareaScrollSync,
  onTextareaInput,
  onInputFocusChange,
  isInputFocused,
  placeholder,
  isTextareaExpanded,
  sendByCtrlEnter,
  onTranscript,
  onBtwMessage,
  onQueueMessage,
  onDequeueMessage,
  onDiscardQueuedMessages,
  queueScopeKey,
  canDispatchQueuedMessage = true,
  claudeModel,
  setClaudeModel,
  claudeEffort,
  setClaudeEffort,
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
}: ChatComposerProps) {
  const { t, i18n } = useTranslation('chat');

  // BTW/队列：模型工作时仍允许用户输入下一条消息。
  const [queuedMessages, setQueuedMessages] = useState<Array<{ id: string; text: string; sourceClientTs?: number }>>([]);
  const formRef = useRef<HTMLFormElement>(null);
  const queueScopeRef = useRef(queueScopeKey);
  const queuedDispatchRef = useRef(false);
  const dispatchingMessageRef = useRef<{ id: string; text: string } | null>(null);
  const isLoadingRef = useRef(isLoading);
  const [queueRetryNonce, setQueueRetryNonce] = useState(0);
  const failedFollowupKeysRef = useRef(new Set<string>());
  isLoadingRef.current = isLoading;

  const enqueueMessage = (text: string) => {
    const message = { id: `queued-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, text };
    setQueuedMessages((previous) => [...previous, message]);
    onQueueMessage?.(message);
  };

  useEffect(() => {
    const handleFailedFollowup = (event: Event) => {
      const detail = (event as CustomEvent<{ text?: string; clientTs?: number }>).detail;
      const text = detail?.text?.trim();
      if (!text) return;
      const sourceClientTs = typeof detail?.clientTs === 'number' ? detail.clientTs : undefined;
      const dedupeKey = sourceClientTs ? `client:${sourceClientTs}` : `text:${text}`;
      if (failedFollowupKeysRef.current.has(dedupeKey)) return;
      failedFollowupKeysRef.current.add(dedupeKey);
      const message = {
        id: `queued-followup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        text,
        sourceClientTs,
      };
      setQueuedMessages((previous) => [...previous, message]);
      onQueueMessage?.(message);
    };
    window.addEventListener('helix:queue-failed-followup', handleFailedFollowup);
    return () => window.removeEventListener('helix:queue-failed-followup', handleFailedFollowup);
  }, [onQueueMessage]);

  useEffect(() => {
    if (queueScopeRef.current === queueScopeKey) return;
    queueScopeRef.current = queueScopeKey;
    if (!queuedMessages.length) return;
    onDiscardQueuedMessages?.(queuedMessages.map((message) => message.id));
    setQueuedMessages([]);
  }, [onDiscardQueuedMessages, queueScopeKey, queuedMessages]);

  // ── 移动端悬浮球 / 可拖拽调整高度 ─────────────────────────────────────
  const [isMobileView, setIsMobileView] = useState(
    () => typeof window !== 'undefined' && window.innerWidth < 640
  );
  const [isMobileMinimized, setIsMobileMinimized] = useState(false);
  const [ballPos, setBallPos] = useState({ bottom: 96, right: 16 });
  const [mobileExtraHeight, setMobileExtraHeight] = useState(0);
  const ballTouchRef = useRef<{
    startX: number; startY: number; initBottom: number; initRight: number; moved: boolean;
  } | null>(null);
  const resizeTouchRef = useRef<{ startY: number; initExtra: number } | null>(null);

  useEffect(() => {
    const check = () => setIsMobileView(window.innerWidth < 640);
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  const providerLabel = getProviderLabel(provider);

  // 等当前会话真正拿到 runtime session id 后再自动发送队列消息；否则会把
  // 同一会话的下一条命令误当作全新会话，造成左侧会话列表不断新增。
  useEffect(() => {
    if (isLoading) {
      const accepted = dispatchingMessageRef.current;
      if (accepted) {
        setQueuedMessages((previous) => previous.filter((message) => message.id !== accepted.id));
        onDequeueMessage?.(accepted.id);
        dispatchingMessageRef.current = null;
      }
      queuedDispatchRef.current = false;
      return;
    }

    if (!queuedDispatchRef.current && canDispatchQueuedMessage && queuedMessages.length > 0) {
      queuedDispatchRef.current = true;
      const message = queuedMessages[0];
      dispatchingMessageRef.current = message;
      // Restore the text synchronously (the composer mirrors it into a ref),
      // then call the submit function directly so it can explicitly acknowledge
      // acceptance. The old requestSubmit + 400ms inference could retry an
      // already accepted message and execute the same follow-up twice.
      onInputChange({ target: { value: message.text } } as ChangeEvent<HTMLTextAreaElement>);
      setTimeout(async () => {
        const syntheticEvent = { preventDefault() {} } as FormEvent<HTMLFormElement>;
        const accepted = await onSubmit(syntheticEvent);
        if (accepted === true) {
          setQueuedMessages((previous) => previous.filter((item) => item.id !== message.id));
          onDequeueMessage?.(message.id);
          dispatchingMessageRef.current = null;
          queuedDispatchRef.current = false;
        } else {
          setTimeout(() => {
            if (dispatchingMessageRef.current?.id === message.id && !isLoadingRef.current) {
              dispatchingMessageRef.current = null;
              queuedDispatchRef.current = false;
              setQueueRetryNonce((value) => value + 1);
            }
          }, 400);
        }
      }, 80);
    }
  }, [canDispatchQueuedMessage, isLoading, onDequeueMessage, onInputChange, onSubmit, queuedMessages, queueRetryNonce]);

  // 拦截提交：支持真 BTW 的 provider 先尝试注入，否则回退到“结束后续发”队列。
  const handleQueueOrSubmit = (event: FormEvent<HTMLFormElement> | MouseEvent<HTMLButtonElement> | TouchEvent<HTMLButtonElement> | KeyboardEvent<HTMLTextAreaElement>) => {
    if (isLoading && input.trim()) {
      event.preventDefault();
      const text = input.trim();
      const injected = onBtwMessage?.(text) === true;
      if (injected) {
        onClearInput();
      } else {
        // 回退：本地队列，等当前回复完成后自动发送。
        enqueueMessage(text);
        onClearInput();
      }
    } else {
      onSubmit(event as FormEvent<HTMLFormElement>);
    }
  };

  // 包装键盘事件：loading 中 Ctrl/Cmd+Enter 触发 BTW/排队，而非被 handleSubmit 拦截后忽略
  const handleKeyDownWrapped = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      isLoading &&
      (event.ctrlKey || event.metaKey) &&
      event.key === 'Enter' &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      handleQueueOrSubmit(event);
      return;
    }
    onTextareaKeyDown(event);
  };

  const textareaRect = textareaRef.current?.getBoundingClientRect();
  const commandMenuPosition = {
    top: textareaRect ? Math.max(16, textareaRect.top - 316) : 0,
    left: textareaRect ? textareaRect.left : 16,
    bottom: textareaRect ? window.innerHeight - textareaRect.top + 8 : 90,
  };

  // Detect if the AskUserQuestion interactive panel is active
  const hasQuestionPanel = pendingPermissionRequests.some(
    (r) => r.toolName === 'AskUserQuestion'
  );

  // ── 手机端悬浮球触摸处理 ────────────────────────────────────────
  const handleBallTouchStart = (e: TouchEvent<HTMLDivElement>) => {
    const touch = e.touches[0];
    ballTouchRef.current = {
      startX: touch.clientX, startY: touch.clientY,
      initBottom: ballPos.bottom, initRight: ballPos.right,
      moved: false,
    };
    e.stopPropagation();
  };
  const handleBallTouchMove = (e: TouchEvent<HTMLDivElement>) => {
    if (!ballTouchRef.current) return;
    const touch = e.touches[0];
    const dx = touch.clientX - ballTouchRef.current.startX;
    const dy = touch.clientY - ballTouchRef.current.startY;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) ballTouchRef.current.moved = true;
    setBallPos({
      right: Math.max(8, Math.min(window.innerWidth - 64, ballTouchRef.current.initRight - dx)),
      bottom: Math.max(8, Math.min(window.innerHeight - 64, ballTouchRef.current.initBottom - dy)),
    });
    e.stopPropagation();
  };
  const handleBallTouchEnd = (e: TouchEvent<HTMLDivElement>) => {
    if (!ballTouchRef.current?.moved) setIsMobileMinimized(false);
    ballTouchRef.current = null;
    e.stopPropagation();
  };
  const handleResizeTouchStart = (e: TouchEvent<HTMLDivElement>) => {
    resizeTouchRef.current = { startY: e.touches[0].clientY, initExtra: mobileExtraHeight };
    e.stopPropagation();
  };
  const handleResizeTouchMove = (e: TouchEvent<HTMLDivElement>) => {
    if (!resizeTouchRef.current) return;
    const dy = e.touches[0].clientY - resizeTouchRef.current.startY;
    // 向上拖（dy < 0）= 增高，向下拖 = 缩小，最小 0，最大 280px
    setMobileExtraHeight(Math.max(0, Math.min(280, resizeTouchRef.current.initExtra - dy)));
    e.stopPropagation();
  };
  const handleResizeTouchEnd = () => { resizeTouchRef.current = null; };

  // 悬浮球视图（移动端 + 桌面端均支持）
  if (isMobileMinimized) {
    return (
      <div
        style={{ position: 'fixed', right: ballPos.right, bottom: ballPos.bottom, zIndex: 60, touchAction: 'none' }}
        onTouchStart={handleBallTouchStart}
        onTouchMove={handleBallTouchMove}
        onTouchEnd={handleBallTouchEnd}
      >
        {/* 悬浮球本体 */}
        <div style={{
          width: 56, height: 56, borderRadius: '50%', position: 'relative',
          background: 'linear-gradient(135deg, #002d5a 0%, #004880 100%)',
          border: '2px solid rgba(0,200,255,0.65)',
          boxShadow: '0 4px 22px rgba(0,100,200,0.5), 0 0 14px rgba(0,200,255,0.25)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <svg width="26" height="26" fill="none" stroke="#00d9ff" strokeWidth="1.8" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
          </svg>
          {/* 输入框有内容时显示角标 */}
          {input.trim() && (
            <div style={{ position: 'absolute', top: 3, right: 3, width: 11, height: 11, borderRadius: '50%', background: '#00d9ff', border: '2px solid #001830' }} />
          )}
        </div>
      </div>
    );
  }

  // On mobile, when input is focused, float the input box at the bottom
  const mobileFloatingClass = isInputFocused
    ? 'max-sm:fixed max-sm:bottom-0 max-sm:left-0 max-sm:right-0 max-sm:z-50 max-sm:bg-background max-sm:shadow-[0_-4px_20px_rgba(0,0,0,0.15)]'
    : '';

  return (
    <div className={`tech-composer-panel p-2 sm:p-4 md:p-4 flex-shrink-0 pb-2 sm:pb-4 md:pb-6 ${mobileFloatingClass}`}>
      <div className="chat-composer-layout flex items-end gap-3">
        <div className="chat-composer-progress"><SidebarProgress docked /></div>
        <div className="chat-composer-content min-w-0 flex-1">
      <GoalStatusBar sessionId={sessionId} provider={String(provider)} isLoading={isLoading} />
      {/* 拖拽调高手柄 + 最小化按钮（移动端 + 桌面端均显示） */}
      {(
        <div className="flex items-center gap-1 mb-1 -mx-2 px-2 pt-0.5">
          {/* 最小化按钮 */}
          <button
            type="button"
            onClick={() => setIsMobileMinimized(true)}
            className="flex-shrink-0 p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
            aria-label={t('input.minimizeToBubble')}
          >
            <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="9" />
              <path strokeLinecap="round" d="M8 12h8" />
            </svg>
          </button>
          {/* 可拖拽调高手柄（向上拖 = 更高） */}
          <div
            className="flex-1 flex items-center justify-center py-2"
            style={{ touchAction: 'none', cursor: 'row-resize' }}
            onTouchStart={handleResizeTouchStart}
            onTouchMove={handleResizeTouchMove}
            onTouchEnd={handleResizeTouchEnd}
          >
            <div style={{ width: 40, height: 4, borderRadius: 2, background: 'var(--muted-foreground, #888)', opacity: 0.3 }} />
          </div>
          {/* 平衡占位（与左侧按钮宽度一致） */}
          <div className="flex-shrink-0 w-9" />
        </div>
      )}
      <div className="max-w-4xl mx-auto">
        <ClaudeStatus
          status={claudeStatus}
          isLoading={isLoading}
          onAbort={onAbortSession}
          provider={provider as string}
        />
      </div>

      <div className="max-w-4xl mx-auto mb-3">
        <PermissionRequestsBanner
          pendingPermissionRequests={pendingPermissionRequests}
          handlePermissionDecision={handlePermissionDecision}
          handleGrantToolPermission={handleGrantToolPermission}
        />

        {!hasQuestionPanel && <ChatInputControls
          permissionMode={permissionMode}
          onModeSwitch={onModeSwitch}
          provider={provider}
          setProvider={setProvider}
          tokenBudget={tokenBudget}
          onRefreshTokenUsage={onRefreshTokenUsage}
          slashCommandsCount={slashCommandsCount}
          onToggleCommandMenu={onToggleCommandMenu}
          hasInput={hasInput}
          onClearInput={onClearInput}
          isUserScrolledUp={isUserScrolledUp}
          hasMessages={hasMessages}
          onScrollToBottom={onScrollToBottom}
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
        />}
      </div>

      {/* BTW/队列提示条 */}
      {queuedMessages.length > 0 && (
        <div className="max-w-4xl mx-auto mb-2 flex items-center gap-2 bg-amber-900/60 text-amber-200 rounded-lg px-3 py-2 border border-amber-700 text-xs sm:text-sm">
          <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span className="flex-1 truncate">
            <span className="font-medium">
              Queued for {providerLabel}{queuedMessages.length > 1 ? ` (${queuedMessages.length})` : ''}:{' '}
            </span>
            {queuedMessages[0].text}
          </span>
          <button
            type="button"
            onClick={() => {
              onDiscardQueuedMessages?.(queuedMessages.map((message) => message.id));
              setQueuedMessages([]);
            }}
            className="flex-shrink-0 hover:text-amber-100 transition-colors ml-1"
            title="Cancel queued messages"
          >✕</button>
        </div>
      )}

      {!hasQuestionPanel && <form ref={formRef} onSubmit={handleQueueOrSubmit as (event: FormEvent<HTMLFormElement>) => void} className="relative max-w-4xl mx-auto">
        {isDragActive && (
          <div className="absolute inset-0 bg-primary/15 border-2 border-dashed border-primary/50 rounded-2xl flex items-center justify-center z-50">
            <div className="bg-card rounded-xl p-4 shadow-lg border border-border/30">
              <svg className="w-8 h-8 text-primary mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
                />
              </svg>
              <p className="text-sm font-medium">Drop images here</p>
            </div>
          </div>
        )}

        {/* 图片预览已移入输入框内部左侧（见 tech-composer-box 内的 InlineImagePreview） */}

        {showFileDropdown && filteredFiles.length > 0 && (
          <div className="absolute bottom-full left-0 right-0 mb-2 bg-card/95 backdrop-blur-md border border-border/50 rounded-xl shadow-lg max-h-48 overflow-y-auto z-50">
            {filteredFiles.map((file, index) => (
              <div
                key={file.path}
                className={`px-4 py-3 cursor-pointer border-b border-border/30 last:border-b-0 touch-manipulation ${
                  index === selectedFileIndex
                    ? 'bg-primary/8 text-primary'
                    : 'hover:bg-accent/50 text-foreground'
                }`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onSelectFile(file);
                }}
              >
                <div className="font-medium text-sm">{file.name}</div>
                <div className="text-xs text-muted-foreground font-mono">{file.path}</div>
              </div>
            ))}
          </div>
        )}

        <CommandMenu
          commands={filteredCommands}
          selectedIndex={selectedCommandIndex}
          onSelect={onCommandSelect}
          onClose={onCloseCommandMenu}
          position={commandMenuPosition}
          isOpen={isCommandMenuOpen}
          frequentCommands={frequentCommands}
        />

        <div className="tech-composer-wrapper">
        <div
          {...getRootProps()}
          className={`tech-composer-box relative bg-card/80 backdrop-blur-sm shadow-sm transition-all duration-200 overflow-hidden ${
            isTextareaExpanded ? 'chat-input-expanded' : ''
          }`}
        >
          <input {...getInputProps()} />
          <div ref={inputHighlightRef} aria-hidden="true" className="absolute inset-0 pointer-events-none overflow-hidden rounded-2xl">
            <div className="chat-input-placeholder block w-full pl-12 pr-36 sm:pr-44 py-1.5 sm:py-4 text-transparent text-base leading-6 whitespace-pre-wrap break-words">
              {renderInputWithMentions(input)}
            </div>
          </div>

          <div className="relative z-10">
            {/* 内嵌图片缩略图：显示在输入框内文字左侧 */}
            {attachedImages.length > 0 && (
              <div className="absolute left-2 top-1/2 -translate-y-1/2 flex gap-1 z-20">
                {attachedImages.slice(0, 3).map((file, index) => (
                  <InlineImagePreview
                    key={`${file.name}-${file.size}-${file.lastModified}`}
                    file={file}
                    onRemove={() => onRemoveImage(index)}
                  />
                ))}
                {attachedImages.length > 3 && (
                  <span className="self-center text-xs text-muted-foreground">+{attachedImages.length - 3}</span>
                )}
              </div>
            )}
            <textarea
              ref={textareaRef}
              value={input}
              onChange={onInputChange}
              onCompositionStart={onCompositionStart}
              onCompositionEnd={onCompositionEnd}
              onClick={onTextareaClick}
              onKeyDown={handleKeyDownWrapped}
              onPaste={onTextareaPaste}
              onScroll={(event) => onTextareaScrollSync(event.target as HTMLTextAreaElement)}
              onFocus={() => onInputFocusChange?.(true)}
              onBlur={() => onInputFocusChange?.(false)}
              onInput={onTextareaInput}
              placeholder={placeholder}
              className={`chat-input-placeholder block w-full py-1.5 sm:py-4 bg-transparent rounded-2xl focus:outline-none text-foreground placeholder-muted-foreground/50 resize-none min-h-[50px] sm:min-h-[80px] max-h-[40vh] sm:max-h-[300px] overflow-y-auto text-base leading-6 transition-all duration-200 ${
                isLoading && input.trim() ? 'pr-48 sm:pr-56' : 'pr-36 sm:pr-44'
              }`}
              style={{
                paddingLeft: attachedImages.length > 0
                  ? `${Math.min(attachedImages.length, 3) * 40 + 12}px`
                  : '48px',
                ...(mobileExtraHeight > 0 ? { minHeight: `${50 + mobileExtraHeight}px` } : {}),
              }}
            />

            {/* 相机按钮：仅在没有图片时显示（有图片时由缩略图占据左侧位置） */}
            {attachedImages.length === 0 && (
            <button
              type="button"
              onClick={openImagePicker}
              className="absolute left-2 top-1/2 transform -translate-y-1/2 p-2 hover:bg-accent/60 rounded-xl transition-colors"
              title={t('input.attachImages')}
            >
              <svg className="w-5 h-5 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
                />
              </svg>
            </button>
            )}

            <div className="absolute right-16 top-1/2 transform -translate-y-1/2 z-20">
              <MicButton onTranscript={onTranscript} />
            </div>

            {/* 发送按钮：外层 wrapper 八边形边框，内层 button 稍小切角 */}
            <div className="tech-send-wrapper absolute right-2 top-1/2 transform -translate-y-1/2">
            <button
              type="submit"
              disabled={!input.trim() && attachedImages.length === 0 && !isLoading}
              onMouseDown={(event) => {
                event.preventDefault();
                handleQueueOrSubmit(event);
              }}
              onTouchStart={(event) => {
                event.preventDefault();
                handleQueueOrSubmit(event);
              }}
              title={isLoading && input.trim()
                ? onBtwMessage
                  ? `Send now if ${providerLabel} supports live input; otherwise queue it`
                  : `Queue this message and send after ${providerLabel} finishes`
                : undefined}
              className={`tech-send-btn w-10 h-10 sm:w-11 sm:h-11 flex items-center justify-center transition-all duration-200 focus:outline-none disabled:bg-muted disabled:text-muted-foreground disabled:cursor-not-allowed ${
                isLoading && input.trim()
                  ? 'bg-amber-500 hover:bg-amber-400'
                  : 'bg-primary hover:bg-primary/90'
              }`}
            >
              {isLoading && input.trim() ? (
                /* BTW/排队图标：时钟 */
                <svg className="w-4 h-4 sm:w-[18px] sm:h-[18px] text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              ) : (
                <svg className="w-4 h-4 sm:w-[18px] sm:h-[18px]" fill="none" stroke="white" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-label={t('input.send')}>
                  {/* 整体旋转 -45°，使火箭朝右上方 45° */}
                  <g transform="rotate(-45, 12, 12)">
                    {/* 飞船主体（机头稍长至 x=22） */}
                    <path d="M22 12 C22 12 19 6.5 12 6 L5 6 C4.4 6 4 6.6 4 7.5 L4 16.5 C4 17.4 4.4 18 5 18 L12 18 C19 17.5 22 12 22 12Z" />
                    {/* 上翼（稍长） */}
                    <path d="M9 6 L7 1.5 L11.5 3 L10.5 6" />
                    {/* 下翼（稍长） */}
                    <path d="M9 18 L7 22.5 L11.5 21 L10.5 18" />
                    {/* 舷窗 */}
                    <circle cx="16" cy="12" r="2" />
                    {/* 排气口 */}
                    <path d="M4 9.5 L1.5 12 L4 14.5" />
                  </g>
                </svg>
              )}
            </button>
            </div> {/* tech-send-wrapper */}

            <div
              className={`chat-input-hint absolute bottom-1 left-12 right-14 sm:right-40 text-xs text-muted-foreground/50 pointer-events-none hidden sm:block transition-opacity duration-200 ${
                input.trim() ? 'opacity-0' : 'opacity-100'
              }`}
            >
              {sendByCtrlEnter ? t('input.hintText.ctrlEnter') : t('input.hintText.enter')}
            </div>
          </div>
        </div>
        </div> {/* tech-composer-wrapper */}
      </form>}
        </div>
      </div>
    </div>
  );
}
