/**
 * Claude SDK Integration
 *
 * This module provides SDK-based integration with Claude using the @anthropic-ai/claude-agent-sdk.
 * It mirrors the interface of claude-cli.js but uses the SDK internally for better performance
 * and maintainability.
 *
 * Key features:
 * - Direct SDK integration without child processes
 * - Session management with abort capability
 * - Options mapping between CLI and SDK formats
 * - WebSocket message streaming
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import crypto from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { CLAUDE_MODELS } from '../shared/modelConstants.js';

const activeSessions = new Map();
const pendingToolApprovals = new Map();

const TOOL_APPROVAL_TIMEOUT_MS = parseInt(process.env.CLAUDE_TOOL_APPROVAL_TIMEOUT_MS, 10) || 55000;
const CLAUDE_RATE_LIMIT_COOLDOWN_MS = parseInt(process.env.CLAUDE_RATE_LIMIT_COOLDOWN_MS, 10) || 5 * 60 * 1000;
const CLAUDE_USAGE_LIMIT_COOLDOWN_MS = parseInt(process.env.CLAUDE_USAGE_LIMIT_COOLDOWN_MS, 10) || 30 * 60 * 1000;

const TOOLS_REQUIRING_INTERACTION = new Set(['AskUserQuestion']);
let claudeThrottleCooldownUntil = 0;
let claudeThrottleCooldownReason = '';

function isClaudeThrottleError(error) {
  const message = String(error?.message || error || '');
  return /rate limited|temporarily limiting requests|you've hit your limit|usage limit|hit your limit/i.test(message);
}

function setClaudeThrottleCooldown(error) {
  const message = String(error?.message || error || '');
  const isUsageLimit = /you've hit your limit|usage limit|hit your limit/i.test(message);
  const cooldownMs = isUsageLimit ? CLAUDE_USAGE_LIMIT_COOLDOWN_MS : CLAUDE_RATE_LIMIT_COOLDOWN_MS;
  claudeThrottleCooldownUntil = Math.max(claudeThrottleCooldownUntil, Date.now() + cooldownMs);
  claudeThrottleCooldownReason = message;
  console.warn(`[THROTTLE] Claude requests paused for ${Math.ceil(cooldownMs / 1000)}s after: ${message}`);
}

function getClaudeThrottleCooldown() {
  const remainingMs = claudeThrottleCooldownUntil - Date.now();
  if (remainingMs <= 0) {
    claudeThrottleCooldownUntil = 0;
    claudeThrottleCooldownReason = '';
    return null;
  }
  return {
    remainingMs,
    reason: claudeThrottleCooldownReason || 'Claude is temporarily throttled',
  };
}

function createRequestId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString('hex');
}

function waitForToolApproval(requestId, options = {}) {
  const { timeoutMs = TOOL_APPROVAL_TIMEOUT_MS, signal, onCancel, metadata } = options;

  return new Promise(resolve => {
    let settled = false;

    const finalize = (decision) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(decision);
    };

    let timeout;

    const cleanup = () => {
      pendingToolApprovals.delete(requestId);
      if (timeout) clearTimeout(timeout);
      if (signal && abortHandler) {
        signal.removeEventListener('abort', abortHandler);
      }
    };

    // timeoutMs 0 = wait indefinitely (interactive tools)
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        onCancel?.('timeout');
        finalize(null);
      }, timeoutMs);
    }

    const abortHandler = () => {
      onCancel?.('cancelled');
      finalize({ cancelled: true });
    };

    if (signal) {
      if (signal.aborted) {
        onCancel?.('cancelled');
        finalize({ cancelled: true });
        return;
      }
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    const resolver = (decision) => {
      finalize(decision);
    };
    // Attach metadata for getPendingApprovalsForSession lookup
    if (metadata) {
      Object.assign(resolver, metadata);
    }
    pendingToolApprovals.set(requestId, resolver);
  });
}

function resolveToolApproval(requestId, decision) {
  const resolver = pendingToolApprovals.get(requestId);
  if (resolver) {
    resolver(decision);
  }
}

// Match stored permission entries against a tool + input combo.
// This only supports exact tool names and the Bash(command:*) shorthand
// used by the UI; it intentionally does not implement full glob semantics,
// introduced to stay consistent with the UI's "Allow rule" format.
function matchesToolPermission(entry, toolName, input) {
  if (!entry || !toolName) {
    return false;
  }

  if (entry === toolName) {
    return true;
  }

  const bashMatch = entry.match(/^Bash\((.+):\*\)$/);
  if (toolName === 'Bash' && bashMatch) {
    const allowedPrefix = bashMatch[1];
    let command = '';

    if (typeof input === 'string') {
      command = input.trim();
    } else if (input && typeof input === 'object' && typeof input.command === 'string') {
      command = input.command.trim();
    }

    if (!command) {
      return false;
    }

    return command.startsWith(allowedPrefix);
  }

  return false;
}

/**
 * Maps CLI options to SDK-compatible options format
 * @param {Object} options - CLI options
 * @returns {Object} SDK-compatible options
 */
function mapCliOptionsToSDK(options = {}) {
  const { sessionId, cwd, toolsSettings, permissionMode, images } = options;

  const sdkOptions = {};

  // Map working directory
  if (cwd) {
    sdkOptions.cwd = cwd;
  }

  // Map permission mode
  if (permissionMode && permissionMode !== 'default') {
    sdkOptions.permissionMode = permissionMode;
  }

  // Map tool settings
  const settings = toolsSettings || {
    allowedTools: [],
    disallowedTools: [],
    skipPermissions: false
  };

  // Handle tool permissions
  if (settings.skipPermissions && permissionMode !== 'plan') {
    // When skipping permissions, use bypassPermissions mode
    sdkOptions.permissionMode = 'bypassPermissions';
  }

  let allowedTools = [...(settings.allowedTools || [])];

  // Add plan mode default tools
  if (permissionMode === 'plan') {
    const planModeTools = ['Read', 'Task', 'exit_plan_mode', 'TodoRead', 'TodoWrite', 'WebFetch', 'WebSearch'];
    for (const tool of planModeTools) {
      if (!allowedTools.includes(tool)) {
        allowedTools.push(tool);
      }
    }
  }

  sdkOptions.allowedTools = allowedTools;

  // Use the tools preset to make all default built-in tools available (including AskUserQuestion).
  // This was introduced in SDK 0.1.57. Omitting this preserves existing behavior (all tools available),
  // but being explicit ensures forward compatibility and clarity.
  sdkOptions.tools = { type: 'preset', preset: 'claude_code' };

  sdkOptions.disallowedTools = settings.disallowedTools || [];

  // Map model (default to sonnet)
  // Valid models include Claude Code aliases and full Claude model IDs from CLAUDE_MODELS.
  sdkOptions.model = options.model || CLAUDE_MODELS.DEFAULT;
  console.log(`Using model: ${sdkOptions.model}`);

  // 思考强度（effort）：原生 Agent SDK 选项，由前端按模型可用档位下发（low/medium/high/xhigh/max）
  // 仅在显式提供时设置，缺省由 SDK 默认（high）
  const VALID_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
  if (options.effort && VALID_EFFORTS.has(options.effort)) {
    sdkOptions.effort = options.effort;
    console.log(`Using effort: ${sdkOptions.effort}`);
  }

  // 开启 token 级部分流式消息：SDK 在生成过程中实时 emit content_block_delta，
  // 让聊天界面逐字渲染（原生 shell 终端般的流畅性），而非整段文本一次性出现。
  sdkOptions.includePartialMessages = true;

  // Map system prompt configuration
  sdkOptions.systemPrompt = {
    type: 'preset',
    preset: 'claude_code'  // Required to use CLAUDE.md
  };

  // Map setting sources for CLAUDE.md loading
  // This loads CLAUDE.md from project, user (~/.config/claude/CLAUDE.md), and local directories
  sdkOptions.settingSources = ['project', 'user', 'local'];

  // Map resume session
  if (sessionId) {
    sdkOptions.resume = sessionId;
  }

  // 移除 Claude Code 相关环境变量，防止 SDK 子进程检测到嵌套 Claude Code 会话而报错
  // ("Claude Code cannot be launched inside another Claude Code session")
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;

  // 自定义 Provider 支持：通过 ANTHROPIC_BASE_URL 将请求转发到兼容 Anthropic API 的代理（如 LiteLLM）
  if (options.customBaseURL) {
    env.ANTHROPIC_BASE_URL = options.customBaseURL;
  }
  if (options.customApiKey) {
    env.ANTHROPIC_API_KEY = options.customApiKey;
  }

  sdkOptions.env = env;

  return sdkOptions;
}

