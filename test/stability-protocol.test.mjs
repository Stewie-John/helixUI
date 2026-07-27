import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  CodexAppServerSession,
  isFinalAssistantMessageForTurn,
} from '../server/codex-app-server.js';
import { readBoundedJsonlLines } from '../server/utils/bounded-jsonl.js';
import { TtlIdempotencyCache } from '../server/utils/ttl-idempotency.js';
import { filterClientInstanceTargets } from '../server/utils/client-routing.js';

test('targeted model frames stay in their originating browser tab', () => {
  const firstTab = { _clientInstanceId: 'tab-a' };
  const secondTab = { _clientInstanceId: 'tab-b' };
  const legacyTab = {};
  const clients = new Set([firstTab, secondTab, legacyTab]);

  assert.deepEqual(filterClientInstanceTargets(clients, 'tab-a'), [firstTab]);
  assert.deepEqual(filterClientInstanceTargets(clients, 'tab-b'), [secondTab]);
  assert.deepEqual(filterClientInstanceTargets(clients, null), [firstTab, secondTab, legacyTab]);
});

test('a reconnect replay is accepted only once', () => {
  let now = 1_000;
  const cache = new TtlIdempotencyCache({
    ttlMs: 10_000,
    maxEntries: 10,
    now: () => now,
  });

  assert.equal(cache.remember('user:codex:123'), false);
  assert.equal(cache.remember('user:codex:123'), true);
  now += 10_001;
  assert.equal(cache.remember('user:codex:123'), false);
});

test('the command cache remains bounded and expires stale entries', () => {
  let now = 1_000;
  const cache = new TtlIdempotencyCache({
    ttlMs: 100,
    maxEntries: 2,
    now: () => now,
  });

  cache.remember('a');
  cache.remember('b');
  cache.remember('c');
  assert.equal(cache.size, 2);
  assert.equal(cache.remember('a'), false);
  assert.equal(cache.size, 2);

  now += 101;
  cache.sweep();
  assert.equal(cache.size, 0);
});

test('oversized JSONL records are skipped without losing later usage records', async () => {
  const archiveRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../trash/test-artifacts',
  );
  await mkdir(archiveRoot, { recursive: true });
  const directory = await mkdtemp(path.join(archiveRoot, 'stability-jsonl-'));
  const filePath = path.join(directory, 'session.jsonl');
  await writeFile(filePath, [
    JSON.stringify({ type: 'assistant', value: 1 }),
    JSON.stringify({ type: 'tool_result', output: 'x'.repeat(4096) }),
    JSON.stringify({ type: 'assistant', value: 2 }),
    '',
  ].join('\n'));

  const values = [];
  for await (const line of readBoundedJsonlLines(filePath, 1024)) {
    values.push(JSON.parse(line).value);
  }
  assert.deepEqual(values, [1, 2]);
});

test('chat session guards are initialized before effects capture them', async () => {
  const source = await readFile(
    new URL('../src/components/chat/hooks/useChatSessionState.ts', import.meta.url),
    'utf8',
  );
  const exemptionDeclaration = source.indexOf('const isSystemChangeExemptionValid = useCallback');
  const exemptionUsage = source.indexOf('isSystemChangeExemptionValid(selectedSession?.id)');
  const lengthRefDeclaration = source.indexOf('const prevSessionMessagesLengthRef = useRef(0)');
  const lengthRefUsage = source.indexOf('prevSessionMessagesLengthRef.current');

  assert.ok(exemptionDeclaration >= 0 && exemptionDeclaration < exemptionUsage);
  assert.ok(lengthRefDeclaration >= 0 && lengthRefDeclaration < lengthRefUsage);
});

