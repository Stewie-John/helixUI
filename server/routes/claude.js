import express from 'express';
import pty from 'node-pty';
import { promises as fs } from 'fs';

const router = express.Router();

// ── 常量 ────────────────────────────────────────────────────────────────
const ANSI_ESCAPE_SEQUENCE_REGEX = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g;
const CLAUDE_STATUS_CACHE_TTL_MS = 3 * 60 * 1000;   // 3 分钟缓存，避免频繁 spawn
const CLAUDE_STATUS_TRUST_DELAY_MS = 3500;          // 等 TUI 启动 + 消可能的信任弹窗
const CLAUDE_STATUS_INPUT_DELAY_MS = 6500;          // 之后再输入 /usage
const CLAUDE_STATUS_TIMEOUT_MS = 30000;
// 主限额就绪后，若「Extra usage」块仍在 "Scanning local sessions…"，最多再等这么久，
// 给异步加载的超额块时间渲染；到点仍未出现则按现有结果收工，避免长时间挂起。
const CLAUDE_EXTRA_USAGE_GRACE_MS = 4500;
const CLAUDE_TUI_ENTER_KEY = '\x1b[13;1u';          // kitty 协议 Enter（与 Codex 一致）

let claudeStatusCache = null;
let claudeStatusInFlight = null;

function stripAnsiSequences(value = '') {
  return value.replace(ANSI_ESCAPE_SEQUENCE_REGEX, '');
}

