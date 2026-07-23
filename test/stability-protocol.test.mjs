import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
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
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ccui-jsonl-'));
  const filePath = path.join(directory, 'session.jsonl');
  try {
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
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
