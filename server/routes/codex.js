import express from 'express';
import { spawn } from 'child_process';
import pty from 'node-pty';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import TOML from '@iarna/toml';
import Database from 'better-sqlite3';
import { getCodexSessions, getCodexSessionMessages, deleteCodexSession } from '../projects.js';
import { applyCustomSessionNames, codexRuntimeAliasesDb, db, sessionNamesDb } from '../database/db.js';
import { clearCodexGoal, updateCodexGoal } from '../openai-codex.js';

const router = express.Router();
const ANSI_ESCAPE_SEQUENCE_REGEX = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g;
const CODEX_STATUS_CACHE_TTL_MS = 3 * 60 * 1000;
const CODEX_STATUS_FORCE_MIN_INTERVAL_MS = 60 * 1000;
const CODEX_STATUS_ERROR_CACHE_TTL_MS = 60 * 1000;
const CODEX_APP_SERVER_TIMEOUT_MS = 12000;
const CODEX_STATUS_INPUT_DELAY_MS = 9000;
const CODEX_STATUS_TIMEOUT_MS = 30000;
const CODEX_TUI_ENTER_KEY = '\x1b[13;1u';
let codexStatusCache = null;
let codexStatusErrorCache = null;
let codexStatusInFlight = null;
let codexGoalsDatabase = null;

function getCodexGoalsDatabase() {
  if (codexGoalsDatabase) return codexGoalsDatabase;
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  codexGoalsDatabase = new Database(path.join(codexHome, 'goals_1.sqlite'), {
    readonly: true,
    fileMustExist: true,
  });
  codexGoalsDatabase.pragma('busy_timeout = 1000');
  return codexGoalsDatabase;
}

function normalizeGoalStatus(status) {
  return ({ usage_limited: 'usageLimited', budget_limited: 'budgetLimited' })[status] || status;
}

function readCodexGoalRow(sessionId) {
  const runtimeThreadId = codexRuntimeAliasesDb.get(sessionId) || sessionId;
  const row = getCodexGoalsDatabase().prepare(`
    SELECT thread_id, goal_id, objective, status, token_budget, tokens_used,
           time_used_seconds, created_at_ms, updated_at_ms
    FROM thread_goals
    WHERE thread_id IN (?, ?)
    ORDER BY CASE WHEN thread_id = ? THEN 0 ELSE 1 END
    LIMIT 1
  `).get(runtimeThreadId, sessionId, runtimeThreadId);
  return { row, runtimeThreadId };
}

function serializeGoalRow(row) {
  if (!row) return null;
  return {
    threadId: row.thread_id,
    goalId: row.goal_id,
    objective: row.objective,
    status: normalizeGoalStatus(row.status),
    tokenBudget: row.token_budget == null ? null : Number(row.token_budget),
    tokensUsed: Number(row.tokens_used || 0),
    timeUsedSeconds: Number(row.time_used_seconds || 0),
    createdAt: Number(row.created_at_ms || 0),
    updatedAt: Number(row.updated_at_ms || 0),
  };
}

function archiveGoalSnapshot(sessionId, row) {
  if (!row?.goal_id) return;
  db.prepare(`
    INSERT INTO codex_goal_history (
      session_id, runtime_thread_id, goal_id, objective, status, token_budget,
      tokens_used, time_used_seconds, created_at_ms, updated_at_ms, archived_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, goal_id) DO UPDATE SET
      runtime_thread_id = excluded.runtime_thread_id,
      objective = excluded.objective,
      status = excluded.status,
      token_budget = excluded.token_budget,
      tokens_used = excluded.tokens_used,
      time_used_seconds = excluded.time_used_seconds,
      created_at_ms = excluded.created_at_ms,
      updated_at_ms = excluded.updated_at_ms,
      archived_at_ms = excluded.archived_at_ms
  `).run(
    sessionId,
    row.thread_id,
    row.goal_id,
    row.objective,
    normalizeGoalStatus(row.status),
    row.token_budget,
    Number(row.tokens_used || 0),
    Number(row.time_used_seconds || 0),
    Number(row.created_at_ms || 0),
    Number(row.updated_at_ms || 0),
    Date.now(),
  );
}

function readGoalHistory(sessionId, runtimeThreadId) {
  return db.prepare(`
    SELECT runtime_thread_id, goal_id, objective, status, token_budget,
           tokens_used, time_used_seconds, created_at_ms, updated_at_ms
    FROM codex_goal_history
    WHERE session_id IN (?, ?) OR runtime_thread_id IN (?, ?)
    ORDER BY created_at_ms DESC, updated_at_ms DESC
  `).all(sessionId, runtimeThreadId, sessionId, runtimeThreadId);
}