/**
 * Adds a session to the active sessions map
 * @param {string} sessionId - Session identifier
 * @param {Object} queryInstance - SDK query instance
 * @param {Array<string>} tempImagePaths - Temp image file paths for cleanup
 * @param {string} tempDir - Temp directory for cleanup
 */
function addSession(sessionId, queryInstance, tempImagePaths = [], tempDir = null, writer = null, turnClientTs = 0) {
  activeSessions.set(sessionId, {
    instance: queryInstance,
    startTime: Date.now(),
    lastActivityAt: Date.now(),
    status: 'active',
    tempImagePaths,
    tempDir,
    writer,
    turnClientTs: Number(turnClientTs || 0) || undefined,
  });
}

function touchSession(sessionId) {
  const session = activeSessions.get(sessionId);
  if (session) session.lastActivityAt = Date.now();
}

/**
 * Removes a session from the active sessions map
 * @param {string} sessionId - Session identifier
 */
function removeSession(sessionId) {
  activeSessions.delete(sessionId);
}

/**
 * 将 session 标记为已完成：立即让 isActive 返回 false（避免刷新后"Reconnecting"误报），
 * 同时保留 writer 5 秒，让重连时可以重放终态消息（claude-complete / claude-error）。
 * 5 秒后彻底删除 session。
 */
function markSessionCompleted(sessionId) {
  const session = activeSessions.get(sessionId);
  if (!session) return;
  session.status = 'completed';
  // 该轮彻底结束：清理整条压缩别名链，恢复到与压缩前一致的行为（旧 id 不再重定向到已完成会话）。
  pruneCompactAliases(sessionId);
  setTimeout(() => {
    // 仅当仍处于 completed 才删除：若这 5s 内已有 fresh turn 重用同 id 变回 active，
    // 不能误删新会话实体（否则新 turn 的 isActive/重连/drain 全部失效）。
    const s = activeSessions.get(sessionId);
    if (s && s.status === 'completed') {
      activeSessions.delete(sessionId);
    }
    // 兜底：会话实体释放后，若仍有在 completed 窗口内入队的孤儿消息，立即起 fresh turn 自愈。
    kickPendingQueue(sessionId);
  }, 5000);
}

// ──────────────────────────────────────────────────────────────
// 会话级串行队列（根本修复「向忙碌会话发消息 → 消息石沉大海」）
//
// 根因：queryClaudeSDK 对已活跃的会话无护栏，会新开并发 query 并用 addSession
// 覆盖原 queryInstance，导致同一 sessionId 上两个 query 并发读写同一份 JSONL，
// 行为未定义、新消息丢失。
//
// 修复不变量：单会话同一时刻只有一个活跃 turn。忙碌时新消息入队，
// 当前 turn 的 for-await 循环结束后，在「同一同步块内」原子地取出下一条串行处理
// （dequeue 与 markSessionCompleted 之间无 await，事件循环无法插入新的入队，故无竞态）。
// ──────────────────────────────────────────────────────────────
const pendingMessages = new Map(); // sessionId -> Array<{command, options, writer}>

function enqueuePendingMessage(sessionId, command, options, writer) {
  if (!sessionId) return 0;
  const q = pendingMessages.get(sessionId) || [];
  q.push({ command, options, writer });
  pendingMessages.set(sessionId, q);
  return q.length;
}

function clearPendingMessages(sessionId) {
  if (!sessionId) return 0;
  const count = (pendingMessages.get(sessionId) || []).length;
  pendingMessages.delete(sessionId);
  return count;
}

function clearAllPendingMessages() {
  let count = 0;
  for (const q of pendingMessages.values()) {
    count += q.length;
  }
  pendingMessages.clear();
  return count;
}

// 取出队首待处理消息；队列清空后删除 key。无则返回 null。
function dequeuePendingMessage(sessionId) {
  if (!sessionId) return null;
  const q = pendingMessages.get(sessionId);
  if (!q || q.length === 0) return null;
  const next = q.shift();
  if (q.length === 0) pendingMessages.delete(sessionId);
  return next;
}

// ──────────────────────────────────────────────────────────────
// 压缩会话别名（根本修复「压缩后双跑」）
//
// 根因：Claude 原生压缩会在流中途把 session_id 从 X 改成 Y，后端把活跃条目迁移到 Y
// 并删除 X。但前端为视图稳定性始终保留 currentSessionId=X（仅建别名做归属），下一条
// 提交仍带 X。此时 isClaudeSDKSessionActive(X)=false（X 已删），串行队列护栏失效 →
// 后端为 X 新开一个并发 query，而 Y 这一轮还在流式 → 同一对话两轮并发，且前端只认 X，
// 无法 abort 正在跑的 Y。
//
// 修复：维护 oldId→newId 别名表。提交/中止/状态查询时把旧 id 解析到当前活跃 id，
// 使旧 id 提交被正确「排队」到 Y 而非并发开新 query；旧 id 的 abort 也能命中 Y。
// 别名在该轮彻底结束（markSessionCompleted）时按链清理，恢复到与压缩前一致的行为。
// ──────────────────────────────────────────────────────────────
const compactSessionAliases = new Map(); // oldSessionId -> newSessionId

function registerCompactAlias(oldId, newId) {
  if (!oldId || !newId || oldId === newId) return;
  compactSessionAliases.set(oldId, newId);
}

