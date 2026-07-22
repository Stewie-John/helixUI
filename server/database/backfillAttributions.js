// 启动时一次性回填：把 ~/.claude/projects/*/<session>.jsonl 里所有 user 类型消息归属给首位账号
// 仅在 message_attributions 表对该 session 还没有任何记录时才回填，避免覆盖已有的真实归属。
// 回填使用 JSONL 自身的 timestamp（毫秒），与 getSessionMessages 加载时使用的 ts 一致，
// 确保前端按 timestamp 反查 user_id 时能命中。
import fs from 'fs';
import fsp from 'fs/promises';
import readline from 'readline';
import path from 'path';
import os from 'os';
import { userDb, attributionDb } from './db.js';

const PROJECTS_ROOT = path.join(os.homedir(), '.claude', 'projects');

// 判断一条 JSONL 记录是不是"会展示在 UI 里的人类提问"——必须与 messageTransforms.convertSessionMessages 行为一致：
// - role 必须是 user
// - content 是字符串：直接接受
// - content 是数组：必须包含至少一个 type:'text' 块；纯 tool_result 数组不算人类提问
// - 提取后的文本不能以 <command-*> / <local-command-stdout> / <system-reminder> / Caveat: 等系统前缀开头
const SYSTEM_PREFIXES = [
  '<command-name>',
  '<command-message>',
  '<command-args>',
  '<local-command-stdout>',
  '<system-reminder>',
  'Caveat:',
  'This session is being continued from a previous',
  '[Request interrupted',
];

function extractHumanText(entry) {
  const msg = entry?.message;
  if (!msg || msg.role !== 'user') return null;

  const content = msg.content;
  let text = '';

  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    const textParts = [];
    for (const part of content) {
      if (part?.type === 'text' && typeof part.text === 'string') {
        textParts.push(part.text);
      }
    }
    if (textParts.length === 0) return null; // 纯 tool_result，不是人类提问
    text = textParts.join('\n');
  } else {
    return null;
  }

  if (!text) return null;
  for (const prefix of SYSTEM_PREFIXES) {
    if (text.startsWith(prefix)) return null;
  }
  return text;
}

async function collectUserTimestampsFromFile(filePath) {
  const tsList = [];
  const stream = fs.createReadStream(filePath);
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== 'user') continue;
    if (!extractHumanText(entry)) continue;
    const ts = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
    if (!Number.isFinite(ts)) continue;
    tsList.push(ts);
  }
  return tsList;
}

export async function backfillHistoricalAttributions() {
  const firstUser = userDb.getFirstUser();
  if (!firstUser) {
    return; // 还没注册过任何账号，跳过
  }

  let projectDirs;
  try {
    projectDirs = await fsp.readdir(PROJECTS_ROOT, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return; // 没装过 Claude
    console.warn('[attribution-backfill] Cannot read projects root:', err.message);
    return;
  }

  let totalSessions = 0;
  let totalRows = 0;
  let skippedExisting = 0;

  for (const dirent of projectDirs) {
    if (!dirent.isDirectory()) continue;
    const projectDir = path.join(PROJECTS_ROOT, dirent.name);

    let files;
    try {
      files = await fsp.readdir(projectDir);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      if (file.startsWith('agent-')) continue;

      const sessionId = file.slice(0, -'.jsonl'.length);
      if (attributionDb.hasAnyForSession(sessionId)) {
        skippedExisting++;
        continue;
      }

      const filePath = path.join(projectDir, file);
      let tsList;
      try {
        tsList = await collectUserTimestampsFromFile(filePath);
      } catch (err) {
        console.warn(`[attribution-backfill] Failed to parse ${file}:`, err.message);
        continue;
      }

      if (!tsList.length) continue;
      const inserted = attributionDb.bulkBackfillForSession(sessionId, firstUser.id, tsList);
      if (inserted > 0) {
        totalSessions++;
        totalRows += inserted;
      }
    }
  }

  if (totalRows > 0 || skippedExisting > 0) {
    console.log(
      `[attribution-backfill] Backfilled ${totalRows} user messages across ${totalSessions} sessions to user #${firstUser.id} (${firstUser.username}); ${skippedExisting} sessions already had attributions.`
    );
  }
}
