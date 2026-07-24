import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type {
  ChangeEvent,
  ClipboardEvent,
  CompositionEvent,
  Dispatch,
  FormEvent,
  KeyboardEvent,
  MouseEvent,
  SetStateAction,
  TouchEvent,
} from 'react';
import { useDropzone } from 'react-dropzone';
import { authenticatedFetch } from '../../../utils/api';


import { grantClaudeToolPermission } from '../utils/chatPermissions';
import { safeLocalStorage } from '../utils/chatStorage';
import { resolveCompactContinuationInfoForProject } from '../utils/compactContinuations';
import type {
  ChatMessage,
  PendingPermissionRequest,
  PermissionMode,
} from '../types/types';
import { useFileMentions } from './useFileMentions';
import { type SlashCommand, useSlashCommands } from './useSlashCommands';
import type { Project, ProjectSession, SessionProvider } from '../../../types/app';
import { BUILTIN_PROVIDERS } from '../../../types/app';
import { escapeRegExp } from '../utils/chatFormatting';
import {
  countInputCharacters,
  getInsertedText,
  recordDailyInputCharacters,
} from '../utils/dailyInputTracking';
import { clearPersistedActiveTurnStatus, persistActiveTurnStatus } from '../utils/activeTurnStatusStorage';

type PendingViewSession = {
  sessionId: string | null;
  startedAt: number;
};

// 串话根因修复（非压缩场景）：上一轮「全新会话」尚未拿到真实 sessionId 的最长等待窗口。
// 在此窗口内若再次发起全新会话，会被拦截，避免后端起两个并行且无法中止的会话。
// 超过该窗口（上一轮多半已失败/异常）则放行，避免把用户永久锁死。
const NEW_SESSION_GUARD_WINDOW_MS = 12000;

interface UseChatComposerStateArgs {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  provider: SessionProvider;
  permissionMode: PermissionMode | string;
  cyclePermissionMode: () => void;
  cursorModel: string;
  claudeModel: string;
  claudeEffort: string;
  codexModel: string;
  codexReasoningEffort: string;
  codexSpeed: string;
  geminiModel: string;
  isLoading: boolean;
  canAbortSession: boolean;
  tokenBudget: Record<string, unknown> | null;
  chatMessages: ChatMessage[];
  sendMessage: (message: unknown) => void;
  sendByCtrlEnter?: boolean;
  onSessionActive?: (sessionId?: string | null) => void;
  onSessionInactive?: (sessionId?: string | null) => void;
  onSessionProcessing?: (sessionId?: string | null) => void;
  onSessionNotProcessing?: (sessionId?: string | null) => void;
  onInputFocusChange?: (focused: boolean) => void;
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onShowSettings?: () => void;
  compactSummaryForNextTurn?: string | null;
  onCompactSummaryConsumed?: () => void;
  onStartVisualContinuation?: () => void;
  pendingViewSessionRef: { current: PendingViewSession | null };
  scrollToBottomAndReset: () => void;
  setChatMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  setSessionMessages?: Dispatch<SetStateAction<any[]>>;
  setIsLoading: (loading: boolean) => void;
  setCanAbortSession: (canAbort: boolean) => void;
  setClaudeStatus: (status: { text: string; tokens: number; inputTokens?: number; outputTokens?: number; startedAt?: number | string; can_interrupt: boolean } | null) => void;
  setPendingPermissionRequests: Dispatch<SetStateAction<PendingPermissionRequest[]>>;
}

interface MentionableFile {
  name: string;
  path: string;
}

interface CommandExecutionResult {
  type: 'builtin' | 'custom';
  action?: string;
  data?: any;
  content?: string;
  hasBashCommands?: boolean;
  hasFileIncludes?: boolean;
}

const createFakeSubmitEvent = () => {
  return { preventDefault: () => undefined } as unknown as FormEvent<HTMLFormElement>;
};

const isTemporarySessionId = (sessionId: string | null | undefined) =>
  Boolean(sessionId && sessionId.startsWith('new-session-'));

const getDraftInputKey = (
  projectName: string | null | undefined,
  selectedSessionId: string | null | undefined,
  currentSessionId: string | null | undefined,
) => {
  if (!projectName) return null;
  const visibleSessionId = selectedSessionId ||
    (currentSessionId && !isTemporarySessionId(currentSessionId) ? currentSessionId : null) ||
    'new';
  return `draft_input_v2_${encodeURIComponent(projectName)}_${encodeURIComponent(visibleSessionId)}`;
};

const readDraftInput = (key: string | null) => {
  if (!key || typeof window === 'undefined') return '';
  try { return sessionStorage.getItem(key) || ''; } catch { return ''; }
};

const writeDraftInput = (key: string | null, value: string) => {
  if (!key || typeof window === 'undefined') return;
  try {
    if (value) sessionStorage.setItem(key, value);
    else sessionStorage.removeItem(key);
  } catch { /* ignore unavailable sessionStorage */ }
};

const getStoredCursorSessionId = () => {
  if (typeof window === 'undefined') return null;
  return sessionStorage.getItem('cursorSessionId');
};

const estimateUiTokenCount = (text: string) => {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
};

