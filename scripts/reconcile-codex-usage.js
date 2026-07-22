import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import Database from 'better-sqlite3';

const DAY_MS = 86_400_000;
const args = new Set(process.argv.slice(2));
const readArg = (name, fallback) => {
  const prefix = `${name}=`;
  const match = [...args].find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
};
const apply = args.has('--apply');
const includeDetails = args.has('--details');
const days = Math.max(1, Number.parseInt(readArg('--days', '7'), 10) || 7);
const databasePath = process.env.DATABASE_PATH || path.join(os.homedir(), '.cloudcli', 'auth.db');
const sessionsRoot = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');

const shanghaiDay = (date) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(date);
const shiftDay = (day, offset) => {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
};
const today = shanghaiDay(new Date());
const throughDay = readArg('--through', shiftDay(today, -1));
const sinceDay = readArg('--since', shiftDay(throughDay, -(days - 1)));
const earliestMtime = new Date(`${sinceDay}T00:00:00Z`).getTime() - DAY_MS;

if (!fs.existsSync(databasePath) || !fs.existsSync(sessionsRoot)) {
  throw new Error('Usage database or Codex sessions directory is unavailable');
}

const db = new Database(databasePath);
const usageColumns = new Set(db.prepare('PRAGMA table_info(model_output_events)').all().map((column) => column.name));
if (!usageColumns.has('cached_input_token_count')) {
  db.exec('ALTER TABLE model_output_events ADD COLUMN cached_input_token_count INTEGER NOT NULL DEFAULT 0 CHECK(cached_input_token_count >= 0)');
}
if (!usageColumns.has('model')) db.exec('ALTER TABLE model_output_events ADD COLUMN model TEXT');
const attributions = new Map();
for (const row of db.prepare(`
  SELECT session_id, message_ts, user_id
  FROM message_attributions
  ORDER BY session_id, message_ts
`).all()) {
  if (!attributions.has(row.session_id)) attributions.set(row.session_id, []);
  attributions.get(row.session_id).push(row);
}

const fallbackOwners = new Map();
for (const row of db.prepare(`
  SELECT session_id, user_id, COUNT(*) AS event_count
  FROM model_output_events
  WHERE provider = 'codex' AND session_id IS NOT NULL
  GROUP BY session_id, user_id
  ORDER BY event_count DESC
`).all()) {
  if (!fallbackOwners.has(row.session_id)) fallbackOwners.set(row.session_id, row.user_id);
}

const findOwner = (sessionId, timestamp) => {
  const entries = attributions.get(sessionId) || [];
  let low = 0;
  let high = entries.length - 1;
  let owner = null;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (Number(entries[middle].message_ts) <= timestamp) {
      owner = Number(entries[middle].user_id);
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return owner || Number(fallbackOwners.get(sessionId) || 0) || null;
};

const files = [];
const walk = (directory) => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(entryPath);
    else if (entry.name.endsWith('.jsonl') && fs.statSync(entryPath).mtimeMs >= earliestMtime) files.push(entryPath);
  }
};
walk(sessionsRoot);
files.sort();

const totals = new Map();
const details = new Map();
const seenUsageSnapshotsBySession = new Map();
let siteFiles = 0;
let attributedTokens = 0;
let unattributedTokens = 0;
const WEBSITE_ORIGINATORS = new Set(['claudecodeui', 'codex_sdk_ts']);

