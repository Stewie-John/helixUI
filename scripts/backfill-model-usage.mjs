import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import Database from 'better-sqlite3';

const dataRoot = process.env.CLOUDCLI_DATA_DIR || path.join(os.homedir(), '.cloudcli');
const databasePath = process.env.DATABASE_PATH || path.join(dataRoot, 'auth.db');
const sessionsRoot = process.env.CODEX_SESSIONS_DIR
  || path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
const db = new Database(databasePath);

const columns = db.prepare('PRAGMA table_info(model_output_events)').all().map((column) => column.name);
if (!columns.includes('input_token_count')) {
  db.exec('ALTER TABLE model_output_events ADD COLUMN input_token_count INTEGER NOT NULL DEFAULT 0 CHECK(input_token_count >= 0)');
}

const rows = db.prepare(`
  SELECT user_id, event_id, session_id, token_count
  FROM model_output_events
  WHERE provider = 'codex'
    AND session_id IS NOT NULL
    AND event_id NOT LIKE 'historical-codex:%'
  ORDER BY session_id, event_id
`).all();
const attributions = db.prepare(`
  SELECT session_id, message_ts, user_id
  FROM message_attributions
  ORDER BY session_id, message_ts
`).all();
const liveSessionIds = new Set(rows.map((row) => String(row.session_id)));
const attributedSessionIds = new Set(attributions.map((row) => String(row.session_id)));
const targetSessionIds = new Set([...liveSessionIds, ...attributedSessionIds]);

function findRollouts(root) {
  const matches = new Map();
  const pending = [root];
  while (pending.length > 0 && matches.size < targetSessionIds.size) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(fullPath);
        continue;
      }
      if (!entry.name.endsWith('.jsonl')) continue;
      for (const sessionId of targetSessionIds) {
        if (!matches.has(sessionId) && entry.name.includes(sessionId)) matches.set(sessionId, fullPath);
      }
    }
  }
  return matches;
}

function readUsage(info) {
  const total = info?.total_token_usage || info?.totalTokenUsage || {};
  const last = info?.last_token_usage || info?.lastTokenUsage || {};
  return {
    totalInput: Number(total.input_tokens || total.inputTokens || 0),
    totalOutput: Number(total.output_tokens || total.outputTokens || 0),
    lastInput: Number(last.input_tokens || last.inputTokens || 0),
    lastOutput: Number(last.output_tokens || last.outputTokens || 0),
  };
}

async function readTurns(filePath) {
  const turns = [];
  let activeTurn = null;
  let previousTotal = null;
  const lines = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of lines) {
    let item;
    try { item = JSON.parse(line); } catch { continue; }
    const payload = item?.payload || {};
    if (item?.type === 'event_msg' && payload.type === 'task_started') {
      activeTurn = {
        id: String(payload.turn_id || `turn-${turns.length}`),
        startMs: Date.parse(item.timestamp),
        endMs: null,
        inputTokens: 0,
        outputTokens: 0,
      };
      turns.push(activeTurn);
      continue;
    }
    if (item?.type !== 'event_msg' || payload.type !== 'token_count') {
      if (item?.type === 'event_msg' && payload.type === 'task_complete' && activeTurn) {
        activeTurn.endMs = Date.parse(item.timestamp);
        activeTurn = null;
      }
      continue;
    }

    const usage = readUsage(payload.info);
    let inputDelta = usage.lastInput;
    let outputDelta = usage.lastOutput;
    if (
      previousTotal &&
      usage.totalInput >= previousTotal.input &&
      usage.totalOutput >= previousTotal.output
    ) {
      const candidateInput = usage.totalInput - previousTotal.input;
      const candidateOutput = usage.totalOutput - previousTotal.output;
      if (candidateInput > 0 || candidateOutput > 0) {
        inputDelta = candidateInput;
        outputDelta = candidateOutput;
      } else {
        inputDelta = 0;
        outputDelta = 0;
      }
    }
    if (usage.totalInput > 0 || usage.totalOutput > 0) {
      previousTotal = { input: usage.totalInput, output: usage.totalOutput };
    }
    if (activeTurn) {
      activeTurn.inputTokens += Math.max(0, inputDelta);
      activeTurn.outputTokens += Math.max(0, outputDelta);
    }
  }
  return turns;
}

