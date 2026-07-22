/**
 * OpenAI Codex SDK Integration
 * =============================
 *
 * This module provides integration with the OpenAI Codex SDK for non-interactive
 * chat sessions. It mirrors the pattern used in claude-sdk.js for consistency.
 *
 * ## Usage
 *
 * - queryCodex(command, options, ws) - Execute a prompt with streaming via WebSocket
 * - abortCodexSession(sessionId) - Cancel an active session
 * - isCodexSessionActive(sessionId) - Check if a session is running
 * - getActiveCodexSessions() - List all active sessions
 */

import { Codex } from '@openai/codex-sdk';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { CodexAppServerSession, normalizeItem } from './codex-app-server.js';
import { codexRuntimeAliasesDb, codexTranscriptDb } from './database/db.js';
import { getCodexSessionMessages, resolveCodexRuntimeThreadId } from './projects.js';

// Track active sessions
const activeCodexSessions = new Map();
const appServerCodexSessions = new Map();
const codexCommandChains = new Map();
const CODEX_CONTEXT_WINDOW = Number(process.env.CODEX_CONTEXT_WINDOW || 1050000) || 1050000;
// Codex CLI 0.143+ exposes `max` for GPT-5.6 Sol/Terra/Luna. Keep this list
// aligned with the native model catalog so the UI value reaches app-server
// unchanged instead of being silently downgraded.
const CODEX_REASONING_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const CODEX_SPEED_TIERS = new Set(['default', 'fast']);
const CODEX_APP_SERVER_IDLE_MS = Number(process.env.CODEX_APP_SERVER_IDLE_MS || 10 * 60 * 1000);
const CODEX_APP_SERVER_POOL_MAX = Math.max(1, Number(process.env.CODEX_APP_SERVER_POOL_MAX || 8));

async function sanitizeCodexModelsCache() {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const cachePath = path.join(codexHome, 'models_cache.json');

  try {
    let cache;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        cache = JSON.parse(await fs.readFile(cachePath, 'utf8'));
        break;
      } catch (error) {
        if (error?.code === 'ENOENT') return;
        if (!(error instanceof SyntaxError) || attempt === 2) throw error;
        // Codex rewrites the catalog in the background. Avoid parsing the
        // transient partial file while that non-atomic write is in progress.
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    let changed = false;

    if (Array.isArray(cache?.models)) {
      for (const model of cache.models) {
        if (!Array.isArray(model?.supported_reasoning_levels)) continue;
        const supportedLevels = model.supported_reasoning_levels.filter((level) =>
          CODEX_REASONING_EFFORTS.has(String(level?.effort || ''))
        );
        if (supportedLevels.length !== model.supported_reasoning_levels.length) {
          model.supported_reasoning_levels = supportedLevels;
          changed = true;
        }
      }
    }

    if (changed) {
      const tempPath = `${cachePath}.helix-${process.pid}-${Date.now()}.tmp`;
      await fs.writeFile(tempPath, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
      await fs.rename(tempPath, cachePath);
      console.warn('[Codex] Removed reasoning levels unsupported by the installed CLI from models cache');
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.warn('[Codex] Failed to sanitize models cache:', error?.message || error);
    }
  }
}

function imageExtensionFromMime(mimeType) {
  const subtype = String(mimeType || 'png').split('/')[1] || 'png';
  if (subtype === 'svg+xml') return 'svg';
  if (subtype === 'jpeg') return 'jpg';
  return subtype.replace(/[^a-z0-9]/gi, '') || 'png';
}

async function prepareCodexInput(command, images, workingDirectory) {
  if (!images || images.length === 0) {
    return { input: command, text: command, tempDir: null };
  }

  try {
    const tempDir = path.join(workingDirectory, '.tmp', 'images', Date.now().toString());
    await fs.mkdir(tempDir, { recursive: true });

    const tempImagePaths = [];
    for (const [index, image] of images.entries()) {
      const matches = image?.data?.match(/^data:([^;]+);base64,(.+)$/);
      if (!matches) continue;

      const [, mimeType, base64Data] = matches;
      const filepath = path.join(tempDir, `image_${index}.${imageExtensionFromMime(mimeType)}`);
      await fs.writeFile(filepath, Buffer.from(base64Data, 'base64'));
      tempImagePaths.push(filepath);
    }

    if (tempImagePaths.length === 0) {
      return { input: command, text: command, tempDir };
    }

    const text = command && command.trim() ? command : 'Please analyze the attached image(s).';
    return {
      input: [
        { type: 'text', text },
        ...tempImagePaths.map((imagePath) => ({ type: 'local_image', path: imagePath })),
      ],
      text,
      tempDir,
    };
  } catch (error) {
    console.error('[Codex] Error processing images:', error);
    return { input: command, text: command, tempDir: null };
  }
}

function truncateStatusText(text, maxLength = 120) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLength) {
    return clean;
  }
  return clean.slice(0, maxLength - 3) + '...';
}