// 沿别名链解析到最终（当前）会话 id；带环保护。
function resolveActiveSessionId(sessionId) {
  let cur = sessionId;
  const seen = new Set();
  while (cur && compactSessionAliases.has(cur) && !seen.has(cur)) {
    seen.add(cur);
    cur = compactSessionAliases.get(cur);
  }
  return cur;
}

// 该轮结束时清理所有解析到 finalId 的别名条目（含整条压缩链），避免陈旧重定向与无限增长。
function pruneCompactAliases(finalId) {
  if (!finalId) return;
  for (const key of [...compactSessionAliases.keys()]) {
    if (key === finalId || resolveActiveSessionId(key) === finalId) {
      compactSessionAliases.delete(key);
    }
  }
}

// 「正在启动」预占集合：sid 已进入 queryClaudeSDK 但尚未走到 addSession（中间隔着
// loadMcpConfig / handleImages 等 await）。这段空档里 isClaudeSDKSessionActive 仍为 false，
// 若不预占，turn 间到达的第二条消息（用户输入 / 后台任务通知）会再开一个 query，
// 与第一个 query 从同一条 assistant 叶子并行续写 → JSONL 分叉成两条互不可见的对话链
// （表现为「一个窗口里两个会话，其中一个完全不记得刚说过的话」）。
// Map<sid, addedAtMs>：用时间戳记录预占时刻，供队列清道夫（sweeper）老化泄漏的预占项。
// 若 queryClaudeSDK 在 addSession 之前就卡死（loadMcpConfig/handleImages 等 await 挂起），
// submitClaudeMessage 的 finally 永不执行 → 预占泄漏 → 后续消息被永久误判为「启动中」而入队孤儿。
const startingSessions = new Map();

// 统一入口：会话忙碌或正在启动 → 入队（由当前活跃 turn 收尾时 drain）；空闲 → 直接开新 query。
async function submitClaudeMessage(command, options = {}, writer) {
  const rawSid = options?.sessionId;
  // 压缩后旧 id 解析到当前活跃 id，确保护栏与排队作用在真正在跑的会话上。
  const sid = resolveActiveSessionId(rawSid);
  const cooldown = getClaudeThrottleCooldown();
  if (cooldown) {
    const remainingSeconds = Math.ceil(cooldown.remainingMs / 1000);
    const message = `Claude requests are paused for ${remainingSeconds}s after a rate/usage limit error: ${cooldown.reason}`;
    console.warn(`[THROTTLE] Rejecting Claude submit during global cooldown (${remainingSeconds}s left)`);
    try {
      writer.send({
        type: 'claude-error',
        error: message,
        sessionId: sid || rawSid || null
      });
    } catch { /* ignore */ }
    return;
  }
  if (sid && (isClaudeSDKSessionActive(sid) || startingSessions.has(sid))) {
    // 用解析后的活跃 id 入队，并改写 options.sessionId，保证 drain 时 resume 的是当前会话
    // （而非已被压缩取代的旧 id），否则会续到压缩前的历史分叉。
    const queuedOptions = sid !== rawSid ? { ...options, sessionId: sid } : options;
    const depth = enqueuePendingMessage(sid, command, queuedOptions, writer);
    console.log(`[QUEUE] Session ${sid} 忙碌/启动中，消息入队（队深=${depth}${sid !== rawSid ? `，原始 id=${rawSid} 经压缩别名解析` : ''}）`);
    // 通知前端「已排队」（前端可据此提示；不发 claude-complete，保持 loading 不灭）
    try { writer.send({ type: 'message-queued', sessionId: sid, depth }); } catch { /* ignore */ }
    return;
  }
  // 同步预占：必须在 queryClaudeSDK 的任何 await 之前登记，才能堵住启动空档的并发分叉。
  // resume（已知 sid）才需要预占；全新会话 sid 为空，其重复提交由前端 new-session 守卫拦截。
  if (sid) startingSessions.set(sid, Date.now());
  try {
    return await queryClaudeSDK(command, options, writer);
  } finally {
    if (sid) {
      startingSessions.delete(sid);
      // 兜底自愈：本轮链已彻底结束。若此刻队列仍有残留（在结束窗口内被入队、
      // 而当前 turn 已过 drain 点的孤儿），不会再有 turn 来 drain → 主动起一条 fresh turn。
      kickPendingQueue(sid);
    }
  }
}

// 队列自愈：当某会话已无任何「正在运行的 turn」却仍有排队消息时，取队首起一条 fresh turn。
// 关键安全约束：只在「确无活跃/启动中 turn」时才起新 turn，绝不与正在跑的 turn 并发（避免 JSONL 分叉）；
// 因此正在等待权限确认或执行长工具的 active 会话不会被打扰，其 type-ahead 消息会照常等当前 turn 收尾 drain。
function kickPendingQueue(sessionId) {
  if (!sessionId) return;
  const cooldown = getClaudeThrottleCooldown();
  if (cooldown) {
    const dropped = clearPendingMessages(sessionId);
    if (dropped) {
      console.warn(`[THROTTLE] Dropped ${dropped} queued Claude message(s) for ${sessionId} during global cooldown`);
    }
    return;
  }
  const q = pendingMessages.get(sessionId);
  if (!q || q.length === 0) return;
  // 仍有 turn 在跑（active 或启动中）→ 交给它收尾时 drain，勿并发。
  if (isClaudeSDKSessionActive(sessionId) || startingSessions.has(sessionId)) return;
  const next = dequeuePendingMessage(sessionId);
  if (!next) return;
  const remaining = (pendingMessages.get(sessionId) || []).length;
  console.log(`[QUEUE-HEAL] Session ${sessionId} 无活跃 turn 但有积压，起 fresh turn 自愈（剩余=${remaining}）`);
  startingSessions.set(sessionId, Date.now());
  Promise.resolve()
    .then(() => queryClaudeSDK(next.command, next.options, next.writer))
    .catch((e) => console.error(`[QUEUE-HEAL] fresh turn error for ${sessionId}:`, e?.message || e))
    .finally(() => {
      startingSessions.delete(sessionId);
      // 链式：本条处理完（queryClaudeSDK 内部已 drain 其余）后若仍有残留，继续自愈。
      kickPendingQueue(sessionId);
    });
}

