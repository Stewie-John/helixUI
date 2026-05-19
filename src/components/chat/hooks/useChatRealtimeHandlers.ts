import { useEffect, useRef } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { decodeHtmlEntities, formatUsageLimitText } from '../utils/chatFormatting';
import { safeLocalStorage } from '../utils/chatStorage';
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

interface UseChatRealtimeHandlersArgs {
  latestMessage: LatestChatMessage | null;
  provider: SessionProvider;
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  setCurrentSessionId: (sessionId: string | null) => void;
  setChatMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  setIsLoading: (loading: boolean) => void;
  setCanAbortSession: (canAbort: boolean) => void;
  setClaudeStatus: (status: { text: string; tokens: number; inputTokens?: number; outputTokens?: number; can_interrupt: boolean } | null) => void;
  setTokenBudget: (budget: Record<string, unknown> | null) => void;
  setIsSystemSessionChange: (isSystemSessionChange: boolean) => void;
  setPendingPermissionRequests: Dispatch<SetStateAction<PendingPermissionRequest[]>>;
  pendingViewSessionRef: MutableRefObject<PendingViewSession | null>;
  streamBufferRef: MutableRefObject<string>;
  streamTimerRef: MutableRefObject<number | null>;
  onSessionInactive?: (sessionId?: string | null) => void;
  onSessionProcessing?: (sessionId?: string | null) => void;
  onSessionNotProcessing?: (sessionId?: string | null) => void;
  onReplaceTemporarySession?: (sessionId?: string | null) => void;
  onNavigateToSession?: (sessionId: string) => void;
  setPermissionMode?: (mode: PermissionMode) => void;
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
  streamBufferRef,
  streamTimerRef,
  onSessionInactive,
  onSessionProcessing,
  onSessionNotProcessing,
  onReplaceTemporarySession,
  onNavigateToSession,
  setPermissionMode,
}: UseChatRealtimeHandlersArgs) {
  const lastProcessedMessageRef = useRef<LatestChatMessage | null>(null);
  // 记录最近一次收到真实内容消息的时间，用于检测 stale loading 状态
  const lastRealActivityRef = useRef<number>(0);
  // 超时计时器：session-status 触发 isLoading=true 后，若 90s 内无真实消息则自动清除
  const staleLoadingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 累计真实 token 用量（来自 Anthropic API message_start / message_delta 流式事件）
  const realTokensRef = useRef<{ input: number; output: number; cacheRead: number; cacheCreation: number }>({
    input: 0, output: 0, cacheRead: 0, cacheCreation: 0,
  });

  useEffect(() => {
    if (!latestMessage) {
      return;
    }

    // Guard against duplicate processing when dependency updates occur without a new message object.
    if (lastProcessedMessageRef.current === latestMessage) {
      return;
    }
    lastProcessedMessageRef.current = latestMessage;

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

    const activeViewSessionId =
      selectedSession?.id || currentSessionId || pendingViewSessionRef.current?.sessionId || null;
    const isSystemInitForView =
      systemInitSessionId && (!activeViewSessionId || systemInitSessionId === activeViewSessionId);
    const shouldBypassSessionFilter = isGlobalMessage || Boolean(isSystemInitForView);
    const isUnscopedError =
      !latestMessage.sessionId &&
      pendingViewSessionRef.current &&
      !pendingViewSessionRef.current.sessionId &&
      (latestMessage.type === 'claude-error' ||
        latestMessage.type === 'cursor-error' ||
        latestMessage.type === 'codex-error' ||
        latestMessage.type === 'gemini-error');

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
      setIsLoading(false);
      setCanAbortSession(false);
      setClaudeStatus(null);
      realTokensRef.current = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
      // 哨兵值 -1：会话已完成，拒绝所有延迟到达的 claude-status，防止"完成后重新显示工作中"
      lastRealActivityRef.current = -1;
      // 清除所有 stale 超时，防止旧计时器在新会话开始后误触发清除
      if (staleLoadingTimerRef.current) {
        clearTimeout(staleLoadingTimerRef.current);
        staleLoadingTimerRef.current = null;
      }
    };

    const markSessionsAsCompleted = (...sessionIds: Array<string | null | undefined>) => {
      const normalizedSessionIds = collectSessionIds(...sessionIds);
      normalizedSessionIds.forEach((sessionId) => {
        onSessionInactive?.(sessionId);
        onSessionNotProcessing?.(sessionId);
      });
    };

    if (!shouldBypassSessionFilter) {
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

      if (latestMessage.sessionId !== activeViewSessionId) {
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
      case 'session-created':
        if (latestMessage.sessionId && !currentSessionId) {
          sessionStorage.setItem('pendingSessionId', latestMessage.sessionId);
          if (pendingViewSessionRef.current && !pendingViewSessionRef.current.sessionId) {
            pendingViewSessionRef.current.sessionId = latestMessage.sessionId;
          }

          setIsSystemSessionChange(true);
          onReplaceTemporarySession?.(latestMessage.sessionId);

          setPendingPermissionRequests((previous) =>
            previous.map((request) =>
              request.sessionId ? request : { ...request, sessionId: latestMessage.sessionId },
            ),
          );
        }
        break;

      case 'token-budget':
        if (latestMessage.data) {
          setTokenBudget(latestMessage.data);
        }
        break;

      case 'claude-response': {
        // 收到真实消息，更新活动时间并取消 stale 超时
        lastRealActivityRef.current = Date.now();
        if (staleLoadingTimerRef.current) {
          clearTimeout(staleLoadingTimerRef.current);
          staleLoadingTimerRef.current = null;
        }
        if (messageData && typeof messageData === 'object' && messageData.type) {
          if (messageData.type === 'content_block_delta' && messageData.delta?.text) {
            const decodedText = decodeHtmlEntities(messageData.delta.text);
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
          // （SDK 默认不开 includePartialMessages，不会发 message_start/message_delta）
          if (messageData.type === 'message' && messageData.usage) {
            const u = messageData.usage;
            const inputTotal =
              (u.input_tokens || 0) +
              (u.cache_read_input_tokens || 0) +
              (u.cache_creation_input_tokens || 0);
            const outputTotal = u.output_tokens || 0;
            const total = inputTotal + outputTotal;
            if (total > 0) {
              realTokensRef.current = {
                input: u.input_tokens || 0,
                output: outputTotal,
                cacheRead: u.cache_read_input_tokens || 0,
                cacheCreation: u.cache_creation_input_tokens || 0,
              };
              setClaudeStatus({
                text: 'Working...',
                tokens: total,
                inputTokens: inputTotal,
                outputTokens: outputTotal,
                can_interrupt: true,
              });
            }
          }
        }

        // 仅在用户没有正在浏览的 session 时才自动跳转，绝不打断用户当前界面
        if (
          structuredMessageData?.type === 'system' &&
          structuredMessageData.subtype === 'init' &&
          structuredMessageData.session_id &&
          !currentSessionId &&
          isSystemInitForView
        ) {
          setIsSystemSessionChange(true);
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
              setChatMessages((previous) => [
                ...previous,
                {
                  type: 'assistant',
                  content,
                  timestamp: new Date(),
                },
              ]);
            }
          });
        } else if (structuredMessageData && typeof structuredMessageData.content === 'string' && structuredMessageData.content.trim()) {
          let content = decodeHtmlEntities(structuredMessageData.content);
          content = formatUsageLimitText(content);
          setChatMessages((previous) => [
            ...previous,
            {
              type: 'assistant',
              content,
              timestamp: new Date(),
            },
          ]);
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
        setClaudeStatus({
          text: 'Waiting for permission',
          tokens: 0,
          can_interrupt: true,
        });
        break;

      case 'claude-permission-cancelled':
        if (!latestMessage.requestId) {
          break;
        }
        setPendingPermissionRequests((previous) =>
          previous.filter((request) => request.requestId !== latestMessage.requestId),
        );
        break;

      case 'claude-error': {
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
            if (!currentSessionId) {
              setIsSystemSessionChange(true);
              onNavigateToSession?.(cursorData.session_id);
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
        } catch (error) {
          console.warn('Error handling cursor-result message:', error);
        }

        if (cursorCompletedSessionId && !currentSessionId && cursorCompletedSessionId === pendingCursorSessionId) {
          setCurrentSessionId(cursorCompletedSessionId);
          sessionStorage.removeItem('pendingSessionId');
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
        const pendingSessionId = sessionStorage.getItem('pendingSessionId');
        const completedSessionId =
          latestMessage.sessionId || currentSessionId || pendingSessionId;

        clearLoadingIndicators();
        markSessionsAsCompleted(
          completedSessionId,
          currentSessionId,
          selectedSession?.id,
          pendingSessionId,
        );

        if (pendingSessionId && !currentSessionId && latestMessage.exitCode === 0) {
          setCurrentSessionId(pendingSessionId);
          sessionStorage.removeItem('pendingSessionId');
          console.log('New session complete, ID set to:', pendingSessionId);
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

        if (codexData.type === 'item') {
          switch (codexData.itemType) {
            case 'agent_message':
              if (codexData.message?.content?.trim()) {
                const content = decodeHtmlEntities(codexData.message.content);
                setChatMessages((previous) => [
                  ...previous,
                  {
                    type: 'assistant',
                    content,
                    timestamp: new Date(),
                  },
                ]);
              }
              break;

            case 'reasoning':
              if (codexData.message?.content?.trim()) {
                const content = decodeHtmlEntities(codexData.message.content);
                setChatMessages((previous) => [
                  ...previous,
                  {
                    type: 'assistant',
                    content,
                    timestamp: new Date(),
                    isThinking: true,
                  },
                ]);
              }
              break;

            case 'command_execution':
              if (codexData.command) {
                setChatMessages((previous) => [
                  ...previous,
                  {
                    type: 'assistant',
                    content: '',
                    timestamp: new Date(),
                    isToolUse: true,
                    toolName: 'Bash',
                    toolInput: codexData.command,
                    toolResult: codexData.output || null,
                    exitCode: codexData.exitCode,
                  },
                ]);
              }
              break;

            case 'file_change':
              if (codexData.changes?.length > 0) {
                const changesList = codexData.changes
                  .map((change: { kind: string; path: string }) => `${change.kind}: ${change.path}`)
                  .join('\n');
                setChatMessages((previous) => [
                  ...previous,
                  {
                    type: 'assistant',
                    content: '',
                    timestamp: new Date(),
                    isToolUse: true,
                    toolName: 'FileChanges',
                    toolInput: changesList,
                    toolResult: {
                      content: `Status: ${codexData.status}`,
                      isError: false,
                    },
                  },
                ]);
              }
              break;

            case 'mcp_tool_call':
              setChatMessages((previous) => [
                ...previous,
                {
                  type: 'assistant',
                  content: '',
                  timestamp: new Date(),
                  isToolUse: true,
                  toolName: `${codexData.server}:${codexData.tool}`,
                  toolInput: JSON.stringify(codexData.arguments, null, 2),
                  toolResult: codexData.result
                    ? JSON.stringify(codexData.result, null, 2)
                    : codexData.error?.message || null,
                },
              ]);
              break;

            case 'error':
              if (codexData.message?.content) {
                setChatMessages((previous) => [
                  ...previous,
                  {
                    type: 'error',
                    content: codexData.message.content,
                    timestamp: new Date(),
                  },
                ]);
              }
              break;

            default:
              console.log('[Codex] Unhandled item type:', codexData.itemType, codexData);
          }
        }

        if (codexData.type === 'turn_complete') {
          clearLoadingIndicators();
          markSessionsAsCompleted(latestMessage.sessionId, currentSessionId, selectedSession?.id);
        }

        if (codexData.type === 'turn_failed') {
          clearLoadingIndicators();
          markSessionsAsCompleted(latestMessage.sessionId, currentSessionId, selectedSession?.id);
          setChatMessages((previous) => [
            ...previous,
            {
              type: 'error',
              content: codexData.error?.message || 'Turn failed',
              timestamp: new Date(),
            },
          ]);
        }
        break;
      }

      case 'codex-complete': {
        const codexPendingSessionId = sessionStorage.getItem('pendingSessionId');
        const codexActualSessionId = latestMessage.actualSessionId || codexPendingSessionId;
        const codexCompletedSessionId =
          latestMessage.sessionId || currentSessionId || codexPendingSessionId;

        clearLoadingIndicators();
        markSessionsAsCompleted(
          codexCompletedSessionId,
          codexActualSessionId,
          currentSessionId,
          selectedSession?.id,
          codexPendingSessionId,
        );

        if (codexPendingSessionId && !currentSessionId) {
          setCurrentSessionId(codexActualSessionId);
          setIsSystemSessionChange(true);
          if (codexActualSessionId) {
            onNavigateToSession?.(codexActualSessionId);
          }
          sessionStorage.removeItem('pendingSessionId');
        }

        if (selectedProject) {
          safeLocalStorage.removeItem(`chat_messages_${selectedProject.name}`);
        }
        break;
      }

      case 'codex-error': {
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

        const isCurrentSession =
          statusSessionId === currentSessionId || (selectedSession && statusSessionId === selectedSession.id);

        if (latestMessage.isProcessing) {
          onSessionProcessing?.(statusSessionId);
          if (isCurrentSession) {
            // 哨兵守卫：若会话已完成（-1），拒绝晚到的 isProcessing=true，防止重新点亮 loading
            if (lastRealActivityRef.current === -1) break;
            // 重置哨兵：新会话开始，允许后续 claude-status 消息正常显示状态文本
            lastRealActivityRef.current = 0;
            setIsLoading(true);
            setCanAbortSession(true);
            // 安全超时：90s 内若无真实消息到达则自动清除，防止永久 loading。
            if (staleLoadingTimerRef.current) clearTimeout(staleLoadingTimerRef.current);
            staleLoadingTimerRef.current = setTimeout(() => {
              setIsLoading(false);
              setCanAbortSession(false);
              setClaudeStatus(null);
              onSessionNotProcessing?.(statusSessionId);
              onSessionInactive?.(statusSessionId);
              if (lastRealActivityRef.current !== -1) lastRealActivityRef.current = 0;
            }, 90000);
          }
          break;
        }

        onSessionInactive?.(statusSessionId);
        onSessionNotProcessing?.(statusSessionId);
        if (isCurrentSession) {
          clearLoadingIndicators();
        }
        break;
      }

      case 'claude-status': {
        // 只处理当前 session 的状态消息，避免后台 session 触发假工作动画
        const claudeStatusSessionId = latestMessage.sessionId;
        if (claudeStatusSessionId) {
          const isCurrentStatusSession =
            claudeStatusSessionId === currentSessionId ||
            (selectedSession && claudeStatusSessionId === selectedSession.id);
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

        // 哨兵检测：会话已完成（-1），拒绝延迟到达的 claude-status，防止完成后重新显示工作中
        if (lastRealActivityRef.current === -1) {
          break;
        }

        // stale 检测：距上次真实消息超过 120s，忽略此状态消息
        if (lastRealActivityRef.current > 0) {
          const elapsed = Date.now() - lastRealActivityRef.current;
          if (elapsed > 120000) {
            break;
          }
        }

        const statusInfo: { text: string; tokens: number; can_interrupt: boolean; inputTokens?: number; outputTokens?: number } = {
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

        if (statusData.can_interrupt !== undefined) {
          statusInfo.can_interrupt = statusData.can_interrupt;
        }

        // 保留已有的真实 token 细分数据（避免被 claude-status 覆盖后丢失 ↑↓ 显示）
        const rt = realTokensRef.current;
        if (rt.input > 0 || rt.output > 0) {
          const inputTotal = rt.input + rt.cacheRead + rt.cacheCreation;
          statusInfo.inputTokens = inputTotal;
          statusInfo.outputTokens = rt.output;
          if (statusInfo.tokens === 0) {
            statusInfo.tokens = inputTotal + rt.output;
          }
        }

        // 更新活动时间戳：工具执行期间定期到达的 claude-status 也是服务器活跃的证明，
        // 避免长时间工具执行（>30s无 claude-response）时 stale 检测误拒后续状态消息
        lastRealActivityRef.current = Date.now();

        setClaudeStatus(statusInfo);
        setIsLoading(true);
        setCanAbortSession(statusInfo.can_interrupt);

        // 安全超时：防止 status 消息后没有 complete/error 到达导致永久 loading
        // 同时清理 processingSessions，避免后续 effect 重入时再点亮 loading
        // 超时后重置哨兵为 0（非 -1），允许后续真实 claude-status 重新激活状态栏，
        // 解决长工具执行（>30s）超时后 UI 永久卡住、刷新无效的问题
        if (staleLoadingTimerRef.current) clearTimeout(staleLoadingTimerRef.current);
        staleLoadingTimerRef.current = setTimeout(() => {
          setIsLoading(false);
          setCanAbortSession(false);
          setClaudeStatus(null);
          if (claudeStatusSessionId) {
            onSessionNotProcessing?.(claudeStatusSessionId);
            onSessionInactive?.(claudeStatusSessionId);
          }
          // 重置为 0（而非保留旧时间戳），允许下一条 claude-status 重新激活
          if (lastRealActivityRef.current !== -1) lastRealActivityRef.current = 0;
        }, 120000);
        break;
      }

      case 'pending-permissions-response': {
        // Server returned pending permissions for this session
        const permSessionId = latestMessage.sessionId;
        const isCurrentPermSession =
          permSessionId === currentSessionId || (selectedSession && permSessionId === selectedSession.id);
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
  }, [
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
    onSessionInactive,
    onSessionProcessing,
    onSessionNotProcessing,
    onReplaceTemporarySession,
    onNavigateToSession,
    setPermissionMode,
  ]);
}