for (const file of files) {
  const lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  let metadata = null;
  let previous = null;
  let currentModel = null;
  let countedSiteFile = false;

  for await (const line of lines) {
    if (!metadata && line.includes('"type":"session_meta"')) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'session_meta') metadata = entry.payload;
      } catch { /* ignore malformed lines */ }
    }
    if (line.includes('"type":"turn_context"')) {
      try {
        const contextEntry = JSON.parse(line);
        if (contextEntry.type === 'turn_context') currentModel = contextEntry.payload?.model || currentModel;
      } catch { /* ignore malformed lines */ }
    }
    if (!line.includes('"type":"token_count"') || !WEBSITE_ORIGINATORS.has(metadata?.originator)) continue;
    if (!countedSiteFile) {
      countedSiteFile = true;
      siteFiles += 1;
    }

    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const info = entry?.payload?.info;
    const usage = info?.total_token_usage;
    if (!usage) continue;
    const current = {
      inputTokens: Number(usage.input_tokens || 0),
      cachedInputTokens: Number(usage.cached_input_tokens || 0),
      outputTokens: Number(usage.output_tokens || 0),
    };
    const lastUsage = info?.last_token_usage;
    let inputTokens = lastUsage
      ? Number(lastUsage.input_tokens || 0)
      : (previous ? current.inputTokens - previous.inputTokens : current.inputTokens);
    let outputTokens = lastUsage
      ? Number(lastUsage.output_tokens || 0)
      : (previous ? current.outputTokens - previous.outputTokens : current.outputTokens);
    let cachedInputTokens = lastUsage
      ? Number(lastUsage.cached_input_tokens || 0)
      : (previous ? current.cachedInputTokens - previous.cachedInputTokens : current.cachedInputTokens);
    if (inputTokens < 0) inputTokens = 0;
    if (outputTokens < 0) outputTokens = 0;
    if (cachedInputTokens < 0) cachedInputTokens = 0;
    cachedInputTokens = Math.min(inputTokens, Math.max(0, cachedInputTokens));
    previous = current;

    // Resumed app-server rollouts can replay the thread's historical cumulative
    // token counters before the first turn_context. Keep those counters as the
    // subtraction baseline, but never bill the replay as fresh website usage.
    if (!currentModel) continue;

    // Resuming a thread creates another rollout file whose opening events replay
    // the complete historical counter sequence with the resume timestamp. Count
    // each authoritative cumulative snapshot once per logical session so those
    // replays do not inflate the resumed day. A genuinely new tail still has new
    // cumulative values and is therefore retained.
    const sessionId = String(metadata.session_id || metadata.id || '');
    const snapshotKey = `${current.inputTokens}:${current.cachedInputTokens}:${current.outputTokens}`;
    const seenUsageSnapshots = seenUsageSnapshotsBySession.get(sessionId) || new Set();
    if (seenUsageSnapshots.has(snapshotKey)) continue;
    seenUsageSnapshots.add(snapshotKey);
    seenUsageSnapshotsBySession.set(sessionId, seenUsageSnapshots);

    const day = shanghaiDay(new Date(entry.timestamp));
    if (day < sinceDay || day > throughDay || (inputTokens <= 0 && outputTokens <= 0)) continue;
    const owner = findOwner(sessionId, Date.parse(entry.timestamp));
    if (!owner) {
      unattributedTokens += inputTokens + outputTokens;
      continue;
    }

    attributedTokens += inputTokens + outputTokens;
    const model = String(currentModel || 'unknown');
    const key = `${day}:${owner}:${model}`;
    const total = totals.get(key) || { day, userId: owner, model, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
    total.inputTokens += inputTokens;
    total.cachedInputTokens += cachedInputTokens;
    total.outputTokens += outputTokens;
    totals.set(key, total);

    if (includeDetails) {
      const detailKey = `${file}:${day}:${owner}:${model}`;
      const detail = details.get(detailKey) || {
        file,
        sessionId,
        cwd: String(metadata.cwd || ''),
        day,
        userId: owner,
        model,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
      };
      detail.inputTokens += inputTokens;
      detail.cachedInputTokens += cachedInputTokens;
      detail.outputTokens += outputTokens;
      details.set(detailKey, detail);
    }
  }
}

const rows = [...totals.values()].sort((left, right) => (
  left.day.localeCompare(right.day) || left.userId - right.userId || left.model.localeCompare(right.model)
));
const report = {
  mode: apply ? 'apply' : 'audit',
  sinceDay,
  throughDay,
  filesScanned: files.length,
  siteFiles,
  attributedTokens,
  unattributedTokens,
  unattributedPercent: attributedTokens + unattributedTokens > 0
    ? (unattributedTokens * 100) / (attributedTokens + unattributedTokens)
    : 0,
  rows,
  ...(includeDetails ? {
    details: [...details.values()].sort((left, right) =>
      right.inputTokens - left.inputTokens || left.file.localeCompare(right.file)
    ),
  } : {}),
};

if (apply && rows.length > 0) {
  const replace = db.transaction((usageRows) => {
    db.prepare(`
      DELETE FROM model_output_events
      WHERE provider = 'codex' AND output_day BETWEEN ? AND ?
    `).run(sinceDay, throughDay);
    const insert = db.prepare(`
      INSERT INTO model_output_events
        (user_id, event_id, output_day, input_token_count, cached_input_token_count, token_count, provider, session_id, model)
      VALUES (?, ?, ?, ?, ?, ?, 'codex', NULL, ?)
    `);
    for (const row of usageRows) {
      insert.run(
        row.userId,
        `codex-jsonl-authoritative:v2:${row.day}:${row.userId}:${row.model}`,
        row.day,
        Math.max(0, Math.trunc(row.inputTokens)),
        Math.max(0, Math.trunc(row.cachedInputTokens)),
        Math.max(0, Math.trunc(row.outputTokens)),
        row.model,
      );
    }
  });
  replace(rows);
}

db.close();
console.log(JSON.stringify(report, null, 2));