// 队列清道夫（sweeper）：周期性兜底回收「无 turn 在跑却仍有积压」的会话。
// 覆盖两类泄漏：①预占泄漏（startingSessions 有项但 queryClaudeSDK 在 addSession 前就卡死/抛错，
// finally 永不执行）；②纯孤儿（会话实体已删、预占也无，但队列里仍有消息）。
// 安全约束：绝不触碰 status==='active' 的会话（可能在等权限确认或执行长工具），只回收确无活跃 turn 的。
const QUEUE_SWEEP_INTERVAL_MS = 20000;
const STARTING_LEAK_MAX_MS = 60000; // 预占超 60s 仍无活跃会话实体 → 判定泄漏，强制清除并自愈
function sweepPendingQueues() {
  // ── 第一遍：主动回收泄漏的预占（即使尚无积压）。
  // 根因：queryClaudeSDK 在 addSession 之前的 await（loadMcpConfig/handleImages 等）若挂死，
  // submitClaudeMessage 的 finally 永不执行 → startingSessions 残留。原 sweeper 只遍历有积压的
  // 会话，泄漏在"用户下一条消息入队"之前是隐形的；那条消息一来就被误判为"启动中"塞进队列、
  // 直到下一轮 sweep 才被救——表现为"消息发出去了但没人回"。这里主动清掉超时预占，使泄漏窗口
  // 之后到来的消息能直接走 fresh query，而非掉进队列黑洞。
  // 安全性：resume 的预占窗口仅 loadMcpConfig+handleImages 两个 await（毫秒~数秒级），
  // 真·活跃会话会被 isClaudeSDKSessionActive 命中而跳过；超 60s 仍非 active 的预占必为挂死，
  // 清除不会与正常启动竞争（与原有 60s 判定一致）。
  for (const sid of [...startingSessions.keys()]) {
    if (isClaudeSDKSessionActive(sid)) continue; // 已 addSession 变 active：预占冗余，留给 finally 清
    const since = startingSessions.get(sid) || 0;
    if (Date.now() - since < STARTING_LEAK_MAX_MS) continue;
    const backlog = (pendingMessages.get(sid) || []).length;
    console.warn(`[QUEUE-SWEEP] Session ${sid} 预占泄漏 ${Math.round((Date.now() - since) / 1000)}s 仍无活跃 turn，主动清除${backlog ? `并自愈（积压=${backlog}）` : '（无积压）'}`);
    startingSessions.delete(sid);
    if (backlog) kickPendingQueue(sid);
  }

  // ── 第二遍：回收"无 turn 在跑却仍有积压"的纯孤儿（会话实体已删、预占也无，但队列残留）。
  for (const sid of [...pendingMessages.keys()]) {
    const q = pendingMessages.get(sid);
    if (!q || q.length === 0) continue;
    const session = getSession(sid);
    // 有 active turn 在跑（含等待权限/长工具）→ 不打扰，等其收尾时 drain。
    if (session && session.status === 'active') continue;
    // 预占仍在合理启动窗口内 → 再等等，避免误判正常的启动延迟（超时的已在第一遍清除）。
    if (startingSessions.has(sid)) continue;
    // 至此：无 active 会话且无预占 → 确无 turn 在跑，安全回收。
    kickPendingQueue(sid);
  }
}
const pendingQueueSweeper = setInterval(sweepPendingQueues, QUEUE_SWEEP_INTERVAL_MS);
if (pendingQueueSweeper.unref) pendingQueueSweeper.unref();

/**
 * Gets a session from the active sessions map
 * @param {string} sessionId - Session identifier
 * @returns {Object|undefined} Session data or undefined
 */
function getSession(sessionId) {
  return activeSessions.get(sessionId);
}

/**
 * Gets all active session IDs
 * @returns {Array<string>} Array of active session IDs
 */
function getAllSessions() {
  return Array.from(activeSessions.keys());
}

function getSessionInfo(sessionId) {
  // 压缩后旧 id 解析到当前活跃 id，使 session-status 在压缩期间仍能返回正确的运行信息。
  sessionId = resolveActiveSessionId(sessionId);
  const session = getSession(sessionId);
  if (!session || session.status !== 'active') return null;
  return {
    id: sessionId,
    status: session.status,
    startedAt: new Date(session.startTime).toISOString(),
    lastActivityAt: new Date(session.lastActivityAt || session.startTime).toISOString(),
    turnClientTs: Number(session.turnClientTs || 0) || undefined,
  };
}

/**
 * Transforms SDK messages to WebSocket format expected by frontend
 * @param {Object} sdkMessage - SDK message object
 * @returns {Object} Transformed message ready for WebSocket
 */
function transformMessage(sdkMessage) {
  // 部分流式消息（开启 includePartialMessages 后产生）：解包为前端已支持的
  // content_block_delta / content_block_stop 形状，实现 token 级实时流式渲染
  // （像原生 shell 终端一样逐字吐出，而非整段一次性出现）。
  if (sdkMessage.type === 'stream_event' && sdkMessage.event) {
    // 子代理（parent_tool_use_id 非空）的部分事件不单独流式渲染：其文本随
    // 子代理工具结果整体呈现，单独下发会产生错位的顶层流式气泡。
    if (sdkMessage.parent_tool_use_id) {
      return null;
    }
    const ev = sdkMessage.event;
    if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') {
      return { type: 'content_block_delta', index: ev.index, delta: { text: ev.delta.text } };
    }
    if (ev.type === 'content_block_stop') {
      return { type: 'content_block_stop', index: ev.index };
    }
    // 其余部分事件（message_start/message_delta/thinking_delta/input_json_delta 等）
    // 前端无需处理，直接丢弃以减少无效 WebSocket 流量。
    return null;
  }

  // 整段助手消息：其中的 text 文本块通常已通过上面的 content_block_delta 实时下发。
  // 但断线重连会丢失中途的 delta（WebSocketWriter 仅重放最后一条终止消息，不补发中间增量），
  // 此时若在后端剥离 text，前端将永远拿不到这段回复文本，只能刷新后从 JSONL 恢复
  // ——表现为"流式消息消失 / 折叠回复为空 / 刷新才出现"。因此这里不再剥离 text，
  // 而是把完整文本作为权威兜底下发；前端负责与已渲染的流式气泡去重/补全（见
  // useChatRealtimeHandlers 中 claude-response 的 text 分支）。保留 tool_use / thinking / usage 原样。
  // 仅处理顶层助手消息；子代理（parent_tool_use_id 非空）文本未走流式，保持原样。

  // Extract parent_tool_use_id for subagent tool grouping
  if (sdkMessage.parent_tool_use_id) {
    return {
      ...sdkMessage,
      parentToolUseId: sdkMessage.parent_tool_use_id
    };
  }
  return sdkMessage;
}

/**
 * Extracts token usage from SDK result messages
 * @param {Object} resultMessage - SDK result message
 * @returns {Object|null} Token budget object or null
 */
