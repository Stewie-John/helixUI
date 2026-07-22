import { authenticatedFetch } from '../../../utils/api';

type InputBatch = {
  eventId: string;
  charCount: number;
};

const FLUSH_DELAY_MS = 800;
const RETRY_DELAY_MS = 3000;
const STORAGE_PREFIX = 'helix:daily-input-pending:';
let pendingCount = 0;
let queuedBatches: InputBatch[] = [];
let flushTimer: number | null = null;
let flushing = false;
let lifecycleListenerRegistered = false;
let loadedStorageKey: string | null = null;

const getCurrentAccountStorageKey = () => {
  try {
    const token = localStorage.getItem('auth-token');
    const payloadPart = token?.split('.')[1];
    if (!payloadPart) return `${STORAGE_PREFIX}anonymous`;
    const normalized = payloadPart.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const payload = JSON.parse(atob(padded));
    return `${STORAGE_PREFIX}${String(payload.userId || payload.username || 'anonymous')}`;
  } catch {
    return `${STORAGE_PREFIX}anonymous`;
  }
};

const persistState = () => {
  if (!loadedStorageKey) return;
  try {
    if (pendingCount === 0 && queuedBatches.length === 0) {
      localStorage.removeItem(loadedStorageKey);
      return;
    }
    localStorage.setItem(loadedStorageKey, JSON.stringify({
      pendingCount,
      queuedBatches: queuedBatches.slice(0, 500),
    }));
  } catch { /* storage can be unavailable in private browsing */ }
};

const ensureStateLoaded = () => {
  const storageKey = getCurrentAccountStorageKey();
  if (loadedStorageKey === storageKey) return;
  persistState();
  pendingCount = 0;
  queuedBatches = [];
  loadedStorageKey = storageKey;
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || '{}');
    pendingCount = Math.max(0, Math.trunc(Number(saved.pendingCount) || 0));
    queuedBatches = Array.isArray(saved.queuedBatches)
      ? saved.queuedBatches.filter((batch: InputBatch) =>
          typeof batch?.eventId === 'string' &&
          Number.isInteger(batch?.charCount) &&
          batch.charCount > 0
        ).slice(0, 500)
      : [];
  } catch {
    pendingCount = 0;
    queuedBatches = [];
  }
};

const createEventId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `input-${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

export const countInputCharacters = (text: string) =>
  Array.from(text).filter((character) => !/\s/u.test(character)).length;

export const getInsertedText = (previousValue: string, nextValue: string) => {
  let prefixLength = 0;
  const sharedLength = Math.min(previousValue.length, nextValue.length);
  while (
    prefixLength < sharedLength &&
    previousValue.charCodeAt(prefixLength) === nextValue.charCodeAt(prefixLength)
  ) {
    prefixLength += 1;
  }

  let previousSuffixIndex = previousValue.length;
  let nextSuffixIndex = nextValue.length;
  while (
    previousSuffixIndex > prefixLength &&
    nextSuffixIndex > prefixLength &&
    previousValue.charCodeAt(previousSuffixIndex - 1) === nextValue.charCodeAt(nextSuffixIndex - 1)
  ) {
    previousSuffixIndex -= 1;
    nextSuffixIndex -= 1;
  }

  return nextValue.slice(prefixLength, nextSuffixIndex);
};

const scheduleFlush = (delay = FLUSH_DELAY_MS) => {
  if (flushTimer !== null) window.clearTimeout(flushTimer);
  flushTimer = window.setTimeout(() => {
    flushTimer = null;
    void flushDailyInputCharacters();
  }, delay);
};

export const flushDailyInputCharacters = async () => {
  if (flushing) return;
  ensureStateLoaded();
  if (pendingCount > 0) {
    queuedBatches.push({ eventId: createEventId(), charCount: pendingCount });
    pendingCount = 0;
    persistState();
  }
  const batch = queuedBatches[0];
  if (!batch) return;

  flushing = true;
  try {
    const response = await authenticatedFetch('/api/user/daily-input', {
      method: 'POST',
      keepalive: true,
      body: JSON.stringify(batch),
    });
    if (!response.ok) throw new Error(`Daily input update failed (${response.status})`);
    queuedBatches.shift();
    persistState();
    window.dispatchEvent(new Event('helix:daily-input-changed'));
  } catch (error) {
    console.warn('Could not record daily input characters:', error);
  } finally {
    flushing = false;
  }

  if (queuedBatches.length > 0 || pendingCount > 0) {
    scheduleFlush(queuedBatches.length > 0 ? RETRY_DELAY_MS : FLUSH_DELAY_MS);
  }
};

export const recordDailyInputCharacters = (charCount: number) => {
  const normalizedCount = Math.max(0, Math.trunc(charCount));
  if (!normalizedCount) return;
  ensureStateLoaded();
  if (!lifecycleListenerRegistered) {
    lifecycleListenerRegistered = true;
    window.addEventListener('pagehide', () => {
      void flushDailyInputCharacters();
    });
  }
  pendingCount += normalizedCount;
  persistState();
  scheduleFlush();
};

if (typeof window !== 'undefined') {
  window.setTimeout(() => {
    ensureStateLoaded();
    if (pendingCount > 0 || queuedBatches.length > 0) scheduleFlush(100);
  }, 0);
}