function stripAnsiSequences(value = '') {
  return value.replace(ANSI_ESCAPE_SEQUENCE_REGEX, '');
}

function normalizeCodexStatusLine(line = '') {
  return line
    .replace(/[╭╮╰╯│─]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseCodexStatusOutput(rawOutput = '') {
  const clean = stripAnsiSequences(rawOutput);
  const lines = clean
    .split(/\r?\n/)
    .map(normalizeCodexStatusLine)
    .filter(Boolean);

  const result = {
    generatedAt: new Date().toISOString(),
    model: null,
    account: null,
    usageUrl: 'https://chatgpt.com/codex/settings/usage',
    limits: [],
  };

  let currentScope = 'Current model';
  let currentScopeKey = 'current';
  let lastLimit = null;

  for (const line of lines) {
    const modelMatch = line.match(/^Model:\s*(.+)$/i);
    if (modelMatch) {
      result.model = modelMatch[1].trim();
      continue;
    }

    const accountMatch = line.match(/^Account:\s*(.+)$/i);
    if (accountMatch) {
      result.account = accountMatch[1].trim();
      continue;
    }

    const sparkMatch = line.match(/^(GPT-[\w.-]+(?:-Codex-[\w.-]+)?)\s+limit:$/i);
    if (sparkMatch) {
      currentScope = sparkMatch[1];
      currentScopeKey = sparkMatch[1].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      lastLimit = null;
      continue;
    }

    const limitMatch = line.match(/^(5h limit|Weekly limit):\s*(?:\[[^\]]*\]\s*)?(\d+(?:\.\d+)?)%\s+left(?:\s*\(([^)]*)\))?/i);
    if (limitMatch) {
      const name = limitMatch[1];
      const cadence = /^5h/i.test(name) ? '5h' : 'weekly';
      lastLimit = {
        key: `${currentScopeKey}-${cadence}`,
        scope: currentScope,
        name,
        cadence,
        percentLeft: Number(limitMatch[2]),
        resetText: limitMatch[3]?.replace(/^resets\s+/i, '').trim() || null,
      };
      result.limits.push(lastLimit);
      continue;
    }

    const resetMatch = line.match(/^\((resets\s+[^)]+)\)$/i);
    if (resetMatch && lastLimit && !lastLimit.resetText) {
      lastLimit.resetText = resetMatch[1].replace(/^resets\s+/i, '').trim();
    }
  }

  return result;
}

function hasCodexUpdatePrompt(rawOutput = '') {
  const clean = stripAnsiSequences(rawOutput);
  return clean.includes('Update available') && clean.includes('Press enter to continue');
}

function createCodexStatusError(rawOutput = '', fallbackError = null) {
  const clean = stripAnsiSequences(rawOutput).replace(/\r/g, '\n');
  if (/Missing optional dependency\s+@openai\/codex-[\w-]+/i.test(clean)) {
    return new Error('Codex CLI is missing its native optional dependency. Reinstall Codex with: npm install -g @openai/codex@latest');
  }
  if (/command not found|ENOENT/i.test(clean) || fallbackError?.code === 'ENOENT') {
    return new Error('Codex CLI was not found on PATH');
  }
  const message = fallbackError?.message || 'Codex exited before status was available';
  return new Error(message);
}

async function resolveCodexCliCommand() {
  const localCodexBin = path.join(process.cwd(), 'node_modules', '.bin', 'codex');
  try {
    await fs.access(localCodexBin);
    return localCodexBin;
  } catch {
    return 'codex';
  }
}

async function createIsolatedCodexHome() {
  const sourceHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'claudecodeui-codex-status-'));

  await Promise.all(['auth.json', 'config.toml'].map(async (fileName) => {
    const sourcePath = path.join(sourceHome, fileName);
    const targetPath = path.join(tempHome, fileName);
    try {
      await fs.symlink(sourcePath, targetPath);
    } catch {
      try {
        await fs.copyFile(sourcePath, targetPath);
      } catch { /* optional */ }
    }
  }));

  try {
    const versionRaw = await fs.readFile(path.join(sourceHome, 'version.json'), 'utf8');
    const version = JSON.parse(versionRaw);
    if (version?.latest_version) {
      version.dismissed_version = version.latest_version;
    }
    await fs.writeFile(path.join(tempHome, 'version.json'), JSON.stringify(version));
  } catch { /* optional */ }

  return tempHome;
}