function extractTokenBudget(resultMessage, latestAssistantUsage) {
  if (resultMessage.type !== 'result') {
    return null;
  }

  // modelUsage 是整个会话的累计账单（每轮的 cache_read 都会叠加），不是上下文占用。
  // 用它驱动上下文轮盘会让数值无上限增长（实测单会话可达数百万），因此这里只取
  // 它的 contextWindow 作为分母，分子改用最近一条 assistant 消息的 usage。
  const modelKey = Object.keys(resultMessage.modelUsage || {})[0];
  const modelData = modelKey ? resultMessage.modelUsage[modelKey] : null;

  // 上下文占用 = 本轮最后一次请求的 input + 两类 cache（与 /token-usage 接口口径一致，
  // 排除 output_tokens：输出不占用下一轮之前的上下文快照）。
  const usage = latestAssistantUsage || resultMessage.usage;
  if (!usage) {
    return null;
  }
  const inputTokens = usage.input_tokens || 0;
  const cacheReadTokens = usage.cache_read_input_tokens || 0;
  const cacheCreationTokens = usage.cache_creation_input_tokens || 0;
  const totalUsed = inputTokens + cacheReadTokens + cacheCreationTokens;
  if (totalUsed <= 0) {
    return null;
  }

  // 分母优先取 SDK 上报的真实窗口，避免硬编码与 1M context 等变体不符
  const contextWindow =
    Number(modelData?.contextWindow) || parseInt(process.env.CONTEXT_WINDOW) || 200000;

  console.log(`Token calculation: input=${inputTokens}, cache=${cacheReadTokens + cacheCreationTokens}, context=${totalUsed}/${contextWindow}`);

  return {
    used: totalUsed,
    total: contextWindow
  };
}

/**
 * Handles image processing for SDK queries
 * Saves base64 images to temporary files and returns modified prompt with file paths
 * @param {string} command - Original user prompt
 * @param {Array} images - Array of image objects with base64 data
 * @param {string} cwd - Working directory for temp file creation
 * @returns {Promise<Object>} {modifiedCommand, tempImagePaths, tempDir}
 */
async function handleImages(command, images, cwd) {
  const tempImagePaths = [];
  let tempDir = null;

  if (!images || images.length === 0) {
    return { modifiedCommand: command, tempImagePaths, tempDir };
  }

  try {
    // Create temp directory in the project directory
    const workingDir = cwd || process.cwd();
    tempDir = path.join(workingDir, '.tmp', 'images', Date.now().toString());
    await fs.mkdir(tempDir, { recursive: true });

    // Save each image to a temp file
    for (const [index, image] of images.entries()) {
      // Extract base64 data and mime type
      const matches = image.data.match(/^data:([^;]+);base64,(.+)$/);
      if (!matches) {
        console.error('Invalid image data format');
        continue;
      }

      const [, mimeType, base64Data] = matches;
      const extension = mimeType.split('/')[1] || 'png';
      const filename = `image_${index}.${extension}`;
      const filepath = path.join(tempDir, filename);

      // Write base64 data to file
      await fs.writeFile(filepath, Buffer.from(base64Data, 'base64'));
      tempImagePaths.push(filepath);
    }

    // Include the full image paths in the prompt
    let modifiedCommand = command;
    if (tempImagePaths.length > 0) {
      const baseCommand = command && command.trim() ? command : 'Please analyze the attached image(s).';
      const imageNote = `\n\n[Images provided at the following paths:]\n${tempImagePaths.map((p, i) => `${i + 1}. ${p}`).join('\n')}`;
      modifiedCommand = baseCommand + imageNote;
    }

    console.log(`Processed ${tempImagePaths.length} images to temp directory: ${tempDir}`);
    return { modifiedCommand, tempImagePaths, tempDir };
  } catch (error) {
    console.error('Error processing images for SDK:', error);
    return { modifiedCommand: command, tempImagePaths, tempDir };
  }
}

/**
 * Cleans up temporary image files
 * @param {Array<string>} tempImagePaths - Array of temp file paths to delete
 * @param {string} tempDir - Temp directory to remove
 */
async function cleanupTempFiles(tempImagePaths, tempDir) {
  // 重要：不再删除用户粘贴/拖入的图片。
  // 这些图片虽写在 <project>/.tmp/images/ 下，但聊天记录里的消息会以该路径内联展示；
  // 一旦在本轮结束时删除源文件，历史消息中的图片就会全部 404（"重试中→加载失败"），
  // 而依赖 /api/image 懒快照的兜底又因消息时间戳 key 不稳定而几乎总是错过（实测 36 张仅 3 张存活）。
  // .tmp 目录已被 .gitignore / .claudeignore 排除，不会进入版本库或上下文，保留它们即可让历史图片永久可见。
  // 如需控制磁盘占用，应改为「按保留期清理过期目录」，而不是「每轮立即删除」。
  void tempImagePaths;
  void tempDir;
}

/**
 * Loads MCP server configurations from ~/.claude.json
 * @param {string} cwd - Current working directory for project-specific configs
 * @returns {Object|null} MCP servers object or null if none found
 */
async function loadMcpConfig(cwd) {
  try {
    const claudeConfigPath = path.join(os.homedir(), '.claude.json');

    // Check if config file exists
    try {
      await fs.access(claudeConfigPath);
    } catch (error) {
      // File doesn't exist, return null
      console.log('No ~/.claude.json found, proceeding without MCP servers');
      return null;
    }

    // Read and parse config file
    let claudeConfig;
    try {
      const configContent = await fs.readFile(claudeConfigPath, 'utf8');
      claudeConfig = JSON.parse(configContent);
    } catch (error) {
      console.error('Failed to parse ~/.claude.json:', error.message);
      return null;
    }

    // Extract MCP servers (merge global and project-specific)
    let mcpServers = {};

    // Add global MCP servers
    if (claudeConfig.mcpServers && typeof claudeConfig.mcpServers === 'object') {
      mcpServers = { ...claudeConfig.mcpServers };
      console.log(`Loaded ${Object.keys(mcpServers).length} global MCP servers`);
    }

    // Add/override with project-specific MCP servers
    if (claudeConfig.claudeProjects && cwd) {
      const projectConfig = claudeConfig.claudeProjects[cwd];
      if (projectConfig && projectConfig.mcpServers && typeof projectConfig.mcpServers === 'object') {
        mcpServers = { ...mcpServers, ...projectConfig.mcpServers };
        console.log(`Loaded ${Object.keys(projectConfig.mcpServers).length} project-specific MCP servers`);
      }
    }

    // Return null if no servers found
    if (Object.keys(mcpServers).length === 0) {
      console.log('No MCP servers configured');
      return null;
    }

    console.log(`Total MCP servers loaded: ${Object.keys(mcpServers).length}`);
    return mcpServers;
  } catch (error) {
    console.error('Error loading MCP config:', error.message);
    return null;
  }
}

/**
 * Executes a Claude query using the SDK
 * @param {string} command - User prompt/command
 * @param {Object} options - Query options
 * @param {Object} ws - WebSocket connection
 * @returns {Promise<void>}
 */