test('bottom-follow fallback depends on DOM geometry, not turn status', async () => {
  const source = await readFile(
    new URL('../src/components/chat/hooks/useChatSessionState.ts', import.meta.url),
    'utf8',
  );
  const start = source.indexOf('const keepLatestVisible = () => {');
  const end = source.indexOf('\n  }, [autoScrollToBottom, scrollToBottom]);', start);
  const fallback = source.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(fallback, /setInterval\(keepLatestVisible/);
  assert.doesNotMatch(fallback, /hasActiveTurn|activeSessions/);
  assert.match(source, /initialScrollDeadlineRef\.current = Date\.now\(\) \+ 1800/);
  assert.match(source, /setInterval\(settleAtBottom, 80\)/);
  assert.match(source, /isUserScrolledUpRef\.current \|\| userScrollIntentRef\.current/);
});

test('the visible chat tail retains the latest user turn boundary', async () => {
  const source = await readFile(
    new URL('../src/components/chat/hooks/useChatSessionState.ts', import.meta.url),
    'utf8',
  );

  assert.match(source, /getTailWithLatestUserBoundary\(chatMessages, visibleMessageCount\)/);
  assert.match(source, /return \[messages\[latestUserIndex\], \.\.\.messages\.slice\(tailStart\)\]/);
});

test('streaming cache writes are throttled and user boundaries persist immediately', async () => {
  const source = await readFile(
    new URL('../src/components/chat/hooks/useChatSessionState.ts', import.meta.url),
    'utf8',
  );

  assert.match(source, /latestUserKey !== lastPersistedUserKeyRef\.current/);
  assert.match(source, /if \(!chatStorageTimerRef\.current\)/);
  const persistenceStart = source.indexOf(
    'const cacheSnapshot = getTailWithLatestUserBoundary(chatMessages, 50)',
  );
  const persistenceEnd = source.indexOf(
    '}, [chatMessages, isMobile',
    persistenceStart,
  );
  assert.doesNotMatch(
    source.slice(persistenceStart, persistenceEnd),
    /clearTimeout\(chatStorageTimerRef\.current\)/,
  );
});

test('page restoration and stale bundle handling never force an automatic reload', async () => {
  const [entry, recovery] = await Promise.all([
    readFile(new URL('../src/main.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/utils/staleBundleRecovery.ts', import.meta.url), 'utf8'),
  ]);

  assert.doesNotMatch(entry, /pageshow[\s\S]*location\.reload/);
  assert.doesNotMatch(recovery, /location\.(?:replace|reload)/);
});

test('safe restart requests coalesce behind one process lock', async () => {
  const source = await readFile(
    new URL('../scripts/restart-when-idle.mjs', import.meta.url),
    'utf8',
  );

  assert.match(source, /spawnSync\(\s*'flock'/);
  assert.match(source, /CCUI_RESTART_LOCK_HELD/);
  assert.match(source, /A restart is already queued/);
});

test('background polling uses hoisted declarations without a temporal dead zone', async () => {
  const source = await readFile(
    new URL('../src/components/chat/hooks/useChatSessionState.ts', import.meta.url),
    'utf8',
  );

  assert.match(source, /function scheduleNextPoll\(delay = 6000\)/);
  assert.match(source, /async function pollLatestPage\(\)/);
  assert.doesNotMatch(source, /const scheduleNextPoll\s*=/);
  assert.doesNotMatch(source, /const pollLatestPage\s*=/);
});

test('command acknowledgements only call hoisted realtime lifecycle helpers', async () => {
  const source = await readFile(
    new URL('../src/components/chat/hooks/useChatRealtimeHandlers.ts', import.meta.url),
    'utf8',
  );

  assert.match(source, /function collectSessionIds\(\.\.\.sessionIds:/);
  assert.match(source, /function markLiveTurnActivity\(sessionId\?:/);
  assert.doesNotMatch(source, /const collectSessionIds\s*=/);
});

test('a Codex turn without a final assistant response is recovered across turn boundaries', async () => {
  const [source, appServerSource] = await Promise.all([
    readFile(new URL('../server/openai-codex.js', import.meta.url), 'utf8'),
    readFile(new URL('../server/codex-app-server.js', import.meta.url), 'utf8'),
  ]);

  assert.match(source, /finalAssistantMessages\.size > finalCountBeforeTurn/);
  assert.match(source, /CODEX_NO_FINAL_RECOVERY_MAX/);
  assert.match(source, /while \(activeSession\?\.status !== 'aborted'\)/);
  assert.match(source, /source="automatic_turn_recovery"/);
  assert.match(source, /recoveryPending/);
  assert.match(source, /pendingSteerInputs/);
  assert.match(source, /Continuing task/);
  assert.match(source, /isFinalAssistantMessageForTurn/);
  assert.match(appServerSource, /message\?\.method !== 'item\/completed'/);
  assert.match(appServerSource, /item\.phase === 'final_answer'/);
  assert.doesNotMatch(appServerSource, /item\.phase == null|item\.phase === ''/);
  assert.match(source, /contextRatio >= CODEX_AUTO_COMPACT_RECOVERY_RATIO/);
  assert.match(appServerSource, /request\('thread\/compact\/start'/);
  assert.match(appServerSource, /if \(!settled\) this\.activeTurnId/);
  assert.doesNotMatch(
    source,
    /item\/agentMessage\/delta'[\s\S]{0,500}finalAssistantMessages\.set/,
  );
});

test('a sub-agent final message cannot complete its parent turn', () => {
  const rootFinal = {
    method: 'item/completed',
    params: {
      threadId: 'root-thread',
      turnId: 'root-turn',
      item: {
        id: 'root-final',
        type: 'agentMessage',
        text: 'Done',
        phase: 'final_answer',
      },
    },
  };
  const childFinal = {
    ...rootFinal,
    params: {
      ...rootFinal.params,
      threadId: 'child-thread',
      turnId: 'child-turn',
    },
  };
  const staleRootFinal = {
    ...rootFinal,
    params: {
      ...rootFinal.params,
      turnId: 'older-root-turn',
    },
  };
  const rootCommentary = {
    ...rootFinal,
    params: {
      ...rootFinal.params,
      item: {
        ...rootFinal.params.item,
        phase: 'commentary',
      },
    },
  };

  assert.equal(
    isFinalAssistantMessageForTurn(rootFinal, 'root-thread', 'root-turn'),
    true,
  );
  assert.equal(
    isFinalAssistantMessageForTurn(childFinal, 'root-thread', 'root-turn'),
    false,
  );
  assert.equal(
    isFinalAssistantMessageForTurn(staleRootFinal, 'root-thread', 'root-turn'),
    false,
  );
  assert.equal(
    isFinalAssistantMessageForTurn(rootCommentary, 'root-thread', 'root-turn'),
    false,
  );
});

test('a completed app-server turn cannot leave a stale active turn id', async () => {
  const session = new CodexAppServerSession('unused');
  session.threadId = 'thread-test';
  session.request = async (method) => {
    assert.equal(method, 'turn/start');
    queueMicrotask(async () => {
      const handler = session.notificationHandler;
      await handler({
        method: 'turn/started',
        params: { threadId: 'thread-test', turn: { id: 'turn-test' } },
      });
      await handler({
        method: 'turn/completed',
        params: { threadId: 'thread-test', turn: { id: 'turn-test', status: 'completed' } },
      });
    });
    return { turn: { id: 'turn-test' } };
  };

  const completion = await session.runTurn(
    { input: [], cwd: '/', model: 'test' },
    async () => {},
  );
  assert.equal(completion.turn.status, 'completed');
  assert.equal(session.hasActiveTurn(), false);
});

test('local submit activates every visible work surface without waiting for server IO', async () => {
  const [composerSource, sidebarSource, usageModalSource, cssSource] = await Promise.all([
    readFile(new URL('../src/components/chat/hooks/useChatComposerState.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/sidebar/view/subcomponents/SidebarSessionItem.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/tech/DailyInputUsageModal.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/index.css', import.meta.url), 'utf8'),
  ]);

  const activeIndex = composerSource.indexOf('onSessionActive?.(statusSessionId)');
  const bubbleIndex = composerSource.indexOf('setChatMessages((previous) => [...previous, userMessage])');
  const sendIndex = composerSource.indexOf("type: 'codex-command'");
  assert.ok(activeIndex > 0 && activeIndex < bubbleIndex && bubbleIndex < sendIndex);
  assert.match(composerSource, /onSessionProcessing\?\.\(statusSessionId\)/);
  assert.match(sidebarSource, /isActive[\s\S]{0,200}formatTimeAgo\(currentTime\.toISOString\(\), currentTime, t\)/);
  assert.match(usageModalSource, /className="daily-usage-dialog"/);
  assert.match(cssSource, /\.daily-usage-dialog[\s\S]{0,300}max-height:\s*calc\(100dvh - 28px\)/);
  assert.match(cssSource, /\.daily-usage-body[\s\S]{0,180}overflow-y:\s*auto/);
});

test('the appearance selector keeps stable geometry and places tech on the right', async () => {
  const [toggleSource, cssSource] = await Promise.all([
    readFile(new URL('../src/components/DarkModeToggle.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/index.css', import.meta.url), 'utf8'),
  ]);

  assert.match(toggleSource, /light:\s*4/);
  assert.match(toggleSource, /dark:\s*28/);
  assert.match(toggleSource, /tech:\s*52/);
  assert.doesNotMatch(toggleSource, /translate-x-13/);
  assert.match(toggleSource, /data-theme=\{currentTheme\}/);
  assert.match(cssSource, /\.tech button\.theme-mode-toggle[\s\S]{0,450}clip-path:\s*none !important/);
  assert.match(cssSource, /\.tech \.theme-mode-thumb[\s\S]{0,180}border-radius:\s*9999px !important/);
});