function formatRateLimitCadence(windowDurationMins) {
  if (windowDurationMins === 300) return { cadence: '5h', name: '5h limit' };
  if (windowDurationMins === 10080) return { cadence: 'weekly', name: 'Weekly limit' };
  if (!Number.isFinite(windowDurationMins) || windowDurationMins <= 0) {
    return { cadence: 'window', name: 'Usage limit' };
  }
  if (windowDurationMins % 1440 === 0) {
    const days = windowDurationMins / 1440;
    return { cadence: `${days}d`, name: `${days}-day limit` };
  }
  if (windowDurationMins % 60 === 0) {
    const hours = windowDurationMins / 60;
    return { cadence: `${hours}h`, name: `${hours}h limit` };
  }
  return { cadence: `${windowDurationMins}m`, name: `${windowDurationMins}m limit` };
}

function convertRateLimitSnapshot(snapshot, fallbackLimitId = 'codex') {
  if (!snapshot || typeof snapshot !== 'object') return [];
  const limitId = snapshot.limitId || fallbackLimitId;
  const scope = snapshot.limitName || (limitId === 'codex' ? 'Current model' : limitId);

  return ['primary', 'secondary'].flatMap((windowKey) => {
    const window = snapshot[windowKey];
    if (!window || !Number.isFinite(Number(window.usedPercent))) return [];
    const duration = Number(window.windowDurationMins);
    const { cadence, name } = formatRateLimitCadence(duration);
    return [{
      key: `${limitId}-${cadence}`,
      limitId,
      scope,
      name,
      cadence,
      windowDurationMins: Number.isFinite(duration) ? duration : null,
      percentLeft: Math.max(0, Math.min(100, 100 - Number(window.usedPercent))),
      resetAt: Number.isFinite(Number(window.resetsAt)) ? Number(window.resetsAt) : null,
      resetText: null,
    }];
  });
}

function convertAppServerRateLimits(response) {
  const primary = response?.rateLimits;
  const snapshots = new Map();
  if (primary) snapshots.set(primary.limitId || 'codex', primary);
  for (const [limitId, snapshot] of Object.entries(response?.rateLimitsByLimitId || {})) {
    snapshots.set(snapshot?.limitId || limitId, snapshot);
  }

  const orderedSnapshots = [...snapshots.entries()].sort(([aId, a], [bId, b]) => {
    if (aId === 'codex') return -1;
    if (bId === 'codex') return 1;
    return String(a?.limitName || aId).localeCompare(String(b?.limitName || bId));
  });
  const limits = orderedSnapshots
    .flatMap(([limitId, snapshot]) => convertRateLimitSnapshot(snapshot, limitId))
    .sort((a, b) => {
      const aCurrent = a.limitId === 'codex';
      const bCurrent = b.limitId === 'codex';
      const scopeOrder = aCurrent !== bCurrent
        ? (aCurrent ? -1 : 1)
        : a.scope.localeCompare(b.scope);
      return scopeOrder || (a.windowDurationMins || Number.MAX_SAFE_INTEGER) - (b.windowDurationMins || Number.MAX_SAFE_INTEGER);
    });

  return {
    generatedAt: new Date().toISOString(),
    source: 'app-server',
    usageUrl: 'https://chatgpt.com/codex/settings/usage',
    planType: primary?.planType || null,
    credits: primary?.credits || null,
    individualLimit: primary?.individualLimit || null,
    rateLimitReachedType: primary?.rateLimitReachedType || null,
    limits,
  };
}

function stabilizeCodexQuotaStatus(nextStatus, previousStatus) {
  if (!previousStatus?.limits?.length || !nextStatus?.limits?.length) return nextStatus;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const previousByKey = new Map(previousStatus.limits.map((limit) => [limit.key, limit]));

  return {
    ...nextStatus,
    limits: nextStatus.limits.map((nextLimit) => {
      const previous = previousByKey.get(nextLimit.key);
      if (!previous) return nextLimit;
      const previousReset = Number(previous.resetAt);
      const nextReset = Number(nextLimit.resetAt);
      const sameWindow = Number.isFinite(previousReset)
        && previousReset > nowSeconds
        && Number.isFinite(nextReset)
        && Math.abs(nextReset - previousReset) <= 5 * 60;
      const percentIncrease = Number(nextLimit.percentLeft) - Number(previous.percentLeft);
      // Small upward changes inside a window are normally transient provider
      // jitter. A large correction can happen after an entitlement change or
      // delayed usage reconciliation and must not leave the old value pinned.
      const isSmallUpwardJitter = percentIncrease > 0 && percentIncrease < 5;
      if (!sameWindow || !isSmallUpwardJitter) return nextLimit;

      return {
        ...nextLimit,
        percentLeft: previous.percentLeft,
        resetAt: previous.resetAt,
      };
    }),
  };
}

async function readConfiguredCodexModel() {
  try {
    const configPath = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml');
    const config = TOML.parse(await fs.readFile(configPath, 'utf8'));
    return config.model || null;
  } catch {
    return null;
  }
}