async function queryClaudeSDK(command, options = {}, ws, _compactRetry = 0) {
  const { sessionId, newSessionRequestId } = options;
  const turnClientTs = Number(options.clientTs || Date.now());
  let capturedSessionId = sessionId;
  let sessionCreatedSent = false;
  let tempImagePaths = [];
  let tempDir = null;

  try {
    // Map CLI options to SDK format
    const sdkOptions = mapCliOptionsToSDK(options);

    // Load MCP configuration
    const mcpServers = await loadMcpConfig(options.cwd);
    if (mcpServers) {
      sdkOptions.mcpServers = mcpServers;
    }

    // Handle images - save to temp files and modify prompt
    const imageResult = await handleImages(command, options.images, options.cwd);
    const finalCommand = imageResult.modifiedCommand;
    tempImagePaths = imageResult.tempImagePaths;
    tempDir = imageResult.tempDir;

    sdkOptions.canUseTool = async (toolName, input, context) => {
      const requiresInteraction = TOOLS_REQUIRING_INTERACTION.has(toolName);

      if (!requiresInteraction) {
        if (sdkOptions.permissionMode === 'bypassPermissions') {
          return { behavior: 'allow', updatedInput: input };
        }

        const isDisallowed = (sdkOptions.disallowedTools || []).some(entry =>
          matchesToolPermission(entry, toolName, input)
        );
        if (isDisallowed) {
          return { behavior: 'deny', message: 'Tool disallowed by settings' };
        }

        const isAllowed = (sdkOptions.allowedTools || []).some(entry =>
          matchesToolPermission(entry, toolName, input)
        );
        if (isAllowed) {
          return { behavior: 'allow', updatedInput: input };
        }
      }

      const requestId = createRequestId();
      ws.send({
        type: 'claude-permission-request',
        requestId,
        toolName,
        input,
        sessionId: capturedSessionId || sessionId || null
      });

      const decision = await waitForToolApproval(requestId, {
        timeoutMs: requiresInteraction ? 0 : undefined,
        signal: context?.signal,
        metadata: {
          _sessionId: capturedSessionId || sessionId || null,
          _toolName: toolName,
          _input: input,
          _receivedAt: new Date(),
        },
        onCancel: (reason) => {
          ws.send({
            type: 'claude-permission-cancelled',
            requestId,
            reason,
            sessionId: capturedSessionId || sessionId || null
          });
        }
      });
      if (!decision) {
        return { behavior: 'deny', message: 'Permission request timed out' };
      }

      if (decision.cancelled) {
        return { behavior: 'deny', message: 'Permission request cancelled' };
      }

      if (decision.allow) {
        if (decision.rememberEntry && typeof decision.rememberEntry === 'string') {
          if (!sdkOptions.allowedTools.includes(decision.rememberEntry)) {
            sdkOptions.allowedTools.push(decision.rememberEntry);
          }
          if (Array.isArray(sdkOptions.disallowedTools)) {
            sdkOptions.disallowedTools = sdkOptions.disallowedTools.filter(entry => entry !== decision.rememberEntry);
          }
        }
        return { behavior: 'allow', updatedInput: decision.updatedInput ?? input };
      }

      return { behavior: 'deny', message: decision.message ?? 'User denied tool use' };
    };

    // PreCompact / PostCompact 钩子：Claude 原生压缩的真实"开始/结束"信号。
    // 关键：PreCompact 在压缩 LLM 摘要调用之前触发，这是唯一能在压缩"开始"时拿到的信号。
    // 旧逻辑只能靠流中途 session_id 变化感知压缩，而那发生在压缩"结束"之后，
    // 导致前端动画压缩结束才出现、失去"让用户察觉而非以为卡死"的意义。
    // 现在：PreCompact→发 compact-start（动画立即开始，覆盖整个冻结期）；
    //      PostCompact→发 compact-complete（压缩真正结束时收尾动画，随后正常流式生成）。
    sdkOptions.hooks = {
      ...(sdkOptions.hooks || {}),
      PreCompact: [
        {
          hooks: [
            async (input) => {
              try {
                ws.send({
                  type: 'compact-start',
                  trigger: (input && input.trigger) || 'auto',
                  sessionId: capturedSessionId || sessionId || null,
                });
              } catch (_) { /* ignore，钩子失败不应中断会话 */ }
              return { continue: true };
            },
          ],
        },
      ],
      PostCompact: [
        {
          hooks: [
            async () => {
              try {
                ws.send({
                  type: 'compact-complete',
                  sessionId: capturedSessionId || sessionId || null,
                });
              } catch (_) { /* ignore */ }
              return { continue: true };
            },
          ],
        },
      ],
    };

    // Set stream-close timeout for interactive tools (Query constructor reads it synchronously). Claude Agent SDK has a default of 5s and this overrides it
    const prevStreamTimeout = process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT;
    process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT = '300000';

    const queryInstance = query({
      prompt: finalCommand,
      options: sdkOptions
    });

    // Restore immediately — Query constructor already captured the value
    if (prevStreamTimeout !== undefined) {
      process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT = prevStreamTimeout;
    } else {
      delete process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT;
    }

    // Track the query instance for abort capability
    if (capturedSessionId) {
      addSession(capturedSessionId, queryInstance, tempImagePaths, tempDir, ws, turnClientTs);
    }

    // Process streaming messages
    console.log('Starting async generator loop for session:', capturedSessionId || 'NEW');
    // 最近一条 assistant 消息的 usage：上下文轮盘的权威分子（见 extractTokenBudget）
    let latestAssistantUsage = null;
    for await (const message of queryInstance) {
      if (message.type === 'assistant' && message.message?.usage) {
        latestAssistantUsage = message.message.usage;
      }
      // Capture session ID from first message
      if (message.session_id && !capturedSessionId) {

        capturedSessionId = message.session_id;
        addSession(capturedSessionId, queryInstance, tempImagePaths, tempDir, ws, turnClientTs);

        // Set session ID on writer
        if (ws.setSessionId && typeof ws.setSessionId === 'function') {
          ws.setSessionId(capturedSessionId);
        }

        // Send session-created event only once for new sessions
        if (!sessionId && !sessionCreatedSent) {
          sessionCreatedSent = true;
          // 携带发起方的 newSessionRequestId：session-created 是广播消息，
          // 只有发起本次新会话请求的那个客户端 requestId 匹配，才会采纳此 sessionId，
          // 防止其他处于"新对话"状态（!currentSessionId）的标签页误采纳别人的会话（串话根因）。
          ws.send({
            type: 'session-created',
            sessionId: capturedSessionId,
            newSessionRequestId: newSessionRequestId || null
          });
        } else {
          console.log('Not sending session-created. sessionId:', sessionId, 'sessionCreatedSent:', sessionCreatedSent);
        }
      } else if (message.session_id && capturedSessionId && message.session_id !== capturedSessionId) {
        // session_id 在流中途变化 = Claude 原生压缩已经产生了新 session（此刻压缩已"结束"）。
        // 压缩的"开始/结束"信号现在改由 PreCompact/PostCompact 钩子精确发出，
        // 故此处不再发 compact-start（否则会在 PostCompact 收尾后重复触发第二次动画）。
        const previousSessionId = capturedSessionId;
        console.log('Compact session change: from', previousSessionId, 'to', message.session_id);
        capturedSessionId = message.session_id;

        // 关键修复①（防止 activeSessions 泄漏）：把旧 id 的会话条目迁移到新 id。
        // 否则旧 id 条目永不被 markSessionCompleted（完成时用的是新 id），
        // 导致 isClaudeSDKSessionActive(旧id) 永远为真 → 前端 check-session-status 轮询
        // 一直收到 isProcessing=true → "工作中"状态栏即使任务结束也清不掉（要等 10min 僵尸回收）。
        const movedSession = activeSessions.get(previousSessionId);
        if (movedSession) {
          movedSession.lastActivityAt = Date.now();
          activeSessions.set(capturedSessionId, movedSession);
          activeSessions.delete(previousSessionId);
        } else {
          addSession(capturedSessionId, queryInstance, tempImagePaths, tempDir, ws, turnClientTs);
        }
        // 注册压缩别名 旧id→新id：让仍带旧 id 的提交/中止/状态查询解析到当前活跃会话，
        // 杜绝「压缩后旧 id 提交 → 旧 id 已失活 → 新开并发 query」的双跑问题。
        registerCompactAlias(previousSessionId, capturedSessionId);
        // 待处理队列也随会话 id 迁移：否则压缩前入队的消息挂在旧 id 上，
        // drain 时用新 id 取不到而永久滞留。合并到新 id 的队尾，保持 FIFO。
        const pendingForOld = pendingMessages.get(previousSessionId);
        if (pendingForOld && pendingForOld.length > 0) {
          const existing = pendingMessages.get(capturedSessionId) || [];
          pendingMessages.set(capturedSessionId, existing.concat(
            pendingForOld.map((m) => ({ ...m, options: { ...m.options, sessionId: capturedSessionId } }))
          ));
          pendingMessages.delete(previousSessionId);
        }
        if (ws.setSessionId && typeof ws.setSessionId === 'function') {
          ws.setSessionId(capturedSessionId);
        }

        // 关键修复②（防止"工作中"残留 + 流式冻结）：通知前端会话 id 因压缩而变化。
        // 此后所有 claude-response 流式块与终态 claude-complete 都带新 id，
        // 前端若仍按旧 id 过滤会全部丢弃 → 既看不到压缩后的输出，也永远收不到能清除
        // loading 的 claude-complete。前端据此把当前视图重映射到新 id（见 session-id-changed 处理）。
        ws.send({
          type: 'session-id-changed',
          from: previousSessionId,
          to: capturedSessionId,
          sessionId: capturedSessionId,
        });
      } else {
        console.log('No session_id in message or already captured. message.session_id:', message.session_id, 'capturedSessionId:', capturedSessionId);
      }

      // isCompactSummary 消息只是 Claude CLI 内部压缩后的会话摘要文本，
      // 前端已通过 compact-start 事件感知压缩开始、通过 claude-complete 感知结束，
      // 不需要摘要内容本身，过滤掉以避免动画立即跳到"完成"状态。
      if (message.isCompactSummary) {
        continue;
      }

      // Transform and send message to WebSocket
      const transformedMessage = transformMessage(message);
      if (capturedSessionId) touchSession(capturedSessionId);
      // transformMessage 对无需前端处理的部分事件返回 null，此时跳过下发
      if (transformedMessage) {
        ws.send({
          type: 'claude-response',
          data: transformedMessage,
          sessionId: capturedSessionId || sessionId || null,
          turnClientTs,
        });
      }

      // Extract and send token budget updates from result messages
      if (message.type === 'result') {
        const models = Object.keys(message.modelUsage || {});
        if (models.length > 0) {
          console.log("---> Model was sent using:", models);
        }
        const tokenBudget = extractTokenBudget(message, latestAssistantUsage);
        if (tokenBudget) {
          console.log('Token budget (context occupancy):', tokenBudget);
          ws.send({
            type: 'token-budget',
            data: tokenBudget,
            sessionId: capturedSessionId || sessionId || null
          });
        }
      }
    }

    // Clean up temporary image files
    await cleanupTempFiles(tempImagePaths, tempDir);

    // ── 串行队列 drain（原子）：cleanupTempFiles 之后无 await，
    //    dequeue 与下方收尾在同一同步块内执行，submitClaudeMessage 的入队无法插入其间。
    const queuedNext = capturedSessionId ? dequeuePendingMessage(capturedSessionId) : null;
    if (queuedNext) {
      // 还有排队消息：不发 claude-complete、不 markSessionCompleted，
      // 保持会话活跃、前端 loading 不灭，直接串行处理下一条（resume 同一 session）。
      console.log(`[QUEUE] Session ${capturedSessionId} 当前 turn 结束，处理下一条排队消息`);
      return queryClaudeSDK(queuedNext.command, queuedNext.options, queuedNext.writer || ws);
    }

    // 先发 complete 事件，再 markSessionCompleted：
    // 1. claude-complete 触发 WebSocketWriter._lastTerminalMsg 缓冲
    // 2. markSessionCompleted 立即将 status 改为 'completed'（isActive=false，刷新后不误报"Reconnecting"）
    //    同时保留 writer 5 秒，允许重连时重放终态消息
    console.log('Streaming complete, sending claude-complete event');
    ws.send({
      type: 'claude-complete',
      sessionId: capturedSessionId,
      exitCode: 0,
      isNewSession: !sessionId && !!command,
      turnClientTs,
    });
    console.log('claude-complete event sent');

    if (capturedSessionId) {
      markSessionCompleted(capturedSessionId);
    }

  } catch (error) {
    console.error('SDK query error:', error);

    // 压缩中断时自动重试（最多3次，退避 2/4/6 秒）
    const isCompactInterrupted = typeof error.message === 'string' &&
      error.message.includes('Compaction interrupted');
    if (isCompactInterrupted && _compactRetry < 3) {
      const delay = (_compactRetry + 1) * 2000;
      const retrySession = capturedSessionId || sessionId;
      console.log(`[compact-retry] attempt ${_compactRetry + 1}/3 in ${delay}ms, session=${retrySession}`);
      await cleanupTempFiles(tempImagePaths, tempDir);
      ws.send({ type: 'compact-retry', attempt: _compactRetry + 1, sessionId: retrySession });
      await new Promise(r => setTimeout(r, delay));
      return queryClaudeSDK(
        null,
        { ...options, sessionId: retrySession },
        ws,
        _compactRetry + 1
      );
    }

    // Clean up temporary image files on error
    await cleanupTempFiles(tempImagePaths, tempDir);

    // 先发 error 事件，再 markSessionCompleted（同 complete 路径）
    ws.send({
      type: 'claude-error',
      error: error.message,
      sessionId: capturedSessionId || sessionId || null,
      turnClientTs,
    });

    if (isClaudeThrottleError(error)) {
      setClaudeThrottleCooldown(error);
      const dropped = clearAllPendingMessages();
      if (dropped) {
        console.warn(`[THROTTLE] Dropped ${dropped} queued Claude message(s) across all sessions`);
      }
      if (capturedSessionId) {
        markSessionCompleted(capturedSessionId);
      }
      throw error;
    }

    // 串行队列 drain（错误路径）：当前 turn 失败不应让后续排队消息一起丢失，
    // 继续处理下一条（其 resume 在空闲会话上执行，状态一致）。
    const queuedAfterError = capturedSessionId ? dequeuePendingMessage(capturedSessionId) : null;
    if (queuedAfterError) {
      console.log(`[QUEUE] Session ${capturedSessionId} 当前 turn 出错，继续处理下一条排队消息`);
      return queryClaudeSDK(queuedAfterError.command, queuedAfterError.options, queuedAfterError.writer || ws);
    }

    if (capturedSessionId) {
      markSessionCompleted(capturedSessionId);
    }

    throw error;
  }
}

