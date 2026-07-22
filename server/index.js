#!/usr/bin/env node
// Load environment variables before other imports execute
import './load-env.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const installMode = fs.existsSync(path.join(__dirname, '..', '.git')) ? 'git' : 'npm';
const packageMetadata = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

// ANSI color codes for terminal output
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    cyan: '\x1b[36m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    dim: '\x1b[2m',
};

const c = {
    info: (text) => `${colors.cyan}${text}${colors.reset}`,
    ok: (text) => `${colors.green}${text}${colors.reset}`,
    warn: (text) => `${colors.yellow}${text}${colors.reset}`,
    tip: (text) => `${colors.blue}${text}${colors.reset}`,
    bright: (text) => `${colors.bright}${text}${colors.reset}`,
    dim: (text) => `${colors.dim}${text}${colors.reset}`,
};

const SENSITIVE_QUERY_KEYS = new Set([
    'token',
    'apikey',
    'api_key',
    'authorization',
    'newgithubtoken',
    'githubtoken'
]);

function sanitizeUrlForLog(rawUrl = '') {
    if (!rawUrl || typeof rawUrl !== 'string') return rawUrl;

    try {
        const parsed = new URL(rawUrl, 'http://localhost');
        for (const [key] of parsed.searchParams.entries()) {
            const normalizedKey = key.toLowerCase();
            if (SENSITIVE_QUERY_KEYS.has(normalizedKey) || normalizedKey.endsWith('token') || normalizedKey.endsWith('key')) {
                parsed.searchParams.set(key, '***');
            }
        }
        return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    } catch {
        return rawUrl.replace(/([?&](?:token|api[_-]?key|authorization|newGithubToken|githubToken)=)[^&]*/gi, '$1***');
    }
}

console.log('PORT from env:', process.env.PORT);

import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import os from 'os';
import http from 'http';
import https from 'https';
import cors from 'cors';
import compression from 'compression';
import { promises as fsPromises } from 'fs';
import readline from 'readline';
import { spawn } from 'child_process';
import pty from 'node-pty';
import fetch from 'node-fetch';
import mime from 'mime-types';

import { getProjects, getSessions, getSessionMessages, renameProject, deleteSession, deleteProject, addProjectManually, extractProjectDirectory, clearProjectDirectoryCache, invalidateProjectsCache } from './projects.js';
import { queryClaudeSDK, submitClaudeMessage, abortClaudeSDKSession, injectBtwMessage, isClaudeSDKSessionActive, getClaudeSDKSessionInfo, getActiveClaudeSDKSessions, resolveToolApproval, getPendingApprovalsForSession, reconnectSessionWriter, markSessionCompleted } from './claude-sdk.js';
import { spawnCursor, abortCursorSession, isCursorSessionActive, getCursorSessionInfo, getActiveCursorSessions } from './cursor-cli.js';
import { submitCodexMessage, steerCodexSession, abortCodexSession, isCodexSessionActive, getCodexSessionInfo, getActiveCodexSessions } from './openai-codex.js';
import { spawnGemini, abortGeminiSession, isGeminiSessionActive, getGeminiSessionInfo, getActiveGeminiSessions } from './gemini-cli.js';
import { readBoundedJsonlLines } from './utils/bounded-jsonl.js';
import sessionManager from './sessionManager.js';
import gitRoutes from './routes/git.js';
import authRoutes from './routes/auth.js';
import mcpRoutes from './routes/mcp.js';
import cursorRoutes from './routes/cursor.js';
import taskmasterRoutes from './routes/taskmaster.js';
import mcpUtilsRoutes from './routes/mcp-utils.js';
import commandsRoutes from './routes/commands.js';
import settingsRoutes from './routes/settings.js';
import agentRoutes from './routes/agent.js';
import projectsRoutes, { WORKSPACES_ROOT, validateWorkspacePath, FORBIDDEN_PATHS } from './routes/projects.js';
import cliAuthRoutes from './routes/cli-auth.js';
import userRoutes from './routes/user.js';
import codexRoutes from './routes/codex.js';
import claudeRoutes from './routes/claude.js';
import geminiRoutes from './routes/gemini.js';
import foldersRoutes from './routes/folders.js';
import { initializeDatabase, sessionNamesDb, applyCustomSessionNames, attributionDb, dailyInputDb, modelOutputDb, userDb, codexTranscriptDb } from './database/db.js';
import { backfillHistoricalAttributions } from './database/backfillAttributions.js';
import { validateApiKey, authenticateToken, authenticateWebSocket } from './middleware/auth.js';
import { IS_PLATFORM } from './constants/config.js';
import { TtlIdempotencyCache } from './utils/ttl-idempotency.js';
import { filterClientInstanceTargets } from './utils/client-routing.js';
import { resolvePathWithinRoot } from './utils/path-security.js';
import { isAllowedWebSocketOrigin } from './utils/request-origin.js';

const VALID_PROVIDERS = ['claude', 'codex', 'cursor', 'gemini'];

function filterProjectsToWorkspace(projects = []) {
    return projects.filter((project) => {
        const directory = project.path || project.fullPath || '';
        return directory && (
            directory === WORKSPACES_ROOT
            || directory.startsWith(`${WORKSPACES_ROOT}${path.sep}`)
        );
    });
}

// File system watchers for provider project/session folders
const PROVIDER_WATCH_PATHS = [
    { provider: 'claude', rootPath: path.join(os.homedir(), '.claude', 'projects') },
    { provider: 'cursor', rootPath: path.join(os.homedir(), '.cursor', 'chats') },
    { provider: 'codex', rootPath: path.join(os.homedir(), '.codex', 'sessions') },
    { provider: 'gemini', rootPath: path.join(os.homedir(), '.gemini', 'projects') },
    { provider: 'gemini_sessions', rootPath: path.join(os.homedir(), '.gemini', 'sessions') }
];
const WATCHER_IGNORED_PATTERNS = [
    '**/node_modules/**',
    '**/.git/**',
    '**/dist/**',
    '**/build/**',
    '**/*.tmp',
    '**/*.swp',
    '**/.DS_Store'
];
// Session rollouts are appended repeatedly while a model is streaming. A
// slightly longer quiet period prevents each pause from rescanning all history.
const WATCHER_DEBOUNCE_MS = 2000;
let projectsWatchers = [];
let projectsWatcherDebounceTimer = null;
const connectedClients = new Set();
const sessionChatClients = new Map();
let isGetProjectsRunning = false; // Flag to prevent reentrant calls

// WebSocket reconnects can replay a command whose bytes reached the server but
// whose ACK did not reach the browser. Keep command acceptance idempotent so a
// transport retry never starts the same paid model turn twice.
const ACCEPTED_COMMAND_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ACCEPTED_COMMANDS = 20_000;
const acceptedCommands = new TtlIdempotencyCache({
    ttlMs: ACCEPTED_COMMAND_TTL_MS,
    maxEntries: MAX_ACCEPTED_COMMANDS,
});

function commandIdentity(data, authedUser) {
    const clientTs = data?.options?.clientTs;
    if (typeof clientTs !== 'number' || !Number.isFinite(clientTs)) return null;
    const userId = authedUser?.userId || authedUser?.username || 'anonymous';
    return `${userId}:${data.type}:${clientTs}`;
}

function rememberCommand(key, metadata) {
    return acceptedCommands.remember(key, metadata);
}

function safeSendWebSocket(client, payload) {
    if (client?.readyState !== WebSocket.OPEN) return false;
    try {
        client.send(payload);
        return true;
    } catch {
        return false;
    }
}

const acceptedCommandSweep = setInterval(() => {
    acceptedCommands.sweep();
}, 30 * 60 * 1000);
acceptedCommandSweep.unref();

function bindChatClientToSession(ws, sessionId) {
    if (!ws || !sessionId) return;
    if (!ws._chatSessionIds) ws._chatSessionIds = new Set();
    // A browser chat socket represents one visible conversation. Remove stale
    // memberships before binding the new view; otherwise every session ever
    // opened in this tab keeps broadcasting into the current transcript.
    for (const previousSessionId of ws._chatSessionIds) {
        if (previousSessionId === sessionId) continue;
        const previousClients = sessionChatClients.get(previousSessionId);
        if (previousClients) {
            previousClients.delete(ws);
            if (previousClients.size === 0) sessionChatClients.delete(previousSessionId);
        }
        ws._chatSessionIds.delete(previousSessionId);
    }
    ws._chatSessionIds.add(sessionId);
    if (!sessionChatClients.has(sessionId)) {
        sessionChatClients.set(sessionId, new Set());
    }
    sessionChatClients.get(sessionId).add(ws);
}

function unbindChatClient(ws) {
    if (!ws || !ws._chatSessionIds) return;
    for (const sessionId of ws._chatSessionIds) {
        const clients = sessionChatClients.get(sessionId);
        if (!clients) continue;
        clients.delete(ws);
        if (clients.size === 0) {
            sessionChatClients.delete(sessionId);
        }
    }
    ws._chatSessionIds.clear();
}

// Broadcast progress to all connected WebSocket clients
function broadcastProgress(progress) {
    const message = JSON.stringify({
        type: 'loading_progress',
        ...progress
    });
    connectedClients.forEach(client => {
        safeSendWebSocket(client, message);
    });
}

// Setup file system watchers for Claude, Cursor, and Codex project/session folders
async function setupProjectsWatcher() {
    const chokidar = (await import('chokidar')).default;

    if (projectsWatcherDebounceTimer) {
        clearTimeout(projectsWatcherDebounceTimer);
        projectsWatcherDebounceTimer = null;
    }

    await Promise.all(
        projectsWatchers.map(async (watcher) => {
            try {
                await watcher.close();
            } catch (error) {
                console.error('[WARN] Failed to close watcher:', error);
            }
        })
    );
    projectsWatchers = [];

    const debouncedUpdate = (eventType, filePath, provider, rootPath) => {
        if (projectsWatcherDebounceTimer) {
            clearTimeout(projectsWatcherDebounceTimer);
        }

        projectsWatcherDebounceTimer = setTimeout(async () => {
            // Prevent reentrant calls — 但不能静默丢弃：
            // 原 `return` 会导致 changedFile 事件永久丢失，客户端无法自动刷新。
            // 修复：延迟重试，等待上一次 getProjects() 完成后再执行。
            if (isGetProjectsRunning) {
                debouncedUpdate(eventType, filePath, provider, rootPath);
                return;
            }

            try {
                isGetProjectsRunning = true;

                // Clear project directory cache when files change
                clearProjectDirectoryCache();
                invalidateProjectsCache();

                // Get updated projects list
                const updatedProjects = await getProjects(broadcastProgress);

                // Notify all connected clients about the project changes
                const updateMessage = JSON.stringify({
                    type: 'projects_updated',
                    projects: updatedProjects,
                    timestamp: new Date().toISOString(),
                    changeType: eventType,
                    changedFile: path.relative(rootPath, filePath),
                    watchProvider: provider
                });

                connectedClients.forEach(client => {
                    safeSendWebSocket(client, updateMessage);
                });

            } catch (error) {
                console.error('[ERROR] Error handling project changes:', error);
            } finally {
                isGetProjectsRunning = false;
            }
        }, WATCHER_DEBOUNCE_MS);
    };

    for (const { provider, rootPath } of PROVIDER_WATCH_PATHS) {
        try {
            // chokidar v4 emits ENOENT via the "error" event for missing roots and will not auto-recover.
            // Ensure provider folders exist before creating the watcher so watching stays active.
            await fsPromises.mkdir(rootPath, { recursive: true });

            // Initialize chokidar watcher with optimized settings
            const watcher = chokidar.watch(rootPath, {
                ignored: WATCHER_IGNORED_PATTERNS,
                persistent: true,
                ignoreInitial: true, // Don't fire events for existing files on startup
                followSymlinks: false,
                depth: 10, // Reasonable depth limit
                awaitWriteFinish: {
                    stabilityThreshold: 100, // Wait 100ms for file to stabilize
                    pollInterval: 50
                }
            });

            // Set up event listeners
            watcher
                .on('add', (filePath) => debouncedUpdate('add', filePath, provider, rootPath))
                .on('change', (filePath) => debouncedUpdate('change', filePath, provider, rootPath))
                .on('unlink', (filePath) => debouncedUpdate('unlink', filePath, provider, rootPath))
                .on('addDir', (dirPath) => debouncedUpdate('addDir', dirPath, provider, rootPath))
                .on('unlinkDir', (dirPath) => debouncedUpdate('unlinkDir', dirPath, provider, rootPath))
                .on('error', (error) => {
                    console.error(`[ERROR] ${provider} watcher error:`, error);
                })
                .on('ready', () => {
                });

            projectsWatchers.push(watcher);
        } catch (error) {
            console.error(`[ERROR] Failed to setup ${provider} watcher for ${rootPath}:`, error);
        }
    }

    if (projectsWatchers.length === 0) {
        console.error('[ERROR] Failed to setup any provider watchers');
    }
}


const app = express();
const server = http.createServer(app);
let isDrainingForRestart = false;
let isRestartRequested = false;
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 3443);
const HTTPS_PUBLIC_HOST = process.env.HTTPS_PUBLIC_HOST || 'localhost';
const HTTPS_CERT_DIR = process.env.HTTPS_CERT_DIR || path.join(__dirname, '../.certs');
const HTTPS_KEY_PATH = path.join(HTTPS_CERT_DIR, 'server.key');
const HTTPS_CERT_PATH = path.join(HTTPS_CERT_DIR, 'server.crt');
const secureServer = fs.existsSync(HTTPS_KEY_PATH) && fs.existsSync(HTTPS_CERT_PATH)
    ? https.createServer({
        key: fs.readFileSync(HTTPS_KEY_PATH),
        cert: fs.readFileSync(HTTPS_CERT_PATH),
      }, app)
    : null;

const ptySessionsMap = new Map();
// sessionId → Set<WebSocket>：追踪每个 session 对应的 shell WebSocket，用于 SDK 事件实时转发
const shellWsMap = new Map();
// A selected Chat session uses a formatted mirror, not a second provider CLI.
// Keeping this independent of browser sockets lets a newly opened Shell catch up
// with a turn that was already running.
const shellMirrorSessions = new Map();
const SHELL_MIRROR_BUFFER_LIMIT = 240000;
const SHELL_MIRROR_IDLE_TTL_MS = 2 * 60 * 60 * 1000;
const SHELL_MIRROR_MAX_SESSIONS = 100;
// Keep detached terminals for a full day. Closing/switching the browser tab
// detaches its WebSocket but does not terminate the command running in the PTY.
const PTY_SESSION_TIMEOUT = 24 * 60 * 60 * 1000;
const SHELL_URL_PARSE_BUFFER_LIMIT = 32768;
const ANSI_ESCAPE_SEQUENCE_REGEX = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g;
const TRAILING_URL_PUNCTUATION_REGEX = /[)\]}>.,;:!?]+$/;

function stripAnsiSequences(value = '') {
    return value.replace(ANSI_ESCAPE_SEQUENCE_REGEX, '');
}

/**
 * 将 Claude SDK 事件格式化为 shell 终端可显示的 ANSI 文本
 * 用于实时将 chat 中的 Claude 活动同步显示到 shell 界面
 */
function formatEventForShell(data, state = {}) {
    if (!data || !data.type) return null;

    // Claude 状态消息（"正在思考..."等）
    if (data.type === 'claude-status' && data.data) {
        const status = data.data.message || data.data.status || '';
        if (status && status !== state.lastStatus) {
            state.lastStatus = status;
            return `\r\n\x1b[36m$ ${status}\x1b[0m`;
        }
    }

    // Claude 响应内容（文本 + 工具调用）
    if (data.type === 'claude-response' && data.data) {
        const msg = data.data;
        if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
            const toolUses = msg.message.content.filter(b => b.type === 'tool_use');
            const textBlocks = msg.message.content.filter(b => b.type === 'text');
            const text = textBlocks.map(b => b.text).join('');
            let output = '';
            if (toolUses.length > 0) {
                output += `\r\n\x1b[33m🔧 ${toolUses.map(t => t.name).join(', ')}\x1b[0m`;
            }
            if (text.trim()) {
                output += `\r\n\x1b[37m${text}\x1b[0m`;
            }
            return output || null;
        }
    }

    // Claude 完成
    if (data.type === 'claude-complete') {
        return `\r\n\x1b[32m[Claude turn complete]\x1b[0m\r\n`;
    }

    if (data.type === 'codex-response' && data.data?.type === 'item') {
        const item = data.data;
        const itemId = String(item.itemId || `${item.itemType || 'item'}:unknown`);
        state.itemLengths ||= new Map();
        state.startedItems ||= new Set();
        if (item.itemType === 'agent_message' || item.itemType === 'reasoning') {
            const text = String(item.message?.content || '');
            const previousLength = Number(state.itemLengths.get(itemId) || 0);
            if (!text || text.length === previousLength) return null;
            state.itemLengths.set(itemId, text.length);
            const delta = text.length > previousLength ? text.slice(previousLength) : `\r\n${text}`;
            const color = item.itemType === 'reasoning' ? '\x1b[35m' : '\x1b[37m';
            return `${color}${delta.replace(/\n/g, '\r\n')}\x1b[0m`;
        }
        if (item.itemType === 'command_execution') {
            let output = '';
            if (!state.startedItems.has(itemId) && item.command) {
                state.startedItems.add(itemId);
                output += `\r\n\x1b[33m$ ${item.command}\x1b[0m\r\n`;
            }
            const commandOutput = String(item.output || '');
            const previousLength = Number(state.itemLengths.get(itemId) || 0);
            if (commandOutput && commandOutput.length !== previousLength) {
                state.itemLengths.set(itemId, commandOutput.length);
                const delta = commandOutput.length > previousLength
                    ? commandOutput.slice(previousLength)
                    : commandOutput;
                output += delta.replace(/\n/g, '\r\n');
            }
            if (item.eventType === 'item.completed') {
                output += `\r\n\x1b[${Number(item.exitCode || 0) === 0 ? '32' : '31'}m[exit ${Number(item.exitCode || 0)}]\x1b[0m\r\n`;
            }
            return output || null;
        }
        if (item.itemType === 'file_change' && item.eventType === 'item.completed') {
            const changes = Array.isArray(item.changes)
                ? item.changes.map((change) => `${change.kind || 'update'} ${change.path || ''}`).join(', ')
                : 'files updated';
            return `\r\n\x1b[34m[files] ${changes}\x1b[0m\r\n`;
        }
        if (item.itemType === 'mcp_tool_call' && item.eventType !== 'item.updated') {
            return `\r\n\x1b[33m[tool] ${item.toolName || item.server || 'MCP'}\x1b[0m\r\n`;
        }
    }

    if (data.type === 'codex-complete') {
        return `\r\n\x1b[32m[Codex turn complete]\x1b[0m\r\n`;
    }
    if (data.type === 'codex-error') {
        return `\r\n\x1b[31m[Codex error] ${String(data.error || 'Unknown error')}\x1b[0m\r\n`;
    }

    return null;
}

function appendShellMirrorEvent(sessionId, data) {
    if (!sessionId) return null;
    let mirror = shellMirrorSessions.get(sessionId);
    if (!mirror) {
        mirror = { state: {}, buffer: '', touchedAt: Date.now() };
        shellMirrorSessions.set(sessionId, mirror);
    }
    mirror.touchedAt = Date.now();
    const startedAt = data?.data?.startedAt;
    if (startedAt && startedAt !== mirror.startedAt) {
        mirror.startedAt = startedAt;
        mirror.state = {};
        mirror.buffer = '';
    }
    let output = formatEventForShell(data, mirror.state);
    if (output?.length > SHELL_MIRROR_BUFFER_LIMIT) {
        output = `\r\n\x1b[90m[Earlier command output omitted]\x1b[0m\r\n${output.slice(-SHELL_MIRROR_BUFFER_LIMIT)}`;
    }
    if (output) mirror.buffer = `${mirror.buffer}${output}`.slice(-SHELL_MIRROR_BUFFER_LIMIT);
    if (['claude-complete', 'codex-complete', 'claude-error', 'codex-error', 'session-aborted'].includes(data?.type)) {
        mirror.completedAt = Date.now();
    }
    return output;
}

const shellMirrorSweep = setInterval(() => {
    const cutoff = Date.now() - SHELL_MIRROR_IDLE_TTL_MS;
    for (const [sessionId, mirror] of shellMirrorSessions) {
        if (Number(mirror.touchedAt || mirror.completedAt || 0) < cutoff) {
            shellMirrorSessions.delete(sessionId);
        }
    }
    while (shellMirrorSessions.size > SHELL_MIRROR_MAX_SESSIONS) {
        let oldestId = null;
        let oldestAt = Infinity;
        for (const [sessionId, mirror] of shellMirrorSessions) {
            const touchedAt = Number(mirror.touchedAt || mirror.completedAt || 0);
            if (touchedAt < oldestAt) {
                oldestAt = touchedAt;
                oldestId = sessionId;
            }
        }
        if (!oldestId) break;
        shellMirrorSessions.delete(oldestId);
    }
}, 60 * 1000);
shellMirrorSweep.unref();

function formatCodexTranscriptForShell(sessionId) {
    const messages = codexTranscriptDb.getMessages(sessionId);
    if (!messages.length) return '';
    const formatted = messages.map((message) => {
        const content = String(message.content || '').replace(/\r?\n/g, '\r\n');
        if (message.role === 'user') return `\x1b[36m> ${content}\x1b[0m\r\n`;
        if (message.role === 'error') return `\x1b[31m[error] ${content}\x1b[0m\r\n`;
        return `\x1b[37m${content}\x1b[0m\r\n`;
    }).join('\r\n');
    return formatted.length <= SHELL_MIRROR_BUFFER_LIMIT
        ? formatted
        : `\x1b[90m[Earlier transcript omitted]\x1b[0m\r\n${formatted.slice(-SHELL_MIRROR_BUFFER_LIMIT)}`;
}