function estimateTokenCount(text) {
  const value = String(text || '');
  if (!value) return 0;
  // Cheap live estimate. CJK characters are usually close to one token each;
  // treating every character as ASCII / 4 severely under-reports Chinese work.
  const cjkCount = (value.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
  return Math.max(1, cjkCount + Math.ceil((value.length - cjkCount) / 4));
}

function readCodexUsageTotals(usage = {}) {
  const usageTokens = usage || {};
  const inputTokens = Number(usageTokens.input_tokens || usageTokens.prompt_tokens || usageTokens.total_input_tokens || 0);
  const cacheReadTokens = Number(
    usageTokens.cached_input_tokens || usageTokens.cache_read_input_tokens || 0,
  );
  const cacheCreationTokens = Number(usageTokens.cache_creation_input_tokens || 0);
  const outputTokens = Number(usageTokens.output_tokens || 0);
  const reasoningOutputTokens = Number(usageTokens.reasoning_output_tokens || 0);
  // Codex 语义：total_tokens = input_tokens + output_tokens。
  // cached_input_tokens 是 input_tokens 的「子集」（命中缓存的那部分，非额外量），
  // reasoning_output_tokens 同样是 output_tokens 的子集。因此严禁把 cache/reasoning 再加一遍，
  // 否则 used 会虚高约 60%~135%，把真实 ~80% 占用算成 >95%，触发每轮假压缩 → 每个新问题分裂出一条会话。
  const totalTokens = Number(
    usageTokens.total_tokens ||
      (inputTokens + outputTokens),
  );

  return {
    inputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens,
  };
}

function isCredibleCodexContextUsage(usageTotals) {
  if (!usageTotals) return false;
  const totalTokens = Number(usageTotals.totalTokens || 0);
  const inputTokens = Number(usageTotals.inputTokens || 0);
  if (!totalTokens) return false;
  // The SDK can report cumulative billing totals for a thread. Those can grow
  // far beyond the model context window and must not drive the context meter or
  // UI-side compaction.
  return totalTokens <= CODEX_CONTEXT_WINDOW * 1.05 && inputTokens <= CODEX_CONTEXT_WINDOW * 1.05;
}

function updateCodexUsageEstimate(usage, event) {
  if (!usage || !event) {
    return;
  }

  if (event.type === 'turn.completed' && event.usage) {
    const { inputTokens, cacheReadTokens, cacheCreationTokens, outputTokens, reasoningOutputTokens, totalTokens } =
      readCodexUsageTotals(event.usage);

    if (!isCredibleCodexContextUsage({ inputTokens, totalTokens })) {
      return;
    }

    // A model invocation's input includes the thread history. This is the
    // official per-turn input shown in both the work status and Daily usage.
    usage.outputTokens = Math.max(usage.outputTokens || 0, outputTokens);
    usage.billingInputTokens = Math.max(usage.billingInputTokens || 0, inputTokens);
    usage.billingCachedInputTokens = Math.max(usage.billingCachedInputTokens || 0, cacheReadTokens);
    usage.billingOutputTokens = Math.max(usage.billingOutputTokens || 0, outputTokens);
    usage.exactInputTokens = inputTokens;
    usage.exactCacheReadTokens = cacheReadTokens;
    usage.exactCacheCreationTokens = cacheCreationTokens;
    usage.exactOutputTokens = outputTokens;
    usage.exactReasoningOutputTokens = reasoningOutputTokens;
    usage.exact = true;
    // SDK total_tokens should include input+output+cache in final accounting.
    if (totalTokens) {
      usage.totalTokens = totalTokens;
    }
    return;
  }

  const item = event.item;
  if (!item) {
    return;
  }

  if (item.type === 'agent_message' || item.type === 'reasoning') {
    if (!(usage.outputTokensByItem instanceof Map)) {
      usage.outputTokensByItem = new Map();
    }
    const itemKey = `${item.type}:${item.id || event.itemId || 'current'}`;
    const previous = Number(usage.outputTokensByItem.get(itemKey) || 0);
    usage.outputTokensByItem.set(itemKey, Math.max(previous, estimateTokenCount(item.text)));
    const streamedTotal = Array.from(usage.outputTokensByItem.values())
      .reduce((sum, count) => sum + Number(count || 0), 0);
    usage.outputTokens = Math.max(usage.outputTokens || 0, streamedTotal);
    usage.billingOutputTokens = Math.max(usage.billingOutputTokens || 0, streamedTotal);
  }
}

function isCodexToolLikeItem(item) {
  return Boolean(item && [
    'command_execution',
    'file_change',
    'mcp_tool_call',
    'web_search',
    'todo_list'
  ].includes(item.type));
}

function getCodexStatusMessage(event) {
  if (!event) {
    return null;
  }

  if (event.type === 'turn.started') {
    return 'Reasoning';
  }

  const item = event.item;
  if (!item || !item.type) {
    return null;
  }

  switch (item.type) {
    case 'agent_message':
      return 'Writing response';
    case 'reasoning':
      return 'Reasoning';
    case 'command_execution':
      return item.command
        ? `Exec command: ${truncateStatusText(item.command)}`
        : 'Exec command';
    case 'file_change':
      return 'Editing files';
    case 'mcp_tool_call':
      return `MCP tool: ${item.server || 'MCP'}:${item.tool || 'tool'}`;
    case 'web_search':
      return item.query
        ? `Web search: ${truncateStatusText(item.query)}`
        : 'Web search';
    case 'todo_list':
      return 'Updating todos';
    default:
      return `Working: ${item.type}`;
  }
}

function sendCodexStatus(ws, sessionId, event, usageEstimate, viewSessionId = null) {
  const message = getCodexStatusMessage(event);
  if (!message || !sessionId) {
    return;
  }

  sendMessage(ws, {
    type: 'claude-status',
    data: {
      status: message,
      tokens: (usageEstimate?.billingInputTokens || usageEstimate?.inputTokens || 0)
        + (usageEstimate?.billingOutputTokens || usageEstimate?.outputTokens || 0),
      inputTokens: usageEstimate?.billingInputTokens || usageEstimate?.inputTokens || 0,
      outputTokens: usageEstimate?.billingOutputTokens || usageEstimate?.outputTokens || 0,
      usageScope: 'turn-billing',
      // Both the work status and Daily usage use the model invocation's full
      // input, including thread context, rather than the typed prompt estimate.
      billingInputTokens: usageEstimate?.billingInputTokens || usageEstimate?.inputTokens || 0,
      billingCachedInputTokens: usageEstimate?.billingCachedInputTokens || 0,
      billingOutputTokens: usageEstimate?.billingOutputTokens || usageEstimate?.outputTokens || 0,
      total: CODEX_CONTEXT_WINDOW,
      startedAt: usageEstimate?.startedAt,
      can_interrupt: true
    },
    sessionId,
    viewSessionId,
    provider: 'codex',
    turnClientTs: Number(activeCodexSessions.get(sessionId)?.latestClientTs || 0) || undefined,
  });
}

/**
 * Transform Codex SDK event to WebSocket message format
 * @param {object} event - SDK event
 * @returns {object} - Transformed event for WebSocket
 */
function transformCodexEvent(event) {
  // Map SDK event types to a consistent format
  switch (event.type) {
    case 'item.started':
    case 'item.updated':
    case 'item.completed':
      const item = event.item;
      if (!item) {
        return { type: event.type, eventType: event.type, item: null };
      }

      // Transform based on item type
      switch (item.type) {
        case 'agent_message':
          return {
            type: 'item',
            eventType: event.type,
            itemId: item.id,
            itemType: 'agent_message',
            message: {
              role: 'assistant',
              content: item.text
            }
          };

        case 'reasoning':
          return {
            type: 'item',
            eventType: event.type,
            itemId: item.id,
            itemType: 'reasoning',
            message: {
              role: 'assistant',
              content: item.text,
              isReasoning: true
            }
          };

        case 'command_execution':
          return {
            type: 'item',
            eventType: event.type,
            itemId: item.id,
            itemType: 'command_execution',
            command: item.command,
            output: item.aggregated_output,
            exitCode: item.exit_code,
            status: item.status
          };

        case 'file_change':
          return {
            type: 'item',
            eventType: event.type,
            itemId: item.id,
            itemType: 'file_change',
            changes: item.changes,
            status: item.status
          };

        case 'mcp_tool_call':
          return {
            type: 'item',
            eventType: event.type,
            itemId: item.id,
            itemType: 'mcp_tool_call',
            server: item.server,
            tool: item.tool,
            arguments: item.arguments,
            result: item.result,
            error: item.error,
            status: item.status
          };

        case 'web_search':
          return {
            type: 'item',
            eventType: event.type,
            itemId: item.id,
            itemType: 'web_search',
            query: item.query,
            status: event.type === 'item.completed' ? 'completed' : 'in_progress'
          };

        case 'todo_list':
          return {
            type: 'item',
            eventType: event.type,
            itemId: item.id,
            itemType: 'todo_list',
            items: item.items
          };

        case 'error':
          return {
            type: 'item',
            eventType: event.type,
            itemId: item.id,
            itemType: 'error',
            message: {
              role: 'error',
              content: item.message
            }
          };

        default:
          return {
            type: 'item',
            eventType: event.type,
            itemId: item.id,
            itemType: item.type,
            item: item
          };
      }

    case 'turn.started':
      return {
        type: 'turn_started'
      };

    case 'turn.completed':
      return {
        type: 'turn_complete',
        usage: event.usage
      };

    case 'turn.failed':
      return {
        type: 'turn_failed',
        error: event.error
      };

    case 'thread.started':
      return {
        type: 'thread_started',
        threadId: event.thread_id || event.id
      };

    case 'error':
      return {
        type: 'error',
        message: event.message
      };

    default:
      return {
        type: event.type,
        data: event
      };
  }
}

/**
 * Map permission mode to Codex SDK options
 * @param {string} permissionMode - 'default', 'acceptEdits', or 'bypassPermissions'
 * @returns {object} - { sandboxMode, approvalPolicy }
 */
function mapPermissionModeToCodexOptions(permissionMode) {
  switch (permissionMode) {
    case 'acceptEdits':
      return {
        sandboxMode: 'workspace-write',
        approvalPolicy: 'never'
      };
    case 'bypassPermissions':
      return {
        sandboxMode: 'danger-full-access',
        approvalPolicy: 'never'
      };
    case 'default':
    default:
      return {
        sandboxMode: 'workspace-write',
        approvalPolicy: 'untrusted'
      };
  }
}

/**
 * Execute a Codex query with streaming
 * @param {string} command - The prompt to send
 * @param {object} options - Options including cwd, sessionId, model, permissionMode
 * @param {WebSocket|object} ws - WebSocket connection or response writer
 */
async function queryCodexLegacy(command, options = {}, ws) {
  // Discard unsupported catalog values before spawning the legacy SDK. The
  // installed Codex CLI supports `max`; only values outside the native model
  // catalog are removed while its cache is refreshed in the background.
  await sanitizeCodexModelsCache();

  const {
    sessionId,
    cwd,
    projectPath,
    model,
    modelReasoningEffort,
    speed,
    permissionMode = 'default',
    images,
    newSessionRequestId,
    clientTs,
    viewSessionId,
  } = options;

  const workingDirectory = cwd || projectPath || process.cwd();
  const codexInput = await prepareCodexInput(command, images, workingDirectory);
  const { sandboxMode, approvalPolicy } = mapPermissionModeToCodexOptions(permissionMode);

  let codex;
  let thread;
  let currentSessionId = sessionId;
  let sessionCreatedSent = false;
  const sessionAliases = new Set();
  const abortController = new AbortController();
  const usageEstimate = {
    // The typed prompt is not the model invocation input: resumed threads also
    // consume their history. Keep the work counter at zero until Codex reports
    // authoritative usage instead of flashing a misleading 20-token value.
    inputTokens: 0,
    outputTokens: 0,
    billingInputTokens: 0,
    billingCachedInputTokens: 0,
    billingOutputTokens: 0,
    startedAt: new Date().toISOString(),
    exact: false,
    outputTokensByItem: new Map(),
  };
  const requestTurnClientTs = Number(clientTs || Date.now());
  const requestViewSessionId = viewSessionId || sessionId || null;
  const sendForView = (data) => sendMessage(ws, {
    ...data,
    viewSessionId: requestViewSessionId,
    turnClientTs: requestTurnClientTs,
  });

  try {
    const requestedReasoningEffort = String(modelReasoningEffort || '');
    const normalizedReasoningEffort = CODEX_REASONING_EFFORTS.has(requestedReasoningEffort)
      ? requestedReasoningEffort
      : undefined;
    // "auto" is a UI choice meaning "let Codex choose"; it must not be sent
    // as service_tier because GPT-5.6 does not advertise it as a valid value.
    const normalizedSpeed = CODEX_SPEED_TIERS.has(String(speed || ''))
      ? String(speed)
      : undefined;

    // Initialize Codex SDK
    codex = new Codex({
      // The SDK package bundles an older CLI (currently 0.134.0), while the
      // system CLI is the one configured with the GPT-5.6 model catalog.
      // Use the configured/system binary so SDK and standalone calls share
      // the same model support. `codex` is resolved through the service PATH.
      codexPathOverride: process.env.CODEX_PATH || 'codex',
      config: normalizedSpeed ? { service_tier: normalizedSpeed } : undefined
    });

    // Thread options with sandbox and approval settings
    const threadOptions = {
      workingDirectory,
      skipGitRepoCheck: true,
      sandboxMode,
      approvalPolicy,
      model,
      ...(normalizedReasoningEffort ? { modelReasoningEffort: normalizedReasoningEffort } : {})
    };

    // Start or resume thread
    if (sessionId) {
      thread = codex.resumeThread(sessionId, threadOptions);
    } else {
      thread = codex.startThread(threadOptions);
    }

    // Get the thread ID
    currentSessionId = thread.id || sessionId || `codex-${Date.now()}`;

    // Track the session
    activeCodexSessions.set(currentSessionId, {
      thread,
      codex,
      status: 'running',
      statusText: 'Starting task',
      lastActivityAt: usageEstimate.startedAt,
      abortController,
      usageEstimate,
      logicalSessionId: sessionId || currentSessionId,
      runtimeThreadId: currentSessionId,
      viewSessionId: requestViewSessionId,
      startedAt: usageEstimate.startedAt,
      latestClientTs: requestTurnClientTs,
    });

    sendCodexStatus(ws, currentSessionId, { type: 'turn.started' }, usageEstimate, requestViewSessionId);

    // Execute with streaming
    const streamedTurn = await thread.runStreamed(codexInput.input, {
      signal: abortController.signal
    });

    for await (const event of streamedTurn.events) {
      if (event.type === 'thread.started' && event.thread_id) {
        const previousSessionId = currentSessionId;
        const sessionIdChanged = event.thread_id !== currentSessionId;
        const sessionState = previousSessionId ? activeCodexSessions.get(previousSessionId) : null;
        currentSessionId = event.thread_id;

        if (sessionState && sessionIdChanged) {
          activeCodexSessions.set(currentSessionId, sessionState);
          if (previousSessionId) {
            sessionAliases.add(previousSessionId);
            activeCodexSessions.delete(previousSessionId);
          }
        }

        if (ws && ws.setSessionId && typeof ws.setSessionId === 'function') {
          ws.setSessionId(currentSessionId);
        }

        if (!sessionId && !sessionCreatedSent) {
          sessionCreatedSent = true;
          sendForView({
            type: 'session-created',
            sessionId: currentSessionId,
            provider: 'codex',
            newSessionRequestId: newSessionRequestId || null
          });
        } else if (sessionIdChanged) {
          sendForView({
            type: 'session-id-changed',
            from: previousSessionId,
            to: currentSessionId,
            sessionId: currentSessionId,
            provider: 'codex'
          });
        }
      }

      // Check if session was aborted
      const session = activeCodexSessions.get(currentSessionId);
      if (!session || session.status === 'aborted') {
        break;
      }

      updateCodexUsageEstimate(usageEstimate, event);
      const activeSession = activeCodexSessions.get(currentSessionId);
      const statusText = getCodexStatusMessage(event);
      if (activeSession && statusText) {
        activeSession.statusText = statusText;
        activeSession.lastActivityAt = new Date().toISOString();
      }
      sendCodexStatus(ws, currentSessionId, event, usageEstimate, requestViewSessionId);

      const isCodexStreamingTextItem =
        event.item && (event.item.type === 'agent_message' || event.item.type === 'reasoning');
      if (
        (event.type === 'item.started' || event.type === 'item.updated') &&
        !isCodexToolLikeItem(event.item) &&
        !isCodexStreamingTextItem
      ) {
        continue;
      }

      const transformed = transformCodexEvent(event);

      sendForView({
        type: 'codex-response',
        data: transformed,
        sessionId: currentSessionId
      });

      // Extract and send token usage if available.
      // Prefer total_tokens to align with Codex /status context usage semantics.
      if (event.type === 'turn.completed' && event.usage) {
        const usageTotals = readCodexUsageTotals(event.usage);
        // used = input + output（真实上下文占用）。cached/reasoning 是子集，已含在 input/output 内，
        // 不能再加，否则 used/total 虚高触发每轮假压缩，导致 GPT 每个新问题分裂成独立 session。
        const totalTokens = usageTotals.totalTokens;
        if (!isCredibleCodexContextUsage(usageTotals)) {
          continue;
        }
        sendForView({
          type: 'token-budget',
          data: {
            used: totalTokens,
            inputTokens: usageTotals.inputTokens,
            outputTokens: usageTotals.outputTokens,
            cacheReadTokens: usageTotals.cacheReadTokens,
            cacheCreationTokens: usageTotals.cacheCreationTokens,
            reasoningOutputTokens: usageTotals.reasoningOutputTokens,
            total: CODEX_CONTEXT_WINDOW
          },
          sessionId: currentSessionId
        });
      }
    }

    if (!sessionId && !sessionCreatedSent) {
      sessionCreatedSent = true;
      sendForView({
        type: 'session-created',
        sessionId: currentSessionId,
        provider: 'codex',
        newSessionRequestId: newSessionRequestId || null
      });
    }

    // Send completion event
    sendForView({
      type: 'codex-complete',
      sessionId: currentSessionId,
      actualSessionId: thread.id || currentSessionId
    });

  } catch (error) {
    const session = currentSessionId ? activeCodexSessions.get(currentSessionId) : null;
    const wasAborted =
      session?.status === 'aborted' ||
      error?.name === 'AbortError' ||
      String(error?.message || '').toLowerCase().includes('aborted');

    if (!wasAborted) {
      console.error('[Codex] Error:', error);
      sendForView({
        type: 'codex-error',
        error: error.message,
        sessionId: currentSessionId,
        // A newly-started thread can fail before thread.started creates a
        // durable session id. Keep the browser-side request correlation so
        // that error is rendered in the tab that initiated the turn.
        newSessionRequestId: newSessionRequestId || null
      });
    }

  } finally {
    if (codexInput.tempDir) {
      await fs.rm(codexInput.tempDir, { recursive: true, force: true }).catch(() => {});
    }
    // Update session status
    const idsToFinalize = new Set([currentSessionId, ...sessionAliases].filter(Boolean));
    for (const id of idsToFinalize) {
      const session = activeCodexSessions.get(id);
      if (session) {
        session.status = session.status === 'aborted' ? 'aborted' : 'completed';
      }
    }
  }
}

function appServerInput(input) {
  if (typeof input === 'string') return [{ type: 'text', text: input }];
  return (input || []).map((item) => item.type === 'local_image'
    ? { type: 'localImage', path: item.path }
    : { type: 'text', text: item.text || '' });
}

async function buildRecoveryInput(sessionId, currentInput) {
  // Recovery only uses the last 12 conversational messages. A bounded request
  // avoids parsing and materializing an entire multi-hundred-megabyte rollout.
  const transcript = await getCodexSessionMessages(sessionId, 120, 0);
  const messages = Array.isArray(transcript) ? transcript : transcript?.messages || [];
  const recent = messages
    .filter((message) => message.type === 'user' || message.type === 'assistant')
    .map((message) => ({
      role: message.message?.role || message.type,
      content: String(message.message?.content || '').trim(),
    }))
    .filter((message) => message.content)
    .slice(-12);

  let context = recent
    .map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.content}`)
    .join('\n\n');
  if (context.length > 24000) context = context.slice(-24000);
  if (!context) return currentInput;

  const prefix = [
    '<codex_internal_context source="session_recovery">',
    'Continue the existing browser conversation using this recent transcript only as context.',
    '<recent_conversation>',
    context,
    '</recent_conversation>',
    '</codex_internal_context>',
    '',
    'Current user request:',
  ].join('\n');
  if (typeof currentInput === 'string') return `${prefix}\n${currentInput}`;
  return [
    { type: 'text', text: prefix },
    ...(currentInput || []),
  ];
}

async function queryCodexAppServer(command, options = {}, ws) {
  await sanitizeCodexModelsCache();
  const {
    sessionId,
    cwd,
    projectPath,
    model,
    modelReasoningEffort,
    speed,
    permissionMode = 'default',
    images,
    newSessionRequestId,
    clientTs,
    viewSessionId,
  } = options;
  const workingDirectory = cwd || projectPath || process.cwd();
  const codexInput = await prepareCodexInput(command, images, workingDirectory);
  const { sandboxMode, approvalPolicy } = mapPermissionModeToCodexOptions(permissionMode);
  const normalizedReasoningEffort = CODEX_REASONING_EFFORTS.has(String(modelReasoningEffort || ''))
    ? String(modelReasoningEffort)
    : undefined;
  const normalizedSpeed = CODEX_SPEED_TIERS.has(String(speed || '')) ? String(speed) : undefined;

  let appSession = sessionId ? appServerCodexSessions.get(sessionId) : null;
  if (!appSession) {
    appSession = new CodexAppServerSession(process.env.CODEX_PATH || 'codex');
  }

  let currentSessionId = sessionId;
  let runtimeThreadId = sessionId;
  let turnStarted = false;
  let turnKey = String(clientTs || Date.now());
  const requestTurnClientTs = Number(clientTs || turnKey);
  const deltaBuffers = new Map();
  const finalAssistantMessages = new Map();
  const usageEstimate = {
    // Do not present the typed prompt length as model input. App-server sends
    // the authoritative invocation usage once the model has consumed context.
    inputTokens: 0,
    outputTokens: 0,
    billingInputTokens: 0,
    billingCachedInputTokens: 0,
    billingOutputTokens: 0,
    startedAt: new Date().toISOString(),
    exact: false,
    outputTokensByItem: new Map(),
    threadUsageByThread: new Map(),
  };
  const requestViewSessionId = viewSessionId || sessionId || null;
  const sendForView = (data) => sendMessage(ws, {
    ...data,
    viewSessionId: requestViewSessionId,
    turnClientTs:
      Number(activeCodexSessions.get(currentSessionId)?.latestClientTs) || requestTurnClientTs,
  });

  try {
    let needsFreshRoot = false;
    if (sessionId) {
      const persistedAlias = codexRuntimeAliasesDb.get(sessionId);
      if (persistedAlias) {
        runtimeThreadId = persistedAlias;
      } else {
        const resolution = await resolveCodexRuntimeThreadId(sessionId);
        runtimeThreadId = resolution.threadId;
        needsFreshRoot = resolution.needsFreshRoot;
      }
    } else {
      runtimeThreadId = null;
    }
    const resolvedThreadId = await appSession.ensureThread({
      threadId: runtimeThreadId || null,
      cwd: workingDirectory,
      model,
      sandbox: sandboxMode,
      approvalPolicy,
      serviceTier: normalizedSpeed,
    });
    // Keep the logical id on all browser-facing events. It is the key used by
    // the sidebar/transcript, while the app-server resumes the physical id.
    currentSessionId = sessionId || resolvedThreadId;
    runtimeThreadId = resolvedThreadId;
    if (sessionId && needsFreshRoot) {
      codexRuntimeAliasesDb.set(sessionId, resolvedThreadId);
    }
    const runtimeInput = needsFreshRoot
      ? await buildRecoveryInput(currentSessionId, codexInput.input)
      : codexInput.input;
    codexTranscriptDb.record(
      currentSessionId,
      `user:${turnKey}`,
      'user',
      codexInput.text,
      usageEstimate.startedAt,
    );
    appServerCodexSessions.set(currentSessionId, appSession);
    appSession.lastUsedAt = Date.now();
    activeCodexSessions.set(currentSessionId, {
      appServer: appSession,
      status: 'running',
      statusText: 'Starting task',
      lastActivityAt: usageEstimate.startedAt,
      abortController: null,
      usageEstimate,
      logicalSessionId: currentSessionId,
      runtimeThreadId,
      viewSessionId: requestViewSessionId,
      startedAt: usageEstimate.startedAt,
      latestClientTs: requestTurnClientTs,
    });

    if (!sessionId) {
      sendForView({
        type: 'session-created',
        sessionId: currentSessionId,
        provider: 'codex',
        newSessionRequestId: newSessionRequestId || null,
      });
    }
    sendCodexStatus(ws, currentSessionId, { type: 'turn.started' }, usageEstimate, requestViewSessionId);

    // Mark the turn before sending the request. If the persistent process
    // drops after accepting it, never replay the user prompt through the
    // legacy SDK, which could charge the same turn twice.
    turnStarted = true;
    const completion = await appSession.runTurn({
      input: appServerInput(runtimeInput),
      cwd: workingDirectory,
      model,
      effort: normalizedReasoningEffort,
      serviceTier: normalizedSpeed,
      // The thread-level setting is inherited by subsequent turns.
      sandboxPolicy: undefined,
      approvalPolicy: undefined,
    }, async (message) => {
      const params = message.params || {};
      if (message.method === 'item/started' || message.method === 'item/updated' || message.method === 'item/completed') {
        const eventType = message.method.replace('/', '.');
        const item = normalizeItem(params.item);
        if (item?.type === 'agent_message' && item.text?.trim()) {
          finalAssistantMessages.set(params.item?.id || item.id || 'agent-message', item.text);
        }
        const event = { type: eventType, item, itemId: params.item?.id || item?.id };
        updateCodexUsageEstimate(usageEstimate, event);
        const activeSession = activeCodexSessions.get(currentSessionId);
        const statusText = getCodexStatusMessage(event);
        if (activeSession && statusText) {
          activeSession.statusText = statusText;
          activeSession.lastActivityAt = new Date().toISOString();
        }
        sendCodexStatus(ws, currentSessionId, event, usageEstimate, requestViewSessionId);
        sendForView({
          type: 'codex-response',
          data: transformCodexEvent(event),
          sessionId: currentSessionId,
        });
      } else if (message.method === 'item/agentMessage/delta') {
        const itemId = params.itemId || 'codex-agent-message';
        const nextText = `${deltaBuffers.get(itemId) || ''}${params.delta || ''}`;
        deltaBuffers.set(itemId, nextText);
        finalAssistantMessages.set(itemId, nextText);
        const event = { type: 'item.updated', itemId, item: { id: itemId, type: 'agent_message', text: nextText } };
        updateCodexUsageEstimate(usageEstimate, event);
        sendCodexStatus(ws, currentSessionId, event, usageEstimate, requestViewSessionId);
        sendForView({
          type: 'codex-response',
          data: {
            type: 'item',
            eventType: 'item.updated',
            itemId,
            itemType: 'agent_message',
            message: { role: 'assistant', content: nextText },
          },
          sessionId: currentSessionId,
        });
      } else if (message.method === 'turn/started') {
        const activeSession = activeCodexSessions.get(currentSessionId);
        if (activeSession) {
          activeSession.statusText = 'Starting task';
          activeSession.lastActivityAt = new Date().toISOString();
        }
        sendCodexStatus(ws, currentSessionId, { type: 'turn.started' }, usageEstimate, requestViewSessionId);
      } else if (message.method === 'thread/tokenUsage/updated') {
        const usage = params.tokenUsage?.last || {};
        const threadTotal = params.tokenUsage?.total || {};
        const usageThreadId = String(params.threadId || currentSessionId || 'root');
        const lastInputTokens = Number(usage.inputTokens || 0);
        const lastCachedInputTokens = Number(usage.cachedInputTokens || 0);
        const lastOutputTokens = Number(usage.outputTokens || 0);
        const totalInputTokens = Number(threadTotal.inputTokens || 0);
        const totalCachedInputTokens = Number(threadTotal.cachedInputTokens || 0);
        const totalOutputTokens = Number(threadTotal.outputTokens || 0);

        // `last` includes the history sent to one model invocation, while
        // `total` is cumulative for the thread. Subtract the pre-turn baseline
        // so the status bar and Daily usage both report this UI turn's actual
        // model input/output rather than only the directly typed prompt.
        const hasThreadTotals = totalInputTokens > 0 || totalOutputTokens > 0;
        const threadUsage = usageEstimate.threadUsageByThread.get(usageThreadId) || {
          baseline: null,
          lastTotal: null,
          billingInputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
        };
        const previousThreadTotal = threadUsage.lastTotal;
        const threadTotalsAreMonotonic = !previousThreadTotal || (
          totalInputTokens >= previousThreadTotal.inputTokens &&
          totalCachedInputTokens >= previousThreadTotal.cachedInputTokens &&
          totalOutputTokens >= previousThreadTotal.outputTokens
        );
        if (hasThreadTotals && threadTotalsAreMonotonic) {
          if (!threadUsage.baseline) {
            threadUsage.baseline = {
              billingInputTokens: Math.max(0, totalInputTokens - lastInputTokens),
              cachedInputTokens: Math.max(0, totalCachedInputTokens - lastCachedInputTokens),
              outputTokens: Math.max(0, totalOutputTokens - lastOutputTokens),
            };
          }
          const baseline = threadUsage.baseline;
          threadUsage.billingInputTokens = Math.max(
            threadUsage.billingInputTokens,
            totalInputTokens - baseline.billingInputTokens,
          );
          threadUsage.cachedInputTokens = Math.max(
            threadUsage.cachedInputTokens,
            totalCachedInputTokens - baseline.cachedInputTokens,
          );
          threadUsage.outputTokens = Math.max(
            threadUsage.outputTokens,
            totalOutputTokens - baseline.outputTokens,
          );
          threadUsage.lastTotal = {
            inputTokens: totalInputTokens,
            cachedInputTokens: totalCachedInputTokens,
            outputTokens: totalOutputTokens,
          };
        } else if (!hasThreadTotals) {
          // Compatibility fallback for app-server versions that omit `total`.
          threadUsage.billingInputTokens = Math.max(threadUsage.billingInputTokens, lastInputTokens);
          threadUsage.cachedInputTokens = Math.max(threadUsage.cachedInputTokens, lastCachedInputTokens);
          threadUsage.outputTokens = Math.max(threadUsage.outputTokens, lastOutputTokens);
        }
        // Some app-server builds briefly reset or replace `total` while a
        // sub-thread is attached. Never let that make a real invocation look
        // like the 20-token typed prompt: `last` is still authoritative for the
        // complete context consumed by this invocation.
        threadUsage.billingInputTokens = Math.max(threadUsage.billingInputTokens, lastInputTokens);
        threadUsage.cachedInputTokens = Math.max(threadUsage.cachedInputTokens, lastCachedInputTokens);
        threadUsage.outputTokens = Math.max(threadUsage.outputTokens, lastOutputTokens);
        usageEstimate.threadUsageByThread.set(usageThreadId, threadUsage);
        const aggregateThreadUsage = Array.from(usageEstimate.threadUsageByThread.values())
          .reduce((total, entry) => ({
            inputTokens: total.inputTokens + Number(entry.billingInputTokens || 0),
            cachedInputTokens: total.cachedInputTokens + Number(entry.cachedInputTokens || 0),
            outputTokens: total.outputTokens + Number(entry.outputTokens || 0),
          }), { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 });
        usageEstimate.billingInputTokens = Math.max(
          usageEstimate.billingInputTokens || 0,
          aggregateThreadUsage.inputTokens,
        );
        usageEstimate.billingCachedInputTokens = Math.max(
          usageEstimate.billingCachedInputTokens || 0,
          aggregateThreadUsage.cachedInputTokens,
        );
        usageEstimate.outputTokens = Math.max(
          usageEstimate.outputTokens || 0,
          aggregateThreadUsage.outputTokens,
        );
        usageEstimate.billingOutputTokens = Math.max(
          usageEstimate.billingOutputTokens || 0,
          aggregateThreadUsage.outputTokens,
        );
        usageEstimate.exact = true;

        const activeSession = activeCodexSessions.get(currentSessionId);
        sendMessage(ws, {
          type: 'claude-status',
          data: {
            status: activeSession?.statusText || 'Working',
            tokens: usageEstimate.billingInputTokens + usageEstimate.billingOutputTokens,
            inputTokens: usageEstimate.billingInputTokens,
            outputTokens: usageEstimate.billingOutputTokens,
            usageScope: 'turn-billing',
            billingInputTokens: usageEstimate.billingInputTokens,
            billingCachedInputTokens: usageEstimate.billingCachedInputTokens,
            billingOutputTokens: usageEstimate.billingOutputTokens,
            startedAt: usageEstimate.startedAt,
            can_interrupt: true,
          },
          sessionId: currentSessionId,
          viewSessionId: requestViewSessionId,
          provider: 'codex',
        });

        // Context occupancy is the latest invocation, not cumulative turn
        // usage. Keeping these values separate prevents the context gauge from
        // exceeding its model window during long, tool-heavy turns.
        if (usageThreadId === String(runtimeThreadId || currentSessionId)) {
          sendForView({
            type: 'token-budget',
            data: {
              used: Number(usage.totalTokens || lastInputTokens + lastOutputTokens),
              inputTokens: lastInputTokens,
              outputTokens: lastOutputTokens,
              cacheReadTokens: Number(usage.cachedInputTokens || 0),
              total: Number(params.tokenUsage?.modelContextWindow || CODEX_CONTEXT_WINDOW),
            },
            sessionId: currentSessionId,
          });
        }
      }
    });

    if (completion?.turn?.status === 'failed') {
      const error = completion.turn.error?.message || 'Codex turn failed';
      codexTranscriptDb.record(currentSessionId, `error:${turnKey}`, 'error', error);
      sendForView({ type: 'codex-error', error, sessionId: currentSessionId, newSessionRequestId: newSessionRequestId || null });
    } else {
      for (const [itemId, text] of finalAssistantMessages) {
        codexTranscriptDb.record(
          currentSessionId,
          `assistant:${turnKey}:${itemId}`,
          'assistant',
          text,
          new Date().toISOString(),
        );
      }
      sendForView({ type: 'codex-response', data: { type: 'turn_complete', usage: completion?.turn }, sessionId: currentSessionId });
      sendForView({ type: 'codex-complete', sessionId: currentSessionId, actualSessionId: runtimeThreadId });
    }
  } catch (error) {
    if (currentSessionId && activeCodexSessions.has(currentSessionId)) {
      activeCodexSessions.get(currentSessionId).status = 'completed';
    }
    error.appServerTurnStarted = turnStarted;
    if (currentSessionId) {
      codexTranscriptDb.record(
        currentSessionId,
        `error:${turnKey}`,
        'error',
        error.message || 'Codex app-server turn failed',
      );
    }
    throw error;
  } finally {
    if (codexInput.tempDir) await fs.rm(codexInput.tempDir, { recursive: true, force: true }).catch(() => {});
    if (currentSessionId && activeCodexSessions.has(currentSessionId)) {
      activeCodexSessions.get(currentSessionId).status = 'completed';
    }
    if (appSession) appSession.lastUsedAt = Date.now();
  }
}

export async function queryCodex(command, options = {}, ws) {
  try {
    return await queryCodexAppServer(command, options, ws);
  } catch (error) {
    if (error?.appServerTurnStarted) {
      console.error('[Codex app-server] Turn failed:', error);
      sendMessage(ws, {
        type: 'codex-error',
        error: error.message || 'Codex app-server turn failed',
        sessionId: options.sessionId || null,
        newSessionRequestId: options.newSessionRequestId || null,
        viewSessionId: options.viewSessionId || options.sessionId || null,
        turnClientTs: Number(options.clientTs || 0) || undefined,
      });
      return;
    }
    // The legacy SDK resolves persisted threads independently and can select a
    // stale rollout after Codex compaction. Never use it to resume an existing
    // browser session; surface the app-server error instead of changing thread.
    if (options.sessionId) {
      console.error('[Codex app-server] Resume failed:', error);
      sendMessage(ws, {
        type: 'codex-error',
        error: error.message || 'Codex app-server could not resume this session',
        sessionId: options.sessionId,
        newSessionRequestId: options.newSessionRequestId || null,
        viewSessionId: options.viewSessionId || options.sessionId || null,
        turnClientTs: Number(options.clientTs || 0) || undefined,
      });
      return;
    }
    console.warn('[Codex app-server] Falling back to legacy SDK for a new session:', error.message);
    return queryCodexLegacy(command, options, ws);
  }
}

function resolveActiveCodexSession(sessionId) {
  if (!sessionId) return null;
  const requestedId = String(sessionId);
  const requestedRuntimeId = codexRuntimeAliasesDb.get(requestedId) || requestedId;
  const direct = activeCodexSessions.get(requestedId)
    || activeCodexSessions.get(requestedRuntimeId);
  if (direct) {
    const entryId = activeCodexSessions.has(requestedId) ? requestedId : requestedRuntimeId;
    if (isCodexSessionHealthy(direct)) return { entryId, session: direct };
    clearStaleCodexSession(entryId, direct, requestedId, requestedRuntimeId);
  }

  for (const [entryId, candidate] of activeCodexSessions.entries()) {
    const entryRuntimeId = candidate.runtimeThreadId
      || candidate.appServer?.threadId
      || candidate.thread?.id
      || codexRuntimeAliasesDb.get(entryId)
      || entryId;
    if (
      entryId === requestedId
      || candidate.logicalSessionId === requestedId
      || entryRuntimeId === requestedId
      || entryRuntimeId === requestedRuntimeId
    ) {
      if (isCodexSessionHealthy(candidate)) return { entryId, session: candidate };
      clearStaleCodexSession(entryId, candidate, requestedId, requestedRuntimeId);
    }
  }
  return null;
}

function isCodexSessionHealthy(session) {
  if (!session || session.status !== 'running') return false;
  // app-server is intentionally long-lived and can remain healthy after its turn
  // completes. Native sessions need both a live process and an active turn.
  return !session.appServer
    || (session.appServer.isAlive() && session.appServer.hasActiveTurn());
}

function clearStaleCodexSession(entryId, session, ...aliases) {
  if (!session || session.status !== 'running') return;
  session.status = 'completed';
  const ids = new Set([
    entryId,
    session.logicalSessionId,
    session.runtimeThreadId,
    ...aliases,
  ].filter(Boolean).map(String));
  for (const id of ids) {
    if (activeCodexSessions.get(id) === session) activeCodexSessions.delete(id);
    if (appServerCodexSessions.get(id) === session.appServer) appServerCodexSessions.delete(id);
    // A dead turn can leave an unresolved promise in the per-session chain.
    // Detach it so the next user command can start a fresh app-server turn.
    codexCommandChains.delete(id);
  }
  if (session.appServer && !session.appServer.hasActiveTurn()) {
    session.appServer.close();
  }
  console.warn(`[Codex] Cleared stale active session ${entryId}: app-server is not writable`);
}

export async function steerCodexSession(sessionId, message, clientTs = Date.now()) {
  const resolved = resolveActiveCodexSession(sessionId);
  const session = resolved?.session;
  if (!session || session.status !== 'running' || !session.appServer) return false;

  try {
    const steerText = String(message || '');
    await session.appServer.steer(
      appServerInput(steerText),
      `ccui-${clientTs}`,
    );
    session.latestClientTs = Math.max(Number(session.latestClientTs || 0), Number(clientTs || 0));
    const addedInputTokens = estimateTokenCount(steerText);
    if (session.usageEstimate && addedInputTokens > 0) {
      session.usageEstimate.inputTokens = Number(session.usageEstimate.inputTokens || 0) + addedInputTokens;
      session.usageEstimate.billingInputTokens = Math.max(
        Number(session.usageEstimate.billingInputTokens || 0),
        session.usageEstimate.inputTokens,
      );
    }
    codexTranscriptDb.record(
      session.logicalSessionId || resolved.entryId || sessionId,
      `user:steer:${clientTs}`,
      'user',
      steerText,
      new Date(clientTs).toISOString(),
    );
    return true;
  } catch (error) {
    console.warn(`[Codex] Could not steer active session ${sessionId}:`, error?.message || error);
    return false;
  }
}

const CODEX_GOAL_STATUSES = new Set([
  'active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete',
]);

async function withCodexGoalSession(sessionId, operation) {
  const runtimeThreadId = codexRuntimeAliasesDb.get(sessionId) || sessionId;
  let appSession = appServerCodexSessions.get(sessionId)
    || appServerCodexSessions.get(runtimeThreadId);
  const temporary = !appSession;
  if (!appSession) {
    appSession = new CodexAppServerSession(process.env.CODEX_PATH || 'codex');
    await appSession.start();
  }
  try {
    return await operation(appSession, runtimeThreadId);
  } finally {
    if (temporary) appSession.close();
  }
}

export async function updateCodexGoal(sessionId, updates = {}) {
  const status = updates.status == null ? null : String(updates.status);
  if (status && !CODEX_GOAL_STATUSES.has(status)) {
    throw new Error('Invalid Codex goal status');
  }
  return withCodexGoalSession(sessionId, (appSession, threadId) =>
    appSession.request('thread/goal/set', {
      threadId,
      status,
      objective: updates.objective == null ? null : String(updates.objective),
      tokenBudget: updates.tokenBudget == null ? null : Number(updates.tokenBudget),
    })
  );
}

export async function clearCodexGoal(sessionId) {
  return withCodexGoalSession(sessionId, (appSession, threadId) =>
    appSession.request('thread/goal/clear', { threadId })
  );
}

// Never start two turns concurrently on the same app-server session. A
// running, steerable turn receives the new input immediately; otherwise the
// command is serialized behind the existing turn.
export async function submitCodexMessage(command, options = {}, ws) {
  const sessionId = options.sessionId || null;
  if (sessionId && isCodexSessionActive(sessionId)) {
    const steered = await steerCodexSession(sessionId, command, options.clientTs);
    if (steered) return { steered: true };
  }

  const chainKey = sessionId || options.newSessionRequestId || `new:${options.clientTs || Date.now()}`;
  const previous = codexCommandChains.get(chainKey) || Promise.resolve();
  const task = previous
    .catch(() => {})
    .then(async () => {
      if (sessionId && isCodexSessionActive(sessionId)) {
        const steered = await steerCodexSession(sessionId, command, options.clientTs);
        if (steered) return { steered: true };
      }
      await queryCodex(command, options, ws);
      return { steered: false };
    });

  codexCommandChains.set(chainKey, task);
  try {
    return await task;
  } finally {
    if (codexCommandChains.get(chainKey) === task) codexCommandChains.delete(chainKey);
  }
}

/**
 * Abort an active Codex session
 * @param {string} sessionId - Session ID to abort
 * @returns {boolean} - Whether abort was successful
 */
export function abortCodexSession(sessionId) {
  const session = resolveActiveCodexSession(sessionId)?.session;

  if (!session) {
    return false;
  }

  session.status = 'aborted';
  try {
    session.abortController?.abort();
    session.appServer?.interrupt();
  } catch (error) {
    console.warn(`[Codex] Failed to abort session ${sessionId}:`, error);
  }

  return true;
}

/**
 * Check if a session is active
 * @param {string} sessionId - Session ID to check
 * @returns {boolean} - Whether session is active
 */
export function isCodexSessionActive(sessionId) {
  const session = resolveActiveCodexSession(sessionId)?.session;
  return session?.status === 'running';
}

/**
 * Get all active sessions
 * @returns {Array} - Array of active session info
 */
export function getActiveCodexSessions() {
  const sessions = [];
  const seenSessions = new Set();

  for (const [id, session] of activeCodexSessions.entries()) {
    if (!isCodexSessionHealthy(session)) {
      clearStaleCodexSession(id, session);
      continue;
    }
    if (!seenSessions.has(session)) {
      seenSessions.add(session);
      sessions.push({
        id,
        logicalSessionId: session.logicalSessionId || id,
        runtimeThreadId: session.runtimeThreadId || id,
        viewSessionId: session.viewSessionId || session.logicalSessionId || id,
        status: session.status,
        startedAt: session.startedAt,
        statusText: session.statusText || 'Working in background',
        lastActivityAt: session.lastActivityAt || session.startedAt,
        inputTokens: Number(session.usageEstimate?.billingInputTokens || session.usageEstimate?.inputTokens || 0),
        outputTokens: Number(session.usageEstimate?.billingOutputTokens || session.usageEstimate?.outputTokens || 0),
        turnClientTs: Number(session.latestClientTs || 0) || undefined,
      });
    }
  }

  return sessions;
}

export function getCodexSessionInfo(sessionId) {
  const resolved = resolveActiveCodexSession(sessionId);
  const session = resolved?.session;
  if (session?.status !== 'running') return null;
  return {
    id: sessionId,
    status: session.status,
    startedAt: session.startedAt,
    statusText: session.statusText || 'Working in background',
    lastActivityAt: session.lastActivityAt || session.startedAt,
    inputTokens: Number(session.usageEstimate?.billingInputTokens || session.usageEstimate?.inputTokens || 0),
    outputTokens: Number(session.usageEstimate?.billingOutputTokens || session.usageEstimate?.outputTokens || 0),
    turnClientTs: Number(session.latestClientTs || 0) || undefined,
  };
}

/**
 * Helper to send message via WebSocket or writer
 * @param {WebSocket|object} ws - WebSocket or response writer
 * @param {object} data - Data to send
 */
function sendMessage(ws, data) {
  try {
    if (ws.isSSEStreamWriter || ws.isWebSocketWriter) {
      // Writer handles stringification (SSEStreamWriter or WebSocketWriter)
      ws.send(data);
    } else if (typeof ws.send === 'function') {
      // Raw WebSocket - stringify here
      ws.send(JSON.stringify(data));
    }
  } catch (error) {
    console.error('[Codex] Error sending message:', error);
  }
}

function evictIdleAppServer(appSession) {
  if (!appSession || appSession.hasActiveTurn()) return false;
  for (const [id, candidate] of appServerCodexSessions.entries()) {
    if (candidate === appSession) appServerCodexSessions.delete(id);
  }
  appSession.close();
  return true;
}

// Clean up old completed sessions and bound the warm app-server pool.
setInterval(() => {
  const now = Date.now();
  const maxAge = 30 * 60 * 1000; // 30 minutes

  for (const [id, session] of activeCodexSessions.entries()) {
    if (session.status !== 'running') {
      const startedAt = new Date(session.startedAt).getTime();
      if (now - startedAt > maxAge) {
        activeCodexSessions.delete(id);
      }
    }
  }

  const uniqueIdle = Array.from(new Set(appServerCodexSessions.values()))
    .filter((session) => !session.hasActiveTurn())
    .sort((a, b) => Number(a.lastUsedAt || 0) - Number(b.lastUsedAt || 0));
  for (const appSession of uniqueIdle) {
    const expired = now - Number(appSession.lastUsedAt || 0) > CODEX_APP_SERVER_IDLE_MS;
    const overLimit = new Set(appServerCodexSessions.values()).size > CODEX_APP_SERVER_POOL_MAX;
    if (expired || overLimit) evictIdleAppServer(appSession);
  }
}, 60 * 1000).unref();