/**
 * Aborts an active SDK session
 * @param {string} sessionId - Session identifier
 * @returns {boolean} True if session was aborted, false if not found
 */
/**
 * 向正在运行的 Claude session 注入 BTW 消息，不打断当前任务
 * 使用 SDK 的 streamInput() + priority:'now' 实现真正的 /btw 效果
 */
async function injectBtwMessage(sessionId, text) {
  // 压缩后旧 id 解析到当前活跃 id：BTW 注入仍能命中正在跑的新会话。
  sessionId = resolveActiveSessionId(sessionId);
  const session = getSession(sessionId);

  if (!session || !session.instance) {
    console.log(`BTW: session ${sessionId} not found or no instance`);
    return false;
  }

  if (typeof session.instance.streamInput !== 'function') {
    console.log(`BTW: streamInput not available on session ${sessionId}`);
    return false;
  }

  try {
    console.log(`BTW inject into session ${sessionId}: "${text}"`);

    const userMsg = {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: sessionId,
      priority: 'now',   // 立即注入，Claude 当前任务中即可看到
      isSynthetic: true,
    };

    // streamInput 接受 AsyncIterable，包装为单条消息的 generator
    await session.instance.streamInput((async function* () { yield userMsg; })());
    return true;
  } catch (error) {
    console.error(`BTW inject error for session ${sessionId}:`, error);
    return false;
  }
}