async function readCodexAppServerStatus() {
  const codexCommand = await resolveCodexCliCommand();
  return new Promise((resolve, reject) => {
    const proc = spawn(codexCommand, ['app-server', '--stdio'], {
      cwd: process.cwd(),
      env: { ...process.env, CODEX_DISABLE_UPDATE_CHECK: '1', CODEX_NO_UPDATE_CHECK: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let initialized = false;

    const cleanup = () => {
      clearTimeout(timeout);
      try { proc.kill(); } catch { /* ignore */ }
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(createCodexStatusError(stderr || stdout, error));
    };
    const finish = async (response) => {
      if (settled) return;
      settled = true;
      cleanup();
      const status = convertAppServerRateLimits(response);
      if (!status.limits.length) {
        reject(new Error('Codex app-server returned no rate-limit windows'));
        return;
      }
      status.model = await readConfiguredCodexModel();
      resolve(status);
    };
    const handleLine = (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id === 1 && !initialized) {
        if (message.error) {
          fail(new Error(message.error.message || 'Codex app-server initialization failed'));
          return;
        }
        initialized = true;
        proc.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
        proc.stdin.write(`${JSON.stringify({ id: 2, method: 'account/rateLimits/read', params: null })}\n`);
      } else if (message.id === 2) {
        if (message.error) fail(new Error(message.error.message || 'Codex rate-limit request failed'));
        else finish(message.result);
      }
    };

    const timeout = setTimeout(() => fail(new Error('Timed out reading Codex rate limits')), CODEX_APP_SERVER_TIMEOUT_MS);
    proc.stdout.on('data', (data) => {
      stdout += data.toString();
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() || '';
      lines.forEach(handleLine);
    });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });
    proc.on('error', fail);
    proc.on('close', (code) => {
      if (!settled) fail(new Error(`Codex app-server exited before rate limits were available (${code})`));
    });
    proc.stdin.write(`${JSON.stringify({
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'claudecodeui', title: 'Claude Code UI', version: '1.0.0' },
        capabilities: { experimentalApi: false },
      },
    })}\n`);
  });
}

async function readCodexNativeStatus() {
  const isolatedCodexHome = await createIsolatedCodexHome();
  const codexCommand = await resolveCodexCliCommand();

  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = pty.spawn(codexCommand, ['--no-alt-screen'], {
        name: 'xterm-256color',
        cols: 120,
        rows: 32,
        cwd: process.cwd(),
        env: {
          ...process.env,
          CODEX_HOME: isolatedCodexHome,
          CODEX_DISABLE_UPDATE_CHECK: '1',
          CODEX_NO_UPDATE_CHECK: '1',
          NO_COLOR: '1',
        },
      });
    } catch (error) {
      fs.rm(isolatedCodexHome, { recursive: true, force: true }).catch(() => {});
      reject(createCodexStatusError('', error));
      return;
    }

    let output = '';
    let settled = false;
    let statusSent = false;
    let updatePromptSkipped = false;
    let quiescenceTimer = null;
    const startedAt = Date.now();
    // 自适应就绪：TUI 引导输出静默 ≥800ms 且已过最短引导期（2s）即认为就绪，提前发 /status。
    // 内容无关的启发式（不依赖具体 TUI 文案），冷读从固定 9s 降到约 2-3s；9s 仍作硬兜底。
    const MIN_BOOT_MS = 2000;
    const QUIESCENCE_MS = 800;

    const cleanup = () => {
      clearTimeout(inputTimer);
      clearTimeout(timeoutTimer);
      if (quiescenceTimer) clearTimeout(quiescenceTimer);
      try {
        proc.kill();
      } catch { /* ignore */ }
      fs.rm(isolatedCodexHome, { recursive: true, force: true }).catch(() => {});
    };

    // 幂等发送 /status（就绪检测与 9s 兜底都可能触发，只发一次）
    const sendStatus = () => {
      if (statusSent || settled) return;
      if (hasCodexUpdatePrompt(output) && !updatePromptSkipped) {
        skipUpdatePrompt();
        return;
      }
      statusSent = true;
      clearTimeout(inputTimer);
      if (quiescenceTimer) { clearTimeout(quiescenceTimer); quiescenceTimer = null; }
      proc.write('/status');
      setTimeout(() => {
        if (!settled) proc.write(CODEX_TUI_ENTER_KEY);
      }, 200);
    };

    const skipUpdatePrompt = () => {
      if (updatePromptSkipped || settled) return;
      updatePromptSkipped = true;
      clearTimeout(inputTimer);
      if (quiescenceTimer) { clearTimeout(quiescenceTimer); quiescenceTimer = null; }
      proc.write('\x1b[B');
      setTimeout(() => {
        if (!settled) proc.write(CODEX_TUI_ENTER_KEY);
      }, 150);
      setTimeout(sendStatus, 1600);
    };

    const finish = (status) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(status);
    };

    const fail = (error) => {
      if (settled) return;
      const parsed = parseCodexStatusOutput(output);
      if (parsed.limits.length >= 4) {
        finish(parsed);
        return;
      }
      fs.writeFile('/tmp/codex-quota-status-debug.log', stripAnsiSequences(output).replace(/\r/g, '\n')).catch(() => {});
      settled = true;
      cleanup();
      reject(createCodexStatusError(output, error));
    };

    const inputTimer = setTimeout(sendStatus, CODEX_STATUS_INPUT_DELAY_MS); // 9s 硬兜底

    const timeoutTimer = setTimeout(() => {
      fail(new Error(statusSent ? 'Timed out reading Codex /status' : 'Timed out starting Codex'));
    }, CODEX_STATUS_TIMEOUT_MS);

    proc.onData((data) => {
      output += data;
      if (!statusSent && hasCodexUpdatePrompt(output) && !updatePromptSkipped) {
        skipUpdatePrompt();
        return;
      }
      // 就绪检测：发 /status 之前，每来一批数据就重置静默计时器；
      // 静默 QUIESCENCE_MS 且已过最短引导期则判定 TUI 就绪，提前发 /status。
      if (!statusSent) {
        if (quiescenceTimer) clearTimeout(quiescenceTimer);
        quiescenceTimer = setTimeout(() => {
          if (Date.now() - startedAt >= MIN_BOOT_MS) sendStatus();
        }, QUIESCENCE_MS);
      }
      const parsed = parseCodexStatusOutput(output);
      if (parsed.limits.length >= 4) {
        setTimeout(() => finish(parsed), 250);
      }
    });

    proc.onExit(({ exitCode }) => {
      if (!settled) {
        const parsed = parseCodexStatusOutput(output);
        if (parsed.limits.length > 0) {
          finish(parsed);
        } else {
          fail(new Error(`Codex exited before status was available (${exitCode})`));
        }
      }
    });
  });
}