const stringifyMessageContent = (value: unknown) => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const truncateHandoffText = (value: string, maxLength: number) => {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 18)).trim()} ... [truncated]`;
};

const getHandoffMessageText = (message: ChatMessage) => {
  if (message.isToolUse) {
    return message.toolName ? `[tool_use: ${message.toolName}]` : '[tool_use]';
  }

  if (message.toolResult || message.toolInput) {
    return '';
  }

  return stringifyMessageContent(message.content || message.reasoning);
};

const buildProviderHandoffContext = (
  messages: ChatMessage[],
  fromProvider: string,
  toProvider: string,
) => {
  let usedChars = 0;
  const maxTotalChars = 12_000;
  const maxMessageChars = 900;
  const relevantMessages = messages
    .filter((message) => !message.pending && !message.sendFailed)
    .slice(-18)
    .map((message, index) => {
      const role = message.type === 'user' ? 'User' : message.type === 'assistant' ? 'Assistant' : message.type || 'Message';
      const content = truncateHandoffText(getHandoffMessageText(message), maxMessageChars);
      if (!content) return '';

      const line = `${index + 1}. ${role}: ${content}`;
      if (usedChars + line.length > maxTotalChars) {
        return '';
      }

      usedChars += line.length;
      return line;
    })
    .filter(Boolean)
    .join('\n\n');

  return [
    `The visible conversation is switching from ${fromProvider} to ${toProvider}.`,
    'Continue as the same assistant conversation. Preserve user requirements, decisions, file paths, code changes, tool results, and unresolved tasks.',
    '',
    '<conversation_handoff>',
    relevantMessages || 'No prior messages were available in the visible transcript.',
    '</conversation_handoff>',
  ].join('\n');
};

export function useChatComposerState({
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
  onCompactSummaryConsumed,
  onStartVisualContinuation,
  pendingViewSessionRef,
  scrollToBottomAndReset,
  setChatMessages,
  setSessionMessages,
  setIsLoading,
  setCanAbortSession,
  setClaudeStatus,
  setPendingPermissionRequests,
}: UseChatComposerStateArgs) {
  const draftInputKey = getDraftInputKey(selectedProject?.name, selectedSession?.id, currentSessionId);
  const [input, setInput] = useState(() => {
    return readDraftInput(draftInputKey);
  });
  const [attachedImages, setAttachedImages] = useState<File[]>([]);
  const [uploadingImages, setUploadingImages] = useState<Map<string, number>>(new Map());
  const [imageErrors, setImageErrors] = useState<Map<string, string>>(new Map());
  const [isTextareaExpanded, setIsTextareaExpanded] = useState(false);
  const [isInputFocused, setIsInputFocused] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputHighlightRef = useRef<HTMLDivElement>(null);
  // 同步提交锁：防止快速双击在 React 重渲染前重复发送
  const isSubmittingRef = useRef(false);
  const handleSubmitRef = useRef<
    ((event: FormEvent<HTMLFormElement> | MouseEvent | TouchEvent | KeyboardEvent<HTMLTextAreaElement>) => Promise<boolean>) | null
  >(null);
  const inputValueRef = useRef(input);
  const activeDraftKeyRef = useRef<string | null>(draftInputKey);
  const restoringDraftRef = useRef(false);
  const voicePreviewRef = useRef<{
    baseInput: string;
    renderedText: string;
    transcriptText: string;
    absorbedTranscript: string;
  } | null>(null);
  const ignoreVoiceUntilFinalRef = useRef(false);
  const isComposingRef = useRef(false);
  const compositionBaseInputRef = useRef<string | null>(null);

  const countActiveVoicePreview = useCallback(() => {
    const preview = voicePreviewRef.current;
    if (!preview) return;
    recordDailyInputCharacters(countInputCharacters(preview.transcriptText));
    voicePreviewRef.current = null;
  }, []);

  useEffect(() => {
    const consumeActiveVoiceInput = () => {
      ignoreVoiceUntilFinalRef.current = true;
      voicePreviewRef.current = null;
    };
    window.addEventListener('helix:voice-input-will-finalize', consumeActiveVoiceInput);
    return () => window.removeEventListener('helix:voice-input-will-finalize', consumeActiveVoiceInput);
  }, []);

  const handleBuiltInCommand = useCallback(
    (result: CommandExecutionResult) => {
      const { action, data } = result;
      switch (action) {
        case 'clear':
          setChatMessages([]);
          setSessionMessages?.([]);
          break;

        case 'help':
          setChatMessages((previous) => [
            ...previous,
            {
              type: 'assistant',
              content: data.content,
              timestamp: Date.now(),
            },
          ]);
          break;

        case 'model':
          {
            const codexLevels = Array.isArray(data.available?.codexReasoningEffort)
              ? data.available.codexReasoningEffort.join(', ')
              : 'N/A';
            const codexSpeeds = Array.isArray(data.available?.codexSpeed)
              ? data.available.codexSpeed.join(', ')
              : 'N/A';
          setChatMessages((previous) => [
            ...previous,
            {
                type: 'assistant',
                content: `**Current Model**: ${data.current.model}\n\n**Available Models**:\n\nClaude: ${data.available.claude.join(', ')}\n\nCursor: ${data.available.cursor.join(', ')}\n\nCodex: ${data.available.codex.join(', ')}\n\nCodex Reasoning: ${codexLevels}\n\nCodex Speed: ${codexSpeeds}`,
                timestamp: Date.now(),
              },
            ]);
          }
          break;

        case 'cost': {
          const costMessage = `**Token Usage**: ${data.tokenUsage.used.toLocaleString()} / ${data.tokenUsage.total.toLocaleString()} (${data.tokenUsage.percentage}%)\n\n**Estimated Cost**:\n- Input: $${data.cost.input}\n- Output: $${data.cost.output}\n- **Total**: $${data.cost.total}\n\n**Model**: ${data.model}`;
          setChatMessages((previous) => [
            ...previous,
            { type: 'assistant', content: costMessage, timestamp: Date.now() },
          ]);
          break;
        }

        case 'status': {
          const statusMessage = `**System Status**\n\n- Version: ${data.version}\n- Uptime: ${data.uptime}\n- Model: ${data.model}\n- Provider: ${data.provider}\n- Node.js: ${data.nodeVersion}\n- Platform: ${data.platform}`;
          setChatMessages((previous) => [
            ...previous,
            { type: 'assistant', content: statusMessage, timestamp: Date.now() },
          ]);
          break;
        }

        case 'memory':
          if (data.error) {
            setChatMessages((previous) => [
              ...previous,
              {
                type: 'assistant',
                content: `⚠️ ${data.message}`,
                timestamp: Date.now(),
              },
            ]);
          } else {
            setChatMessages((previous) => [
              ...previous,
              {
                type: 'assistant',
                content: `📝 ${data.message}\n\nPath: \`${data.path}\``,
                timestamp: Date.now(),
              },
            ]);
            if (data.exists && onFileOpen) {
              onFileOpen(data.path);
            }
          }
          break;

        case 'config':
          onShowSettings?.();
          break;

        case 'rewind':
          if (data.error) {
            setChatMessages((previous) => [
              ...previous,
              {
                type: 'assistant',
                content: `⚠️ ${data.message}`,
                timestamp: Date.now(),
              },
            ]);
          } else {
            setChatMessages((previous) => previous.slice(0, -data.steps * 2));
            setChatMessages((previous) => [
              ...previous,
              {
                type: 'assistant',
                content: `⏪ ${data.message}`,
                timestamp: Date.now(),
              },
            ]);
          }
          break;

        default:
          console.warn('Unknown built-in command action:', action);
      }
    },
    [onFileOpen, onShowSettings, setChatMessages, setSessionMessages],
  );

  const handleCustomCommand = useCallback(async (result: CommandExecutionResult) => {
    const { content, hasBashCommands } = result;

    if (hasBashCommands) {
      const confirmed = window.confirm(
        'This command contains bash commands that will be executed. Do you want to proceed?',
      );
      if (!confirmed) {
        setChatMessages((previous) => [
          ...previous,
          {
            type: 'assistant',
            content: '❌ Command execution cancelled',
            timestamp: Date.now(),
          },
        ]);
        return;
      }
    }

    const commandContent = content || '';
    setInput(commandContent);
    inputValueRef.current = commandContent;

    // Defer submit to next tick so the command text is reflected in UI before dispatching.
    setTimeout(() => {
      if (handleSubmitRef.current) {
        handleSubmitRef.current(createFakeSubmitEvent());
      }
    }, 0);
  }, [setChatMessages]);

  const executeCommand = useCallback(
    async (command: SlashCommand, rawInput?: string) => {
      if (!command || !selectedProject) {
        return;
      }

      try {
        const effectiveInput = rawInput ?? input;
        const commandMatch = effectiveInput.match(new RegExp(`${escapeRegExp(command.name)}\\s*(.*)`));
        const args =
          commandMatch && commandMatch[1] ? commandMatch[1].trim().split(/\s+/) : [];

        const context = {
          projectPath: selectedProject.fullPath || selectedProject.path,
          projectName: selectedProject.name,
          sessionId: currentSessionId,
          provider,
          model: provider === 'cursor' ? cursorModel : provider === 'codex' ? codexModel : provider === 'gemini' ? geminiModel : claudeModel,
          tokenUsage: tokenBudget,
        };

        const response = await authenticatedFetch('/api/commands/execute', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            commandName: command.name,
            commandPath: command.path,
            args,
            context,
          }),
        });

        if (!response.ok) {
          let errorMessage = `Failed to execute command (${response.status})`;
          try {
            const errorData = await response.json();
            errorMessage = errorData?.message || errorData?.error || errorMessage;
          } catch {
            // Ignore JSON parse failures and use fallback message.
          }
          throw new Error(errorMessage);
        }

        const result = (await response.json()) as CommandExecutionResult;
        if (result.type === 'builtin') {
          handleBuiltInCommand(result);
          setInput('');
          inputValueRef.current = '';
        } else if (result.type === 'custom') {
          await handleCustomCommand(result);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error('Error executing command:', error);
        setChatMessages((previous) => [
          ...previous,
          {
            type: 'assistant',
            content: `Error executing command: ${message}`,
            timestamp: Date.now(),
          },
        ]);
      }
    },
    [
      claudeModel,
      codexModel,
      currentSessionId,
      cursorModel,
      geminiModel,
      handleBuiltInCommand,
      handleCustomCommand,
      input,
      provider,
      selectedProject,
      setChatMessages,
      tokenBudget,
    ],
  );

  const {
    slashCommands,
    slashCommandsCount,
    filteredCommands,
    frequentCommands,
    commandQuery,
    showCommandMenu,
    selectedCommandIndex,
    resetCommandMenuState,
    handleCommandSelect,
    handleToggleCommandMenu,
    handleCommandInputChange,
    handleCommandMenuKeyDown,
  } = useSlashCommands({
    selectedProject,
    input,
    setInput,
    textareaRef,
    onExecuteCommand: executeCommand,
  });

  const {
    showFileDropdown,
    filteredFiles,
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    setCursorPosition,
    handleFileMentionsKeyDown,
  } = useFileMentions({
    selectedProject,
    input,
    setInput,
    textareaRef,
  });

  const syncInputOverlayScroll = useCallback((target: HTMLTextAreaElement) => {
    if (!inputHighlightRef.current || !target) {
      return;
    }
    inputHighlightRef.current.scrollTop = target.scrollTop;
    inputHighlightRef.current.scrollLeft = target.scrollLeft;
  }, []);

  // 压缩图片：缩放到最大边 1500px，转为 JPEG 85% 品质
  // SVG / GIF 直接透传（无法用 Canvas 处理动画或矢量）
  const compressImageFile = useCallback(async (file: File): Promise<File> => {
    if (file.type === 'image/svg+xml' || file.type === 'image/gif') return file;
    return new Promise((resolve) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        const MAX = 1500;
        let { width, height } = img;
        if (width > MAX || height > MAX) {
          if (width >= height) { height = Math.round(height * MAX / width); width = MAX; }
          else { width = Math.round(width * MAX / height); height = MAX; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) { resolve(file); return; }
        ctx.drawImage(img, 0, 0, width, height);
        canvas.toBlob(
          (blob) => {
            if (!blob) { resolve(file); return; }
            // 如果压缩后反而更大（例如本来就是小 PNG），则用原文件
            if (blob.size >= file.size) { resolve(file); return; }
            const compressed = new File([blob], file.name.replace(/\.[^.]+$/, '.jpg'), {
              type: 'image/jpeg',
              lastModified: Date.now(),
            });
            resolve(compressed);
          },
          'image/jpeg',
          0.85,
        );
      };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
      img.src = url;
    });
  }, []);

  const handleImageFiles = useCallback(async (files: File[]) => {
    const validFiles = files.filter((file) => {
      try {
        if (!file || typeof file !== 'object') {
          console.warn('Invalid file object:', file);
          return false;
        }

        if (!file.type || !file.type.startsWith('image/')) {
          return false;
        }

        // 上传前限制原始大小 20MB（压缩后通常远低于此值）
        if (!file.size || file.size > 20 * 1024 * 1024) {
          const fileName = file.name || 'Unknown file';
          setImageErrors((previous) => {
            const next = new Map(previous);
            next.set(fileName, 'File too large (max 20MB)');
            return next;
          });
          return false;
        }

        return true;
      } catch (error) {
        console.error('Error validating file:', error, file);
        return false;
      }
    });

    if (validFiles.length > 0) {
      // 并行压缩所有图片
      const compressed = await Promise.all(validFiles.map(compressImageFile));
      setAttachedImages((previous) => [...previous, ...compressed].slice(0, 5));
    }
  }, [compressImageFile]);

  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const items = Array.from(event.clipboardData.items);

      items.forEach((item) => {
        if (!item.type.startsWith('image/')) {
          return;
        }
        const file = item.getAsFile();
        if (file) {
          handleImageFiles([file]);
        }
      });

      if (items.length === 0 && event.clipboardData.files.length > 0) {
        const files = Array.from(event.clipboardData.files);
        const imageFiles = files.filter((file) => file.type.startsWith('image/'));
        if (imageFiles.length > 0) {
          handleImageFiles(imageFiles);
        }
      }
    },
    [handleImageFiles],
  );

  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    accept: {
      'image/*': ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'],
    },
    maxSize: 20 * 1024 * 1024, // 20MB 原始大小上限，上传前自动压缩
    maxFiles: 5,
    onDrop: handleImageFiles,
    noClick: true,
    noKeyboard: true,
  });

  const handleSubmit = useCallback(
    async (
      event: FormEvent<HTMLFormElement> | MouseEvent | TouchEvent | KeyboardEvent<HTMLTextAreaElement>,
    ) => {
      event.preventDefault();
      const currentInput = inputValueRef.current;
      const hasAttachedImages = attachedImages.length > 0;
      if ((!currentInput.trim() && !hasAttachedImages) || isLoading || !selectedProject) {
        return false;
      }
      // 同步锁：即便 React 未完成重渲染也能阻止双击重复发送
      if (isSubmittingRef.current) return false;
      isSubmittingRef.current = true;

      // 串话根因修复（非压缩场景）：当本次提交会开启一个「全新会话」（没有可复用的 sessionId），
      // 且上一轮新会话还没拿到真实 sessionId（pendingViewSessionRef 仍是未采纳的占位）时，直接拦截。
      // 否则后端会再起一个全新会话，而前端只采纳后一个，导致前一轮变成无法中止的孤儿任务
      // （两个回复同时返回）。主动「新建会话」会重置该 ref，因此不会误伤正常的连续新建流程。
      {
        const guardContinuation = resolveCompactContinuationInfoForProject(selectedProject, selectedSession?.id);
        const guardProvider = guardContinuation.isContinuation
          ? guardContinuation.provider
          : selectedSession?.__provider;
        const guardFreshProviderSwitch = Boolean(selectedSession?.id && guardProvider && guardProvider !== provider);
        const guardFreshCompact = ((compactSummaryForNextTurn ?? '').trim()).length > 0;
        const guardContinuationSessionId =
          guardContinuation.isContinuation && guardContinuation.provider === provider
            ? guardContinuation.sessionId
            : null;
        const guardSelectedRuntimeSessionId =
          selectedSession?.id && !isTemporarySessionId(selectedSession.id)
            ? guardContinuationSessionId || selectedSession.id
            : null;
        const guardFallbackSessionId =
          provider === 'cursor' ? getStoredCursorSessionId() : null;
        const guardEffectiveSessionId = guardFreshCompact || guardFreshProviderSwitch
          ? null
          : guardSelectedRuntimeSessionId || currentSessionId || guardFallbackSessionId;
        const pendingNew = pendingViewSessionRef.current;
        if (
          !guardEffectiveSessionId &&
          pendingNew &&
          !pendingNew.sessionId &&
          Date.now() - pendingNew.startedAt < NEW_SESSION_GUARD_WINDOW_MS
        ) {
          // 保留用户已输入的文本，不清空，便于上一轮被采纳后重新发送
          isSubmittingRef.current = false;
          return false;
        }
      }

      // Intercept slash commands: if input starts with /commandName, execute as command with args
      const trimmedInput = currentInput.trim();
      if (trimmedInput.startsWith('/')) {
        const firstSpace = trimmedInput.indexOf(' ');
        const commandName = firstSpace > 0 ? trimmedInput.slice(0, firstSpace) : trimmedInput;
        const matchedCommand = slashCommands.find((cmd: SlashCommand) => cmd.name === commandName);
        if (matchedCommand) {
          executeCommand(matchedCommand, trimmedInput);
          isSubmittingRef.current = false;
          if (voicePreviewRef.current) {
            ignoreVoiceUntilFinalRef.current = true;
            countActiveVoicePreview();
          }
          window.dispatchEvent(new Event('helix:voice-input-committed'));
          setInput('');
          inputValueRef.current = '';
          setAttachedImages([]);
          setUploadingImages(new Map());
          setImageErrors(new Map());
          resetCommandMenuState();
          setIsTextareaExpanded(false);
          if (textareaRef.current) {
            textareaRef.current.style.height = 'auto';
          }
          return true;
        }
      }

      const compactSummary = compactSummaryForNextTurn?.trim() || '';
      const continuationInfo = resolveCompactContinuationInfoForProject(selectedProject, selectedSession?.id);
      const selectedProvider = continuationInfo.isContinuation
        ? continuationInfo.provider
        : selectedSession?.__provider;
      const shouldStartFreshAfterProviderSwitch =
        Boolean(selectedSession?.id && selectedProvider && selectedProvider !== provider);
      const shouldStartFreshAfterCompact = compactSummary.length > 0;
      let messageContent = currentInput.trim() || (hasAttachedImages ? 'Please analyze the attached image(s).' : currentInput);
      if (shouldStartFreshAfterCompact) {
        messageContent = [
          'The previous conversation was automatically compacted because the context window was near full.',
          'Use this compacted context as continuity, then answer the current user request.',
          '',
          '<compacted_context>',
          compactSummary,
          '</compacted_context>',
          '',
          'Current user request:',
          messageContent,
        ].join('\n');
      }
      if (shouldStartFreshAfterProviderSwitch) {
        const handoffContext = buildProviderHandoffContext(
          chatMessages,
          String(selectedProvider),
          String(provider),
        );
        messageContent = [
          handoffContext,
          '',
          'Current user request:',
          messageContent,
        ].join('\n');
        onStartVisualContinuation?.();
      }

      let uploadedImages: unknown[] = [];
      if (attachedImages.length > 0) {
        setIsLoading(true);
        setCanAbortSession(false);
        setClaudeStatus({
          text: 'Uploading images',
          tokens: 0,
          can_interrupt: false,
        });

        const formData = new FormData();
        attachedImages.forEach((file) => {
          formData.append('images', file);
        });

        try {
          const response = await authenticatedFetch(`/api/projects/${selectedProject.name}/upload-images`, {
            method: 'POST',
            headers: {},
            body: formData,
          });

          if (!response.ok) {
            throw new Error('Failed to upload images');
          }

          const result = await response.json();
          uploadedImages = result.images;
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          console.error('Image upload failed:', error);
          isSubmittingRef.current = false;
          setIsLoading(false);
          setCanAbortSession(false);
          setClaudeStatus(null);
          setChatMessages((previous) => [
            ...previous,
            {
              type: 'error',
              content: `Failed to upload images: ${message}`,
              timestamp: new Date(),
            },
          ]);
          return false;
        }
      }

      // 多账号场景：用统一的 submitTs 既给本地 user 消息打时间戳，
      // 也跟着 WS payload 发到后端写 attribution；后端按 (sessionId, clientTs) 落库，
      // 前端按 message.timestamp 反查得到 user_id，渲染时挂上对应账号的头像。
      const submitTs = Date.now();
      const statusSessionId = currentSessionId || selectedSession?.id;
      if (statusSessionId && !isTemporarySessionId(statusSessionId)) {
        clearPersistedActiveTurnStatus(statusSessionId);
      }
      try {
        sessionStorage.setItem('task_start_time', String(submitTs));
      } catch { /* ignore */ }
      const userMessage: ChatMessage = {
        type: 'user',
        content: currentInput,
        images: uploadedImages as any,
        timestamp: new Date(submitTs),
        clientTs: submitTs,
        pending: true,  // 等待服务器响应，响应到达后清除
        deliveryStatus: 'sending',  // 等待后端 command-ack 回执；超时→failed，回执到达→delivered
      };

      // These three surfaces are one local transaction: conversation bubble,
      // work status, and sidebar activity. Mark the known view id active before
      // waiting for command ACK/turn.started or a project-directory rescan.
      if (statusSessionId) {
        onSessionActive?.(statusSessionId);
        onSessionProcessing?.(statusSessionId);
      }
      setChatMessages((previous) => [...previous, userMessage]);
      setIsLoading(true);
      setCanAbortSession(true);
      const estimatedInputTokens =
        estimateUiTokenCount(messageContent) + (Array.isArray(uploadedImages) ? uploadedImages.length * 256 : 0);
      const initialTurnStatus = {
        text: '',   // 留空让前端自动循环切换 ...ing 词汇
        tokens: estimatedInputTokens,
        inputTokens: estimatedInputTokens,
        outputTokens: 0,
        startedAt: submitTs,
        can_interrupt: true,
      };
      setClaudeStatus(initialTurnStatus);
      if (statusSessionId && !isTemporarySessionId(statusSessionId)) {
        persistActiveTurnStatus(statusSessionId, initialTurnStatus);
      }

      // 未浏览历史时跟随新提交；若已上滑，传入的滚动函数会保留锁定位置。
      // 只有显式点击“回到底部”按钮才会解除历史浏览锁。
      setTimeout(() => scrollToBottomAndReset(), 100);

      const continuationSessionId =
        continuationInfo.isContinuation && continuationInfo.provider === provider
          ? continuationInfo.sessionId
          : null;
      const selectedViewSessionId = selectedSession?.id || null;
      const selectedRuntimeSessionId =
        selectedViewSessionId && !isTemporarySessionId(selectedViewSessionId)
          ? continuationSessionId || selectedViewSessionId
          : null;
      const fallbackSessionId = provider === 'cursor' ? getStoredCursorSessionId() : null;
      const effectiveSessionId = shouldStartFreshAfterCompact || shouldStartFreshAfterProviderSwitch
        ? null
        : selectedRuntimeSessionId || currentSessionId || fallbackSessionId;
      if (
        selectedRuntimeSessionId &&
        effectiveSessionId &&
        effectiveSessionId !== selectedRuntimeSessionId &&
        !shouldStartFreshAfterCompact &&
        !shouldStartFreshAfterProviderSwitch
      ) {
        console.error('[SESSION_GUARD] Refusing to send command to non-visible session', {
          selectedViewSessionId,
          selectedRuntimeSessionId,
          currentSessionId,
          effectiveSessionId,
          provider,
        });
        setChatMessages((previous) => previous.filter((message) => message !== userMessage).concat({
          type: 'error',
          content: 'Refused to send because the active session changed. Please click the target conversation once and send again.',
          timestamp: new Date(),
        }));
        isSubmittingRef.current = false;
        setIsLoading(false);
        setCanAbortSession(false);
        setClaudeStatus(null);
        return false;
      }
      const sessionToActivate = effectiveSessionId || `new-session-${Date.now()}`;

      // 新会话关联 ID：session-created 是服务端广播消息，会发给所有客户端。
      // 只有发起本次新会话请求的这个标签页持有匹配的 requestId，才会采纳返回的真实 sessionId，
      // 避免其他处于"新对话"状态的标签页误采纳别人的会话（串话根因）。
      const newSessionRequestId = !effectiveSessionId
        ? `req-${submitTs}-${Math.random().toString(36).slice(2, 10)}`
        : null;
      if (newSessionRequestId && typeof window !== 'undefined') {
        sessionStorage.setItem('pendingNewSessionRequestId', newSessionRequestId);
      }

      if (!effectiveSessionId && (!selectedSession?.id || shouldStartFreshAfterCompact || shouldStartFreshAfterProviderSwitch)) {
        if (typeof window !== 'undefined') {
          // Reset stale pending IDs from previous interrupted runs before creating a new one.
          sessionStorage.removeItem('pendingSessionId');
          sessionStorage.removeItem('compactContinuationSourceSessionId');
          sessionStorage.removeItem('compactContinuationSourceProjectName');
          if (shouldStartFreshAfterCompact || shouldStartFreshAfterProviderSwitch) {
            sessionStorage.removeItem('cursorSessionId');
            sessionStorage.setItem('compactContinuationPending', '1');
            if (selectedSession?.id) {
              sessionStorage.setItem('compactContinuationSourceSessionId', selectedSession.id);
            }
            if (selectedProject.name) {
              sessionStorage.setItem('compactContinuationSourceProjectName', selectedProject.name);
            }
          }
        }
        pendingViewSessionRef.current = { sessionId: null, startedAt: Date.now() };
      }
      onSessionActive?.(sessionToActivate);
      if (shouldStartFreshAfterProviderSwitch) {
        const previousRuntimeSessionId = currentSessionId || selectedSession?.id || null;
        if (previousRuntimeSessionId && !isTemporarySessionId(previousRuntimeSessionId)) {
          onSessionInactive?.(previousRuntimeSessionId);
          onSessionNotProcessing?.(previousRuntimeSessionId);
        }
        if (
          selectedSession?.id &&
          selectedSession.id !== previousRuntimeSessionId &&
          !isTemporarySessionId(selectedSession.id)
        ) {
          onSessionInactive?.(selectedSession.id);
          onSessionNotProcessing?.(selectedSession.id);
        }
      }
      if (effectiveSessionId && !isTemporarySessionId(effectiveSessionId)) {
        onSessionProcessing?.(effectiveSessionId);
      }

      const getToolsSettings = () => {
        try {
          const settingsKey =
            provider === 'cursor'
              ? 'cursor-tools-settings'
              : provider === 'codex'
                ? 'codex-settings'
                : provider === 'gemini'
                  ? 'gemini-settings'
                  : 'claude-settings';
          const savedSettings = safeLocalStorage.getItem(settingsKey);
          if (savedSettings) {
            return JSON.parse(savedSettings);
          }
        } catch (error) {
          console.error('Error loading tools settings:', error);
        }

        return {
          allowedTools: [],
          disallowedTools: [],
          skipPermissions: false,
        };
      };

      const toolsSettings = getToolsSettings();
      const resolvedProjectPath = selectedProject.fullPath || selectedProject.path || '';

      if (provider === 'cursor') {
        sendMessage({
          type: 'cursor-command',
          command: messageContent,
          sessionId: effectiveSessionId,
          viewSessionId: selectedViewSessionId,
          options: {
            cwd: resolvedProjectPath,
            projectPath: resolvedProjectPath,
            sessionId: effectiveSessionId,
            viewSessionId: selectedViewSessionId,
            runtimeSessionId: effectiveSessionId,
            resume: Boolean(effectiveSessionId),
            model: cursorModel,
            images: uploadedImages,
            skipPermissions: toolsSettings?.skipPermissions || false,
            toolsSettings,
            clientTs: submitTs,
          },
        });
      } else if (provider === 'codex') {
        sendMessage({
          type: 'codex-command',
          command: messageContent,
          sessionId: effectiveSessionId,
          viewSessionId: selectedViewSessionId,
          options: {
            cwd: resolvedProjectPath,
            projectPath: resolvedProjectPath,
            sessionId: effectiveSessionId,
            viewSessionId: selectedViewSessionId,
            runtimeSessionId: effectiveSessionId,
            resume: Boolean(effectiveSessionId),
            model: codexModel,
            modelReasoningEffort: codexReasoningEffort,
            speed: codexSpeed,
            images: uploadedImages,
            permissionMode: permissionMode === 'plan' ? 'default' : permissionMode,
            clientTs: submitTs,
            newSessionRequestId,
          },
        });
      } else if (provider === 'gemini') {
        sendMessage({
          type: 'gemini-command',
          command: messageContent,
          sessionId: effectiveSessionId,
          viewSessionId: selectedViewSessionId,
          options: {
            cwd: resolvedProjectPath,
            projectPath: resolvedProjectPath,
            sessionId: effectiveSessionId,
            viewSessionId: selectedViewSessionId,
            runtimeSessionId: effectiveSessionId,
            resume: Boolean(effectiveSessionId),
            model: geminiModel,
            images: uploadedImages,
            permissionMode,
            toolsSettings,
            clientTs: submitTs,
          },
        });
      } else if (!BUILTIN_PROVIDERS.has(provider)) {
        // 自定义 Provider：从 localStorage 读取配置，通过 ANTHROPIC_BASE_URL 转发到兼容代理
        const customProviders = JSON.parse(safeLocalStorage.getItem('custom-providers') || '[]');
        const customProvider = customProviders.find((p: { id: string }) => p.id === provider);
        const customModel = safeLocalStorage.getItem(`custom-model-${provider}`) || customProvider?.model || '';
        sendMessage({
          type: 'claude-command',
          command: messageContent,
          sessionId: effectiveSessionId,
          viewSessionId: selectedViewSessionId,
          options: {
            projectPath: resolvedProjectPath,
            cwd: resolvedProjectPath,
            sessionId: effectiveSessionId,
            viewSessionId: selectedViewSessionId,
            runtimeSessionId: effectiveSessionId,
            resume: Boolean(effectiveSessionId),
            toolsSettings,
            permissionMode,
            model: customModel,
            images: uploadedImages,
            clientTs: submitTs,
            newSessionRequestId,
            customBaseURL: customProvider?.baseURL,
            customApiKey: customProvider?.apiKey,
          },
        });
      } else {
        sendMessage({
          type: 'claude-command',
          command: messageContent,
          sessionId: effectiveSessionId,
          viewSessionId: selectedViewSessionId,
          options: {
            projectPath: resolvedProjectPath,
            cwd: resolvedProjectPath,
            sessionId: effectiveSessionId,
            viewSessionId: selectedViewSessionId,
            runtimeSessionId: effectiveSessionId,
            resume: Boolean(effectiveSessionId),
            toolsSettings,
            permissionMode,
            model: claudeModel,
            effort: claudeEffort,
            images: uploadedImages,
            clientTs: submitTs,
            newSessionRequestId,
          },
        });
      }

      // 发送完毕，释放同步锁（isLoading=true 会防止下一次提交）
      isSubmittingRef.current = false;

      // Sending consumes the visible voice preview. Stop the active browser
      // recognition session and ignore its trailing onend transcript so the
      // same sentence cannot be inserted again into the newly cleared input.
      if (voicePreviewRef.current) {
        ignoreVoiceUntilFinalRef.current = true;
        countActiveVoicePreview();
      }
      window.dispatchEvent(new Event('helix:voice-input-committed'));

      setInput('');
      inputValueRef.current = '';
      resetCommandMenuState();
      setAttachedImages([]);
      setUploadingImages(new Map());
      setImageErrors(new Map());
      setIsTextareaExpanded(false);

      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }

      writeDraftInput(activeDraftKeyRef.current, '');
      if (shouldStartFreshAfterCompact) {
        onCompactSummaryConsumed?.();
      }
      return true;
    },
    [
      attachedImages,
      chatMessages,
      claudeModel,
      claudeEffort,
      codexModel,
      codexReasoningEffort,
      codexSpeed,
      compactSummaryForNextTurn,
      currentSessionId,
      cursorModel,
      executeCommand,
      geminiModel,
      isLoading,
      onCompactSummaryConsumed,
      onSessionActive,
      onSessionInactive,
      onSessionNotProcessing,
      onSessionProcessing,
      onStartVisualContinuation,
      pendingViewSessionRef,
      permissionMode,
      provider,
      resetCommandMenuState,
      scrollToBottomAndReset,
      selectedProject,
      selectedSession?.id,
      selectedSession?.__provider,
      sendMessage,
      setCanAbortSession,
      setChatMessages,
      setClaudeStatus,
      setIsLoading,
      slashCommands,
      countActiveVoicePreview,
    ],
  );

  useEffect(() => {
    handleSubmitRef.current = handleSubmit;
  }, [handleSubmit]);

  useEffect(() => {
    inputValueRef.current = input;
  }, [input]);

  useEffect(() => {
    if (activeDraftKeyRef.current === draftInputKey) return;

    // Persist the visible session before switching keys. sessionStorage keeps
    // this tab isolated from every other browser tab/window.
    writeDraftInput(activeDraftKeyRef.current, inputValueRef.current);
    activeDraftKeyRef.current = draftInputKey;
    restoringDraftRef.current = true;
    const savedInput = readDraftInput(draftInputKey);
    inputValueRef.current = savedInput;
    setInput(savedInput);
    setAttachedImages([]);
    setUploadingImages(new Map());
    setImageErrors(new Map());
    resetCommandMenuState();
  }, [draftInputKey, resetCommandMenuState]);

  useEffect(() => {
    if (restoringDraftRef.current) {
      restoringDraftRef.current = false;
      return;
    }
    writeDraftInput(activeDraftKeyRef.current, input);
  }, [input, draftInputKey]);

  useEffect(() => {
    // Remove the old project-wide key so stale shared drafts cannot reappear
    // in older code paths after this migration.
    if (selectedProject?.name) {
      safeLocalStorage.removeItem(`draft_input_${selectedProject.name}`);
    }
  }, [selectedProject?.name]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    textarea.style.height = 'auto';
    if (!input.trim()) {
      setIsTextareaExpanded(false);
      return;
    }

    // Programmatic updates (voice transcription, restored drafts and queued
    // prompts) do not emit a textarea input event, so size from React state.
    textarea.style.height = `${textarea.scrollHeight}px`;
    const lineHeight = parseFloat(window.getComputedStyle(textarea).lineHeight) || 24;
    const expanded = textarea.scrollHeight > lineHeight * 2;
    setIsTextareaExpanded(expanded);
  }, [input]);

  useEffect(() => {
    if (!textareaRef.current || input.trim()) {
      return;
    }
    textareaRef.current.style.height = 'auto';
    setIsTextareaExpanded(false);
  }, [input]);

  const handleInputChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = event.target.value;
      const cursorPos = event.target.selectionStart;
      const nativeEvent = event.nativeEvent as InputEvent | undefined;
      const isUserInput = Boolean(nativeEvent);

      if (isUserInput && !isComposingRef.current && !nativeEvent?.isComposing) {
        const insertedText = getInsertedText(inputValueRef.current, newValue);
        recordDailyInputCharacters(countInputCharacters(insertedText));
      }

      setInput(newValue);
      inputValueRef.current = newValue;
      setCursorPosition(cursorPos);

      if (!newValue.trim()) {
        event.target.style.height = 'auto';
        setIsTextareaExpanded(false);
        resetCommandMenuState();
        return;
      }

      handleCommandInputChange(newValue, cursorPos);
    },
    [handleCommandInputChange, resetCommandMenuState, setCursorPosition],
  );

  const handleCompositionStart = useCallback((_event: CompositionEvent<HTMLTextAreaElement>) => {
    isComposingRef.current = true;
    compositionBaseInputRef.current = inputValueRef.current;
  }, []);

  const handleCompositionEnd = useCallback((event: CompositionEvent<HTMLTextAreaElement>) => {
    const finalValue = event.currentTarget.value;
    const baseValue = compositionBaseInputRef.current ?? inputValueRef.current;
    const insertedText = getInsertedText(baseValue, finalValue);
    recordDailyInputCharacters(countInputCharacters(insertedText));
    isComposingRef.current = false;
    compositionBaseInputRef.current = null;
    inputValueRef.current = finalValue;
  }, []);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (handleCommandMenuKeyDown(event)) {
        return;
      }

      if (handleFileMentionsKeyDown(event)) {
        return;
      }

      if (event.key === 'Tab' && !showFileDropdown && !showCommandMenu) {
        event.preventDefault();
        cyclePermissionMode();
        return;
      }

      if (event.key === 'Enter') {
        if (event.nativeEvent.isComposing) {
          return;
        }

        if ((event.ctrlKey || event.metaKey) && !event.shiftKey) {
          event.preventDefault();
          handleSubmit(event);
        } else if (!event.shiftKey && !event.ctrlKey && !event.metaKey && !sendByCtrlEnter) {
          event.preventDefault();
          handleSubmit(event);
        }
      }
    },
    [
      cyclePermissionMode,
      handleCommandMenuKeyDown,
      handleFileMentionsKeyDown,
      handleSubmit,
      sendByCtrlEnter,
      showCommandMenu,
      showFileDropdown,
    ],
  );

  const handleTextareaClick = useCallback(
    (event: MouseEvent<HTMLTextAreaElement>) => {
      setCursorPosition(event.currentTarget.selectionStart);
    },
    [setCursorPosition],
  );

  const handleTextareaInput = useCallback(
    (event: FormEvent<HTMLTextAreaElement>) => {
      const target = event.currentTarget;
      target.style.height = 'auto';
      target.style.height = `${target.scrollHeight}px`;
      setCursorPosition(target.selectionStart);
      syncInputOverlayScroll(target);

      const lineHeight = parseInt(window.getComputedStyle(target).lineHeight);
      setIsTextareaExpanded(target.scrollHeight > lineHeight * 2);
    },
    [setCursorPosition, syncInputOverlayScroll],
  );

  const handleClearInput = useCallback(() => {
    setInput('');
    inputValueRef.current = '';
    resetCommandMenuState();
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.focus();
    }
    setIsTextareaExpanded(false);
  }, [resetCommandMenuState]);

  const handleAbortSession = useCallback(() => {
    if (!canAbortSession) {
      return;
    }

    const pendingSessionId =
      typeof window !== 'undefined' ? sessionStorage.getItem('pendingSessionId') : null;
    const cursorSessionId =
      typeof window !== 'undefined' ? sessionStorage.getItem('cursorSessionId') : null;

    const candidateSessionIds = [
      currentSessionId,
      pendingViewSessionRef.current?.sessionId || null,
      pendingSessionId,
      provider === 'cursor' ? cursorSessionId : null,
      selectedSession?.id || null,
    ];

    const targetSessionId =
      candidateSessionIds.find((sessionId) => Boolean(sessionId) && !isTemporarySessionId(sessionId)) || null;

    if (!targetSessionId) {
      console.warn('Abort requested but no concrete session ID is available yet.');
      return;
    }

    sendMessage({
      type: 'abort-session',
      sessionId: targetSessionId,
      provider,
    });
  }, [canAbortSession, currentSessionId, pendingViewSessionRef, provider, selectedSession?.id, sendMessage]);

  const handleTranscript = useCallback((text: string, isFinal = true) => {
    if (ignoreVoiceUntilFinalRef.current) {
      if (isFinal) ignoreVoiceUntilFinalRef.current = false;
      return;
    }
    const normalizedText = text.trim();
    if (isFinal && normalizedText) {
      recordDailyInputCharacters(countInputCharacters(normalizedText));
    }
    setInput((previousInput) => {
      const previousPreview = voicePreviewRef.current;
      const expectedPreviousInput = previousPreview
        ? `${previousPreview.baseInput}${previousPreview.renderedText}`
        : previousInput;
      const wasEditedDuringRecognition = Boolean(
        previousPreview && previousInput !== expectedPreviousInput
      );

      // Once the user edits the textarea, freeze everything recognized so far
      // into the new baseline. Later interim events may revise the old phrase;
      // only the newly recognized tail is allowed to change after that point.
      const baseInput = wasEditedDuringRecognition ? previousInput : (previousPreview?.baseInput ?? previousInput);
      const absorbedTranscript = wasEditedDuringRecognition
        ? (previousPreview?.transcriptText || '')
        : (previousPreview?.absorbedTranscript || '');

      if (!normalizedText) {
        voicePreviewRef.current = null;
        inputValueRef.current = baseInput;
        return baseInput;
      }

      const transcriptTail = absorbedTranscript && normalizedText.length >= absorbedTranscript.length
        ? normalizedText.slice(absorbedTranscript.length)
        : (absorbedTranscript ? '' : normalizedText);

      const hasCjkBoundary = /[\u3400-\u9fff\uf900-\ufaff]/.test(
        `${baseInput.slice(-1)}${transcriptTail.slice(0, 1)}`,
      );
      const boundary = hasCjkBoundary
        ? (/[，。！？；：,.!?;:]$/.test(baseInput) ? '' : '，')
        : ' ';
      const renderedText = transcriptTail
        ? (baseInput.trim() ? `${boundary}${transcriptTail}` : transcriptTail)
        : '';
      const newInput = `${baseInput}${renderedText}`;
      voicePreviewRef.current = isFinal ? null : {
        baseInput,
        renderedText,
        transcriptText: normalizedText,
        absorbedTranscript,
      };
      inputValueRef.current = newInput;

      setTimeout(() => {
        if (!textareaRef.current) {
          return;
        }

        textareaRef.current.style.height = 'auto';
        textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
        const lineHeight = parseInt(window.getComputedStyle(textareaRef.current).lineHeight);
        setIsTextareaExpanded(textareaRef.current.scrollHeight > lineHeight * 2);
      }, 0);

      return newInput;
    });
  }, []);

  const handleGrantToolPermission = useCallback(
    (suggestion: { entry: string; toolName: string }) => {
      if (!suggestion || provider !== 'claude') {
        return { success: false };
      }
      return grantClaudeToolPermission(suggestion.entry);
    },
    [provider],
  );

  const handlePermissionDecision = useCallback(
    (
      requestIds: string | string[],
      decision: { allow?: boolean; message?: string; rememberEntry?: string | null; updatedInput?: unknown },
    ) => {
      const ids = Array.isArray(requestIds) ? requestIds : [requestIds];
      const validIds = ids.filter(Boolean);
      if (validIds.length === 0) {
        return;
      }

      validIds.forEach((requestId) => {
        sendMessage({
          type: 'claude-permission-response',
          requestId,
          allow: Boolean(decision?.allow),
          updatedInput: decision?.updatedInput,
          message: decision?.message,
          rememberEntry: decision?.rememberEntry,
        });
      });

      setPendingPermissionRequests((previous) => {
        const next = previous.filter((request) => !validIds.includes(request.requestId));
        if (next.length === 0) {
          setClaudeStatus(null);
        }
        return next;
      });
    },
    [sendMessage, setClaudeStatus, setPendingPermissionRequests],
  );

  const handleInputFocusChange = useCallback(
    (focused: boolean) => {
      setIsInputFocused(focused);
      const textarea = textareaRef.current;
      if (textarea) {
        if (textarea.value.trim()) {
          textarea.style.height = 'auto';
          textarea.style.height = `${textarea.scrollHeight}px`;
          const lineHeight = parseFloat(window.getComputedStyle(textarea).lineHeight) || 24;
          setIsTextareaExpanded(textarea.scrollHeight > lineHeight * 2);
        } else {
          textarea.style.height = 'auto';
          setIsTextareaExpanded(false);
        }
      }
      onInputFocusChange?.(focused);
    },
    [onInputFocusChange],
  );

  return {
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
    filteredFiles: filteredFiles as MentionableFile[],
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
    openImagePicker: open,
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
    // 编辑重发：绕过 inputValueRef，直接注入内容并触发 submit
    programmaticSubmit: (content: string) => {
      inputValueRef.current = content;
      setInput(content);
      setTimeout(() => {
        if (handleSubmitRef.current) {
          handleSubmitRef.current(createFakeSubmitEvent());
        }
      }, 0);
    },
  };
}