async function abortClaudeSDKSession(sessionId) {
  // 压缩后旧 id 解析到当前活跃 id：前端只持有旧 id 时，中止指令仍能命中正在跑的新会话。
  const resolvedId = resolveActiveSessionId(sessionId);
  if (resolvedId !== sessionId) {
    console.log(`Abort: resolved compact alias ${sessionId} -> ${resolvedId}`);
    sessionId = resolvedId;
  }
  const session = getSession(sessionId);

  if (!session) {
    console.log(`Session ${sessionId} not found`);
    return false;
  }

  try {
    console.log(`Aborting SDK session: ${sessionId}`);

    // Call interrupt() on the query instance
    await session.instance.interrupt();

    // Update session status
    session.status = 'aborted';

    // Clean up temporary image files
    await cleanupTempFiles(session.tempImagePaths, session.tempDir);

    // Clean up session
    removeSession(sessionId);
    // 中止即结束本轮：清理整条压缩别名链，避免陈旧重定向到已中止会话。
    pruneCompactAliases(sessionId);

    return true;
  } catch (error) {
    console.error(`Error aborting session ${sessionId}:`, error);
    return false;
  }
}

/**
 * Checks if an SDK session is currently active
 * @param {string} sessionId - Session identifier
 * @returns {boolean} True if session is active
 */
// session 最长存活时间：3小时（防止僵尸进程永久占用 isProcessing 状态）
const SESSION_MAX_AGE_MS = 3 * 60 * 60 * 1000;

// 超过此时间没有任何 SDK 活动，视为僵尸 session
const SESSION_IDLE_ZOMBIE_MS = 10 * 60 * 1000; // 10 分钟

function isClaudeSDKSessionActive(sessionId) {
  // 压缩后旧 id 解析到当前活跃 id：使前端用旧 id 轮询 check-session-status 仍能得到 active，
  // 「工作中」状态栏在压缩期间不被误清；串行队列护栏也据此对旧 id 提交生效。
  const resolvedId = resolveActiveSessionId(sessionId);
  const session = getSession(resolvedId);
  if (!session || session.status !== 'active') return false;
  sessionId = resolvedId;
  // 超过最大存活时间视为僵尸，自动清除
  if (Date.now() - session.startTime > SESSION_MAX_AGE_MS) {
    console.warn(`[SDK] Session ${sessionId} exceeded max age, auto-removing.`);
    markSessionCompleted(sessionId);
    return false;
  }
  // 超过 10min 没有任何活动，视为僵尸（SDK 崩溃未调用 markSessionCompleted）
  const idle = Date.now() - (session.lastActivityAt || session.startTime);
  if (idle > SESSION_IDLE_ZOMBIE_MS) {
    console.warn(`[SDK] Session ${sessionId} idle ${Math.round(idle/1000)}s, marking as zombie.`);
    markSessionCompleted(sessionId);
    return false;
  }
  return true;
}

/**
 * Gets all active SDK session IDs
 * @returns {Array<string>} Array of active session IDs
 */
function getActiveClaudeSDKSessions() {
  return getAllSessions()
    .map((sessionId) => getSessionInfo(sessionId))
    .filter(Boolean);
}

/**
 * Get pending tool approvals for a specific session.
 * @param {string} sessionId - The session ID
 * @returns {Array} Array of pending permission request objects
 */
function getPendingApprovalsForSession(sessionId) {
  const pending = [];
  for (const [requestId, resolver] of pendingToolApprovals.entries()) {
    if (resolver._sessionId === sessionId) {
      pending.push({
        requestId,
        toolName: resolver._toolName || 'UnknownTool',
        input: resolver._input,
        context: resolver._context,
        sessionId,
        receivedAt: resolver._receivedAt || new Date(),
      });
    }
  }
  return pending;
}

/**
 * Reconnect a session's WebSocketWriter to a new raw WebSocket.
 * Called when client reconnects (e.g. page refresh) while SDK is still running.
 * @param {string} sessionId - The session ID
 * @param {Object} newRawWs - The new raw WebSocket connection
 * @returns {boolean} True if writer was successfully reconnected
 */
function reconnectSessionWriter(sessionId, newRawWs) {
  // 压缩后旧 id 解析到当前活跃 id，使重连客户端能挂回正在跑的新会话 writer。
  sessionId = resolveActiveSessionId(sessionId);
  const session = getSession(sessionId);
  if (!session?.writer?.updateWebSocket) return false;
  // active 和 completed（5s 内）状态都支持重连重放
  session.writer.updateWebSocket(newRawWs);
  console.log(`[RECONNECT] Writer swapped for session ${sessionId} (status=${session.status})`);
  return true;
}

// Export public API
export {
  queryClaudeSDK,
  submitClaudeMessage,
  abortClaudeSDKSession,
  injectBtwMessage,
  isClaudeSDKSessionActive,
  getSessionInfo as getClaudeSDKSessionInfo,
  getActiveClaudeSDKSessions,
  resolveToolApproval,
  getPendingApprovalsForSession,
  reconnectSessionWriter,
  markSessionCompleted
};
