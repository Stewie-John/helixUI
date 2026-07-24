import { spawn } from 'child_process';
import readline from 'readline';

const APP_SERVER_TIMEOUT_MS = Number(process.env.CODEX_APP_SERVER_TIMEOUT_MS || 30000);
const APP_SERVER_COMPACTION_TIMEOUT_MS = Number(
  process.env.CODEX_APP_SERVER_COMPACTION_TIMEOUT_MS || 5 * 60 * 1000,
);

const normalizeItemType = (type) => ({
  agentMessage: 'agent_message',
  commandExecution: 'command_execution',
  fileChange: 'file_change',
  mcpToolCall: 'mcp_tool_call',
  webSearch: 'web_search',
  todoList: 'todo_list',
  imageView: 'image_view',
  contextCompaction: 'context_compaction',
}[type] || type);

function normalizeItem(item) {
  if (!item || typeof item !== 'object') return item;
  const type = normalizeItemType(item.type);
  return {
    ...item,
    type,
    id: item.id,
    text: item.text ?? item.message ?? (Array.isArray(item.content) ? item.content.join('\n') : undefined),
    aggregated_output: item.aggregated_output ?? item.aggregatedOutput ?? item.output,
    exit_code: item.exit_code ?? item.exitCode,
    changes: item.changes,
    arguments: item.arguments,
    result: item.result,
    error: item.error,
  };
}

function isFinalAssistantMessageForTurn(message, threadId, turnId = null) {
  if (message?.method !== 'item/completed') return false;
  const params = message.params || {};
  if (!threadId || params.threadId !== threadId) return false;
  if (turnId && params.turnId !== turnId) return false;
  const item = normalizeItem(params.item);
  return item?.type === 'agent_message' && item.phase === 'final_answer';
}

export class CodexAppServerSession {
  constructor(command = 'codex') {
    this.command = command;
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    this.notificationHandler = null;
    this.threadId = null;
    this.activeTurnId = null;
    this.initialized = null;
    this.closed = false;
    this.turnReject = null;
    this.threadAttached = false;
    this.stderrTail = '';
    this.lastUsedAt = Date.now();
  }