// 去掉进度条/方框绘制字符并压缩空白，便于正则匹配
function normalizeClaudeLine(line = '') {
  return line
    .replace(/[█▉▊▋▌▍▎▏▐▕▔▛▜▝▘▗▖▄▀░▒▓│─╭╮╰╯]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// 把粘连的 model token 美化，如 "Opus4.7" → "Opus 4.7"
function prettifyModel(raw = '') {
  return raw.replace(/(Opus|Sonnet|Haiku)\s*([\d.]+)/i, (_m, a, b) => `${a} ${b}`).trim();
}

/**
 * 解析 `claude` 的 `/usage` TUI 文本。
 * 由于 alt-screen 重绘，文字会粘连且偶尔丢字（如 Current→Curret、Resets→Reses），
 * 因此采用「关键字模糊匹配 + 百分比模式」而非精确标签匹配。
 *
 * 典型结构：
 *   Opus4.7(1Mcontext)·ClaudeMax        <- 头部：模型 + 套餐
 *   Curretsession / 13%used / Reses1:20am(...)
 *   Currentweek(allmodels) / 13%used / ResetsJun5,8pm(...)
 *   Currentweek(Sonnetonly) / 6%used / ResetsJun5,8pm(...)
 */
function parseClaudeUsageOutput(rawOutput = '') {
  const clean = stripAnsiSequences(rawOutput);
  // alt-screen TUI 大量使用裸 \r 做光标回车，需把 \r\n / \r / \n 都视为换行，
  // 否则整屏内容会粘成一行导致 label 与百分比错位。
  const lines = clean
    .split(/\r\n|[\r\n]/)
    .map(normalizeClaudeLine)
    .filter(Boolean);

  const result = {
    generatedAt: new Date().toISOString(),
    model: null,
    plan: null,
    usageUrl: 'https://claude.ai/settings/usage',
    limits: [],
  };

  // 头部：模型 + 套餐（Claude Max / Pro / Team / Enterprise / Free）
  for (const line of lines) {
    if (!result.model) {
      const m = line.match(/(Opus|Sonnet|Haiku)\s*[\d.]+/i);
      if (m) result.model = prettifyModel(m[0]);
    }
    if (!result.plan) {
      const p = line.match(/Claude\s*(Max|Pro|Team|Enterprise|Free)\b/i);
      if (p) result.plan = `Claude ${p[1].replace(/^\w/, (c) => c.toUpperCase())}`;
    }
    if (result.model && result.plan) break;
  }

  // 限额块：扫描每一行，记住最近的 label，遇到 "N% used" 落一条 limit，
  // 再向后找紧邻的 "Resets ..." 作为重置时间。
  let pendingLabel = null;
  const classify = (label = '') => {
    const l = label.toLowerCase();
    // 超额使用（Extra usage）：达到套餐上限后继续付费工作的额度，按 $ 计量
    if (l.includes('extra')) {
      return { name: 'Extra usage', cadence: 'extra', scope: 'extra' };
    }
    if (l.includes('session')) {
      return { name: 'Current session', cadence: 'session', scope: 'session' };
    }
    if (l.includes('week') && l.includes('sonnet')) {
      return { name: 'Current week (Sonnet)', cadence: 'weekly', scope: 'sonnet' };
    }
    if (l.includes('week')) {
      return { name: 'Current week (all models)', cadence: 'weekly', scope: 'all' };
    }
    return null;
  };

  // 仅当某行明确包含 "used" 才视为限额百分比，排除 "85% of your usage..." 之类噪声
  const usedRe = /(\d+(?:\.\d+)?)\s*%\s*used/i;
  // 不用 \w*（会贪婪吃掉 "Resets1" 的数字前缀），用显式可选 t/s
  const resetRe = /Rese(?:t)?(?:s)?\s*(.+)$/i;
  // 超额使用金额：$5.45 / $100.00 spent
  const spentRe = /\$\s*([\d.]+)\s*\/\s*\$\s*([\d.]+)\s*spent/i;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    // 候选 label 行：先单独识别 "Extra usage"（它含 "usage" 会被下面的过滤排除）
    if (/extra\s*usage/i.test(line) && !usedRe.test(line) && !spentRe.test(line)) {
      pendingLabel = 'Extra usage';
    } else if (/session|week/i.test(line) && !usedRe.test(line) && !/^rese/i.test(line) && !/usage/i.test(line)) {
      // 候选 label 行（包含 session / week，但本身不是百分比或 reset 行）
      pendingLabel = line;
    }

    const usedMatch = line.match(usedRe);
    if (usedMatch) {
      const info = classify(pendingLabel || '');
      if (!info) {
        pendingLabel = null;
        continue;
      }
      const percentUsed = Math.max(0, Math.min(100, Number(usedMatch[1])));

      // 向后最多看 3 行找 reset 时间；超额块同时在这些行里找已花费金额
      let resetText = null;
      let spentAmount = null;
      let spentLimit = null;
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j += 1) {
        if (info.scope === 'extra' && spentAmount === null) {
          const sm = lines[j].match(spentRe);
          if (sm) {
            spentAmount = Number(sm[1]);
            spentLimit = Number(sm[2]);
          }
        }
        if (resetText === null) {
          const rm = lines[j].match(resetRe);
          if (rm) {
            resetText = rm[1]
              .replace(/\(/, ' (')              // 重置时区前留空格
              .replace(/([A-Za-z])(\d)/g, '$1 $2')  // Jun5 → Jun 5
              .replace(/,(\S)/g, ', $1')        // ,8pm → , 8pm
              .replace(/spent\s*·?\s*/i, '')    // 去掉金额行残留的 "spent ·"
              .replace(/\s+/g, ' ')
              .trim();
          }
        }
        if (resetText !== null && (info.scope !== 'extra' || spentAmount !== null)) break;
      }

      const key = `${info.scope}-${info.cadence}`;
      // 去重：同一 key 只保留第一条
      if (!result.limits.some((x) => x.key === key)) {
        const entry = {
          key,
          name: info.name,
          cadence: info.cadence,
          scope: info.scope,
          percentUsed,
          resetText,
        };
        if (info.scope === 'extra' && spentAmount !== null && spentLimit !== null) {
          entry.spentAmount = spentAmount;
          entry.spentLimit = spentLimit;
          entry.spentText = `$${spentAmount.toFixed(2)} / $${spentLimit.toFixed(2)}`;
        }
        result.limits.push(entry);
      }
      pendingLabel = null;
      continue;
    }

    // 兜底：超额使用「已启用但未消费/未满限额」时，排版可能只有金额行而无 "N% used" 行
    // （如 $0.00 / $100.00 spent）。只要在 Extra usage 标签下出现金额行，就照样产出一行，
    // 百分比由金额比值推算，确保「只要启用就能看到」。
    const spentOnly = line.match(spentRe);
    if (
      spentOnly &&
      classify(pendingLabel || '')?.scope === 'extra' &&
      !result.limits.some((x) => x.scope === 'extra')
    ) {
      const spentAmount = Number(spentOnly[1]);
      const spentLimit = Number(spentOnly[2]);
      const percentUsed = spentLimit > 0
        ? Math.max(0, Math.min(100, (spentAmount / spentLimit) * 100))
        : 0;
      // reset 时间通常就在同一金额行内（…spent · Resets Jul 1）
      let resetText = null;
      const rm = line.match(resetRe);
      if (rm) {
        resetText = rm[1]
          .replace(/\(/, ' (')
          .replace(/([A-Za-z])(\d)/g, '$1 $2')
          .replace(/,(\S)/g, ', $1')
          .replace(/spent\s*·?\s*/i, '')
          .replace(/\s+/g, ' ')
          .trim();
      }
      result.limits.push({
        key: 'extra-extra',
        name: 'Extra usage',
        cadence: 'extra',
        scope: 'extra',
        percentUsed,
        resetText,
        spentAmount,
        spentLimit,
        spentText: `$${spentAmount.toFixed(2)} / $${spentLimit.toFixed(2)}`,
      });
      pendingLabel = null;
    }
  }

  return result;
}

function readClaudeNativeStatus() {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = pty.spawn('claude', [], {
        name: 'xterm-256color',
        cols: 120,
        rows: 45,
        cwd: process.cwd(),
        env: { ...process.env, NO_COLOR: '1' },
      });
    } catch (error) {
      reject(error);
      return;
    }

    let output = '';
    let settled = false;
    let statusSent = false;

    let graceTimer = null;

    const cleanup = () => {
      clearTimeout(trustTimer);
      clearTimeout(inputTimer);
      clearTimeout(timeoutTimer);
      if (graceTimer) clearTimeout(graceTimer);
      try { proc.kill(); } catch { /* ignore */ }
    };

    const finish = (status) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(status);
    };

    const fail = (error) => {
      if (settled) return;
      const parsed = parseClaudeUsageOutput(output);
      if (parsed.limits.length > 0) {
        finish(parsed);
        return;
      }
      fs.writeFile('/tmp/claude-quota-status-debug.log', stripAnsiSequences(output).replace(/\r/g, '\n')).catch(() => {});
      settled = true;
      cleanup();
      reject(error);
    };

    // 启动后先回车，消掉可能的 workspace trust / 欢迎弹窗
    const trustTimer = setTimeout(() => {
      if (!settled) proc.write('\r');
    }, CLAUDE_STATUS_TRUST_DELAY_MS);

    // 输入 /usage 并执行
    const inputTimer = setTimeout(() => {
      if (settled) return;
      statusSent = true;
      proc.write('/usage');
      setTimeout(() => { if (!settled) proc.write('\r'); }, 250);
      setTimeout(() => { if (!settled) proc.write(CLAUDE_TUI_ENTER_KEY); }, 450);
    }, CLAUDE_STATUS_INPUT_DELAY_MS);

    const timeoutTimer = setTimeout(() => {
      fail(new Error(statusSent ? 'Timed out reading Claude /usage' : 'Timed out starting Claude'));
    }, CLAUDE_STATUS_TIMEOUT_MS);

    proc.onData((data) => {
      output += data;
      const parsed = parseClaudeUsageOutput(output);
      // 拿到任意一条限额即视为主限额就绪。不能要求 >=2：Claude Code v2.1.x 起
      // /usage 只同屏渲染 Current session，周限额改由 `w` 键切换到另一视图，
      // 旧的 >=2 条件在新版永远不成立，会一直空转到超时。
      // 真正的「渲染完毕」信号是下面的超额块（Extra usage）已落定——它排在
      // 所有主限额之后渲染，因此旧版布局仍会等到周限额出现才收工。
      if (parsed.limits.length === 0) return;

      // 超额块（Extra usage）是异步加载的，排在 "Scanning local sessions…" 之后，
      // 远晚于主限额渲染。判断它是否已"尘埃落定"：解析到 extra 行 / 出现金额行 /
      // 明确显示未启用——三者之一即可收工；否则说明仍在扫描，需再等一会儿。
      const normBlob = stripAnsiSequences(output)
        .split(/\r\n|[\r\n]/)
        .map(normalizeClaudeLine)
        .filter(Boolean)
        .join('\n');
      const hasExtraLimit = parsed.limits.some((l) => l.scope === 'extra');
      const extraDisabled = /extra\s*usage[\s\S]{0,80}?(not\s*enabled|to\s*enable)/i.test(normBlob);
      const spentSeen = /\$\s*[\d.]+\s*\/\s*\$\s*[\d.]+\s*spent/i.test(normBlob);

      if (hasExtraLimit || extraDisabled || spentSeen) {
        // 超额信息已就绪（或确认关闭）→ 短延迟后结束，finish 时重解析最新 output
        if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
        setTimeout(() => finish(parseClaudeUsageOutput(output)), 350);
      } else if (!graceTimer) {
        // 主限额已就绪、但超额块仍在扫描 → 给一段宽限期等待其渲染，
        // 到点仍未出现则按现有结果收工（兼容未启用超额或扫描很慢的情况）
        graceTimer = setTimeout(() => finish(parseClaudeUsageOutput(output)), CLAUDE_EXTRA_USAGE_GRACE_MS);
      }
    });

    proc.onExit(({ exitCode }) => {
      if (!settled) {
        const parsed = parseClaudeUsageOutput(output);
        if (parsed.limits.length > 0) {
          resolve(parsed);
        } else {
          reject(new Error(`Claude exited before usage was available (${exitCode})`));
        }
      }
    });
  });
}

async function getClaudeNativeStatus() {
  if (claudeStatusCache && Date.now() - claudeStatusCache.cachedAt < CLAUDE_STATUS_CACHE_TTL_MS) {
    return { ...claudeStatusCache.payload, cached: true, cachedAt: claudeStatusCache.cachedAt };
  }

  if (!claudeStatusInFlight) {
    claudeStatusInFlight = readClaudeNativeStatus()
      .then((payload) => {
        claudeStatusCache = { cachedAt: Date.now(), payload };
        return payload;
      })
      .finally(() => {
        claudeStatusInFlight = null;
      });
  }

  const payload = await claudeStatusInFlight;
  return { ...payload, cached: false, cachedAt: claudeStatusCache?.cachedAt || Date.now() };
}

// GET /api/claude/quota-status — 读取 Claude 订阅额度（/usage）
router.get('/quota-status', async (req, res) => {
  try {
    const status = await getClaudeNativeStatus();
    res.json({ success: true, status });
  } catch (error) {
    console.error('Error reading Claude quota status:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to read Claude quota status' });
  }
});

export default router;