async function getCodexNativeStatus(forceRefresh = false) {
  const cacheAge = codexStatusCache ? Date.now() - codexStatusCache.cachedAt : Number.POSITIVE_INFINITY;
  // A forced refresh is user initiated, but old/multiple tabs may all request
  // one. Keep a hard server-side floor so they cannot create a probe storm.
  if (codexStatusCache && (
    cacheAge < (forceRefresh ? CODEX_STATUS_FORCE_MIN_INTERVAL_MS : CODEX_STATUS_CACHE_TTL_MS)
  )) {
    return { ...codexStatusCache.payload, cached: true, cachedAt: codexStatusCache.cachedAt };
  }

  if (!forceRefresh && codexStatusErrorCache && Date.now() - codexStatusErrorCache.cachedAt < CODEX_STATUS_ERROR_CACHE_TTL_MS) {
    const error = new Error(codexStatusErrorCache.error);
    error.cachedAt = codexStatusErrorCache.cachedAt;
    throw error;
  }

  if (!codexStatusInFlight) {
    codexStatusInFlight = readCodexAppServerStatus()
      .catch(async (appServerError) => {
        console.warn('Codex app-server quota read failed; falling back to /status:', appServerError.message);
        return readCodexNativeStatus();
      })
      .then((payload) => {
        payload = stabilizeCodexQuotaStatus(payload, codexStatusCache?.payload);
        codexStatusCache = { cachedAt: Date.now(), payload };
        codexStatusErrorCache = null;
        return payload;
      })
      .catch((error) => {
        codexStatusErrorCache = {
          cachedAt: Date.now(),
          error: error.message || 'Failed to read Codex quota status',
        };
        throw error;
      })
      .finally(() => {
        codexStatusInFlight = null;
      });
  }

  const payload = await codexStatusInFlight;
  return { ...payload, cached: false, cachedAt: codexStatusCache?.cachedAt || Date.now() };
}

function createCliResponder(res) {
  let responded = false;
  return (status, payload) => {
    if (responded || res.headersSent) {
      return;
    }
    responded = true;
    res.status(status).json(payload);
  };
}