function normalizeDetectedUrl(url) {
    if (!url || typeof url !== 'string') return null;

    const cleaned = url.trim().replace(TRAILING_URL_PUNCTUATION_REGEX, '');
    if (!cleaned) return null;

    try {
        const parsed = new URL(cleaned);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return null;
        }
        return parsed.toString();
    } catch {
        return null;
    }
}

function extractUrlsFromText(value = '') {
    const directMatches = value.match(/https?:\/\/[^\s<>"'`\\\x1b\x07]+/gi) || [];

    // Handle wrapped terminal URLs split across lines by terminal width.
    const wrappedMatches = [];
    const continuationRegex = /^[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+$/;
    const lines = value.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        const startMatch = line.match(/https?:\/\/[^\s<>"'`\\\x1b\x07]+/i);
        if (!startMatch) continue;

        let combined = startMatch[0];
        let j = i + 1;
        while (j < lines.length) {
            const continuation = lines[j].trim();
            if (!continuation) break;
            if (!continuationRegex.test(continuation)) break;
            combined += continuation;
            j++;
        }

        wrappedMatches.push(combined.replace(/\r?\n\s*/g, ''));
    }

    return Array.from(new Set([...directMatches, ...wrappedMatches]));
}

function shouldAutoOpenUrlFromOutput(value = '') {
    const normalized = value.toLowerCase();
    return (
        normalized.includes('browser didn\'t open') ||
        normalized.includes('open this url') ||
        normalized.includes('continue in your browser') ||
        normalized.includes('press enter to open') ||
        normalized.includes('open_url:')
    );
}

function getWebSocketAuthToken(req) {
    const url = new URL(req.url, 'http://localhost');
    const queryToken = url.searchParams.get('token');
    if (queryToken) return queryToken;

    const bearerToken = req.headers.authorization?.split(' ')[1];
    if (bearerToken) return bearerToken;

    return null;
}

function isAdminRequest(req) {
    if (IS_PLATFORM) return true;
    const userId = Number(req.user?.id ?? req.user?.userId);
    return Number.isInteger(userId) && userId === 1;
}

function getShanghaiCalendarDay(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(date);
    const readPart = (type) => parts.find((part) => part.type === type)?.value || '';
    return `${readPart('year')}-${readPart('month')}-${readPart('day')}`;
}

function shiftCalendarDay(day, offsetDays) {
    const date = new Date(`${day}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + offsetDays);
    return date.toISOString().slice(0, 10);
}

// One WebSocket server handles both the HTTP and HTTPS listeners.
const wsMaxPayloadMb = Math.max(1, Math.min(128, Number(process.env.WS_MAX_PAYLOAD_MB || 32)));
const wss = new WebSocketServer({
    noServer: true,
    maxPayload: wsMaxPayloadMb * 1024 * 1024,
    perMessageDeflate: false,
});

function authenticateWebSocketRequest(req) {
        console.log('WebSocket connection attempt to:', sanitizeUrlForLog(req.url));

        // Platform mode: always allow connection
        if (IS_PLATFORM) {
            const user = authenticateWebSocket(null); // Will return first user
            if (!user) {
                console.log('[WARN] Platform mode: No user found in database');
                return false;
            }
            req.user = user;
            console.log('[OK] Platform mode WebSocket authenticated for user:', user.username);
            return true;
        }

        // Normal mode: verify token
        // Browser WebSocket cannot send custom Authorization headers reliably;
        // query token is kept for compatibility and redacted from server logs.
        const token = getWebSocketAuthToken(req);

        // Verify token
        const user = authenticateWebSocket(token);
        if (!user) {
            console.log('[WARN] WebSocket authentication failed');
            return false;
        }

        // Store user info in the request for later use
        req.user = user;
        console.log('[OK] WebSocket authenticated for user:', user.username);
        return true;
}

function attachWebSocketUpgradeListener(httpServer, protocolLabel) {
    httpServer.on('upgrade', (req, socket, head) => {
        console.log(
            `[DEBUG] ${protocolLabel} upgrade request received:`,
            sanitizeUrlForLog(req.url),
            'from',
            socket.remoteAddress,
            'headers:',
            JSON.stringify({ upgrade: req.headers.upgrade, connection: req.headers.connection })
        );

        if (!isAllowedWebSocketOrigin(req, {
            allowedOrigins: process.env.WS_ALLOWED_ORIGINS,
            corsOrigins: process.env.CORS_ORIGIN,
            allowMissingOrigin: process.env.WS_ALLOW_NO_ORIGIN === 'true',
        })) {
            socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
            socket.destroy();
            return;
        }

        if (!authenticateWebSocketRequest(req)) {
            socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
            socket.destroy();
            return;
        }

        wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit('connection', ws, req);
        });
    });
}

attachWebSocketUpgradeListener(server, 'HTTP');
if (secureServer) attachWebSocketUpgradeListener(secureServer, 'HTTPS');

// Make WebSocket server available to routes
app.locals.wss = wss;

// 请求计时中间件：记录所有超过 500ms 的慢请求
app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - start;
        if (duration > 500) {
            console.log(`[SLOW] ${req.method} ${sanitizeUrlForLog(req.originalUrl)} ${duration}ms ${res.statusCode}`);
        }
    });
    next();
});

app.disable('x-powered-by');
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), payment=()');
    next();
});

// gzip 压缩所有响应（JS/CSS 可减少 60-70% 体积，显著加速网页加载）
app.use(compression({ level: 6 }));
const corsOrigins = (process.env.CORS_ORIGIN || '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);
const corsOptions = corsOrigins.length
    ? {
        origin: (origin, callback) => {
            if (!origin || corsOrigins.includes(origin)) {
                return callback(null, true);
            }
            return callback(new Error('Not allowed by CORS'));
        },
        credentials: true
    }
    : { origin: false };
app.use(cors(corsOptions));
app.use(express.json({
    limit: '50mb',
    type: (req) => {
        // Skip multipart/form-data requests (for file uploads like images)
        const contentType = req.headers['content-type'] || '';
        if (contentType.includes('multipart/form-data')) {
            return false;
        }
        return contentType.includes('json');
    }
}));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Public health check endpoint (no authentication required)
app.get('/health', (req, res) => {
    const activeTurns = {
        claude: getActiveClaudeSDKSessions().length,
        codex: getActiveCodexSessions().length,
        cursor: getActiveCursorSessions().length,
        gemini: getActiveGeminiSessions().length,
    };
    const response = {
        status: isDrainingForRestart ? 'draining' : 'ok',
        timestamp: new Date().toISOString(),
        activeTurnCount: Object.values(activeTurns).reduce((sum, count) => sum + count, 0),
    };
    if (process.env.HEALTH_DETAILS === 'true') {
        response.installMode = installMode;
        response.activeTurns = activeTurns;
    }
    res.json(response);
});


// Optional API key validation (if configured)
app.use('/api', validateApiKey);

// Authentication routes (public)
app.use('/api/auth', authRoutes);

// Projects API Routes (protected)
app.use('/api/projects', authenticateToken, projectsRoutes);

// Git API Routes (protected)
app.use('/api/git', authenticateToken, gitRoutes);

// MCP API Routes (protected)
app.use('/api/mcp', authenticateToken, mcpRoutes);

// Cursor API Routes (protected)
app.use('/api/cursor', authenticateToken, cursorRoutes);

// TaskMaster API Routes (protected)
app.use('/api/taskmaster', authenticateToken, taskmasterRoutes);

// MCP utilities
app.use('/api/mcp-utils', authenticateToken, mcpUtilsRoutes);

// Commands API Routes (protected)
app.use('/api/commands', authenticateToken, commandsRoutes);

// Settings API Routes (protected)
app.use('/api/settings', authenticateToken, settingsRoutes);

// CLI Authentication API Routes (protected)
app.use('/api/cli', authenticateToken, cliAuthRoutes);

// User API Routes (protected)
app.use('/api/user', authenticateToken, userRoutes);

// Codex API Routes (protected)
app.use('/api/codex', authenticateToken, codexRoutes);

// Claude API Routes (protected) — 订阅额度 /usage 查询
app.use('/api/claude', authenticateToken, claudeRoutes);

// Gemini API Routes (protected)
app.use('/api/gemini', authenticateToken, geminiRoutes);

// Agent API Routes (uses API key authentication)
app.use('/api/agent', agentRoutes);

// 会话子文件夹（多层嵌套，仅前端视图层归类）
// 鉴权由 foldersRoutes 内部按路径声明，外层不再施加，避免污染 /api/* 命名空间
app.use('/api', foldersRoutes);

// 消息归属查询：返回某 session 内所有 user 消息的 (clientTs → userId) 映射
// 前端在加载会话消息后调用一次，构建 timestamp 索引以渲染对应头像
app.get('/api/sessions/:sessionId/attributions', authenticateToken, (req, res) => {
    try {
        const rows = attributionDb.getBySession(req.params.sessionId);
        res.json({ success: true, attributions: rows });
    } catch (error) {
        console.error('Error loading attributions:', error);
        res.status(500).json({ error: 'Failed to load attributions' });
    }
});

app.get('/api/user/daily-input', authenticateToken, (req, res) => {
    const day = getShanghaiCalendarDay();
    const totals = dailyInputDb.getForDay(req.user.id, day);
    const outputTotals = modelOutputDb.getForDay(req.user.id, day);
    res.json({
        day,
        timeZone: 'Asia/Shanghai',
        userId: Number(req.user.id),
        isAdmin: isAdminRequest(req),
        username: req.user.username,
        ...totals,
        ...outputTotals,
    });
});

app.get('/api/user/daily-input/all', authenticateToken, (req, res) => {
    if (!isAdminRequest(req)) {
        return res.status(403).json({ error: 'Administrator access required' });
    }
    const today = getShanghaiCalendarDay();
    const requestedDay = typeof req.query.day === 'string' ? req.query.day.trim() : '';
    const earliestDay = shiftCalendarDay(today, -364);
    const validRequestedDay = /^\d{4}-\d{2}-\d{2}$/.test(requestedDay)
        && !Number.isNaN(new Date(`${requestedDay}T00:00:00Z`).getTime())
        && new Date(`${requestedDay}T00:00:00Z`).toISOString().slice(0, 10) === requestedDay;
    if (requestedDay && (!validRequestedDay || requestedDay < earliestDay || requestedDay > today)) {
        return res.status(400).json({ error: 'Requested day must be within the last 12 months' });
    }
    const day = requestedDay || today;
    const outputByUser = new Map(
        modelOutputDb.getAllUserTotals(day).map((entry) => [entry.userId, entry]),
    );
    res.json({
        day,
        timeZone: 'Asia/Shanghai',
        users: dailyInputDb.getAllUserTotals(day).map((entry) => ({
            ...entry,
            todayInputTokens: outputByUser.get(entry.userId)?.todayInputTokens || 0,
            todayCachedInputTokens: outputByUser.get(entry.userId)?.todayCachedInputTokens || 0,
            totalInputTokens: outputByUser.get(entry.userId)?.totalInputTokens || 0,
            totalCachedInputTokens: outputByUser.get(entry.userId)?.totalCachedInputTokens || 0,
            todayOutputTokens: outputByUser.get(entry.userId)?.todayOutputTokens || 0,
            totalOutputTokens: outputByUser.get(entry.userId)?.totalOutputTokens || 0,
            todayEstimatedCredits: outputByUser.get(entry.userId)?.todayEstimatedCredits || 0,
            totalEstimatedCredits: outputByUser.get(entry.userId)?.totalEstimatedCredits || 0,
            hasUnknownPricing: outputByUser.get(entry.userId)?.hasUnknownPricing || false,
        })),
    });
});

app.get('/api/user/daily-input/history', authenticateToken, (req, res) => {
    const requestedUserId = Number.parseInt(String(req.query.userId || ''), 10);
    const currentUserId = Number(req.user.id);
    const targetUserId = Number.isInteger(requestedUserId) ? requestedUserId : currentUserId;
    if (!isAdminRequest(req) && targetUserId !== currentUserId) {
        return res.status(403).json({ error: 'You can only view your own input history' });
    }

    const targetUser = userDb.getUserById(targetUserId);
    if (!targetUser) return res.status(404).json({ error: 'User not found' });

    const endDay = getShanghaiCalendarDay();
    const startDay = shiftCalendarDay(endDay, -364);
    const overview = dailyInputDb.getUsageOverview(targetUserId, startDay, endDay);
    const outputOverview = modelOutputDb.getUsageOverview(targetUserId, startDay, endDay);
    const daysByDate = new Map(
        overview.days.map((entry) => [entry.day, { ...entry, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, estimatedCredits: 0, hasUnknownPricing: false }]),
    );
    outputOverview.days.forEach((entry) => {
        const existing = daysByDate.get(entry.day) || { day: entry.day, charCount: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, estimatedCredits: 0, hasUnknownPricing: false };
        existing.inputTokens = entry.inputTokens;
        existing.cachedInputTokens = entry.cachedInputTokens;
        existing.outputTokens = entry.outputTokens;
        existing.estimatedCredits = entry.estimatedCredits;
        existing.hasUnknownPricing = entry.hasUnknownPricing;
        daysByDate.set(entry.day, existing);
    });
    return res.json({
        userId: targetUserId,
        username: targetUser.username,
        timeZone: 'Asia/Shanghai',
        startDay,
        endDay,
        days: Array.from(daysByDate.values()).sort((a, b) => a.day.localeCompare(b.day)),
        summary: {
            ...overview.summary,
            ...outputOverview.summary,
        },
    });
});

app.post('/api/user/daily-input', authenticateToken, (req, res) => {
    const eventId = typeof req.body?.eventId === 'string' ? req.body.eventId.trim() : '';
    const charCount = Number(req.body?.charCount);
    if (!eventId || eventId.length > 160 || !Number.isInteger(charCount) || charCount < 1 || charCount > 100000) {
        return res.status(400).json({ error: 'Invalid daily input event' });
    }

    const day = getShanghaiCalendarDay();
    dailyInputDb.record(req.user.id, eventId, day, charCount);
    return res.json({
        day,
        timeZone: 'Asia/Shanghai',
        username: req.user.username,
        ...dailyInputDb.getForDay(req.user.id, day),
    });
});

// Serve public files (like api-docs.html)
app.use(express.static(path.join(__dirname, '../public')));

// Preserve the current login when moving from the HTTP origin to HTTPS. The
// token stays in the URL fragment, so browsers do not send it to the server.
app.get('/switch-to-https', (req, res) => {
    const secureUrl = `https://${HTTPS_PUBLIC_HOST}:${HTTPS_PORT}/`;
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(`<!doctype html><meta charset="utf-8"><title>Opening secure CCUI</title><script>
      const token = localStorage.getItem('auth-token') || '';
      const target = ${JSON.stringify(secureUrl)} + (token ? '#ccui-auth=' + encodeURIComponent(token) : '');
      location.replace(target);
    </script>`);
});

// 优先服务预压缩静态文件（Brotli > gzip > 原文件）
// 浏览器发送 Accept-Encoding: br 时直接返回 .br 文件，无需实时压缩
app.use((req, res, next) => {
    const distDir = path.join(__dirname, '../dist');
    const acceptEncoding = req.headers['accept-encoding'] || '';
    // 只处理 assets 目录下的 js/css 文件
    if (!req.path.startsWith('/assets/') || !req.path.match(/\.(js|css)$/)) {
        return next();
    }
    const filePath = path.join(distDir, req.path);

    const setAssetHeaders = (res, encoding) => {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        if (encoding) res.setHeader('Content-Encoding', encoding);
        // 告知代理层不同编码是不同响应
        res.setHeader('Vary', 'Accept-Encoding');
        const ext = req.path.endsWith('.css') ? 'text/css' : 'application/javascript';
        res.setHeader('Content-Type', ext);
    };

    if (acceptEncoding.includes('br')) {
        const brPath = filePath + '.br';
        if (fs.existsSync(brPath)) {
            setAssetHeaders(res, 'br');
            return res.sendFile(brPath);
        }
    }
    if (acceptEncoding.includes('gzip')) {
        const gzPath = filePath + '.gz';
        if (fs.existsSync(gzPath)) {
            setAssetHeaders(res, 'gzip');
            return res.sendFile(gzPath);
        }
    }
    next();
});

// Static files served after API routes
// Add cache control: HTML files should not be cached, but assets can be cached
app.use(express.static(path.join(__dirname, '../dist'), {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
            // Prevent HTML caching to avoid service worker issues after builds
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        } else if (filePath.match(/\.(js|css|woff2?|ttf|eot|svg|png|jpg|jpeg|gif|ico)$/)) {
            // Cache static assets for 1 year (they have hashed names)
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
    }
}));

// API Routes (protected)
// /api/config endpoint removed - no longer needed
// Frontend now uses window.location for WebSocket URLs

// System update endpoint
app.post('/api/system/update', authenticateToken, async (req, res) => {
    try {
        if (process.env.ENABLE_SELF_UPDATE !== 'true') {
            return res.status(403).json({
                error: 'Self-update is disabled',
                message: 'Set ENABLE_SELF_UPDATE=true to enable server-side update commands.'
            });
        }

        if (!isAdminRequest(req)) {
            return res.status(403).json({ error: 'Only the admin account can run system updates' });
        }

        // Get the project root directory (parent of server directory)
        const projectRoot = path.join(__dirname, '..');

        console.log('Starting system update from directory:', projectRoot);

        // Run the update command based on install mode
        const updateCommand = installMode === 'git'
            ? 'git checkout main && git pull && npm install'
            : `npm install -g ${packageMetadata.name}@latest`;

        const child = spawn('sh', ['-c', updateCommand], {
            cwd: installMode === 'git' ? projectRoot : os.homedir(),
            env: process.env
        });

        let output = '';
        let errorOutput = '';

        child.stdout.on('data', (data) => {
            const text = data.toString();
            output += text;
            console.log('Update output:', text);
        });

        child.stderr.on('data', (data) => {
            const text = data.toString();
            errorOutput += text;
            console.error('Update error:', text);
        });

        child.on('close', (code) => {
            if (code === 0) {
                res.json({
                    success: true,
                    output: output || 'Update completed successfully',
                    message: 'Update completed. Please restart the server to apply changes.'
                });
            } else {
                res.status(500).json({
                    success: false,
                    error: 'Update command failed',
                    output: output,
                    errorOutput: errorOutput
                });
            }
        });

        child.on('error', (error) => {
            console.error('Update process error:', error);
            res.status(500).json({
                success: false,
                error: error.message
            });
        });

    } catch (error) {
        console.error('System update error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

app.get('/api/projects', authenticateToken, async (req, res) => {
    try {
        // 不传 progressCallback 以启用缓存（progress 仅在文件监听触发时使用）
        const projects = await getProjects();
        // 过滤：只显示 WORKSPACES_ROOT 目录下的项目，防止显示其他用户的项目
        res.json(filterProjectsToWorkspace(projects));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/projects/:projectName/sessions', authenticateToken, async (req, res) => {
    try {
        const { limit = 5, offset = 0 } = req.query;
        const result = await getSessions(req.params.projectName, parseInt(limit), parseInt(offset));
        applyCustomSessionNames(result.sessions, 'claude');
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get messages for a specific session
app.get('/api/projects/:projectName/sessions/:sessionId/messages', authenticateToken, async (req, res) => {
    try {
        const { projectName, sessionId } = req.params;
        const { limit, offset, full } = req.query;

        // Old tabs used unbounded reads for automatic refreshes. Only the
        // current UI's explicit Load All action may request the full transcript.
        const parsedLimit = limit ? parseInt(limit, 10) : full === '1' ? null : 120;
        const parsedOffset = offset ? parseInt(offset, 10) : 0;

        const result = await getSessionMessages(projectName, sessionId, parsedLimit, parsedOffset);

        // Handle both old and new response formats
        if (Array.isArray(result)) {
            // Backward compatibility: no pagination parameters were provided
            res.json({ messages: result });
        } else {
            // New format with pagination info
            res.json(result);
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Rename project endpoint
app.put('/api/projects/:projectName/rename', authenticateToken, async (req, res) => {
    try {
        const { displayName } = req.body;
        await renameProject(req.params.projectName, displayName);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Delete session endpoint
app.delete('/api/projects/:projectName/sessions/:sessionId', authenticateToken, async (req, res) => {
    try {
        const { projectName, sessionId } = req.params;
        console.log(`[API] Deleting session: ${sessionId} from project: ${projectName}`);
        await deleteSession(projectName, sessionId);
        invalidateProjectsCache();
        console.log(`[API] Session ${sessionId} deleted successfully`);
        res.json({ success: true });
    } catch (error) {
        console.error(`[API] Error deleting session ${req.params.sessionId}:`, error);
        res.status(500).json({ error: error.message });
    }
});

// Rename session endpoint
app.put('/api/sessions/:sessionId/rename', authenticateToken, async (req, res) => {
    try {
        const { sessionId } = req.params;
        const safeSessionId = String(sessionId).replace(/[^a-zA-Z0-9._-]/g, '');
        if (!safeSessionId || safeSessionId !== String(sessionId)) {
            return res.status(400).json({ error: 'Invalid sessionId' });
        }
        const { summary, provider } = req.body;
        if (!summary || typeof summary !== 'string' || summary.trim() === '') {
            return res.status(400).json({ error: 'Summary is required' });
        }
        if (summary.trim().length > 500) {
            return res.status(400).json({ error: 'Summary must not exceed 500 characters' });
        }
        if (!provider || !VALID_PROVIDERS.includes(provider)) {
            return res.status(400).json({ error: `Provider must be one of: ${VALID_PROVIDERS.join(', ')}` });
        }
        sessionNamesDb.setName(safeSessionId, provider, summary.trim());
        res.json({ success: true });
    } catch (error) {
        console.error(`[API] Error renaming session ${req.params.sessionId}:`, error);
        res.status(500).json({ error: error.message });
    }
});

// Delete project endpoint (force=true to delete with sessions)
app.delete('/api/projects/:projectName', authenticateToken, async (req, res) => {
    try {
        const { projectName } = req.params;
        const force = req.query.force === 'true';
        await deleteProject(projectName, force);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Create project endpoint
app.post('/api/projects/create', authenticateToken, async (req, res) => {
    try {
        const { path: projectPath } = req.body;

        if (!projectPath || !projectPath.trim()) {
            return res.status(400).json({ error: 'Project path is required' });
        }

        const validation = await validateWorkspacePath(projectPath.trim());
        if (!validation.valid) {
            return res.status(403).json({ error: validation.error });
        }

        const project = await addProjectManually(validation.resolvedPath);
        res.json({ success: true, project });
    } catch (error) {
        console.error('Error creating project:', error);
        res.status(500).json({ error: error.message });
    }
});

const expandWorkspacePath = (inputPath) => {
    if (!inputPath) return inputPath;
    if (inputPath === '~') {
        return WORKSPACES_ROOT;
    }
    if (inputPath.startsWith('~/') || inputPath.startsWith('~\\')) {
        return path.join(WORKSPACES_ROOT, inputPath.slice(2));
    }
    return inputPath;
};

// Browse filesystem endpoint for project suggestions - uses existing getFileTree
app.get('/api/browse-filesystem', authenticateToken, async (req, res) => {
    try {
        const { path: dirPath } = req.query;

        console.log('[API] Browse filesystem request for path:', dirPath);
        console.log('[API] WORKSPACES_ROOT is:', WORKSPACES_ROOT);
        // Default to home directory if no path provided
        const defaultRoot = WORKSPACES_ROOT;
        let targetPath = dirPath ? expandWorkspacePath(dirPath) : defaultRoot;

        // Resolve and normalize the path
        targetPath = path.resolve(targetPath);

        // Security check - only browse within the configured workspace root.
        const pathValidation = await validateWorkspacePath(targetPath);
        if (!pathValidation.valid) {
            return res.status(403).json({ error: pathValidation.error });
        }

        const normalizedTarget = path.normalize(targetPath);
        const isForbidden = FORBIDDEN_PATHS.includes(normalizedTarget) ||
            FORBIDDEN_PATHS.some(f => normalizedTarget === f || normalizedTarget.startsWith(f + path.sep) &&
                !(f === '/var' && (normalizedTarget.startsWith('/var/tmp') || normalizedTarget.startsWith('/var/folders'))));
        if (isForbidden) {
            return res.status(403).json({ error: 'Cannot browse system-critical directories' });
        }
        const resolvedPath = pathValidation.resolvedPath;

        // Security check - ensure path is accessible
        try {
            await fs.promises.access(resolvedPath);
            const stats = await fs.promises.stat(resolvedPath);

            if (!stats.isDirectory()) {
                return res.status(400).json({ error: 'Path is not a directory' });
            }
        } catch (err) {
            return res.status(404).json({ error: 'Directory not accessible' });
        }

        // Use existing getFileTree function with shallow depth (only direct children)
        const fileTree = await getFileTree(resolvedPath, 1, 0, false); // maxDepth=1, showHidden=false

        // Filter only directories and format for suggestions
        const directories = fileTree
            .filter(item => item.type === 'directory')
            .map(item => ({
                path: item.path,
                name: item.name,
                type: 'directory'
            }))
            .sort((a, b) => {
                const aHidden = a.name.startsWith('.');
                const bHidden = b.name.startsWith('.');
                if (aHidden && !bHidden) return 1;
                if (!aHidden && bHidden) return -1;
                return a.name.localeCompare(b.name);
            });

        // Add common directories if browsing home directory
        const suggestions = [];
        let resolvedWorkspaceRoot = defaultRoot;
        try {
            resolvedWorkspaceRoot = await fsPromises.realpath(defaultRoot);
        } catch (error) {
            // Use default root as-is if realpath fails
        }
        if (resolvedPath === resolvedWorkspaceRoot) {
            const commonDirs = ['Desktop', 'Documents', 'Projects', 'Development', 'Dev', 'Code', 'workspace'];
            const existingCommon = directories.filter(dir => commonDirs.includes(dir.name));
            const otherDirs = directories.filter(dir => !commonDirs.includes(dir.name));

            suggestions.push(...existingCommon, ...otherDirs);
        } else {
            suggestions.push(...directories);
        }

        res.json({
            path: resolvedPath,
            suggestions: suggestions
        });

    } catch (error) {
        console.error('Error browsing filesystem:', error);
        res.status(500).json({ error: 'Failed to browse filesystem' });
    }
});

app.post('/api/create-folder', authenticateToken, async (req, res) => {
    try {
        const { path: folderPath } = req.body;
        if (!folderPath) {
            return res.status(400).json({ error: 'Path is required' });
        }
        const expandedPath = expandWorkspacePath(folderPath);
        const resolvedInput = path.resolve(expandedPath);
        const validation = await validateWorkspacePath(resolvedInput);
        if (!validation.valid) {
            return res.status(403).json({ error: validation.error });
        }
        const targetPath = validation.resolvedPath || resolvedInput;
        const parentDir = path.dirname(targetPath);
        try {
            await fs.promises.access(parentDir);
        } catch (err) {
            return res.status(404).json({ error: 'Parent directory does not exist' });
        }
        try {
            await fs.promises.access(targetPath);
            return res.status(409).json({ error: 'Folder already exists' });
        } catch (err) {
            // Folder doesn't exist, which is what we want
        }
        try {
            await fs.promises.mkdir(targetPath, { recursive: false });
            res.json({ success: true, path: targetPath });
        } catch (mkdirError) {
            if (mkdirError.code === 'EEXIST') {
                return res.status(409).json({ error: 'Folder already exists' });
            }
            throw mkdirError;
        }
    } catch (error) {
        console.error('Error creating folder:', error);
        res.status(500).json({ error: 'Failed to create folder' });
    }
});

// Read file content endpoint
app.get('/api/projects/:projectName/file', authenticateToken, async (req, res) => {
    try {
        const { projectName } = req.params;
        const { filePath } = req.query;


        // Files 页面允许绝对路径；相对路径仍按当前项目根目录解析。
        if (!filePath) {
            return res.status(400).json({ error: 'Invalid file path' });
        }

        const projectRoot = await extractProjectDirectory(projectName).catch(() => null);
        if (!projectRoot) {
            return res.status(404).json({ error: 'Project not found' });
        }

        const validation = await resolveFilePagePath(projectRoot, filePath);
        if (!validation.valid) {
            return res.status(403).json({ error: validation.error });
        }
        const resolved = validation.resolved;

        const content = await fsPromises.readFile(resolved, 'utf8');
        res.json({ content, path: resolved });
    } catch (error) {
        console.error('Error reading file:', error);
        if (error.code === 'ENOENT') {
            res.status(404).json({ error: 'File not found' });
        } else if (error.code === 'EACCES') {
            res.status(403).json({ error: 'Permission denied' });
        } else {
            res.status(500).json({ error: error.message });
        }
    }
});

// Serve binary file content endpoint (for images, etc.)
app.get('/api/projects/:projectName/files/content', authenticateToken, async (req, res) => {
    try {
        const { projectName } = req.params;
        const { path: filePath } = req.query;


        // Files 页面允许绝对路径；相对路径仍按当前项目根目录解析。
        if (!filePath) {
            return res.status(400).json({ error: 'Invalid file path' });
        }

        const projectRoot = await extractProjectDirectory(projectName).catch(() => null);
        if (!projectRoot) {
            return res.status(404).json({ error: 'Project not found' });
        }

        const validation = await resolveFilePagePath(projectRoot, filePath);
        if (!validation.valid) {
            return res.status(403).json({ error: validation.error });
        }
        const resolved = validation.resolved;

        // Check if file exists
        try {
            await fsPromises.access(resolved);
        } catch (error) {
            return res.status(404).json({ error: 'File not found' });
        }

        // Get file extension and set appropriate content type
        const mimeType = mime.lookup(resolved) || 'application/octet-stream';
        res.setHeader('Content-Type', mimeType);

        // Stream the file
        const fileStream = fs.createReadStream(resolved);
        fileStream.pipe(res);

        fileStream.on('error', (error) => {
            console.error('Error streaming file:', error);
            if (!res.headersSent) {
                res.status(500).json({ error: 'Error reading file' });
            }
        });

    } catch (error) {
        console.error('Error serving binary file:', error);
        if (!res.headersSent) {
            res.status(500).json({ error: error.message });
        }
    }
});

// 图片快照目录（与会话数据同级，持久化保存历史图片版本）
const IMAGE_SNAPSHOT_DIR = path.join(__dirname, '../data/image-snapshots');

// 服务器图片直出接口（需鉴权）：
// 仅允许读取 WORKSPACES_ROOT 内的图片文件；支持快照模式防止历史消息图片被覆盖。
app.get('/api/image', authenticateToken, async (req, res) => {
    try {
        const { path: filePath, t: tsParam, snapshot } = req.query;

        if (!filePath || typeof filePath !== 'string') {
            return res.status(400).json({ error: 'Missing path parameter' });
        }

        const resolvedWorkspaceRoot = await fsPromises
            .realpath(WORKSPACES_ROOT)
            .catch(() => path.resolve(WORKSPACES_ROOT));
        const resolvedWorkspaceRootPrefix = resolvedWorkspaceRoot.endsWith(path.sep)
            ? resolvedWorkspaceRoot
            : resolvedWorkspaceRoot + path.sep;

        const resolvedInput = path.resolve(filePath);
        let realFilePath;
        try {
            realFilePath = await fsPromises.realpath(resolvedInput);
        } catch (error) {
            if (error?.code === 'ENOENT') {
                return res.status(404).json({ error: 'File not found' });
            }
            throw error;
        }

        if (
            realFilePath !== resolvedWorkspaceRoot &&
            !realFilePath.startsWith(resolvedWorkspaceRootPrefix)
        ) {
            return res.status(403).json({ error: 'Access denied' });
        }

        const relativeFilePath = path.relative(resolvedWorkspaceRoot, realFilePath);
        if (relativeFilePath.startsWith('..') || path.isAbsolute(relativeFilePath)) {
            return res.status(403).json({ error: 'Access denied' });
        }

        // 只允许图片格式
        const ext = path.extname(realFilePath).toLowerCase();
        const allowedExts = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp'];
        if (!allowedExts.includes(ext)) {
            return res.status(403).json({ error: 'File type not allowed' });
        }

        // ── 快照模式：消息时间戳作为稳定 key ──────────────────────────────
        // snapshot=1 且 t 为有效的消息时间戳（> 2020年）时启用
        const msgTs = parseInt(tsParam, 10);
        const useSnapshot = snapshot === '1' && msgTs > 1577836800000; // > 2020-01-01

        if (useSnapshot) {
            // 快照路径：data/image-snapshots/<msgTs>/<workspace-relative path>
            const snapshotPath = path.join(IMAGE_SNAPSHOT_DIR, String(msgTs), relativeFilePath);

            // 若快照已存在，直接返回（永久缓存，内容不会再变）
            const snapshotExists = await fsPromises.access(snapshotPath).then(() => true).catch(() => false);
            if (snapshotExists) {
                const mimeType = mime.lookup(snapshotPath) || 'image/png';
                res.setHeader('Content-Type', mimeType);
                res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
                return fs.createReadStream(snapshotPath).pipe(res);
            }

            // 快照不存在：读取原文件并保存快照
            let sourceStat;
            try { sourceStat = await fsPromises.stat(realFilePath); } catch {
                return res.status(404).json({ error: 'File not found' });
            }
            // 只快照实际图片文件（非目录）
            if (sourceStat.isFile()) {
                try {
                    await fsPromises.mkdir(path.dirname(snapshotPath), { recursive: true });
                    await fsPromises.copyFile(realFilePath, snapshotPath);
                } catch (copyErr) {
                    console.warn('[image-snapshot] copy failed:', copyErr.message);
                    // 快照失败不影响图片正常展示，继续走实时文件逻辑
                }
                // 快照成功，返回快照文件
                const snapshotOk = await fsPromises.access(snapshotPath).then(() => true).catch(() => false);
                if (snapshotOk) {
                    const mimeType = mime.lookup(snapshotPath) || 'image/png';
                    res.setHeader('Content-Type', mimeType);
                    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
                    return fs.createReadStream(snapshotPath).pipe(res);
                }
            }
            // 快照失败时降级为实时文件（下方继续处理）
        }

        // ── 实时文件模式（无快照或快照降级）────────────────────────────────
        let stat;
        try {
            stat = await fsPromises.stat(realFilePath);
        } catch {
            return res.status(404).json({ error: 'File not found' });
        }

        const mimeType = mime.lookup(realFilePath) || 'image/png';
        const etag = `"${stat.mtimeMs.toString(36)}-${stat.size.toString(36)}"`;
        const lastModified = stat.mtime.toUTCString();

        res.setHeader('Content-Type', mimeType);
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('ETag', etag);
        res.setHeader('Last-Modified', lastModified);

        const ifNoneMatch = req.headers['if-none-match'];
        const ifModifiedSince = req.headers['if-modified-since'];
        if (
            (ifNoneMatch && ifNoneMatch === etag) ||
            (!ifNoneMatch && ifModifiedSince && new Date(ifModifiedSince) >= stat.mtime)
        ) {
            return res.status(304).end();
        }

        const fileStream = fs.createReadStream(realFilePath);
        fileStream.pipe(res);
        fileStream.on('error', (err) => {
            console.error('Image stream error:', err);
            if (!res.headersSent) res.status(500).json({ error: 'Read error' });
        });
    } catch (error) {
        console.error('Error serving image:', error);
        if (!res.headersSent) res.status(500).json({ error: error.message });
    }
});

// ── CPU 利用率：缓存上一次 /proc/stat 采样（两次差值计算瞬时占用）──
let _lastCpuStat = null;
function readProcCpuStat() {
    try {
        const line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0];
        const parts = line.trim().split(/\s+/).slice(1).map(Number);
        const idle  = parts[3] + (parts[4] || 0); // idle + iowait
        const total = parts.reduce((a, b) => a + b, 0);
        return { idle, total };
    } catch { return null; }
}

// ── 系统实时统计接口（供 HUD 面板使用，需鉴权）────────────────
// 使用已在顶部导入的 os 和 spawn（ESM 模块，不能用 require）
// 5s 服务端缓存：ps/nvidia-smi 在高负载系统上可能耗时 2-3s，多客户端频繁轮询会让
// Node 事件循环持续被阻塞；缓存让同一周期内所有请求直接返回上次结果，大幅降低开销。
let _sysStatsCache = null;
let _sysStatsCacheAt = 0;
let _sysStatsInFlight = null;
const SYS_STATS_CACHE_TTL = 15000; // ms

app.get('/api/sys-stats', authenticateToken, async (req, res) => {
    // 缓存命中：直接返回，不再启动子进程
    if (_sysStatsCache && (Date.now() - _sysStatsCacheAt) < SYS_STATS_CACHE_TTL) {
        return res.json(_sysStatsCache);
    }
    if (_sysStatsInFlight) {
        try {
            return res.json(await _sysStatsInFlight);
        } catch (err) {
            return res.status(500).json({ error: err.message });
        }
    }

    _sysStatsInFlight = (async () => {
      try {
        // ── RAM（同步，os 模块） ──
        const totalMem = os.totalmem();
        const freeMem  = os.freemem();
        const usedMem  = totalMem - freeMem;

        // ── 运行子进程的辅助函数 ──
        const runCmd = (cmd, args, timeoutMs = 3000) =>
            new Promise((resolve) => {
                let out = '';
                const proc = spawn(cmd, args, { timeout: timeoutMs });
                proc.stdout.on('data', d => { out += d.toString(); });
                proc.on('close', () => resolve(out.trim()));
                proc.on('error', () => resolve(''));
                setTimeout(() => { proc.kill(); resolve(''); }, timeoutMs);
            });

        // ── 按系统账号汇总全部进程 RSS ──
        // 单进程 Top N 会漏掉“同一账号启动几十个中小进程”的高总占用。
        // RSS 由 ps 以 KiB 返回；这里按 USER 求和并附带进程数，再按总量降序。
        let memoryByUser = [];
        try {
            const raw = await runCmd('ps', ['-eo', 'user:32=,rss=']);
            const totals = new Map();
            for (const line of raw.split('\n')) {
                const match = line.trim().match(/^(\S+)\s+(\d+)$/);
                if (!match) continue;
                const user = match[1];
                const rssKiB = Number(match[2]);
                if (!Number.isFinite(rssKiB) || rssKiB < 0) continue;
                const previous = totals.get(user) || { rssKiB: 0, processCount: 0 };
                previous.rssKiB += rssKiB;
                previous.processCount += 1;
                totals.set(user, previous);
            }
            memoryByUser = Array.from(totals, ([user, usage]) => {
                const bytes = usage.rssKiB * 1024;
                return {
                    user,
                    bytes,
                    pct: Number((bytes / totalMem * 100).toFixed(2)),
                    processCount: usage.processCount,
                };
            }).sort((a, b) => b.bytes - a.bytes || a.user.localeCompare(b.user));
        } catch (_) {}

        // ── CPU 利用率（两次 /proc/stat 差值）──
        const curCpu = readProcCpuStat();
        let cpuPct = 0;
        if (_lastCpuStat && curCpu) {
            const dTotal = curCpu.total - _lastCpuStat.total;
            const dIdle  = curCpu.idle  - _lastCpuStat.idle;
            cpuPct = dTotal > 0 ? Math.round((1 - dIdle / dTotal) * 100) : 0;
        }
        _lastCpuStat = curCpu;

        // ── 所有 GPU（nvidia-smi，每张卡一行）──
        let gpus = null;
        try {
            const gpuRaw = await runCmd('nvidia-smi', [
                '--query-gpu=memory.used,memory.total,utilization.gpu',
                '--format=csv,noheader,nounits',
            ]);
            if (gpuRaw) {
                const rows = gpuRaw.split('\n').filter(l => l.trim());
                const parsed = rows.map(line => {
                    const [used, total, util] = line.split(',').map(s => parseFloat(s.trim()));
                    return (!isNaN(used) && !isNaN(total))
                        ? { used: Math.round(used), total: Math.round(total), util: Math.round(util || 0) }
                        : null;
                }).filter(Boolean);
                if (parsed.length) gpus = parsed;
            }
        } catch (_) {}

        const payload = {
            ram: {
                total: totalMem,
                used:  usedMem,
                free:  freeMem,
                pct:   parseFloat((usedMem / totalMem * 100).toFixed(1)),
            },
            cpu: cpuPct,
            gpus,
            memoryByUser,
        };
        _sysStatsCache = payload;
        _sysStatsCacheAt = Date.now();
        return payload;
      } catch (err) {
        throw err;
      }
    })();

    try {
        return res.json(await _sysStatsInFlight);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    } finally {
        _sysStatsInFlight = null;
    }
});

// Save file content endpoint
app.put('/api/projects/:projectName/file', authenticateToken, async (req, res) => {
    try {
        const { projectName } = req.params;
        const { filePath, content } = req.body;


        // Files 页面允许绝对路径；相对路径仍按当前项目根目录解析。
        if (!filePath) {
            return res.status(400).json({ error: 'Invalid file path' });
        }

        if (content === undefined) {
            return res.status(400).json({ error: 'Content is required' });
        }

        const projectRoot = await extractProjectDirectory(projectName).catch(() => null);
        if (!projectRoot) {
            return res.status(404).json({ error: 'Project not found' });
        }

        const validation = await resolveFilePagePath(projectRoot, filePath);
        if (!validation.valid) {
            return res.status(403).json({ error: validation.error });
        }
        const resolved = validation.resolved;

        await retryFileOperationWithOwnerWriteAccess(
            () => fsPromises.writeFile(resolved, content, 'utf8'),
            [resolved, path.dirname(resolved)]
        );

        res.json({
            success: true,
            path: resolved,
            message: 'File saved successfully'
        });
    } catch (error) {
        console.error('Error saving file:', error);
        if (error.code === 'ENOENT') {
            res.status(404).json({ error: 'File or directory not found' });
        } else if (isFilesystemPermissionError(error)) {
            sendFilePermissionError(res, req.body?.filePath || 'target file');
        } else {
            res.status(500).json({ error: error.message });
        }
    }
});

app.get('/api/projects/:projectName/files', authenticateToken, async (req, res) => {
    try {

        // Using fsPromises from import

        // Use extractProjectDirectory to get the actual project path
        let actualPath;
        try {
            actualPath = await extractProjectDirectory(req.params.projectName);
        } catch (error) {
            console.error('Error extracting project directory:', error);
            // Fallback to simple dash replacement
            actualPath = req.params.projectName.replace(/-/g, '/');
        }

        // Check if path exists
        try {
            await fsPromises.access(actualPath);
        } catch (e) {
            return res.status(404).json({ error: `Project path not found: ${actualPath}` });
        }

        // 支持懒加载：前端传入绝对路径请求子目录内容
        const rootValidation = await resolveFilePagePath(actualPath, '.');
        if (!rootValidation.valid) {
            return res.status(403).json({ error: rootValidation.error });
        }

        const requestPath = req.query.path;
        const normalizedRoot = rootValidation.resolved;
        let targetDir = normalizedRoot;
        if (requestPath && requestPath !== '/') {
            const pathValidation = await resolveFilePagePath(normalizedRoot, requestPath);
            if (!pathValidation.valid) {
                return res.status(403).json({ error: pathValidation.error });
            }
            targetDir = pathValidation.resolved;
        }
        const searchQuery = typeof req.query.search === 'string' ? req.query.search.trim() : '';
        if (searchQuery) {
            const completeTree = await getFileTree(targetDir, 24, 0, true);
            const files = filterAndRankFileTree(completeTree, searchQuery, normalizedRoot);
            return res.json(files);
        }

        const requestedDepth = Number.parseInt(String(req.query.depth ?? '0'), 10);
        const depth = Number.isFinite(requestedDepth)
            ? Math.max(0, Math.min(requestedDepth, 3))
            : 0;
        const files = await getFileTree(targetDir, depth, 0, true);
        res.json(files);
    } catch (error) {
        console.error('[ERROR] File tree error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Files can browse absolute paths only when they remain inside WORKSPACES_ROOT.
app.get('/api/browse', authenticateToken, async (req, res) => {
    try {
        const requestPath = req.query.path;
        if (!requestPath || !path.isAbsolute(requestPath)) {
            return res.status(400).json({ error: 'Absolute path required' });
        }
        const targetDir = path.resolve(requestPath);
        const pathValidation = await resolveFilePagePath(targetDir, '.');
        if (!pathValidation.valid) {
            return res.status(403).json({ error: pathValidation.error });
        }

        try {
            await fsPromises.access(pathValidation.resolved);
        } catch {
            return res.status(404).json({ error: 'Path not found' });
        }
        // 只取一层深度，快速响应
        const files = await getFileTree(pathValidation.resolved, 1, 0, true);
        console.log(`[DEBUG] /api/browse ${pathValidation.resolved} → ${files.length} items`);
        res.json(files);
    } catch (error) {
        console.error('[ERROR] Browse error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================================
// FILE OPERATIONS API ENDPOINTS
// ============================================================================

async function resolveFilePagePath(projectRoot, targetPath) {
    try {
        const workspace = await resolvePathWithinRoot(WORKSPACES_ROOT, projectRoot, { allowMissing: false });
        const target = await resolvePathWithinRoot(workspace.path, targetPath, { allowMissing: true });
        return { valid: true, resolved: target.path };
    } catch (error) {
        return { valid: false, error: `Path validation failed: ${error.message}` };
    }
}

function isFilesystemPermissionError(error) {
    return error && (error.code === 'EACCES' || error.code === 'EPERM');
}

async function addOwnerWritePermissionIfPossible(targetPath) {
    if (!targetPath || typeof process.getuid !== 'function') {
        return false;
    }

    try {
        const stats = await fsPromises.stat(targetPath);
        if (stats.uid !== process.getuid()) {
            return false;
        }

        const ownerWriteBit = stats.isDirectory() ? 0o700 : 0o600;
        const nextMode = stats.mode | ownerWriteBit;
        if (nextMode === stats.mode) {
            return false;
        }

        await fsPromises.chmod(targetPath, nextMode);
        return true;
    } catch {
        return false;
    }
}

async function retryFileOperationWithOwnerWriteAccess(operation, writablePaths) {
    try {
        return await operation();
    } catch (error) {
        if (!isFilesystemPermissionError(error)) {
            throw error;
        }

        let changedPermission = false;
        for (const writablePath of writablePaths) {
            changedPermission = (await addOwnerWritePermissionIfPossible(writablePath)) || changedPermission;
        }

        if (!changedPermission) {
            throw error;
        }

        return operation();
    }
}

function sendFilePermissionError(res, targetPath) {
    return res.status(403).json({
        error: `Permission denied: the server process cannot write to ${targetPath}`,
    });
}

/**
 * Validate filename - check for invalid characters
 * @param {string} name - The filename to validate
 * @returns {{ valid: boolean, error?: string }}
 */
function validateFilename(name) {
    if (!name || !name.trim()) {
        return { valid: false, error: 'Filename cannot be empty' };
    }
    // Check for invalid characters (Windows + Unix)
    const invalidChars = /[<>:"/\\|?*\x00-\x1f]/;
    if (invalidChars.test(name)) {
        return { valid: false, error: 'Filename contains invalid characters' };
    }
    // Check for reserved names (Windows)
    const reserved = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
    if (reserved.test(name)) {
        return { valid: false, error: 'Filename is a reserved name' };
    }
    // Check for dots only
    if (/^\.+$/.test(name)) {
        return { valid: false, error: 'Filename cannot be only dots' };
    }
    return { valid: true };
}

// POST /api/projects/:projectName/files/create - Create new file or directory
app.post('/api/projects/:projectName/files/create', authenticateToken, async (req, res) => {
    try {
        const { projectName } = req.params;
        const { path: parentPath, type, name } = req.body;

        // Validate input
        if (!name || !type) {
            return res.status(400).json({ error: 'Name and type are required' });
        }

        if (!['file', 'directory'].includes(type)) {
            return res.status(400).json({ error: 'Type must be "file" or "directory"' });
        }

        const nameValidation = validateFilename(name);
        if (!nameValidation.valid) {
            return res.status(400).json({ error: nameValidation.error });
        }

        // Get project root
        const projectRoot = await extractProjectDirectory(projectName).catch(() => null);
        if (!projectRoot) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Build and validate target path
        const targetDir = parentPath || '';
        const targetPath = targetDir ? path.join(targetDir, name) : name;
        const validation = await resolveFilePagePath(projectRoot, targetPath);
        if (!validation.valid) {
            return res.status(403).json({ error: validation.error });
        }

        const resolvedPath = validation.resolved;

        // Check if already exists
        try {
            await fsPromises.access(resolvedPath);
            return res.status(409).json({ error: `${type === 'file' ? 'File' : 'Directory'} already exists` });
        } catch {
            // Doesn't exist, which is what we want
        }

        const createEntry = async () => {
            if (type === 'directory') {
                await fsPromises.mkdir(resolvedPath, { recursive: false });
                return;
            }

            const parentDir = path.dirname(resolvedPath);
            try {
                await fsPromises.access(parentDir);
            } catch {
                await fsPromises.mkdir(parentDir, { recursive: true });
            }
            await fsPromises.writeFile(resolvedPath, '', 'utf8');
        };

        await retryFileOperationWithOwnerWriteAccess(createEntry, [path.dirname(resolvedPath)]);

        res.json({
            success: true,
            path: resolvedPath,
            name,
            type,
            message: `${type === 'file' ? 'File' : 'Directory'} created successfully`
        });
    } catch (error) {
        console.error('Error creating file/directory:', error);
        if (isFilesystemPermissionError(error)) {
            sendFilePermissionError(res, req.body?.path || 'target directory');
        } else if (error.code === 'ENOENT') {
            res.status(404).json({ error: 'Parent directory not found' });
        } else {
            res.status(500).json({ error: error.message });
        }
    }
});

// PUT /api/projects/:projectName/files/rename - Rename file or directory
app.put('/api/projects/:projectName/files/rename', authenticateToken, async (req, res) => {
    try {
        const { projectName } = req.params;
        const { oldPath, newName } = req.body;

        // Validate input
        if (!oldPath || !newName) {
            return res.status(400).json({ error: 'oldPath and newName are required' });
        }

        const nameValidation = validateFilename(newName);
        if (!nameValidation.valid) {
            return res.status(400).json({ error: nameValidation.error });
        }

        // Get project root
        const projectRoot = await extractProjectDirectory(projectName).catch(() => null);
        if (!projectRoot) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Validate old path
        const oldValidation = await resolveFilePagePath(projectRoot, oldPath);
        if (!oldValidation.valid) {
            return res.status(403).json({ error: oldValidation.error });
        }

        const resolvedOldPath = oldValidation.resolved;

        // Check if old path exists
        try {
            await fsPromises.access(resolvedOldPath);
        } catch {
            return res.status(404).json({ error: 'File or directory not found' });
        }

        // Build and validate new path
        const parentDir = path.dirname(resolvedOldPath);
        const resolvedNewPath = path.join(parentDir, newName);
        const newValidation = await resolveFilePagePath(projectRoot, resolvedNewPath);
        if (!newValidation.valid) {
            return res.status(403).json({ error: newValidation.error });
        }

        // Check if new path already exists
        try {
            await fsPromises.access(resolvedNewPath);
            return res.status(409).json({ error: 'A file or directory with this name already exists' });
        } catch {
            // Doesn't exist, which is what we want
        }

        await retryFileOperationWithOwnerWriteAccess(
            () => fsPromises.rename(resolvedOldPath, resolvedNewPath),
            [path.dirname(resolvedOldPath), path.dirname(resolvedNewPath)]
        );

        res.json({
            success: true,
            oldPath: resolvedOldPath,
            newPath: resolvedNewPath,
            newName,
            message: 'Renamed successfully'
        });
    } catch (error) {
        console.error('Error renaming file/directory:', error);
        if (isFilesystemPermissionError(error)) {
            sendFilePermissionError(res, req.body?.oldPath || 'target file');
        } else if (error.code === 'ENOENT') {
            res.status(404).json({ error: 'File or directory not found' });
        } else if (error.code === 'EXDEV') {
            res.status(400).json({ error: 'Cannot move across different filesystems' });
        } else {
            res.status(500).json({ error: error.message });
        }
    }
});

// PUT /api/projects/:projectName/files/move - Move file or directory to a different directory
app.put('/api/projects/:projectName/files/move', authenticateToken, async (req, res) => {
    try {
        const { projectName } = req.params;
        const { sourcePath, targetDir } = req.body;

        if (!sourcePath || !targetDir) {
            return res.status(400).json({ error: 'sourcePath and targetDir are required' });
        }

        const projectRoot = await extractProjectDirectory(projectName).catch(() => null);
        if (!projectRoot) {
            return res.status(404).json({ error: 'Project not found' });
        }

        const sourceValidation = await resolveFilePagePath(projectRoot, sourcePath);
        if (!sourceValidation.valid) {
            return res.status(403).json({ error: sourceValidation.error });
        }
        const resolvedSource = sourceValidation.resolved;

        try {
            await fsPromises.access(resolvedSource);
        } catch {
            return res.status(404).json({ error: 'Source file or directory not found' });
        }

        const targetValidation = await resolveFilePagePath(projectRoot, targetDir);
        if (!targetValidation.valid) {
            return res.status(403).json({ error: targetValidation.error });
        }
        const resolvedTarget = targetValidation.resolved;

        try {
            const stat = await fsPromises.stat(resolvedTarget);
            if (!stat.isDirectory()) {
                return res.status(400).json({ error: 'Target must be a directory' });
            }
        } catch {
            return res.status(404).json({ error: 'Target directory not found' });
        }

        const sourceName = path.basename(resolvedSource);
        const resolvedNewPath = path.join(resolvedTarget, sourceName);

        // 禁止将目录移动到其自身或子目录中
        if (resolvedNewPath === resolvedSource || resolvedNewPath.startsWith(resolvedSource + path.sep)) {
            return res.status(400).json({ error: 'Cannot move a directory into itself' });
        }

        // 已在目标目录中（无需移动）
        if (path.dirname(resolvedSource) === resolvedTarget) {
            return res.status(400).json({ error: 'Source is already in the target directory' });
        }

        try {
            await fsPromises.access(resolvedNewPath);
            return res.status(409).json({ error: 'A file or directory with this name already exists in the target' });
        } catch {
            // 目标路径不存在，可以移动
        }

        await retryFileOperationWithOwnerWriteAccess(
            () => fsPromises.rename(resolvedSource, resolvedNewPath),
            [path.dirname(resolvedSource), resolvedTarget]
        );

        res.json({ success: true, sourcePath: resolvedSource, newPath: resolvedNewPath });
    } catch (error) {
        console.error('Error moving file/directory:', error);
        if (isFilesystemPermissionError(error)) {
            sendFilePermissionError(res, req.body?.sourcePath || 'target file');
        } else if (error.code === 'ENOENT') {
            res.status(404).json({ error: 'File or directory not found' });
        } else if (error.code === 'EXDEV') {
            res.status(400).json({ error: 'Cannot move across different filesystems' });
        } else {
            res.status(500).json({ error: error.message });
        }
    }
});

// DELETE /api/projects/:projectName/files - Delete file or directory
app.delete('/api/projects/:projectName/files', authenticateToken, async (req, res) => {
    try {
        const { projectName } = req.params;
        const { path: targetPath, type } = req.body;

        // Validate input
        if (!targetPath) {
            return res.status(400).json({ error: 'Path is required' });
        }

        // Get project root
        const projectRoot = await extractProjectDirectory(projectName).catch(() => null);
        if (!projectRoot) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Validate path
        const validation = await resolveFilePagePath(projectRoot, targetPath);
        if (!validation.valid) {
            return res.status(403).json({ error: validation.error });
        }

        const resolvedPath = validation.resolved;

        // Check if path exists and get stats
        let stats;
        try {
            stats = await fsPromises.stat(resolvedPath);
        } catch {
            return res.status(404).json({ error: 'File or directory not found' });
        }

        // Prevent deleting the project root itself
        if (resolvedPath === path.resolve(projectRoot)) {
            return res.status(403).json({ error: 'Cannot delete project root directory' });
        }

        const deleteEntry = async () => {
            if (stats.isDirectory()) {
                await fsPromises.rm(resolvedPath, { recursive: true, force: true });
            } else {
                await fsPromises.unlink(resolvedPath);
            }
        };

        await retryFileOperationWithOwnerWriteAccess(deleteEntry, [resolvedPath, path.dirname(resolvedPath)]);

        res.json({
            success: true,
            path: resolvedPath,
            type: stats.isDirectory() ? 'directory' : 'file',
            message: 'Deleted successfully'
        });
    } catch (error) {
        console.error('Error deleting file/directory:', error);
        if (isFilesystemPermissionError(error)) {
            sendFilePermissionError(res, req.body?.path || 'target file');
        } else if (error.code === 'ENOENT') {
            res.status(404).json({ error: 'File or directory not found' });
        } else if (error.code === 'ENOTEMPTY') {
            res.status(400).json({ error: 'Directory is not empty' });
        } else {
            res.status(500).json({ error: error.message });
        }
    }
});

// POST /api/projects/:projectName/files/upload - Upload files
// Dynamic import of multer for file uploads
// 「两者都保留」改名：在扩展名前依次插入 "_2"、"_3"… 直到找到不存在的路径。
// 无扩展名文件则在末尾追加 "_N"。文件名中一律用下划线，不使用空格。
const findAvailableDestPath = async (destPath) => {
    const dir = path.dirname(destPath);
    const base = path.basename(destPath);
    const ext = path.extname(base);                       // 含点，如 ".txt"；无扩展名为 ""
    const stem = ext ? base.slice(0, -ext.length) : base;
    let counter = 2;
    // 上限保护，避免极端情况下死循环
    while (counter < 10000) {
        const candidate = path.join(dir, `${stem}_${counter}${ext}`);
        try {
            await fsPromises.access(candidate);
            counter += 1; // 仍存在，尝试下一个
        } catch {
            return candidate; // 不存在，可用
        }
    }
    // 兜底：极端情况下用时间戳保证唯一
    return path.join(dir, `${stem}_${Date.now()}${ext}`);
};

// 上传前的重名预检：给定目标目录与各文件相对路径，返回其中已存在的文件相对路径列表。
// 前端据此弹出 Mac 风格「覆盖 / 两者都保留 / 跳过」对话框。
const checkUploadConflictsHandler = async (req, res) => {
    try {
        const { projectName } = req.params;
        const { targetPath, relativePaths } = req.body;
        const filePaths = Array.isArray(relativePaths) ? relativePaths : [];

        const projectRoot = await extractProjectDirectory(projectName).catch(() => null);
        if (!projectRoot) {
            return res.status(404).json({ error: 'Project not found' });
        }

        const targetDir = targetPath || '';
        let resolvedTargetDir;
        if (!targetDir || targetDir === '.' || targetDir === './') {
            resolvedTargetDir = path.resolve(projectRoot);
        } else {
            const validation = await resolveFilePagePath(projectRoot, targetDir);
            if (!validation.valid) {
                return res.status(403).json({ error: validation.error });
            }
            resolvedTargetDir = validation.resolved;
        }

        const conflicts = [];
        for (const rel of filePaths) {
            if (!rel) continue;
            const destPath = path.resolve(resolvedTargetDir, rel);
            const relativeDestPath = path.relative(resolvedTargetDir, destPath);
            if (relativeDestPath === '' || relativeDestPath.startsWith('..') || path.isAbsolute(relativeDestPath)) {
                continue;
            }
            try {
                await fsPromises.access(destPath);
                conflicts.push(rel);
            } catch { /* 不存在，无冲突 */ }
        }

        res.json({ conflicts });
    } catch (error) {
        console.error('Error checking upload conflicts:', error);
        res.status(500).json({ error: error.message });
    }
};

const uploadFilesHandler = async (req, res) => {
    // Dynamic import of multer
    const multer = (await import('multer')).default;

    const uploadMiddleware = multer({
        storage: multer.diskStorage({
            destination: (req, file, cb) => {
                cb(null, os.tmpdir());
            },
            filename: (req, file, cb) => {
                // Use a unique temp name, but preserve original name in file.originalname
                // Note: file.originalname may contain path separators for folder uploads
                const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
                // For temp file, just use a safe unique name without the path
                cb(null, `upload-${uniqueSuffix}`);
            }
        }),
        limits: {
            fileSize: 50 * 1024 * 1024, // 50MB limit
            files: 20 // Max 20 files at once
        }
    });

    // Use multer middleware
    uploadMiddleware.array('files', 20)(req, res, async (err) => {
        if (err) {
            console.error('Multer error:', err);
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(400).json({ error: 'File too large. Maximum size is 50MB.' });
            }
            if (err.code === 'LIMIT_FILE_COUNT') {
                return res.status(400).json({ error: 'Too many files. Maximum is 20 files.' });
            }
            return res.status(500).json({ error: err.message });
        }

        try {
            const { projectName } = req.params;
            const { targetPath, relativePaths } = req.body;
            // 重名冲突策略（Mac 风格）：'replace' 覆盖（默认，向后兼容）/ 'keepBoth' 两者都保留（自动改名）/ 'skip' 跳过
            const conflictPolicy = ['replace', 'keepBoth', 'skip'].includes(req.body.conflictPolicy)
                ? req.body.conflictPolicy
                : 'replace';

            // Parse relative paths if provided (for folder uploads)
            let filePaths = [];
            if (relativePaths) {
                try {
                    filePaths = JSON.parse(relativePaths);
                } catch (e) {
                    console.log('[DEBUG] Failed to parse relativePaths:', relativePaths);
                }
            }

            console.log('[DEBUG] File upload request:', {
                projectName,
                targetPath: JSON.stringify(targetPath),
                targetPathType: typeof targetPath,
                filesCount: req.files?.length,
                relativePaths: filePaths
            });

            if (!req.files || req.files.length === 0) {
                return res.status(400).json({ error: 'No files provided' });
            }

            // Get project root
            const projectRoot = await extractProjectDirectory(projectName).catch(() => null);
            if (!projectRoot) {
                return res.status(404).json({ error: 'Project not found' });
            }

            console.log('[DEBUG] Project root:', projectRoot);

            // Validate and resolve target path
            // If targetPath is empty or '.', use project root directly
            const targetDir = targetPath || '';
            let resolvedTargetDir;

            console.log('[DEBUG] Target dir:', JSON.stringify(targetDir));

            if (!targetDir || targetDir === '.' || targetDir === './') {
                // Empty path means upload to project root
                resolvedTargetDir = path.resolve(projectRoot);
                console.log('[DEBUG] Using project root as target:', resolvedTargetDir);
            } else {
                const validation = await resolveFilePagePath(projectRoot, targetDir);
                if (!validation.valid) {
                    console.log('[DEBUG] Path validation failed:', validation.error);
                    return res.status(403).json({ error: validation.error });
                }
                resolvedTargetDir = validation.resolved;
                console.log('[DEBUG] Resolved target dir:', resolvedTargetDir);
            }

            // Ensure target directory exists
            try {
                await fsPromises.access(resolvedTargetDir);
            } catch {
                await retryFileOperationWithOwnerWriteAccess(
                    () => fsPromises.mkdir(resolvedTargetDir, { recursive: true }),
                    [path.dirname(resolvedTargetDir)]
                );
            }

            // Move uploaded files from temp to target directory
            const uploadedFiles = [];
            const skippedFiles = [];
            console.log('[DEBUG] Processing files:', req.files.map(f => ({ originalname: f.originalname, path: f.path })));
            for (let i = 0; i < req.files.length; i++) {
                const file = req.files[i];
                // Use relative path if provided (for folder uploads), otherwise use originalname
                const fileName = (filePaths && filePaths[i]) ? filePaths[i] : file.originalname;
                console.log('[DEBUG] Processing file:', fileName, '(originalname:', file.originalname + ')');
                const destPath = path.resolve(resolvedTargetDir, fileName);
                const relativeDestPath = path.relative(resolvedTargetDir, destPath);

                // 上传目标目录可以在任意位置，但上传包内部路径不能用 .. 或绝对路径逃出目标目录。
                if (relativeDestPath === '' || relativeDestPath.startsWith('..') || path.isAbsolute(relativeDestPath)) {
                    console.log('[DEBUG] Destination validation failed for:', destPath);
                    // Clean up temp file
                    await fsPromises.unlink(file.path).catch(() => {});
                    continue;
                }

                // 重名冲突处理：按客户端选择的策略决定最终落盘路径
                let finalDestPath = destPath;
                let alreadyExists = false;
                try {
                    await fsPromises.access(destPath);
                    alreadyExists = true;
                } catch { /* 不存在，无冲突 */ }

                if (alreadyExists) {
                    if (conflictPolicy === 'skip') {
                        // 跳过：保留原文件，丢弃本次上传的临时文件
                        await fsPromises.unlink(file.path).catch(() => {});
                        skippedFiles.push(path.relative(resolvedTargetDir, destPath));
                        continue;
                    }
                    if (conflictPolicy === 'keepBoth') {
                        // 两者都保留：在扩展名前插入 " 2"、" 3"… 直到不冲突（Mac 风格）
                        finalDestPath = await findAvailableDestPath(destPath);
                    }
                    // 'replace'：finalDestPath 保持为 destPath，直接覆盖
                }

                // Ensure parent directory exists (for nested files from folder upload)
                const parentDir = path.dirname(finalDestPath);
                try {
                    await fsPromises.access(parentDir);
                } catch {
                    await retryFileOperationWithOwnerWriteAccess(
                        () => fsPromises.mkdir(parentDir, { recursive: true }),
                        [resolvedTargetDir, path.dirname(parentDir)]
                    );
                }

                // Move file (copy + unlink to handle cross-device scenarios)
                await retryFileOperationWithOwnerWriteAccess(
                    () => fsPromises.copyFile(file.path, finalDestPath),
                    [finalDestPath, parentDir, resolvedTargetDir]
                );
                await fsPromises.unlink(file.path);

                uploadedFiles.push({
                    name: path.relative(resolvedTargetDir, finalDestPath),
                    path: finalDestPath,
                    size: file.size,
                    mimeType: file.mimetype,
                    renamed: finalDestPath !== destPath
                });
            }

            res.json({
                success: true,
                files: uploadedFiles,
                skipped: skippedFiles,
                targetPath: resolvedTargetDir,
                message: `Uploaded ${uploadedFiles.length} file(s) successfully`
            });
        } catch (error) {
            console.error('Error uploading files:', error);
            // Clean up any remaining temp files
            if (req.files) {
                for (const file of req.files) {
                    await fsPromises.unlink(file.path).catch(() => {});
                }
            }
            if (isFilesystemPermissionError(error)) {
                sendFilePermissionError(res, req.body?.targetPath || 'target directory');
            } else {
                res.status(500).json({ error: error.message });
            }
        }
    });
};

app.post('/api/projects/:projectName/files/check-conflicts', authenticateToken, checkUploadConflictsHandler);
app.post('/api/projects/:projectName/files/upload', authenticateToken, uploadFilesHandler);

// WebSocket connection handler that routes based on URL path
wss.on('connection', (ws, request) => {
    const url = request.url;
    ws.authUser = request.user || null;
    console.log('[INFO] Client connected to:', sanitizeUrlForLog(url));

    // Parse URL to get pathname without query parameters
    const urlObj = new URL(url, 'http://localhost');
    const pathname = urlObj.pathname;

    if (pathname === '/shell') {
        handleShellConnection(ws);
    } else if (pathname === '/ws') {
        // 把验签时存入 request.user 的用户信息透传给 chat handler，
        // 用于给提交的 user 消息打 attribution 标记
        handleChatConnection(ws, request.user || null);
    } else {
        console.log('[WARN] Unknown WebSocket path:', pathname);
        ws.close();
    }
});

// 服务端主动应用层心跳：每 10s 向所有在线客户端发送一条 {type:'heartbeat'} 数据帧。
// 修复根因：Claude "思考"无输出期间（客户端 30s idle ping 尚未触发），代理 idle 超时
// 会掐断 WebSocket → 前端频繁重连 → 每次重连重跑会话加载/重放，表现为历史消息和刚
// 发出的消息"过一会消失、过一会又出现"的周期性闪烁。
// 关键改动：从 WS 协议级 ping 控制帧改为真正的数据帧（text frame）。部分前置代理只
// 对承载实际数据的 message 帧刷新 idle 计时器，对 ping/pong 控制帧不计为活跃流量，
// 导致协议级心跳无法保活。数据帧能确保代理始终把连接视为活跃。客户端静默忽略此帧。
// 仅发送保活帧、不做僵尸判定（避免误杀繁忙但健康的连接）；真正的死连接由
// 客户端 pong 超时与 TCP 层兜底回收。
const WS_HEARTBEAT_INTERVAL_MS = 10000;
const wsHeartbeatInterval = setInterval(() => {
    const frame = JSON.stringify({ type: 'heartbeat', ts: Date.now() });
    wss.clients.forEach((client) => {
        if (client.readyState === client.OPEN) {
            try { client.send(frame); } catch { /* ignore */ }
        }
    });
}, WS_HEARTBEAT_INTERVAL_MS);
wss.on('close', () => clearInterval(wsHeartbeatInterval));

// Reconcile the previous completed Shanghai day from Codex's authoritative
// JSONL logs. Live app-server events keep today's panel moving; this daily pass
// repairs gaps caused by restarts and attributes subagent threads to the user
// message that launched their root session.
const codexUsageReconcileStatePath = path.join(
    process.env.CLOUDCLI_DATA_DIR || path.join(os.homedir(), '.cloudcli'),
    'codex-usage-reconcile.json',
);
let codexUsageReconcileRunning = false;
const runCodexUsageReconciliation = () => {
    if (codexUsageReconcileRunning) return;
    const completedDay = shiftCalendarDay(getShanghaiCalendarDay(), -1);
    try {
        const state = JSON.parse(fs.readFileSync(codexUsageReconcileStatePath, 'utf8'));
        if (state?.completedDay === completedDay) return;
    } catch { /* first run or invalid marker */ }

    codexUsageReconcileRunning = true;
    const scriptPath = path.join(__dirname, '..', 'scripts', 'reconcile-codex-usage.js');
    const child = spawn(process.execPath, [
        scriptPath,
        '--apply',
        `--since=${completedDay}`,
        `--through=${completedDay}`,
    ], { cwd: path.join(__dirname, '..'), stdio: 'ignore', env: process.env });
    child.once('exit', (code) => {
        codexUsageReconcileRunning = false;
        if (code === 0) {
            try {
                fs.mkdirSync(path.dirname(codexUsageReconcileStatePath), { recursive: true });
                fs.writeFileSync(codexUsageReconcileStatePath, JSON.stringify({ completedDay, updatedAt: new Date().toISOString() }));
            } catch (error) {
                console.warn('[USAGE] Could not save Codex reconciliation marker:', error.message);
            }
        } else {
            console.warn(`[USAGE] Codex reconciliation failed with exit code ${code}`);
        }
    });
    child.once('error', (error) => {
        codexUsageReconcileRunning = false;
        console.warn('[USAGE] Could not start Codex reconciliation:', error.message);
    });
};
setTimeout(runCodexUsageReconciliation, 30_000).unref();
setInterval(runCodexUsageReconciliation, 60 * 60 * 1000).unref();

function createModelOutputTracker({ userId, eventId, provider, initialSessionId, model }) {
    let exactInputTokens = 0;
    let exactOutputTokens = 0;
    let reportedInputTokens = 0;
    let reportedCachedInputTokens = 0;
    let reportedOutputTokens = 0;
    let sessionId = initialSessionId || null;
    let finalized = false;
    let lastPersistedInputTokens = 0;
    let lastPersistedCachedInputTokens = 0;
    let lastPersistedOutputTokens = 0;
    let lastPersistedAt = 0;
    let pendingPersistTimer = null;
    const seenClaudeUsageIds = new Set();

    const notifyUsageUpdated = () => {
        const usageFrame = JSON.stringify({ type: 'daily-usage-updated', ts: Date.now() });
        connectedClients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN && client.authUser?.userId === userId) {
                try { client.send(usageFrame); } catch { /* ignore */ }
            }
        });
    };

    const readTokens = (...values) => values.reduce((max, value) => {
        const parsed = Number(value);
        return Number.isFinite(parsed) && parsed > max ? parsed : max;
    }, 0);

    const persistSnapshot = () => {
        const inputTokens = Math.max(exactInputTokens, reportedInputTokens);
        const cachedInputTokens = Math.min(inputTokens, reportedCachedInputTokens);
        const outputTokens = Math.max(exactOutputTokens, reportedOutputTokens);
        if (inputTokens <= lastPersistedInputTokens && cachedInputTokens <= lastPersistedCachedInputTokens && outputTokens <= lastPersistedOutputTokens) return false;
        const changed = modelOutputDb.record(
            userId,
            eventId,
            getShanghaiCalendarDay(),
            outputTokens,
            provider,
            sessionId,
            inputTokens,
            cachedInputTokens,
            model,
        );
        lastPersistedInputTokens = inputTokens;
        lastPersistedCachedInputTokens = cachedInputTokens;
        lastPersistedOutputTokens = outputTokens;
        lastPersistedAt = Date.now();
        if (changed) notifyUsageUpdated();
        return changed;
    };

    const scheduleSnapshot = () => {
        if (pendingPersistTimer || finalized) return;
        const elapsed = Date.now() - lastPersistedAt;
        const delay = lastPersistedAt === 0 ? 0 : Math.max(0, 10_000 - elapsed);
        pendingPersistTimer = setTimeout(() => {
            pendingPersistTimer = null;
            persistSnapshot();
        }, delay);
        pendingPersistTimer.unref?.();
    };

    const terminalTypes = new Set([
        'claude-complete', 'codex-complete', 'cursor-complete', 'gemini-complete',
        'claude-error', 'codex-error', 'cursor-error', 'gemini-error', 'session-aborted',
    ]);

    const observe = (payload) => {
        if (!payload || finalized) return false;
        if (payload.sessionId) sessionId = payload.sessionId;

        const data = payload.data || {};
        if (payload.type === 'claude-response') {
            // Claude sends one SDK assistant message for every model step. Sum
            // those exact per-message values; modelUsage below reconciles the
            // total when subagents or cached steps are involved.
            if (data.type === 'assistant') {
                const usage = data.message?.usage || data.usage || {};
                const usageId = String(data.message?.id || data.id || data.uuid || `legacy:${JSON.stringify(usage)}`);
                if (!seenClaudeUsageIds.has(usageId)) {
                    seenClaudeUsageIds.add(usageId);
                    exactInputTokens += readTokens(usage.input_tokens)
                        + readTokens(usage.cache_read_input_tokens)
                        + readTokens(usage.cache_creation_input_tokens);
                    exactOutputTokens += readTokens(usage.output_tokens);
                }
            }
            if (data.type === 'result' && data.modelUsage && typeof data.modelUsage === 'object') {
                const modelInputTotal = Object.values(data.modelUsage).reduce((sum, usage) => (
                    sum + readTokens(usage?.cumulativeInputTokens, usage?.inputTokens)
                ), 0);
                const modelTotal = Object.values(data.modelUsage).reduce((sum, usage) => (
                    sum + readTokens(usage?.cumulativeOutputTokens, usage?.outputTokens)
                ), 0);
                reportedInputTokens = Math.max(reportedInputTokens, modelInputTotal);
                reportedOutputTokens = Math.max(reportedOutputTokens, modelTotal);
            }
        }

        if (payload.type === 'codex-response' && data.type === 'turn_complete') {
            exactInputTokens = Math.max(
                exactInputTokens,
                readTokens(data.usage?.input_tokens, data.usage?.inputTokens),
            );
            exactOutputTokens = Math.max(
                exactOutputTokens,
                readTokens(data.usage?.output_tokens, data.usage?.outputTokens),
            );
            reportedCachedInputTokens = Math.max(
                reportedCachedInputTokens,
                readTokens(data.usage?.cached_input_tokens, data.usage?.cachedInputTokens),
            );
        }

        if (payload.type === 'claude-status' || payload.type === 'token-budget') {
            reportedInputTokens = Math.max(
                reportedInputTokens,
                readTokens(
                    data.billingInputTokens,
                    data.inputTokens,
                    data.input_tokens,
                    data.input,
                ),
            );
            reportedCachedInputTokens = Math.max(
                reportedCachedInputTokens,
                readTokens(data.billingCachedInputTokens, data.cachedInputTokens, data.cached_input_tokens),
            );
            reportedOutputTokens = Math.max(
                reportedOutputTokens,
                readTokens(
                    data.billingOutputTokens,
                    data.outputTokens,
                    data.output_tokens,
                    data.output,
                    data.reasoningOutputTokens,
                    data.reasoning_output_tokens,
                ),
            );
        }

        if (terminalTypes.has(payload.type)) {
            finalized = true;
            if (pendingPersistTimer) {
                clearTimeout(pendingPersistTimer);
                pendingPersistTimer = null;
            }
            return persistSnapshot();
        }

        if (
            Math.max(exactInputTokens, reportedInputTokens) > lastPersistedInputTokens ||
            Math.max(exactOutputTokens, reportedOutputTokens) > lastPersistedOutputTokens
        ) {
            scheduleSnapshot();
        }
        return false;
    };

    return { observe };
}

/**
 * WebSocket Writer - Wrapper for WebSocket to match SSEStreamWriter interface
 */
class WebSocketWriter {
    constructor(ws) {
        this.ws = ws;
        this.sessionId = null;
        this.isWebSocketWriter = true;  // Marker for transport detection
        // 断线重连重放：只保留最后一条终态消息（完成/错误），TTL 15 分钟
        this._lastTerminalMsg = null;
        this._REPLAY_TTL_MS = 15 * 60 * 1000;
    }

    send(data) {
        // 只缓冲"终态消息"供重连重放（完成/错误）
        // 流式 chunk 不缓冲——重连后由 JSONL 重新加载完整内容，避免重复
        const isTerminal = [
            'claude-complete', 'claude-error', 'session-aborted',
            'codex-complete', 'codex-error',
            'gemini-complete', 'gemini-error',
        ].includes(data.type);
        if (isTerminal) {
            this._lastTerminalMsg = { data, ts: Date.now() };
        }

        // Send workflow output only to sockets bound to the same session plus
        // the originating socket. Broadcasting every stream event to every chat
        // tab makes multi-session use noisy and can surface as cross-session UI.
        const jsonStr = JSON.stringify(data);
        const targetSessionIds = new Set([
            data.viewSessionId,
            data.sessionId,
            !data.viewSessionId && !data.sessionId ? this.sessionId : null,
        ].filter(Boolean));
        const targets = new Set();
        for (const targetSessionId of targetSessionIds) {
            if (sessionChatClients.has(targetSessionId)) {
                sessionChatClients.get(targetSessionId).forEach(client => targets.add(client));
            }
        }
        // A compacted/resumed turn can use a runtime thread id different from
        // the immutable sidebar view id. Deliver when the origin is subscribed
        // to either identity; requiring only data.sessionId silently dropped
        // turn-accepted/status frames and made the work bar disappear.
        const originStillViewingTarget = targetSessionIds.size === 0
            || [...targetSessionIds].some((id) => this.ws._chatSessionIds?.has(id));
        if (this.ws.readyState === WebSocket.OPEN && originStillViewingTarget) {
            targets.add(this.ws);
        }

        const targetClientInstanceId = typeof data.targetClientInstanceId === 'string'
            ? data.targetClientInstanceId
            : null;
        const routedTargets = filterClientInstanceTargets(targets, targetClientInstanceId);

        let delivered = false;
        routedTargets.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                try {
                    client.send(jsonStr);
                    delivered = true;
                } catch {
                    // A stale OPEN socket must not abort the provider turn or
                    // prevent delivery to another healthy tab.
                }
            }
        });

        // Keep the session mirror current even when its Shell tab is closed.
        const sid = data.sessionId || data.viewSessionId || this.sessionId;
        if (sid) {
            const shellOutput = appendShellMirrorEvent(sid, data);
            if (shellOutput && shellWsMap.has(sid)) {
                for (const shellWs of shellWsMap.get(sid)) {
                    if (shellWs.readyState === 1) {
                        try {
                            shellWs.send(JSON.stringify({ type: 'output', data: shellOutput }));
                        } catch {
                            // A closed Shell mirror must not interrupt the model turn.
                        }
                    }
                }
            }
        }
    }

    updateWebSocket(newRawWs) {
        this.ws = newRawWs;
        if (this.sessionId) {
            bindChatClientToSession(newRawWs, this.sessionId);
        }
        // 重放最后一条终态消息（如果在 TTL 内）——让前端清除 loading 状态
        if (this._lastTerminalMsg && Date.now() - this._lastTerminalMsg.ts < this._REPLAY_TTL_MS) {
            const { data: termData } = this._lastTerminalMsg;
            this._lastTerminalMsg = null;
            if (newRawWs.readyState === 1) {
                console.log(`[RECONNECT] Replaying terminal message ${termData.type} to new WebSocket`);
                newRawWs.send(JSON.stringify({ ...termData, _replayed: true }));
            }
        }
    }

    setSessionId(sessionId) {
        this.sessionId = sessionId;
        bindChatClientToSession(this.ws, sessionId);
    }

    getSessionId() {
        return this.sessionId;
    }
}

// Handle chat WebSocket connections
function handleChatConnection(ws, authedUser) {
    console.log('[INFO] Chat WebSocket connected', authedUser ? `(user: ${authedUser.username})` : '');

    // Add to connected clients for project updates
    connectedClients.add(ws);

    // Wrap WebSocket with writer for consistent interface with SSEStreamWriter
    const writer = new WebSocketWriter(ws);

    // Repair a sidebar that missed a project-config update while disconnected or
    // received the stale-while-refresh list immediately after workspace creation.
    void getProjects()
        .then((projects) => {
            if (ws.readyState !== WebSocket.OPEN) return;
            ws.send(JSON.stringify({
                type: 'projects_updated',
                projects: filterProjectsToWorkspace(projects),
                timestamp: new Date().toISOString(),
                changeType: 'sync',
            }));
        })
        .catch((error) => console.warn('[WARN] Could not synchronize projects on connect:', error.message));

    ws.on('message', async (message) => {
        let data = null;
        try {
            data = JSON.parse(message);
            const incomingClientInstanceId = data.options?.clientInstanceId ?? data.clientInstanceId;
            if (typeof incomingClientInstanceId === 'string' && incomingClientInstanceId.length <= 160) {
                ws._clientInstanceId = incomingClientInstanceId;
            }
            const commandTypes = ['claude-command', 'codex-command', 'gemini-command', 'cursor-command'];
            const isCommandMessage = commandTypes.includes(data.type);
            const commandViewSessionId = data.options?.viewSessionId ?? data.viewSessionId ?? null;
            const commandClientInstanceId = data.options?.clientInstanceId ?? data.clientInstanceId ?? null;
            const commandProvider = isCommandMessage ? data.type.replace('-command', '') : null;
            const commandEventId = isCommandMessage
                ? `model-output:${commandProvider}:${data.options?.clientTs ?? `${Date.now()}:${Math.random().toString(36).slice(2)}`}`
                : null;
            const modelOutputTracker = isCommandMessage && authedUser?.userId
                ? createModelOutputTracker({
                    userId: authedUser.userId,
                    eventId: commandEventId,
                    provider: commandProvider,
                    initialSessionId: data.options?.sessionId || commandViewSessionId,
                    model: data.options?.model || null,
                })
                : null;
            const commandWriter = isCommandMessage
                ? {
                    isWebSocketWriter: true,
                    send(payload) {
                        modelOutputTracker?.observe(payload);
                        writer.send({
                            ...payload,
                            viewSessionId: commandViewSessionId,
                            targetClientInstanceId: commandClientInstanceId,
                            turnClientTs: (payload.turnClientTs ?? Number(data.options?.clientTs || 0)) || undefined,
                        });
                    },
                    setSessionId(sessionId) {
                        writer.setSessionId(sessionId);
                    },
                    getSessionId() {
                        return writer.getSessionId();
                    },
                }
                : writer;

            if (isCommandMessage && isDrainingForRestart) {
                const provider = data.type.replace('-command', '');
                commandWriter.send({
                    type: 'command-ack',
                    ackId: data.options?.clientTs,
                    sessionId: data.options?.sessionId || data.sessionId || null,
                    viewSessionId: commandViewSessionId,
                    provider,
                    accepted: false,
                    reason: 'server-draining',
                });
                commandWriter.send({
                    type: `${provider}-error`,
                    error: 'Server update is waiting for active turns to finish. Please retry in a moment.',
                    sessionId: data.options?.sessionId || data.sessionId || null,
                    viewSessionId: commandViewSessionId,
                    turnClientTs: Number(data.options?.clientTs || 0) || undefined,
                });
                return;
            }

            if (isCommandMessage) {
                const topLevelSessionId = data.sessionId ?? null;
                const optionSessionId = data.options?.sessionId ?? null;
                const runtimeSessionId = data.options?.runtimeSessionId ?? null;
                const viewSessionId = data.options?.viewSessionId ?? data.viewSessionId ?? null;
                const mismatchedTopLevel =
                    topLevelSessionId &&
                    optionSessionId &&
                    topLevelSessionId !== optionSessionId;
                const mismatchedRuntime =
                    runtimeSessionId &&
                    optionSessionId &&
                    runtimeSessionId !== optionSessionId;

                if (mismatchedTopLevel || mismatchedRuntime) {
                    console.error('[SESSION_GUARD] Rejecting command with inconsistent session IDs', {
                        type: data.type,
                        topLevelSessionId,
                        optionSessionId,
                        runtimeSessionId,
                        viewSessionId,
                    });
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({
                            type: 'command-rejected',
                            ackId: data.options?.clientTs,
                            reason: 'inconsistent-session-id',
                            sessionId: optionSessionId || topLevelSessionId || null,
                            viewSessionId,
                        }));
                    }
                    return;
                }

                // Bind from the immutable UI view identity at receipt time.
                // Provider runtime IDs may change during resume/compaction and
                // must not leave this socket subscribed to an older sidebar view.
                if (viewSessionId) bindChatClientToSession(ws, viewSessionId);

                const dedupeKey = commandIdentity(data, authedUser);
                const isDuplicate = rememberCommand(dedupeKey, {
                    sessionId: optionSessionId || topLevelSessionId || null,
                    viewSessionId,
                });
                if (isDuplicate) {
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({
                            type: 'command-ack',
                            ackId: data.options?.clientTs,
                            sessionId: optionSessionId || null,
                            viewSessionId,
                            provider: commandProvider,
                            duplicate: true,
                        }));
                    }
                    return;
                }
            }

            // 权限模式同步：把发令方的 permissionMode 广播给同一 session 的其他所有客户端
            // 确保多设备/多标签同时打开时权限显示一致，追随真实发令状态
            if (isCommandMessage && data.options) {
                const syncSessionId = data.options.sessionId;
                let syncMode = data.options.permissionMode || 'default';
                if (data.type === 'cursor-command' && data.options.skipPermissions) syncMode = 'bypassPermissions';
                if (syncSessionId) {
                    const syncMsg = JSON.stringify({ type: 'permission-mode-sync', sessionId: syncSessionId, permissionMode: syncMode });
                    connectedClients.forEach(client => {
                        if (client !== ws) safeSendWebSocket(client, syncMsg);
                    });
                }
            }

            // 消息归属：多账号共享数据时，记录每条 user 提交是哪个账号发的
            // 前端在提交时附带 clientTs（毫秒时间戳，与本地 chatMessages.timestamp 一致），
            // 服务端按 (sessionId, clientTs) 写入归属表，渲染时按此映射显示对应头像
            if (
                isCommandMessage &&
                data.options &&
                authedUser?.userId &&
                data.options.sessionId &&
                typeof data.options.clientTs === 'number'
            ) {
                attributionDb.set(data.options.sessionId, data.options.clientTs, authedUser.userId);
            }

            // 通用送达回执：收到任何 *-command 立即用 clientTs 作为 ackId 回 command-ack。
            // 前端发出命令后启动计时，收到此 ack 即确认"消息真的抵达后端"。
            // 僵尸 socket（readyState 显示 OPEN 但实际已死）时 ack 永远回不来，
            // 前端据此判定"未送达"→ 触发重连并提示重发，消除消息静默丢失的黑洞。
            if (isCommandMessage) {
                const ackId = data.options?.clientTs;
                if (ackId != null && ws.readyState === WebSocket.OPEN) {
                    try {
                        ws.send(JSON.stringify({
                            type: 'command-ack',
                            ackId,
                            sessionId: data.options?.sessionId || null,
                            viewSessionId: data.options?.viewSessionId || data.viewSessionId || null,
                            provider: data.type.replace('-command', ''),
                            startedAt: data.options?.clientTs || Date.now(),
                        }));
                    } catch { /* ignore */ }
                }
                safeSendWebSocket(ws, JSON.stringify({
                    type: 'turn-accepted',
                    sessionId: data.options?.sessionId || data.options?.viewSessionId || data.viewSessionId || null,
                    viewSessionId: data.options?.viewSessionId || data.viewSessionId || null,
                    provider: commandProvider,
                    turnClientTs: Number(data.options?.clientTs || 0) || undefined,
                    startedAt: new Date(data.options?.clientTs || Date.now()).toISOString(),
                    targetClientInstanceId: commandClientInstanceId,
                }));
            }

            if (data.type === 'claude-command') {
                console.log('[DEBUG] User message:', data.command || '[Continue/Resume]');
                console.log('📁 Project:', data.options?.projectPath || 'Unknown');
                console.log('🔄 Session:', data.options?.sessionId ? `Resume ${data.options.sessionId}` : 'New');
                console.log('👁️ View Session:', data.options?.viewSessionId || data.viewSessionId || 'none');

                // Use Claude Agents SDK（经 submitClaudeMessage 统一入口：
                // 会话忙碌时入队串行处理，避免并发 query 覆盖导致消息丢失）
                await submitClaudeMessage(data.command, data.options, commandWriter);
            } else if (data.type === 'cursor-command') {
                console.log('[DEBUG] Cursor message:', data.command || '[Continue/Resume]');
                console.log('📁 Project:', data.options?.cwd || 'Unknown');
                console.log('🔄 Session:', data.options?.sessionId ? `Resume ${data.options.sessionId}` : 'New');
                console.log('👁️ View Session:', data.options?.viewSessionId || data.viewSessionId || 'none');
                console.log('🤖 Model:', data.options?.model || 'default');
                await spawnCursor(data.command, data.options, commandWriter);
            } else if (data.type === 'codex-command') {
                console.log('[DEBUG] Codex message:', data.command || '[Continue/Resume]');
                console.log('📁 Project:', data.options?.projectPath || data.options?.cwd || 'Unknown');
                console.log('🔄 Session:', data.options?.sessionId ? `Resume ${data.options.sessionId}` : 'New');
                console.log('👁️ View Session:', data.options?.viewSessionId || data.viewSessionId || 'none');
                console.log('🤖 Model:', data.options?.model || 'default');
                console.log('🧠 Reasoning:', data.options?.modelReasoningEffort || 'default');
                console.log('⚡ Speed:', data.options?.speed || 'default');
                await submitCodexMessage(data.command, data.options, commandWriter);
            } else if (data.type === 'gemini-command') {
                console.log('[DEBUG] Gemini message:', data.command || '[Continue/Resume]');
                console.log('📁 Project:', data.options?.projectPath || data.options?.cwd || 'Unknown');
                console.log('🔄 Session:', data.options?.sessionId ? `Resume ${data.options.sessionId}` : 'New');
                console.log('👁️ View Session:', data.options?.viewSessionId || data.viewSessionId || 'none');
                console.log('🤖 Model:', data.options?.model || 'default');
                await spawnGemini(data.command, data.options, commandWriter);
            } else if (data.type === 'cursor-resume') {
                // Backward compatibility: treat as cursor-command with resume and no prompt
                console.log('[DEBUG] Cursor resume session (compat):', data.sessionId);
                await spawnCursor('', {
                    sessionId: data.sessionId,
                    resume: true,
                    cwd: data.options?.cwd
                }, writer);
            } else if (data.type === 'claude-btw') {
                // BTW：向运行中的 Claude session 注入消息，不打断当前任务
                console.log('[DEBUG] BTW inject:', data.sessionId, '->', data.message);
                const success = await injectBtwMessage(data.sessionId, data.message);
                writer.send({
                    type: 'btw-result',
                    sessionId: data.sessionId,
                    success,
                    message: data.message,
                    clientTs: data.clientTs,
                });

            } else if (data.type === 'codex-steer') {
                // Native Codex app-server steering: add user input to the
                // currently running turn without starting a concurrent turn.
                console.log('[DEBUG] Codex steer:', data.sessionId, '->', data.message);
                const clientTs = typeof data.clientTs === 'number' ? data.clientTs : Date.now();
                const success = await steerCodexSession(data.sessionId, data.message, clientTs);
                if (success && authedUser?.userId) {
                    attributionDb.set(data.sessionId, clientTs, authedUser.userId);
                }
                writer.send({
                    type: 'btw-result',
                    sessionId: data.sessionId,
                    success,
                    message: data.message,
                    clientTs,
                });

            } else if (data.type === 'abort-session') {
                console.log('[DEBUG] Abort session request:', data.sessionId);
                const provider = data.provider || 'claude';
                let success;

                if (provider === 'cursor') {
                    success = abortCursorSession(data.sessionId);
                } else if (provider === 'codex') {
                    success = abortCodexSession(data.sessionId);
                } else if (provider === 'gemini') {
                    success = abortGeminiSession(data.sessionId);
                } else {
                    // Use Claude Agents SDK
                    success = await abortClaudeSDKSession(data.sessionId);
                }

                writer.send({
                    type: 'session-aborted',
                    sessionId: data.sessionId,
                    provider,
                    success
                });
            } else if (data.type === 'claude-permission-response') {
                // Relay UI approval decisions back into the SDK control flow.
                // This does not persist permissions; it only resolves the in-flight request,
                // introduced so the SDK can resume once the user clicks Allow/Deny.
                if (data.requestId) {
                    resolveToolApproval(data.requestId, {
                        allow: Boolean(data.allow),
                        updatedInput: data.updatedInput,
                        message: data.message,
                        rememberEntry: data.rememberEntry
                    });
                }
            } else if (data.type === 'cursor-abort') {
                console.log('[DEBUG] Abort Cursor session:', data.sessionId);
                const success = abortCursorSession(data.sessionId);
                writer.send({
                    type: 'session-aborted',
                    sessionId: data.sessionId,
                    provider: 'cursor',
                    success
                });
            } else if (data.type === 'check-session-status') {
                // Check if a specific session is currently processing
                const provider = data.provider || 'claude';
                const sessionId = data.sessionId;
                // A status check from the visible chat is also its reconnect
                // subscription handshake. Without this, a refreshed tab learns
                // that Codex is active but all subsequent stream events continue
                // targeting the dead pre-refresh socket.
                if (data.viewSessionId) {
                    bindChatClientToSession(ws, data.viewSessionId);
                }
                let isActive;
                let sessionInfo = null;

                if (provider === 'cursor') {
                    isActive = isCursorSessionActive(sessionId);
                    sessionInfo = isActive ? getCursorSessionInfo(sessionId) : null;
                } else if (provider === 'codex') {
                    isActive = isCodexSessionActive(sessionId);
                    sessionInfo = isActive ? getCodexSessionInfo(sessionId) : null;
                } else if (provider === 'gemini') {
                    isActive = isGeminiSessionActive(sessionId);
                    sessionInfo = isActive ? getGeminiSessionInfo(sessionId) : null;
                } else {
                    // Use Claude Agents SDK
                    isActive = isClaudeSDKSessionActive(sessionId);
                    sessionInfo = isActive ? getClaudeSDKSessionInfo(sessionId) : null;
                    // 无论 active 还是 completed（5s 内），都尝试重连 writer：
                    // - active：重定向后续 SDK 输出到新 WS
                    // - completed：触发 _lastTerminalMsg 重放（让前端清除 loading 状态）
                    reconnectSessionWriter(sessionId, ws);
                }

                writer.send({
                    type: 'session-status',
                    sessionId,
                    provider,
                    isProcessing: isActive,
                    status: sessionInfo?.status || null,
                    startedAt: sessionInfo?.startedAt || null,
                    statusText: sessionInfo?.statusText || null,
                    lastActivityAt: sessionInfo?.lastActivityAt || null,
                    inputTokens: Number(sessionInfo?.inputTokens || 0),
                    outputTokens: Number(sessionInfo?.outputTokens || 0),
                    turnClientTs: Number(sessionInfo?.turnClientTs || 0) || undefined,
                    viewSessionId: data.viewSessionId || null,
                });
            } else if (data.type === 'get-pending-permissions') {
                // Return pending permission requests for a session
                const sessionId = data.sessionId;
                if (sessionId && isClaudeSDKSessionActive(sessionId)) {
                    const pending = getPendingApprovalsForSession(sessionId);
                    writer.send({
                        type: 'pending-permissions-response',
                        sessionId,
                        data: pending
                    });
                }
            } else if (data.type === 'get-active-sessions') {
                // Get all currently active sessions
                const activeSessions = {
                    claude: getActiveClaudeSDKSessions(),
                    cursor: getActiveCursorSessions(),
                    codex: getActiveCodexSessions(),
                    gemini: getActiveGeminiSessions()
                };
                writer.send({
                    type: 'active-sessions',
                    sessions: activeSessions
                });
            } else if (data.type === 'ping') {
                // 心跳 ping → 立即回复 pong，防止客户端僵尸连接检测误判
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'pong' }));
                }
            }
        } catch (error) {
            console.error('[ERROR] Chat WebSocket error:', error.message);
            const failedProvider = typeof data?.type === 'string' && data.type.endsWith('-command')
                ? data.type.slice(0, -'-command'.length)
                : null;
            safeSendWebSocket(ws, JSON.stringify({
                type: failedProvider ? `${failedProvider}-error` : 'error',
                error: error.message,
                sessionId: data?.options?.sessionId || data?.sessionId || null,
                viewSessionId: data?.options?.viewSessionId || data?.viewSessionId || null,
                turnClientTs: Number(data?.options?.clientTs || 0) || undefined,
                targetClientInstanceId: data?.options?.clientInstanceId || data?.clientInstanceId || null,
            }));
        }
    });

    ws.on('close', () => {
        console.log('🔌 Chat client disconnected');
        // Remove from connected clients
        connectedClients.delete(ws);
        unbindChatClient(ws);
    });
}

// Handle shell WebSocket connections
function handleShellConnection(ws) {
    console.log('🐚 Shell client connected');
    let shellProcess = null;
    let ptySessionKey = null;
    let shellSessionId = null;  // 当前 shell 对应的 Claude session ID
    let urlDetectionBuffer = '';
    const announcedAuthUrls = new Set();
    const MAX_PTY_REPLAY_BYTES = 2 * 1024 * 1024;

    ws.on('message', async (message) => {
        let data = null;
        try {
            data = JSON.parse(message);
            console.log('📨 Shell message received:', data.type);

            if (data.type === 'init') {
                const sessionId = data.sessionId;
                const hasSession = data.hasSession;
                const provider = data.provider || 'claude';
                const codexModel = provider === 'codex' && typeof data.model === 'string' && /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(data.model)
                    ? data.model
                    : null;
                const initialCommand = data.initialCommand;
                const isPlainShell = data.isPlainShell || (!!initialCommand && !hasSession) || provider === 'plain-shell';
                urlDetectionBuffer = '';
                announcedAuthUrls.clear();

                // 登录类命令（Claude/Cursor auth）不依赖项目路径，直接在 WORKSPACES_ROOT 下运行
                const isLoginCommand = initialCommand && (
                    initialCommand.includes('setup-token') ||
                    initialCommand.includes('/login') ||
                    initialCommand.includes('/exit') ||
                    initialCommand.includes('cursor-agent login') ||
                    initialCommand.includes('auth login')
                );

                // 对于登录命令，跳过路径校验，使用 WORKSPACES_ROOT 作为工作目录
                let projectPath;
                if (isLoginCommand) {
                    projectPath = WORKSPACES_ROOT;
                } else {
                    projectPath = data.projectPath || process.cwd();
                    // 路径安全校验：只允许在 WORKSPACES_ROOT 内启动会话
                    const pathValidation = await validateWorkspacePath(projectPath);
                    if (!pathValidation.valid) {
                        ws.send(JSON.stringify({
                            type: 'error',
                            message: `Unauthorized workspace path: ${projectPath}. Only paths within ${WORKSPACES_ROOT} are allowed.`
                        }));
                        ws.close();
                        return;
                    }
                }

                // Include command hash in session key so different commands get separate sessions
                const commandSuffix = isPlainShell && initialCommand
                    ? `_cmd_${Buffer.from(initialCommand).toString('base64').slice(0, 16)}`
                    : '';
                const modelSuffix = provider === 'codex' && codexModel ? `_model_${codexModel}` : '';
                const shellProviderKey = isPlainShell ? 'plain-shell' : provider;
                ptySessionKey = `${projectPath}_${shellProviderKey}_${sessionId || 'default'}${modelSuffix}${commandSuffix}`;

                // 注册 shell WebSocket 到 shellWsMap，接收 SDK 事件实时转发
                if (sessionId && !isPlainShell) {
                    shellSessionId = sessionId;
                    if (!shellWsMap.has(sessionId)) shellWsMap.set(sessionId, new Set());
                    shellWsMap.get(sessionId).add(ws);
                    console.log(`🔗 Shell WS registered for session: ${sessionId}`);
                }

                // A session Shell is a faithful view of the Chat runtime. Starting
                // another `codex resume`/`claude --resume` here creates an unrelated
                // process that can lag behind or contend for the same thread.
                if (sessionId && !isPlainShell) {
                    for (const [key, staleSession] of ptySessionsMap) {
                        if (staleSession.sessionId !== sessionId || staleSession.provider !== provider) continue;
                        if (staleSession.timeoutId) clearTimeout(staleSession.timeoutId);
                        if (staleSession.quietTimer) clearTimeout(staleSession.quietTimer);
                        try { staleSession.pty?.kill?.(); } catch { /* ignore stale PTY */ }
                        ptySessionsMap.delete(key);
                    }

                    const transcript = provider === 'codex' ? formatCodexTranscriptForShell(sessionId) : '';
                    const mirror = shellMirrorSessions.get(sessionId);
                    const liveOutput = mirror && !mirror.completedAt ? mirror.buffer : '';
                    ws.send(JSON.stringify({ type: 'output', data: '\x1b[2J\x1b[H' }));
                    if (transcript) ws.send(JSON.stringify({ type: 'output', data: transcript }));
                    if (liveOutput) {
                        ws.send(JSON.stringify({
                            type: 'output',
                            data: `${transcript ? '\r\n\x1b[90m[Current turn]\x1b[0m\r\n' : ''}${liveOutput}`,
                        }));
                    }
                    ws.send(JSON.stringify({
                        type: 'session-sync',
                        provider,
                        sessionId,
                        projectPath,
                        mirror: true,
                    }));
                    return;
                }

                // Kill any existing login session before starting fresh
                if (isLoginCommand) {
                    const oldSession = ptySessionsMap.get(ptySessionKey);
                    if (oldSession) {
                        console.log('🧹 Cleaning up existing login session:', ptySessionKey);
                        if (oldSession.timeoutId) clearTimeout(oldSession.timeoutId);
                        if (oldSession.pty && oldSession.pty.kill) oldSession.pty.kill();
                        ptySessionsMap.delete(ptySessionKey);
                    }
                }

                const existingSession = isLoginCommand ? null : ptySessionsMap.get(ptySessionKey);
                if (existingSession) {
                    const sessionMatchesRequest =
                        existingSession.projectPath === projectPath &&
                        (existingSession.sessionId || null) === (sessionId || null) &&
                        existingSession.provider === shellProviderKey;

                    if (!sessionMatchesRequest) {
                        console.warn('🧹 PTY session key collision or stale metadata, cleaning up:', ptySessionKey);
                        if (existingSession.timeoutId) clearTimeout(existingSession.timeoutId);
                        if (existingSession.quietTimer) clearTimeout(existingSession.quietTimer);
                        if (existingSession.pty && existingSession.pty.kill) existingSession.pty.kill();
                        ptySessionsMap.delete(ptySessionKey);
                    } else {
                    // 检查 PTY 进程是否仍然存活，避免重连到已退出的僵尸会话
                    let isPtyAlive = false;
                    try {
                        process.kill(existingSession.pty.pid, 0);
                        isPtyAlive = true;
                    } catch {
                        isPtyAlive = false;
                    }

                    if (!isPtyAlive) {
                        // PTY 进程已退出，清理僵尸会话，后续走创建新会话的流程
                        console.log('🧹 Stale PTY session detected (process dead), cleaning up:', ptySessionKey);
                        if (existingSession.timeoutId) clearTimeout(existingSession.timeoutId);
                        if (existingSession.quietTimer) clearTimeout(existingSession.quietTimer);
                        ptySessionsMap.delete(ptySessionKey);
                    } else {
                        console.log('♻️  Reconnecting to existing PTY session:', ptySessionKey);
                        shellProcess = existingSession.pty;

                        clearTimeout(existingSession.timeoutId);

                        // 重放 buffer：将之前积累的输出先发给客户端，恢复终端上下文
                        if (existingSession.buffer && existingSession.buffer.length > 0) {
                            const replayData = existingSession.buffer.join('');
                            ws.send(JSON.stringify({ type: 'output', data: '\x1b[2J\x1b[H' }));
                            ws.send(JSON.stringify({ type: 'output', data: replayData }));
                        } else {
                            const providerName = isPlainShell ? 'Shell' :
                                (provider === 'cursor' ? 'Cursor' : (provider === 'codex' ? 'Codex' : (provider === 'gemini' ? 'Gemini' : 'Claude')));
                            ws.send(JSON.stringify({
                                type: 'output',
                                data: `\x1b[2J\x1b[H\x1b[36m[Reconnected · ${providerName}${isPlainShell ? '' : ' · ' + projectPath}]\x1b[0m\r\n`
                            }));
                        }

                        // 通知客户端当前会话的 provider，便于前端同步
                        ws.send(JSON.stringify({
                            type: 'session-sync',
                            provider: isPlainShell ? 'plain-shell' : provider,
                            sessionId: sessionId || null,
                            projectPath,
                        }));

                        existingSession.ws = ws;
                        existingSession.provider = shellProviderKey;

                        // 注意：不需要重新绑定 onData —— 原始 onData handler 通过 session.ws 引用发送数据，
                        // 上面已经把 existingSession.ws 更新为新的 ws 了，后续输出会自动发到新连接。
                        return;
                    }
                    }
                }

                console.log('[INFO] Starting shell in:', projectPath);
                console.log('📋 Session info:', hasSession ? `Resume session ${sessionId}` : (isPlainShell ? 'Plain shell mode' : 'New session'));
                console.log('🤖 Provider:', isPlainShell ? 'plain-shell' : provider);
                if (initialCommand) {
                    console.log('⚡ Initial command:', initialCommand);
                }

                // First send a welcome message
                let welcomeMsg;
                if (isPlainShell) {
                    welcomeMsg = `\x1b[36mStarting terminal in: ${projectPath}\x1b[0m\r\n`;
                } else {
                    const providerName = provider === 'cursor' ? 'Cursor' : (provider === 'codex' ? 'Codex' : (provider === 'gemini' ? 'Gemini' : 'Claude'));
                    welcomeMsg = hasSession ?
                        `\x1b[36mResuming ${providerName} session ${sessionId} in: ${projectPath}\x1b[0m\r\n` :
                        `\x1b[36mStarting new ${providerName} session in: ${projectPath}\x1b[0m\r\n`;
                }

                ws.send(JSON.stringify({
                    type: 'output',
                    data: welcomeMsg
                }));

                try {
                    // Prepare the shell command adapted to the platform and provider
                    let shellCommand;
                    if (isPlainShell) {
                        // Plain shell mode - run initialCommand or fall back to interactive bash
                        const shellCmd = initialCommand || 'bash';
                        if (os.platform() === 'win32') {
                            shellCommand = `Set-Location -Path "${projectPath}"; ${shellCmd}`;
                        } else {
                            shellCommand = `cd "${projectPath}" && ${shellCmd}`;
                        }
                    } else if (provider === 'cursor') {
                        // Use cursor-agent command
                        if (os.platform() === 'win32') {
                            if (hasSession && sessionId) {
                                shellCommand = `Set-Location -Path "${projectPath}"; cursor-agent --resume="${sessionId}"`;
                            } else {
                                shellCommand = `Set-Location -Path "${projectPath}"; cursor-agent`;
                            }
                        } else {
                            if (hasSession && sessionId) {
                                shellCommand = `cd "${projectPath}" && cursor-agent --resume="${sessionId}"`;
                            } else {
                                shellCommand = `cd "${projectPath}" && cursor-agent`;
                            }
                        }

                    } else if (provider === 'codex') {
                        // Use codex command
                        const modelArg = codexModel ? ` --model "${codexModel}"` : '';
                        if (os.platform() === 'win32') {
                            if (hasSession && sessionId) {
                                // Try to resume session, but with fallback to a new session if it fails
                                shellCommand = `Set-Location -Path "${projectPath}"; codex resume${modelArg} "${sessionId}"; if ($LASTEXITCODE -ne 0) { codex${modelArg} }`;
                            } else {
                                shellCommand = `Set-Location -Path "${projectPath}"; codex${modelArg}`;
                            }
                        } else {
                            if (hasSession && sessionId) {
                                // Try to resume session, but with fallback to a new session if it fails
                                shellCommand = `cd "${projectPath}" && codex resume${modelArg} "${sessionId}" || codex${modelArg}`;
                            } else {
                                shellCommand = `cd "${projectPath}" && codex${modelArg}`;
                            }
                        }
                    } else if (provider === 'gemini') {
                        // Use gemini command
                        const command = initialCommand || 'gemini';
                        let resumeId = sessionId;
                        if (hasSession && sessionId) {
                            try {
                                // Gemini CLI enforces its own native session IDs, unlike other agents that accept arbitrary string names.
                                // The UI only knows about its internal generated `sessionId` (e.g. gemini_1234).
                                // We must fetch the mapping from the backend session manager to pass the native `cliSessionId` to the shell.
                                const sess = sessionManager.getSession(sessionId);
                                if (sess && sess.cliSessionId) {
                                    resumeId = sess.cliSessionId;
                                }
                            } catch (err) {
                                console.error('Failed to get Gemini CLI session ID:', err);
                            }
                        }

                        if (os.platform() === 'win32') {
                            if (hasSession && resumeId) {
                                shellCommand = `Set-Location -Path "${projectPath}"; ${command} --resume "${resumeId}"`;
                            } else {
                                shellCommand = `Set-Location -Path "${projectPath}"; ${command}`;
                            }
                        } else {
                            if (hasSession && resumeId) {
                                shellCommand = `cd "${projectPath}" && ${command} --resume "${resumeId}"`;
                            } else {
                                shellCommand = `cd "${projectPath}" && ${command}`;
                            }
                        }
                    } else {
                        const claudeBin = initialCommand || process.env.CLAUDE_CLI_PATH || 'claude';
                        if (os.platform() === 'win32') {
                            if (hasSession && sessionId) {
                                shellCommand = `Set-Location -Path "${projectPath}"; ${claudeBin} --resume ${sessionId}; if ($LASTEXITCODE -ne 0) { ${claudeBin} }`;
                            } else {
                                shellCommand = `Set-Location -Path "${projectPath}"; ${claudeBin}`;
                            }
                        } else {
                            if (hasSession && sessionId) {
                                shellCommand = `cd "${projectPath}" && ${claudeBin} --resume ${sessionId} || ${claudeBin}`;
                            } else {
                                shellCommand = `cd "${projectPath}" && ${claudeBin}`;
                            }
                        }
                    }

                    console.log('🔧 Executing shell command:', shellCommand);

                    // Use appropriate shell based on platform
                    const shell = os.platform() === 'win32' ? 'powershell.exe' : 'bash';
                    const shellArgs = os.platform() === 'win32' ? ['-Command', shellCommand] : ['-c', shellCommand];

                    // Use terminal dimensions from client if provided, otherwise use defaults
                    const termCols = data.cols || 80;
                    const termRows = data.rows || 24;
                    console.log('📐 Using terminal dimensions:', termCols, 'x', termRows);

                    // 构建 shell 环境变量，删除 Claude Code 嵌套会话检测变量
                    const { CLAUDECODE: _cc, CLAUDE_CODE_ENTRYPOINT: _cce, ...shellEnv } = process.env;
                    shellProcess = pty.spawn(shell, shellArgs, {
                        name: 'xterm-256color',
                        cols: termCols,
                        rows: termRows,
                        cwd: os.homedir(),
                        env: {
                            ...shellEnv,
                            TERM: 'xterm-256color',
                            COLORTERM: 'truecolor',
                            FORCE_COLOR: '3'
                        }
                    });

                    console.log('🟢 Shell process started with PTY, PID:', shellProcess.pid);

                    ptySessionsMap.set(ptySessionKey, {
                        pty: shellProcess,
                        ws: ws,
                        buffer: [],
                        bufferBytes: 0,
                        timeoutId: null,
                        projectPath,
                        sessionId,
                        provider: shellProviderKey,
                        // Claude resume 时会打印大量历史，用"安静期检测"代替固定延迟清屏：
                        // 输出流停止 600ms 后（说明 Claude 已显示提示符），才发清屏指令
                        waitingForQuiet: !isPlainShell && hasSession,
                        clearSent: false,
                        quietTimer: null,
                    });

                    // 20 秒兜底：若安静期迟迟未到（极长会话），强制清屏
                    if (!isPlainShell && hasSession) {
                        setTimeout(() => {
                            const sess = ptySessionsMap.get(ptySessionKey);
                            if (sess && sess.waitingForQuiet && !sess.clearSent) {
                                if (sess.quietTimer) clearTimeout(sess.quietTimer);
                                sess.clearSent = true;
                                sess.waitingForQuiet = false;
                                if (sess.ws && sess.ws.readyState === WebSocket.OPEN) {
                                    safeSendWebSocket(sess.ws, JSON.stringify({ type: 'output', data: '\x1b[2J\x1b[H' }));
                                }
                            }
                        }, 20000);
                    }

                    // Handle data output
                    shellProcess.onData((data) => {
                        const session = ptySessionsMap.get(ptySessionKey);
                        if (!session) return;

                        const replayChunk = Buffer.byteLength(data) > MAX_PTY_REPLAY_BYTES
                            ? Buffer.from(data).subarray(-MAX_PTY_REPLAY_BYTES).toString('utf8')
                            : data;
                        session.buffer.push(replayChunk);
                        session.bufferBytes = Number(session.bufferBytes || 0) + Buffer.byteLength(replayChunk);
                        while (session.bufferBytes > MAX_PTY_REPLAY_BYTES && session.buffer.length > 1) {
                            session.bufferBytes -= Buffer.byteLength(session.buffer.shift());
                        }

                        if (session.ws && session.ws.readyState === WebSocket.OPEN) {
                            let outputData = data;

                            const cleanChunk = stripAnsiSequences(data);
                            urlDetectionBuffer = `${urlDetectionBuffer}${cleanChunk}`.slice(-SHELL_URL_PARSE_BUFFER_LIMIT);

                            outputData = outputData.replace(
                                /OPEN_URL:\s*(https?:\/\/[^\s\x1b\x07]+)/g,
                                '[INFO] Opening in browser: $1'
                            );

                            const emitAuthUrl = (detectedUrl, autoOpen = false) => {
                                const normalizedUrl = normalizeDetectedUrl(detectedUrl);
                                if (!normalizedUrl) return;

                                const isNewUrl = !announcedAuthUrls.has(normalizedUrl);
                                if (isNewUrl) {
                                    announcedAuthUrls.add(normalizedUrl);
                                    safeSendWebSocket(session.ws, JSON.stringify({
                                        type: 'auth_url',
                                        url: normalizedUrl,
                                        autoOpen
                                    }));
                                }

                            };

                            const normalizedDetectedUrls = extractUrlsFromText(urlDetectionBuffer)
                                .map((url) => normalizeDetectedUrl(url))
                                .filter(Boolean);

                            // Prefer the most complete URL if shorter prefix variants are also present.
                            const dedupedDetectedUrls = Array.from(new Set(normalizedDetectedUrls)).filter((url, _, urls) =>
                                !urls.some((otherUrl) => otherUrl !== url && otherUrl.startsWith(url))
                            );

                            dedupedDetectedUrls.forEach((url) => emitAuthUrl(url, false));

                            if (shouldAutoOpenUrlFromOutput(cleanChunk) && dedupedDetectedUrls.length > 0) {
                                const bestUrl = dedupedDetectedUrls.reduce((longest, current) =>
                                    current.length > longest.length ? current : longest
                                );
                                emitAuthUrl(bestUrl, true);
                            }

                            // Send regular output
                            safeSendWebSocket(session.ws, JSON.stringify({
                                type: 'output',
                                data: outputData
                            }));
                        }

                        // 安静期检测：每次有输出就重置计时器，安静 600ms 后清屏
                        if (session.waitingForQuiet && !session.clearSent) {
                            if (session.quietTimer) clearTimeout(session.quietTimer);
                            session.quietTimer = setTimeout(() => {
                                const s = ptySessionsMap.get(ptySessionKey);
                                if (!s || s.clearSent) return;
                                s.clearSent = true;
                                s.waitingForQuiet = false;
                                if (s.ws && s.ws.readyState === WebSocket.OPEN) {
                                    safeSendWebSocket(s.ws, JSON.stringify({ type: 'output', data: '\x1b[2J\x1b[H' }));
                                }
                            }, 600);
                        }
                    });

                    // Handle process exit
                    shellProcess.onExit((exitCode) => {
                        console.log('🔚 Shell process exited with code:', exitCode.exitCode, 'signal:', exitCode.signal);
                        const session = ptySessionsMap.get(ptySessionKey);
                        if (session && session.ws && session.ws.readyState === WebSocket.OPEN) {
                            safeSendWebSocket(session.ws, JSON.stringify({
                                type: 'output',
                                data: `\r\n\x1b[33mProcess exited with code ${exitCode.exitCode}${exitCode.signal ? ` (${exitCode.signal})` : ''}\x1b[0m\r\n`
                            }));
                        }
                        if (session && session.timeoutId) {
                            clearTimeout(session.timeoutId);
                        }
                        ptySessionsMap.delete(ptySessionKey);
                        shellProcess = null;
                    });

                } catch (spawnError) {
                    console.error('[ERROR] Error spawning process:', spawnError);
                    ws.send(JSON.stringify({
                        type: 'output',
                        data: `\r\n\x1b[31mError: ${spawnError.message}\x1b[0m\r\n`
                    }));
                }

            } else if (data.type === 'input') {
                // Send input to shell process
                if (shellProcess && shellProcess.write) {
                    try {
                        shellProcess.write(data.data);
                    } catch (error) {
                        console.error('Error writing to shell:', error);
                    }
                } else {
                    console.warn('No active shell process to send input to');
                }
            } else if (data.type === 'resize') {
                // Handle terminal resize
                if (shellProcess && shellProcess.resize) {
                    console.log('Terminal resize requested:', data.cols, 'x', data.rows);
                    shellProcess.resize(data.cols, data.rows);
                }
            } else if (data.type === 'ping') {
                // 心跳 ping → 立即回复 pong，防止代理/防火墙断连
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'pong' }));
                }
            }
        } catch (error) {
            console.error('[ERROR] Shell WebSocket error:', error.message);
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'output',
                    data: `\r\n\x1b[31mError: ${error.message}\x1b[0m\r\n`
                }));
                // An init failure otherwise leaves the browser attached to an
                // open socket with no PTY. Closing it lets the existing client
                // reconnect loop retry automatically after a transient deploy
                // or server-side initialization failure.
                if (data?.type === 'init') {
                    ws.close(1011, 'Shell initialization failed');
                }
            }
        }
    });

    ws.on('close', () => {
        console.log('🔌 Shell client disconnected');

        // 从 shellWsMap 移除，避免向已断开的 ws 转发事件
        if (shellSessionId) {
            const wsSet = shellWsMap.get(shellSessionId);
            if (wsSet) {
                wsSet.delete(ws);
                if (wsSet.size === 0) shellWsMap.delete(shellSessionId);
            }
            shellSessionId = null;
            console.log(`🔗 Shell WS unregistered for session`);
        }

        if (ptySessionKey) {
            const session = ptySessionsMap.get(ptySessionKey);
            if (session) {
                console.log('⏳ PTY session kept alive, will timeout in 24 hours:', ptySessionKey);
                session.ws = null;

                session.timeoutId = setTimeout(() => {
                    console.log('⏰ PTY session timeout, killing process:', ptySessionKey);
                    if (session.pty && session.pty.kill) {
                        session.pty.kill();
                    }
                    ptySessionsMap.delete(ptySessionKey);
                }, PTY_SESSION_TIMEOUT);
            }
        }
    });

    ws.on('error', (error) => {
        console.error('[ERROR] Shell WebSocket error:', error);
    });
}
// Audio transcription endpoint
app.post('/api/transcribe', authenticateToken, async (req, res) => {
    try {
        const multer = (await import('multer')).default;
        const upload = multer({ storage: multer.memoryStorage() });

        // Handle multipart form data
        upload.single('audio')(req, res, async (err) => {
            if (err) {
                return res.status(400).json({ error: 'Failed to process audio file' });
            }

            if (!req.file) {
                return res.status(400).json({ error: 'No audio file provided' });
            }

            const apiKey = process.env.OPENAI_API_KEY;
            if (!apiKey) {
                return res.status(500).json({ error: 'OpenAI API key not configured. Please set OPENAI_API_KEY in server environment.' });
            }

            try {
                // Create form data for OpenAI
                const FormData = (await import('form-data')).default;
                const formData = new FormData();
                formData.append('file', req.file.buffer, {
                    filename: req.file.originalname,
                    contentType: req.file.mimetype
                });
                formData.append('model', 'whisper-1');
                formData.append('response_format', 'json');
                const requestedLanguage = String(req.body.language || '').trim();
                if (requestedLanguage && requestedLanguage !== 'auto') {
                    formData.append('language', requestedLanguage.split('-')[0]);
                }

                // Make request to OpenAI
                const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${apiKey}`,
                        ...formData.getHeaders()
                    },
                    body: formData
                });

                if (!response.ok) {
                    const errorData = await response.json().catch(() => ({}));
                    throw new Error(errorData.error?.message || `Whisper API error: ${response.status}`);
                }

                const data = await response.json();
                let transcribedText = data.text || '';

                // Check if enhancement mode is enabled
                const mode = req.body.mode || 'default';

                // If no transcribed text, return empty
                if (!transcribedText) {
                    return res.json({ text: '' });
                }

                // If default mode, return transcribed text without enhancement
                if (mode === 'default') {
                    return res.json({ text: transcribedText });
                }

                // Handle different enhancement modes
                try {
                    const OpenAI = (await import('openai')).default;
                    const openai = new OpenAI({ apiKey });

                    let prompt, systemMessage, temperature = 0.7, maxTokens = 800;

                    switch (mode) {
                        case 'prompt':
                            systemMessage = 'You are an expert prompt engineer who creates clear, detailed, and effective prompts.';
                            prompt = `You are an expert prompt engineer. Transform the following rough instruction into a clear, detailed, and context-aware AI prompt.

Your enhanced prompt should:
1. Be specific and unambiguous
2. Include relevant context and constraints
3. Specify the desired output format
4. Use clear, actionable language
5. Include examples where helpful
6. Consider edge cases and potential ambiguities

Transform this rough instruction into a well-crafted prompt:
"${transcribedText}"

Enhanced prompt:`;
                            break;

                        case 'vibe':
                        case 'instructions':
                        case 'architect':
                            systemMessage = 'You are a helpful assistant that formats ideas into clear, actionable instructions for AI agents.';
                            temperature = 0.5; // Lower temperature for more controlled output
                            prompt = `Transform the following idea into clear, well-structured instructions that an AI agent can easily understand and execute.

IMPORTANT RULES:
- Format as clear, step-by-step instructions
- Add reasonable implementation details based on common patterns
- Only include details directly related to what was asked
- Do NOT add features or functionality not mentioned
- Keep the original intent and scope intact
- Use clear, actionable language an agent can follow

Transform this idea into agent-friendly instructions:
"${transcribedText}"

Agent instructions:`;
                            break;

                        default:
                            // No enhancement needed
                            break;
                    }

                    // Only make GPT call if we have a prompt
                    if (prompt) {
                        const completion = await openai.chat.completions.create({
                            model: 'gpt-4o-mini',
                            messages: [
                                { role: 'system', content: systemMessage },
                                { role: 'user', content: prompt }
                            ],
                            temperature: temperature,
                            max_tokens: maxTokens
                        });

                        transcribedText = completion.choices[0].message.content || transcribedText;
                    }

                } catch (gptError) {
                    console.error('GPT processing error:', gptError);
                    // Fall back to original transcription if GPT fails
                }

                res.json({ text: transcribedText });

            } catch (error) {
                console.error('Transcription error:', error);
                res.status(500).json({ error: error.message });
            }
        });
    } catch (error) {
        console.error('Endpoint error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Image upload endpoint
app.post('/api/projects/:projectName/upload-images', authenticateToken, async (req, res) => {
    try {
        const multer = (await import('multer')).default;
        const path = (await import('path')).default;
        const fs = (await import('fs')).promises;
        const os = (await import('os')).default;

        // Configure multer for image uploads
        const storage = multer.diskStorage({
            destination: async (req, file, cb) => {
                const uploadDir = path.join(os.tmpdir(), 'claude-ui-uploads', String(req.user.id));
                await fs.mkdir(uploadDir, { recursive: true });
                cb(null, uploadDir);
            },
            filename: (req, file, cb) => {
                const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
                const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
                cb(null, uniqueSuffix + '-' + sanitizedName);
            }
        });

        const fileFilter = (req, file, cb) => {
            const allowedMimes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'];
            if (allowedMimes.includes(file.mimetype)) {
                cb(null, true);
            } else {
                cb(new Error('Invalid file type. Only JPEG, PNG, GIF, WebP, and SVG are allowed.'));
            }
        };

        const upload = multer({
            storage,
            fileFilter,
            limits: {
                fileSize: 20 * 1024 * 1024, // 20MB（前端已压缩，此处兜底）
                files: 5
            }
        });

        // Handle multipart form data
        upload.array('images', 5)(req, res, async (err) => {
            if (err) {
                return res.status(400).json({ error: err.message });
            }

            if (!req.files || req.files.length === 0) {
                return res.status(400).json({ error: 'No image files provided' });
            }

            try {
                // Process uploaded images
                const processedImages = await Promise.all(
                    req.files.map(async (file) => {
                        // Read file and convert to base64
                        const buffer = await fs.readFile(file.path);
                        const base64 = buffer.toString('base64');
                        const mimeType = file.mimetype;

                        // Clean up temp file immediately
                        await fs.unlink(file.path);

                        return {
                            name: file.originalname,
                            data: `data:${mimeType};base64,${base64}`,
                            size: file.size,
                            mimeType: mimeType
                        };
                    })
                );

                res.json({ images: processedImages });
            } catch (error) {
                console.error('Error processing images:', error);
                // Clean up any remaining files
                await Promise.all(req.files.map(f => fs.unlink(f.path).catch(() => { })));
                res.status(500).json({ error: 'Failed to process images' });
            }
        });
    } catch (error) {
        console.error('Error in image upload endpoint:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

function estimateTokenCountForBudget(value) {
    const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
    return text ? Math.max(1, Math.ceil(text.length / 4)) : 0;
}

function estimateStoredMessagesTokenUsage(messages = []) {
    return messages.reduce((total, message) => {
        return total + estimateTokenCountForBudget(message?.content ?? message?.message?.content ?? '');
    }, 0);
}

const codexSessionFileCache = new Map();
const codexSessionFileLookups = new Map();
const codexTokenUsageCache = new Map();
const codexCumulativeUsageCache = new Map();
const claudeTokenUsageCache = new Map();
const claudeCumulativeUsageCache = new Map();
function parseCodexTokenUsageLine(line) {
    if (!line?.trim()) return null;
    try {
        const entry = JSON.parse(line);
        if (entry.type !== 'event_msg' || entry.payload?.type !== 'token_count' || !entry.payload?.info) {
            return null;
        }
        const tokenInfo = entry.payload.info;
        const usage = tokenInfo.last_token_usage || tokenInfo.total_token_usage;
        const totalTokens = usage
            ? Number(usage.total_tokens || (
                Number(usage.input_tokens || usage.prompt_tokens || usage.total_input_tokens || 0)
                + Number(usage.output_tokens || 0)
            ))
            : 0;
        return {
            totalTokens,
            contextWindow: Number(tokenInfo.model_context_window || 0),
        };
    } catch {
        return null;
    }
}

async function readLatestCodexTokenUsage(filePath, fileSize) {
    const handle = await fsPromises.open(filePath, 'r');
    const chunkSize = 256 * 1024;
    let position = fileSize;
    let carry = '';
    try {
        while (position > 0) {
            const bytesToRead = Math.min(chunkSize, position);
            position -= bytesToRead;
            const buffer = Buffer.allocUnsafe(bytesToRead);
            const { bytesRead } = await handle.read(buffer, 0, bytesToRead, position);
            const lines = `${buffer.toString('utf8', 0, bytesRead)}${carry}`.split('\n');
            carry = lines.shift() || '';
            for (let index = lines.length - 1; index >= 0; index -= 1) {
                const found = parseCodexTokenUsageLine(lines[index]);
                if (found) return found;
            }
        }
        return parseCodexTokenUsageLine(carry);
    } finally {
        await handle.close();
    }
}

async function resolveCodexSessionFile(sessionsDir, sessionId) {
    const cachedPath = codexSessionFileCache.get(sessionId);
    if (cachedPath) {
        try {
            await fsPromises.access(cachedPath);
            return cachedPath;
        } catch {
            codexSessionFileCache.delete(sessionId);
        }
    }

    if (codexSessionFileLookups.has(sessionId)) {
        return codexSessionFileLookups.get(sessionId);
    }

    const lookup = (async () => {
        const visit = async (dir) => {
            let entries;
            try {
                entries = await fsPromises.readdir(dir, { withFileTypes: true });
            } catch {
                return null;
            }
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    const found = await visit(fullPath);
                    if (found) return found;
                } else if (entry.name.includes(sessionId) && entry.name.endsWith('.jsonl')) {
                    return fullPath;
                }
            }
            return null;
        };
        const found = await visit(sessionsDir);
        if (found) codexSessionFileCache.set(sessionId, found);
        return found;
    })().finally(() => codexSessionFileLookups.delete(sessionId));

    codexSessionFileLookups.set(sessionId, lookup);
    return lookup;
}

async function resolveCodexLogicalSessionFiles(sessionsDir, sessionId) {
    const files = [];
    const sessionMarker = `"session_id":"${sessionId}"`;
    const visit = async (directory) => {
        let entries;
        try {
            entries = await fsPromises.readdir(directory, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const fullPath = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                await visit(fullPath);
                continue;
            }
            if (!entry.name.endsWith('.jsonl')) continue;
            if (entry.name.includes(sessionId)) {
                files.push(fullPath);
                continue;
            }
            try {
                const handle = await fsPromises.open(fullPath, 'r');
                try {
                    const buffer = Buffer.allocUnsafe(4096);
                    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
                    if (buffer.toString('utf8', 0, bytesRead).includes(sessionMarker)) files.push(fullPath);
                } finally {
                    await handle.close();
                }
            } catch { /* rollout disappeared during scan */ }
        }
    };
    await visit(sessionsDir);
    return files.sort();
}

async function readCodexLogicalSessionUsage(files) {
    const seenSnapshots = new Set();
    let input = 0;
    let cachedInput = 0;
    let output = 0;

    for (const filePath of files) {
        let previous = null;
        for await (const line of readBoundedJsonlLines(filePath)) {
            if (!line.includes('"type":"token_count"')) continue;
            let entry;
            try { entry = JSON.parse(line); } catch { continue; }
            const info = entry?.type === 'event_msg' && entry.payload?.type === 'token_count'
                ? entry.payload.info
                : null;
            const total = info?.total_token_usage;
            if (!total) continue;
            const current = {
                input: Number(total.input_tokens || total.prompt_tokens || 0),
                cachedInput: Number(total.cached_input_tokens || 0),
                output: Number(total.output_tokens || 0),
            };
            const snapshotKey = `${current.input}:${current.cachedInput}:${current.output}`;
            if (seenSnapshots.has(snapshotKey)) {
                previous = current;
                continue;
            }
            seenSnapshots.add(snapshotKey);

            const last = info.last_token_usage;
            if (last) {
                input += Math.max(0, Number(last.input_tokens || last.prompt_tokens || 0));
                cachedInput += Math.max(0, Number(last.cached_input_tokens || 0));
                output += Math.max(0, Number(last.output_tokens || 0));
            } else {
                input += Math.max(0, current.input - Number(previous?.input || 0));
                cachedInput += Math.max(0, current.cachedInput - Number(previous?.cachedInput || 0));
                output += Math.max(0, current.output - Number(previous?.output || 0));
            }
            previous = current;
        }
    }
    return { input, cachedInput, output };
}

// Get token usage for a specific session
app.get('/api/projects/:projectName/sessions/:sessionId/token-usage', authenticateToken, async (req, res) => {
    try {
        const { projectName, sessionId } = req.params;
        const { provider = 'claude' } = req.query;
        const homeDir = os.homedir();

        // Allow only safe characters in sessionId
        const safeSessionId = String(sessionId).replace(/[^a-zA-Z0-9._-]/g, '');
        if (!safeSessionId || safeSessionId !== String(sessionId)) {
            return res.status(400).json({ error: 'Invalid sessionId' });
        }

        // Handle Cursor sessions - they use SQLite and don't have token usage info
        if (provider === 'cursor') {
            return res.json({
                used: 0,
                total: 0,
                breakdown: { input: 0, cacheCreation: 0, cacheRead: 0 },
                unsupported: true,
                message: 'Token usage tracking not available for Cursor sessions'
            });
        }

        // Handle Gemini sessions from the local session manager with a conservative estimate
        if (provider === 'gemini') {
            const session = sessionManager.getSession(safeSessionId);
            const used = estimateStoredMessagesTokenUsage(session?.messages || []);
            return res.json({
                used,
                total: 1000000,
                estimated: true,
                breakdown: { input: used, cacheCreation: 0, cacheRead: 0 }
            });
        }

        // Handle Codex sessions
        if (provider === 'codex') {
            const codexSessionsDir = path.join(homeDir, '.codex', 'sessions');

            const sessionFilePath = await resolveCodexSessionFile(codexSessionsDir, safeSessionId);

            if (!sessionFilePath) {
                return res.status(404).json({ error: 'Codex session file not found', sessionId: safeSessionId });
            }

            const sessionStat = await fsPromises.stat(sessionFilePath);
            const cachedUsage = codexTokenUsageCache.get(safeSessionId);
            if (cachedUsage
                && cachedUsage.path === sessionFilePath
                && cachedUsage.size === sessionStat.size
                && cachedUsage.mtimeMs === sessionStat.mtimeMs) {
                return res.json(cachedUsage.payload);
            }

            // Token events are near the end of rollout files. Read backwards in
            // small chunks instead of loading and parsing a multi-GB session on
            // the Node event loop, which used to stall every page request.
            let latestUsage;
            try {
                latestUsage = await readLatestCodexTokenUsage(sessionFilePath, sessionStat.size);
            } catch (error) {
                if (error.code === 'ENOENT') {
                    return res.status(404).json({ error: 'Session file not found', path: sessionFilePath });
                }
                throw error;
            }
            const totalTokens = Number(latestUsage?.totalTokens || 0);
            const contextWindow = Number(
                latestUsage?.contextWindow || process.env.CODEX_CONTEXT_WINDOW || 1050000
            ) || 1050000;

            const payload = {
                used: totalTokens,
                total: contextWindow
            };
            codexTokenUsageCache.set(safeSessionId, {
                path: sessionFilePath,
                size: sessionStat.size,
                mtimeMs: sessionStat.mtimeMs,
                payload,
            });
            return res.json(payload);
        }

        // Handle Claude sessions (default)
        // Extract actual project path
        let projectPath;
        try {
            projectPath = await extractProjectDirectory(projectName);
        } catch (error) {
            console.error('Error extracting project directory:', error);
            return res.status(500).json({ error: 'Failed to determine project path' });
        }

        // Construct the JSONL file path
        // Claude stores session files in ~/.claude/projects/[encoded-project-path]/[session-id].jsonl
        // The encoding replaces any non-alphanumeric character (except -) with -
        const encodedPath = projectPath.replace(/[^a-zA-Z0-9-]/g, '-');
        const projectDir = path.join(homeDir, '.claude', 'projects', encodedPath);

        const jsonlPath = path.join(projectDir, `${safeSessionId}.jsonl`);

        // Constrain to projectDir
        const rel = path.relative(path.resolve(projectDir), path.resolve(jsonlPath));
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
            return res.status(400).json({ error: 'Invalid path' });
        }

        const claudeStat = await fsPromises.stat(jsonlPath).catch(() => null);
        const cachedClaudeUsage = claudeTokenUsageCache.get(jsonlPath);
        if (
            claudeStat &&
            cachedClaudeUsage?.size === claudeStat.size &&
            cachedClaudeUsage?.mtimeMs === claudeStat.mtimeMs
        ) {
            return res.json(cachedClaudeUsage.payload);
        }

        // Read incrementally with a per-record cap. Tool output can make a
        // single JSONL line hundreds of MiB; token records are small.
        let foundUsage = null;
        try {
            for await (const line of readBoundedJsonlLines(jsonlPath)) {
                let entry;
                try { entry = JSON.parse(line); } catch { continue; }
                if (entry.type === 'assistant' && entry.message?.usage) {
                    foundUsage = entry.message.usage;
                }
            }
        } catch (error) {
            if (error.code === 'ENOENT') {
                return res.status(404).json({ error: 'Session file not found', path: jsonlPath });
            }
            throw error; // Re-throw other errors to be caught by outer try-catch
        }
        const parsedContextWindow = parseInt(process.env.CONTEXT_WINDOW, 10);
        const contextWindow = Number.isFinite(parsedContextWindow) ? parsedContextWindow : 160000;
        let inputTokens = 0;
        let cacheCreationTokens = 0;
        let cacheReadTokens = 0;

        inputTokens = foundUsage?.input_tokens || 0;
        cacheCreationTokens = foundUsage?.cache_creation_input_tokens || 0;
        cacheReadTokens = foundUsage?.cache_read_input_tokens || 0;

        // Calculate total context usage (excluding output_tokens, as per ccusage)
        const totalUsed = inputTokens + cacheCreationTokens + cacheReadTokens;

        const payload = {
            used: totalUsed,
            total: contextWindow,
            breakdown: {
                input: inputTokens,
                cacheCreation: cacheCreationTokens,
                cacheRead: cacheReadTokens
            }
        };
        if (claudeStat) {
            claudeTokenUsageCache.set(jsonlPath, {
                size: claudeStat.size,
                mtimeMs: claudeStat.mtimeMs,
                payload,
            });
        }
        res.json(payload);
    } catch (error) {
        console.error('Error reading session token usage:', error);
        res.status(500).json({ error: 'Failed to read session token usage' });
    }
});

// 汇总整个 session 历史的累计 token 用量（按 requestId 去重，避免重复计）
app.get('/api/projects/:projectName/sessions/:sessionId/cumulative-tokens', authenticateToken, async (req, res) => {
    try {
        const { projectName, sessionId } = req.params;
        const homeDir = os.homedir();

        const safeSessionId = String(sessionId).replace(/[^a-zA-Z0-9._-]/g, '');
        if (!safeSessionId || safeSessionId !== String(sessionId)) {
            return res.status(400).json({ error: 'Invalid sessionId' });
        }

        if (req.query.provider === 'codex') {
            const sessionsRoot = path.join(homeDir, '.codex', 'sessions');
            const cached = codexCumulativeUsageCache.get(safeSessionId);
            if (cached && cached.expiresAt > Date.now()) return res.json(cached.payload);

            // A logical Codex session can own many subagent rollout files whose
            // filenames use their runtime thread ids. Sum each official
            // last_token_usage once and deduplicate the historical counter
            // snapshots replayed into child/resumed rollouts.
            const files = await resolveCodexLogicalSessionFiles(sessionsRoot, safeSessionId);
            if (files.length === 0) return res.status(404).json({ error: 'Codex session file not found' });
            const usage = await readCodexLogicalSessionUsage(files);
            const payload = {
                input: usage.input,
                cachedInput: usage.cachedInput,
                output: usage.output,
                rolloutFiles: files.length,
                authoritative: true,
            };
            codexCumulativeUsageCache.set(safeSessionId, {
                expiresAt: Date.now() + 15_000,
                payload,
            });
            return res.json(payload);
        }

        let projectPath;
        try {
            projectPath = await extractProjectDirectory(projectName);
        } catch (e) {
            return res.status(500).json({ error: 'Failed to determine project path' });
        }

        const encodedPath = projectPath.replace(/[^a-zA-Z0-9-]/g, '-');
        const jsonlPath = path.join(homeDir, '.claude', 'projects', encodedPath, `${safeSessionId}.jsonl`);
        const cachedClaudeCumulative = claudeCumulativeUsageCache.get(jsonlPath);
        if (cachedClaudeCumulative?.expiresAt > Date.now()) {
            return res.json(cachedClaudeCumulative.payload);
        }

        try {
            await fsPromises.access(jsonlPath);
        } catch (e) {
            if (e.code === 'ENOENT') return res.status(404).json({ error: 'Session file not found' });
            throw e;
        }

        const seen = new Set();
        let totalInput = 0, totalOutput = 0;

        for await (const line of readBoundedJsonlLines(jsonlPath)) {
            try {
                const entry = JSON.parse(line);
                if (entry.type !== 'assistant' || !entry.message?.usage) continue;
                // requestId 去重：同一次 API 调用在 jsonl 里可能有多行（不同 content block）
                const key = entry.requestId || entry.uuid;
                if (!key || seen.has(key)) continue;
                seen.add(key);
                const u = entry.message.usage;
                totalInput  += (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
                totalOutput += (u.output_tokens || 0);
            } catch (_) { /* skip malformed lines */ }
        }

        const payload = { input: totalInput, output: totalOutput };
        claudeCumulativeUsageCache.set(jsonlPath, {
            expiresAt: Date.now() + 15_000,
            payload,
        });
        res.json(payload);
    } catch (error) {
        console.error('Error reading cumulative token usage:', error);
        res.status(500).json({ error: 'Failed to read cumulative token usage' });
    }
});

// Serve React app for all other routes (excluding static files)
app.get('*', (req, res) => {
    // Skip requests for static assets (files with extensions)
    if (path.extname(req.path)) {
        return res.status(404).send('Not found');
    }

    // Only serve index.html for HTML routes, not for static assets
    // Static assets should already be handled by express.static middleware above
    const indexPath = path.join(__dirname, '../dist/index.html');

    // Check if dist/index.html exists (production build available)
    if (fs.existsSync(indexPath)) {
        // Set no-cache headers for HTML to prevent service worker issues
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.sendFile(indexPath);
    } else {
        // In development, redirect to Vite dev server only if dist doesn't exist
        res.redirect(`http://localhost:${process.env.VITE_PORT || 5173}`);
    }
});

// Helper function to convert permissions to rwx format
function permToRwx(perm) {
    const r = perm & 4 ? 'r' : '-';
    const w = perm & 2 ? 'w' : '-';
    const x = perm & 1 ? 'x' : '-';
    return r + w + x;
}

async function getFileTree(dirPath, maxDepth = 3, currentDepth = 0, showHidden = true) {
    // Using fsPromises from import
    const items = [];

    try {
        const entries = await fsPromises.readdir(dirPath, { withFileTypes: true });

        for (const entry of entries) {
            // Debug: log all entries including hidden files


            // Skip heavy build/cache/VCS/data directories
            const skipDirs = new Set([
                'node_modules', 'dist', 'build', '.git', '.svn', '.hg',
                '__pycache__', '.conda', '.cache', '.tox', '.eggs', '.mypy_cache',
                '.ipynb_checkpoints', '.venv', 'venv', '.pytest_cache',
            ]);
            if (skipDirs.has(entry.name)) continue;

            const itemPath = path.join(dirPath, entry.name);
            const item = {
                name: entry.name,
                path: itemPath,
                type: entry.isDirectory() ? 'directory' : 'file'
            };

            // Get file stats for additional metadata
            try {
                const stats = await fsPromises.stat(itemPath);
                item.size = stats.size;
                item.modified = stats.mtime.toISOString();

                // Convert permissions to rwx format
                const mode = stats.mode;
                const ownerPerm = (mode >> 6) & 7;
                const groupPerm = (mode >> 3) & 7;
                const otherPerm = mode & 7;
                item.permissions = ((mode >> 6) & 7).toString() + ((mode >> 3) & 7).toString() + (mode & 7).toString();
                item.permissionsRwx = permToRwx(ownerPerm) + permToRwx(groupPerm) + permToRwx(otherPerm);
            } catch (statError) {
                // If stat fails, provide default values
                item.size = 0;
                item.modified = null;
                item.permissions = '000';
                item.permissionsRwx = '---------';
            }

            if (entry.isDirectory() && currentDepth < maxDepth) {
                // Recursively get subdirectories but limit depth
                try {
                    // Check if we can access the directory before trying to read it
                    await fsPromises.access(item.path, fs.constants.R_OK);
                    item.children = await getFileTree(item.path, maxDepth, currentDepth + 1, showHidden);
                } catch (e) {
                    // Silently skip directories we can't access (permission denied, etc.)
                    item.children = [];
                }
            }

            items.push(item);
        }
    } catch (error) {
        // Only log non-permission errors to avoid spam
        if (error.code !== 'EACCES' && error.code !== 'EPERM') {
            console.error('Error reading directory:', error);
        }
    }

    return items.sort((a, b) => {
        if (a.type !== b.type) {
            return a.type === 'directory' ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
    });
}

function fuzzyFileScore(value, query) {
    const source = value.toLowerCase();
    const needle = query.toLowerCase();
    if (!needle) return 0;

    const exactIndex = source.indexOf(needle);
    if (exactIndex >= 0) {
        return 10000 - exactIndex * 20 - Math.max(0, source.length - needle.length);
    }

    let score = 0;
    let sourceIndex = 0;
    let previousIndex = -2;
    for (const character of needle) {
        const matchIndex = source.indexOf(character, sourceIndex);
        if (matchIndex < 0) return Number.NEGATIVE_INFINITY;
        score += matchIndex === previousIndex + 1 ? 40 : 12;
        if (matchIndex === 0 || '/._- '.includes(source[matchIndex - 1])) score += 30;
        score -= Math.max(0, matchIndex - sourceIndex) * 2;
        previousIndex = matchIndex;
        sourceIndex = matchIndex + 1;
    }
    return score - source.length;
}

function filterAndRankFileTree(items, rawQuery, projectRoot) {
    const terms = rawQuery.toLowerCase().split(/\s+/).filter(Boolean);

    const visit = (nodes) => nodes.reduce((results, item) => {
        const relativePath = path.relative(projectRoot, item.path).split(path.sep).join('/');
        const scores = terms.map((term) => Math.max(
            fuzzyFileScore(item.name, term) + 250,
            fuzzyFileScore(relativePath, term),
        ));
        const matches = scores.every(Number.isFinite);
        const children = item.type === 'directory' && item.children ? visit(item.children) : [];
        if (!matches && children.length === 0) return results;

        const score = matches ? scores.reduce((total, value) => total + value, 0) : -1;
        results.push({ ...item, children, _searchScore: score });
        return results;
    }, []);

    const sortTree = (nodes) => nodes
        .map((node) => ({ ...node, children: node.children ? sortTree(node.children) : node.children }))
        .sort((a, b) => {
            const aBest = Math.max(a._searchScore ?? -1, ...(a.children || []).map((child) => child._searchScore ?? -1));
            const bBest = Math.max(b._searchScore ?? -1, ...(b.children || []).map((child) => child._searchScore ?? -1));
            return bBest - aBest || a.name.localeCompare(b.name);
        });

    return sortTree(visit(items));
}

const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || '127.0.0.1';
// Show localhost in URL when binding to all interfaces (0.0.0.0 isn't a connectable address)
const DISPLAY_HOST = HOST === '0.0.0.0' ? 'localhost' : HOST;

// Initialize database and start server
async function startServer() {
    try {
        // Initialize authentication database
        await initializeDatabase();

        // 异步回填历史 JSONL 归属（不阻塞 server 启动）：把改造前已有的 user 消息归到首位账号
        backfillHistoricalAttributions().catch(err =>
            console.warn('[attribution-backfill] Failed:', err.message)
        );

        // Check if running in production mode (dist folder exists)
        const distIndexPath = path.join(__dirname, '../dist/index.html');
        const isProduction = fs.existsSync(distIndexPath);

        // Log Claude implementation mode
        console.log(`${c.info('[INFO]')} Using Claude Agents SDK for Claude integration`);
        console.log(`${c.info('[INFO]')} Running in ${c.bright(isProduction ? 'PRODUCTION' : 'DEVELOPMENT')} mode`);

        if (!isProduction) {
            console.log(`${c.warn('[WARN]')} Note: Requests will be proxied to Vite dev server at ${c.dim('http://localhost:' + (process.env.VITE_PORT || 5173))}`);
        }

        const listen = (httpServer, port) => new Promise((resolve, reject) => {
            const handleError = (error) => reject(error);
            httpServer.once('error', handleError);
            httpServer.listen(port, HOST, () => {
                httpServer.off('error', handleError);
                resolve();
            });
        });

        await listen(server, PORT);
        if (secureServer) await listen(secureServer, HTTPS_PORT);

        const appInstallPath = path.join(__dirname, '..');
        console.log('');
        console.log(c.dim('═'.repeat(63)));
        console.log(`  ${c.bright('HelixUI Server - Ready')}`);
        console.log(c.dim('═'.repeat(63)));
        console.log('');
        console.log(`${c.info('[INFO]')} Server URL:  ${c.bright('http://' + DISPLAY_HOST + ':' + PORT)}`);
        if (secureServer) {
            console.log(`${c.info('[INFO]')} Secure URL:  ${c.bright('https://' + HTTPS_PUBLIC_HOST + ':' + HTTPS_PORT)}`);
        } else {
            console.log(`${c.warn('[WARN]')} HTTPS disabled: certificate files not found in ${HTTPS_CERT_DIR}`);
        }
        console.log(`${c.info('[INFO]')} Installed at: ${c.dim(appInstallPath)}`);
        console.log(`${c.tip('[TIP]')}  Run "helix-ui status" for full configuration details`);
        console.log('');

        await setupProjectsWatcher();
    } catch (error) {
        console.error('[ERROR] Failed to start server:', error);
        process.exit(1);
    }
}

startServer();

const beginGracefulRestart = (signal) => {
    if (isRestartRequested) return;
    isRestartRequested = true;
    console.log(`[SHUTDOWN] ${signal} received; waiting for active model turns to finish.`);

    let clearChecks = 0;
    const checkActiveTurns = () => {
        const counts = {
            claude: getActiveClaudeSDKSessions().length,
            codex: getActiveCodexSessions().length,
            cursor: getActiveCursorSessions().length,
            gemini: getActiveGeminiSessions().length,
        };
        const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
        if (total === 0) {
            // Only stop accepting new commands during the short, verified idle
            // window immediately before exit. Long-running turns must not make
            // the whole site unavailable while an update is pending.
            isDrainingForRestart = true;
            clearChecks += 1;
            if (clearChecks >= 2) {
                console.log('[SHUTDOWN] All model turns completed; shutting down now.');
                process.exit(0);
            }
        } else {
            isDrainingForRestart = false;
            clearChecks = 0;
            console.log(`[SHUTDOWN] Still draining ${total} active turn(s): ${JSON.stringify(counts)}`);
        }
        setTimeout(checkActiveTurns, 1000).unref();
    };
    checkActiveTurns();
};

process.on('SIGTERM', () => beginGracefulRestart('SIGTERM'));
process.on('SIGINT', () => beginGracefulRestart('SIGINT'));