  async start() {
    if (this.proc?.stdin?.writable && this.proc.exitCode === null && !this.proc.killed) return;
    if (this.proc) {
      try { this.proc.kill(); } catch { /* ignore stale process */ }
      this.proc = null;
    }
    this.closed = false;
    this.threadAttached = false;
    this.activeTurnId = null;
    this.stderrTail = '';
    const proc = spawn(this.command, ['app-server', '--stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CODEX_DISABLE_UPDATE_CHECK: '1', CODEX_NO_UPDATE_CHECK: '1' },
    });
    this.proc = proc;
    const handleProcessFailure = (error) => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.initialized = null;
      this.threadAttached = false;
      this.failAll(error);
      this.failTurn(error);
    };
    proc.on('error', (error) => handleProcessFailure(error));
    proc.stdin.on('error', (error) => handleProcessFailure(error));
    // Always drain stderr. Leaving this pipe unread eventually blocks a noisy
    // app-server and makes otherwise healthy stdin requests time out.
    proc.stderr.on('data', (chunk) => {
      this.stderrTail = (this.stderrTail + String(chunk)).slice(-8192);
    });
    proc.on('close', (code) => {
      if (!this.closed) handleProcessFailure(new Error(`Codex app-server exited (${code})`));
    });
    readline.createInterface({ input: proc.stdout }).on('line', (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id !== undefined && this.pending.has(String(message.id))) {
        const entry = this.pending.get(String(message.id));
        this.pending.delete(String(message.id));
        clearTimeout(entry.timer);
        if (message.error) entry.reject(new Error(message.error.message || 'Codex app-server request failed'));
        else entry.resolve(message.result);
        return;
      }
      if (message.id !== undefined && message.method) {
        // The web UI currently has no interactive Codex approval dialog. Keep
        // the existing non-interactive behavior: trusted commands run, while
        // requests requiring an explicit approval are declined.
        const decision = this.approvalDecision;
        this.write({ id: message.id, result: { decision } });
        return;
      }
      if (message.method && this.notificationHandler) {
        this.notificationHandler(message).catch(() => {});
      }
    });
    this.initialized = this.request('initialize', {
      clientInfo: { name: 'claudecodeui', title: 'Claude Code UI', version: '1.0.0' },
      capabilities: { experimentalApi: false },
    }).then(() => this.write({ method: 'initialized' }));
    await this.initialized;
  }

  isAlive() {
    return Boolean(
      this.proc
      && this.proc.stdin?.writable
      && this.proc.exitCode === null
      && !this.proc.killed
      && !this.closed
    );
  }

  hasActiveTurn() {
    // Installed before turn/start is sent, so this also covers the short period
    // before app-server returns an active turn id.
    return Boolean(this.turnReject || this.activeTurnId);
  }

  write(message) {
    if (!this.proc?.stdin?.writable) throw new Error('Codex app-server stdin is unavailable');
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, APP_SERVER_TIMEOUT_MS);
      this.pending.set(String(id), { resolve, reject, timer });
      try { this.write({ id, method, params }); } catch (error) {
        clearTimeout(timer);
        this.pending.delete(String(id));
        reject(error);
      }
    });
  }

  async ensureThread({ threadId, cwd, model, sandbox, approvalPolicy, serviceTier }) {
    await this.start();
    this.approvalDecision = approvalPolicy === 'never' ? 'accept' : 'decline';
    if (this.threadAttached && this.threadId === threadId && this.threadId) return this.threadId;

    const params = threadId
      ? { threadId, cwd, model, sandbox, approvalPolicy, serviceTier }
      : { cwd, model, sandbox, approvalPolicy, serviceTier, threadSource: 'user' };
    const response = await this.request(threadId ? 'thread/resume' : 'thread/start', params);
    this.threadId = response?.thread?.id || response?.thread?.sessionId || threadId;
    if (!this.threadId) throw new Error('Codex app-server did not return a thread id');
    this.threadAttached = true;
    this.lastUsedAt = Date.now();
    return this.threadId;
  }

  async runTurn({ input, cwd, model, effort, serviceTier, sandboxPolicy, approvalPolicy }, onNotification) {
    this.approvalDecision = approvalPolicy === 'never' ? 'accept' : 'decline';
    this.lastUsedAt = Date.now();
    let settled = false;
    const turnDone = new Promise((resolve, reject) => {
      const previousHandler = this.notificationHandler;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        this.notificationHandler = previousHandler;
        this.turnReject = null;
        this.activeTurnId = null;
        callback(value);
      };
      this.turnReject = (error) => finish(reject, error);
      this.notificationHandler = async (message) => {
        try { await onNotification(message); } catch { /* transport formatting must not stall the turn */ }
        if (message.method === 'turn/started' && message.params?.threadId === this.threadId) {
          this.activeTurnId = message.params?.turn?.id || this.activeTurnId;
        }
        if (message.method === 'turn/completed' && message.params?.threadId === this.threadId) {
          if (!message.params?.turn?.id || message.params.turn.id === this.activeTurnId) {
            finish(resolve, message.params);
          }
        } else if (message.method === 'turn/failed' && message.params?.threadId === this.threadId) {
          finish(reject, new Error(message.params?.turn?.error?.message || 'Codex turn failed'));
        }
      };
    });
    // A process exit can reject the start request and the turn completion at the
    // same time. Attach a handler immediately so the latter is never unhandled.
    turnDone.catch(() => {});
    let response;
    try {
      response = await this.request('turn/start', {
      threadId: this.threadId,
      input,
      cwd,
      model,
      effort,
      serviceTier,
      sandboxPolicy,
      approvalPolicy,
      });
    } catch (error) {
      this.failTurn(error);
      throw error;
    }
    if (!settled) this.activeTurnId = response?.turn?.id || this.activeTurnId;
    return turnDone;
  }

  async compactThread(onNotification = async () => {}) {
    if (!this.threadId) throw new Error('Codex thread is not attached');
    if (this.hasActiveTurn()) throw new Error('Cannot compact while a Codex turn is active');

    this.lastUsedAt = Date.now();
    const previousHandler = this.notificationHandler;
    let compactionTurnId = null;
    let settled = false;
    let timeout;
    const compactionDone = new Promise((resolve, reject) => {
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.notificationHandler = previousHandler;
        this.turnReject = null;
        this.activeTurnId = null;
        callback(value);
      };
      this.turnReject = (error) => finish(reject, error);
      this.notificationHandler = async (message) => {
        try { await onNotification(message); } catch { /* UI transport must not stall compaction */ }
        const params = message.params || {};
        if (params.threadId !== this.threadId) return;
        if (message.method === 'turn/started') {
          compactionTurnId = params.turn?.id || compactionTurnId;
          this.activeTurnId = compactionTurnId;
        } else if (
          (message.method === 'item/started' || message.method === 'item/completed')
          && normalizeItem(params.item)?.type === 'context_compaction'
        ) {
          compactionTurnId = params.turnId || compactionTurnId;
          this.activeTurnId = compactionTurnId;
        } else if (
          message.method === 'turn/completed'
          && compactionTurnId
          && (!params.turn?.id || params.turn.id === compactionTurnId)
        ) {
          finish(resolve, params);
        } else if (
          message.method === 'turn/failed'
          && (!compactionTurnId || !params.turn?.id || params.turn.id === compactionTurnId)
        ) {
          finish(reject, new Error(params.turn?.error?.message || 'Codex context compaction failed'));
        }
      };
      timeout = setTimeout(
        () => finish(reject, new Error('Codex context compaction timed out')),
        APP_SERVER_COMPACTION_TIMEOUT_MS,
      );
    });
    compactionDone.catch(() => {});

    try {
      await this.request('thread/compact/start', { threadId: this.threadId });
    } catch (error) {
      this.failTurn(error);
      throw error;
    }
    return compactionDone;
  }

  async steer(input, clientUserMessageId = null) {
    if (!this.threadId || !this.activeTurnId) {
      throw new Error('Codex turn is not ready for steering');
    }
    return this.request('turn/steer', {
      threadId: this.threadId,
      expectedTurnId: this.activeTurnId,
      clientUserMessageId,
      input,
    });
  }

  interrupt() {
    if (this.threadId && this.activeTurnId) {
      return this.request('turn/interrupt', {
        threadId: this.threadId,
        turnId: this.activeTurnId,
      }).catch(() => {});
    }
    return Promise.resolve();
  }

  failAll(error) {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  failTurn(error) {
    const reject = this.turnReject;
    this.turnReject = null;
    if (reject) reject(error);
  }

  close() {
    this.closed = true;
    this.failAll(new Error('Codex app-server closed'));
    this.failTurn(new Error('Codex app-server closed'));
    try { this.proc?.kill(); } catch { /* ignore */ }
    this.proc = null;
    this.threadAttached = false;
  }
}

export { isFinalAssistantMessageForTurn, normalizeItem };