const rolloutBySession = findRollouts(sessionsRoot);
const update = db.prepare(`
  UPDATE model_output_events
  SET input_token_count = MAX(input_token_count, ?),
      token_count = MAX(token_count, ?)
  WHERE user_id = ? AND event_id = ?
`);
const insertHistorical = db.prepare(`
  INSERT INTO model_output_events
    (user_id, event_id, output_day, input_token_count, token_count, provider, session_id)
  VALUES (?, ?, ?, ?, ?, 'codex', ?)
  ON CONFLICT(user_id, event_id) DO UPDATE SET
    input_token_count = MAX(input_token_count, excluded.input_token_count),
    token_count = MAX(token_count, excluded.token_count)
`);

const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: process.env.DAILY_INPUT_TIME_ZONE || 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function formatDay(timestampMs) {
  const parts = Object.fromEntries(
    dayFormatter.formatToParts(new Date(timestampMs)).map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function findClosestTurn(turns, available, eventMs) {
  let bestIndex = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const index of available) {
    const distance = Math.abs(turns[index].startMs - eventMs);
    if (turns[index].startMs < eventMs - 30_000 || distance > 15 * 60_000) continue;
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }
  return bestIndex;
}

let matched = 0;
let unmatched = 0;
let historicalMatched = 0;
let historicalUnmatched = 0;
let historicalAlreadyTracked = 0;
let attributionSessionsWithoutCodexRollout = 0;
const attributionsBySession = new Map();
for (const attribution of attributions) {
  const sessionId = String(attribution.session_id);
  if (!attributionsBySession.has(sessionId)) attributionsBySession.set(sessionId, []);
  attributionsBySession.get(sessionId).push(attribution);
}

for (const sessionId of targetSessionIds) {
  const filePath = rolloutBySession.get(sessionId);
  const sessionRows = rows.filter((row) => String(row.session_id) === sessionId);
  const sessionAttributions = attributionsBySession.get(sessionId) || [];
  if (!filePath) {
    unmatched += sessionRows.length;
    if (sessionAttributions.length > 0) attributionSessionsWithoutCodexRollout += 1;
    continue;
  }
  const turns = await readTurns(filePath);
  const available = new Set(turns.map((_, index) => index));
  const liveTurnIndexes = new Set();
  for (const row of sessionRows) {
    const eventMs = Number(String(row.event_id).split(':').at(-1));
    const bestIndex = findClosestTurn(turns, available, eventMs);
    if (bestIndex < 0) {
      unmatched += 1;
      continue;
    }
    const turn = turns[bestIndex];
    available.delete(bestIndex);
    liveTurnIndexes.add(bestIndex);
    update.run(turn.inputTokens, turn.outputTokens, row.user_id, row.event_id);
    matched += 1;
  }

  // Attribute older turns only when a persisted website message attribution
  // identifies the submitting account. Unattributed CLI history is left alone.
  // Match attributions against the full turn list first. If the same turn was
  // already captured by the live tracker, skip it instead of sliding the
  // attribution to a nearby older turn and counting that usage twice.
  const attributionAvailable = new Set(turns.map((_, index) => index));
  for (const attribution of sessionAttributions) {
    const attributionMs = Number(attribution.message_ts);
    const bestIndex = findClosestTurn(turns, attributionAvailable, attributionMs);
    if (bestIndex < 0) {
      historicalUnmatched += 1;
      continue;
    }
    attributionAvailable.delete(bestIndex);
    if (liveTurnIndexes.has(bestIndex)) {
      historicalAlreadyTracked += 1;
      continue;
    }
    const turn = turns[bestIndex];
    const eventId = `historical-codex:${sessionId}:${turn.id}`;
    insertHistorical.run(
      attribution.user_id,
      eventId,
      formatDay(turn.startMs),
      turn.inputTokens,
      turn.outputTokens,
      sessionId,
    );
    historicalMatched += 1;
  }
}

const totals = db.prepare(`
  SELECT COUNT(*) AS events,
         COALESCE(SUM(input_token_count), 0) AS input_tokens,
         COALESCE(SUM(token_count), 0) AS output_tokens
  FROM model_output_events
`).get();
console.log(JSON.stringify({
  matched,
  unmatched,
  historicalMatched,
  historicalUnmatched,
  historicalAlreadyTracked,
  attributionSessionsWithoutCodexRollout,
  rolloutSessions: rolloutBySession.size,
  ...totals,
  databasePath,
}, null, 2));
db.close();