router.get('/config', async (req, res) => {
  try {
    const configPath = path.join(os.homedir(), '.codex', 'config.toml');
    const content = await fs.readFile(configPath, 'utf8');
    const config = TOML.parse(content);

    res.json({
      success: true,
      config: {
        model: config.model || null,
        mcpServers: config.mcp_servers || {},
        approvalMode: config.approval_mode || 'suggest'
      }
    });
  } catch (error) {
    if (error.code === 'ENOENT') {
      res.json({
        success: true,
        config: {
          model: null,
          mcpServers: {},
          approvalMode: 'suggest'
        }
      });
    } else {
      console.error('Error reading Codex config:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }
});

router.put('/config/model', async (req, res) => {
  const model = typeof req.body?.model === 'string' ? req.body.model.trim() : '';
  // Keep this permissive for newly released Codex models while making it safe
  // to place in a shell command and a TOML basic string.
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(model)) {
    return res.status(400).json({ success: false, error: 'Invalid Codex model name' });
  }

  try {
    const configPath = path.join(os.homedir(), '.codex', 'config.toml');
    let content = '';
    try {
      content = await fs.readFile(configPath, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }

    const modelLine = `model = ${JSON.stringify(model)}`;
    if (/^\s*model\s*=/m.test(content)) {
      content = content.replace(/^\s*model\s*=.*$/m, modelLine);
    } else {
      const lines = content.split(/\r?\n/);
      const firstSection = lines.findIndex((line) => /^\s*\[/.test(line));
      lines.splice(firstSection === -1 ? lines.length : firstSection, 0, modelLine);
      content = lines.join('\n');
    }
    if (!content.endsWith('\n')) content += '\n';

    await fs.mkdir(path.dirname(configPath), { recursive: true });
    const tempPath = `${configPath}.helix-${process.pid}-${Date.now()}.tmp`;
    await fs.writeFile(tempPath, content, 'utf8');
    await fs.rename(tempPath, configPath);
    codexStatusCache = null;
    codexStatusErrorCache = null;
    res.json({ success: true, model });
  } catch (error) {
    console.error('Error updating Codex model:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to update Codex model' });
  }
});

router.get('/quota-status', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === '1' || req.query.refresh === 'true';
    const status = await getCodexNativeStatus(forceRefresh);
    res.json({ success: true, status });
  } catch (error) {
    console.error('Error reading Codex quota status:', error);
    res.status(503).json({
      success: false,
      error: error.message || 'Failed to read Codex quota status',
      status: {
        generatedAt: new Date().toISOString(),
        cached: Boolean(error.cachedAt),
        error: error.message || 'Failed to read Codex quota status',
        limits: [],
      },
    });
  }
});

router.get('/goals/:sessionId', (req, res) => {
  const sessionId = String(req.params.sessionId || '');
  if (!/^[a-zA-Z0-9._-]{1,128}$/.test(sessionId)) {
    return res.status(400).json({ success: false, error: 'Invalid session ID' });
  }
  try {
    const { row, runtimeThreadId } = readCodexGoalRow(sessionId);
    archiveGoalSnapshot(sessionId, row);
    const historyCount = new Set(readGoalHistory(sessionId, runtimeThreadId).map((entry) => entry.goal_id)).size;
    return res.json({
      success: true,
      goal: serializeGoalRow(row),
      historyCount,
    });
  } catch (error) {
    if (error?.code === 'SQLITE_CANTOPEN') return res.json({ success: true, goal: null });
    console.error('Error reading Codex goal:', error);
    return res.status(500).json({ success: false, error: error.message || 'Failed to read goal' });
  }
});

router.get('/goals/:sessionId/history', (req, res) => {
  const sessionId = String(req.params.sessionId || '');
  if (!/^[a-zA-Z0-9._-]{1,128}$/.test(sessionId)) {
    return res.status(400).json({ success: false, error: 'Invalid session ID' });
  }
  try {
    const { row: currentRow, runtimeThreadId } = readCodexGoalRow(sessionId);
    archiveGoalSnapshot(sessionId, currentRow);
    const currentGoalId = currentRow?.goal_id || null;
    const seen = new Set();
    const history = readGoalHistory(sessionId, runtimeThreadId)
      .filter((entry) => {
        if (seen.has(entry.goal_id)) return false;
        seen.add(entry.goal_id);
        return true;
      })
      .map((entry) => ({
        threadId: entry.runtime_thread_id,
        goalId: entry.goal_id,
        objective: entry.objective,
        status: normalizeGoalStatus(entry.status),
        tokenBudget: entry.token_budget == null ? null : Number(entry.token_budget),
        tokensUsed: Number(entry.tokens_used || 0),
        timeUsedSeconds: Number(entry.time_used_seconds || 0),
        createdAt: Number(entry.created_at_ms || 0),
        updatedAt: Number(entry.updated_at_ms || 0),
        isCurrent: entry.goal_id === currentGoalId,
      }));
    return res.json({ success: true, history });
  } catch (error) {
    if (error?.code === 'SQLITE_CANTOPEN') return res.json({ success: true, history: [] });
    console.error('Error reading Codex goal history:', error);
    return res.status(500).json({ success: false, error: error.message || 'Failed to read goal history' });
  }
});

router.patch('/goals/:sessionId', async (req, res) => {
  const sessionId = String(req.params.sessionId || '');
  const status = String(req.body?.status || '');
  if (!/^[a-zA-Z0-9._-]{1,128}$/.test(sessionId)) {
    return res.status(400).json({ success: false, error: 'Invalid session ID' });
  }
  if (!['active', 'paused', 'complete'].includes(status)) {
    return res.status(400).json({ success: false, error: 'Unsupported goal status' });
  }
  try {
    const before = readCodexGoalRow(sessionId).row;
    archiveGoalSnapshot(sessionId, before);
    const result = await updateCodexGoal(sessionId, { status });
    const after = readCodexGoalRow(sessionId).row;
    archiveGoalSnapshot(sessionId, after);
    return res.json({ success: true, goal: result?.goal || null });
  } catch (error) {
    console.error('Error updating Codex goal:', error);
    return res.status(500).json({ success: false, error: error.message || 'Failed to update goal' });
  }
});

router.delete('/goals/:sessionId', async (req, res) => {
  const sessionId = String(req.params.sessionId || '');
  if (!/^[a-zA-Z0-9._-]{1,128}$/.test(sessionId)) {
    return res.status(400).json({ success: false, error: 'Invalid session ID' });
  }
  try {
    const current = readCodexGoalRow(sessionId).row;
    archiveGoalSnapshot(sessionId, current);
    await clearCodexGoal(sessionId);
    return res.json({ success: true });
  } catch (error) {
    console.error('Error clearing Codex goal:', error);
    return res.status(500).json({ success: false, error: error.message || 'Failed to clear goal' });
  }
});

router.get('/sessions', async (req, res) => {
  try {
    const { projectPath } = req.query;

    if (!projectPath) {
      return res.status(400).json({ success: false, error: 'projectPath query parameter required' });
    }

    const sessions = await getCodexSessions(projectPath);
    applyCustomSessionNames(sessions, 'codex');
    res.json({ success: true, sessions });
  } catch (error) {
    console.error('Error fetching Codex sessions:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/sessions/:sessionId/messages', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { limit, offset, full } = req.query;
    // Legacy tabs used an unbounded request for automatic continuation
    // refreshes. Treat an omitted limit as a safe history window unless the
    // current UI explicitly marks a user-initiated Load All request.
    const requestedLimit = limit
      ? parseInt(limit, 10)
      : full === '1' ? null : 120;

    const result = await getCodexSessionMessages(
      sessionId,
      requestedLimit,
      offset ? parseInt(offset, 10) : 0
    );

    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Error fetching Codex session messages:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.delete('/sessions/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    await deleteCodexSession(sessionId);
    sessionNamesDb.deleteName(sessionId, 'codex');
    res.json({ success: true });
  } catch (error) {
    console.error(`Error deleting Codex session ${req.params.sessionId}:`, error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// MCP Server Management Routes

router.get('/mcp/cli/list', async (req, res) => {
  try {
    const respond = createCliResponder(res);
    const proc = spawn('codex', ['mcp', 'list'], { stdio: ['pipe', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (data) => { stdout += data.toString(); });
    proc.stderr?.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      if (code === 0) {
        respond(200, { success: true, output: stdout, servers: parseCodexListOutput(stdout) });
      } else {
        respond(500, { error: 'Codex CLI command failed', details: stderr || `Exited with code ${code}` });
      }
    });

    proc.on('error', (error) => {
      const isMissing = error?.code === 'ENOENT';
      respond(isMissing ? 503 : 500, {
        error: isMissing ? 'Codex CLI not installed' : 'Failed to run Codex CLI',
        details: error.message,
        code: error.code
      });
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to list MCP servers', details: error.message });
  }
});

router.post('/mcp/cli/add', async (req, res) => {
  try {
    const { name, command, args = [], env = {} } = req.body;

    if (!name || !command) {
      return res.status(400).json({ error: 'name and command are required' });
    }

    // Build: codex mcp add <name> [-e KEY=VAL]... -- <command> [args...]
    let cliArgs = ['mcp', 'add', name];

    Object.entries(env).forEach(([key, value]) => {
      cliArgs.push('-e', `${key}=${value}`);
    });

    cliArgs.push('--', command);

    if (args && args.length > 0) {
      cliArgs.push(...args);
    }

    const respond = createCliResponder(res);
    const proc = spawn('codex', cliArgs, { stdio: ['pipe', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (data) => { stdout += data.toString(); });
    proc.stderr?.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      if (code === 0) {
        respond(200, { success: true, output: stdout, message: `MCP server "${name}" added successfully` });
      } else {
        respond(400, { error: 'Codex CLI command failed', details: stderr || `Exited with code ${code}` });
      }
    });

    proc.on('error', (error) => {
      const isMissing = error?.code === 'ENOENT';
      respond(isMissing ? 503 : 500, {
        error: isMissing ? 'Codex CLI not installed' : 'Failed to run Codex CLI',
        details: error.message,
        code: error.code
      });
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to add MCP server', details: error.message });
  }
});

router.delete('/mcp/cli/remove/:name', async (req, res) => {
  try {
    const { name } = req.params;

    const respond = createCliResponder(res);
    const proc = spawn('codex', ['mcp', 'remove', name], { stdio: ['pipe', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (data) => { stdout += data.toString(); });
    proc.stderr?.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      if (code === 0) {
        respond(200, { success: true, output: stdout, message: `MCP server "${name}" removed successfully` });
      } else {
        respond(400, { error: 'Codex CLI command failed', details: stderr || `Exited with code ${code}` });
      }
    });

    proc.on('error', (error) => {
      const isMissing = error?.code === 'ENOENT';
      respond(isMissing ? 503 : 500, {
        error: isMissing ? 'Codex CLI not installed' : 'Failed to run Codex CLI',
        details: error.message,
        code: error.code
      });
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to remove MCP server', details: error.message });
  }
});

router.get('/mcp/cli/get/:name', async (req, res) => {
  try {
    const { name } = req.params;

    const respond = createCliResponder(res);
    const proc = spawn('codex', ['mcp', 'get', name], { stdio: ['pipe', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (data) => { stdout += data.toString(); });
    proc.stderr?.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      if (code === 0) {
        respond(200, { success: true, output: stdout, server: parseCodexGetOutput(stdout) });
      } else {
        respond(404, { error: 'Codex CLI command failed', details: stderr || `Exited with code ${code}` });
      }
    });

    proc.on('error', (error) => {
      const isMissing = error?.code === 'ENOENT';
      respond(isMissing ? 503 : 500, {
        error: isMissing ? 'Codex CLI not installed' : 'Failed to run Codex CLI',
        details: error.message,
        code: error.code
      });
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get MCP server details', details: error.message });
  }
});

router.get('/mcp/config/read', async (req, res) => {
  try {
    const configPath = path.join(os.homedir(), '.codex', 'config.toml');

    let configData = null;

    try {
      const fileContent = await fs.readFile(configPath, 'utf8');
      configData = TOML.parse(fileContent);
    } catch (error) {
      // Config file doesn't exist
    }

    if (!configData) {
      return res.json({ success: true, configPath, servers: [] });    }

    const servers = [];

    if (configData.mcp_servers && typeof configData.mcp_servers === 'object') {
      for (const [name, config] of Object.entries(configData.mcp_servers)) {
        servers.push({
          id: name,
          name: name,
          type: 'stdio',
          scope: 'user',
          config: {
            command: config.command || '',
            args: config.args || [],
            env: config.env || {}
          },
          raw: config
        });
      }
    }

    res.json({ success: true, configPath, servers });
  } catch (error) {
    res.status(500).json({ error: 'Failed to read Codex configuration', details: error.message });
  }
});

function parseCodexListOutput(output) {
  const servers = [];
  const lines = output.split('\n').filter(line => line.trim());

  for (const line of lines) {
    if (line.includes(':')) {
      const colonIndex = line.indexOf(':');
      const name = line.substring(0, colonIndex).trim();

      if (!name) continue;

      const rest = line.substring(colonIndex + 1).trim();
      let description = rest;
      let status = 'unknown';

      if (rest.includes('✓') || rest.includes('✗')) {
        const statusMatch = rest.match(/(.*?)\s*-\s*([✓✗].*)$/);
        if (statusMatch) {
          description = statusMatch[1].trim();
          status = statusMatch[2].includes('✓') ? 'connected' : 'failed';
        }
      }

      servers.push({ name, type: 'stdio', status, description });
    }
  }

  return servers;
}

function parseCodexGetOutput(output) {
  try {
    const jsonMatch = output.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }

    const server = { raw_output: output };
    const lines = output.split('\n');

    for (const line of lines) {
      if (line.includes('Name:')) server.name = line.split(':')[1]?.trim();
      else if (line.includes('Type:')) server.type = line.split(':')[1]?.trim();
      else if (line.includes('Command:')) server.command = line.split(':')[1]?.trim();
    }

    return server;
  } catch (error) {
    return { raw_output: output, parse_error: error.message };
  }
}

export default router;
