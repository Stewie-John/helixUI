// v2 drops legacy Codex entries whose input field contained full context usage.
const STORAGE_KEY = 'active_turn_status_v2';
const MAX_AGE_MS = 2 * 60 * 60 * 1000;

export type PersistedActiveTurnStatus = {
  text: string;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  startedAt: number | string;
  can_interrupt: boolean;
  updatedAt: number;
};

type StatusMap = Record<string, PersistedActiveTurnStatus>;

const readStatuses = (): StatusMap => {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || '{}') as StatusMap;
    const now = Date.now();
    return Object.fromEntries(
      Object.entries(parsed).filter(([, status]) =>
        status && Number.isFinite(Number(status.updatedAt)) && now - Number(status.updatedAt) < MAX_AGE_MS
      ),
    );
  } catch {
    return {};
  }
};

export const getPersistedActiveTurnStatus = (sessionId?: string | null) => {
  if (!sessionId) return null;
  return readStatuses()[sessionId] || null;
};

export const persistActiveTurnStatus = (
  sessionId: string,
  incoming: Partial<Omit<PersistedActiveTurnStatus, 'updatedAt'>>,
) => {
  if (!sessionId) return;
  try {
    const statuses = readStatuses();
    const previous = statuses[sessionId];
    const incomingStartedAt = incoming.startedAt ? new Date(incoming.startedAt).getTime() : 0;
    const previousStartedAt = previous?.startedAt ? new Date(previous.startedAt).getTime() : 0;
    const isNewTurn = incomingStartedAt > 0
      && previousStartedAt > 0
      && incomingStartedAt > previousStartedAt + 500;
    const baseline = isNewTurn ? undefined : previous;
    const inputTokens = Math.max(Number(baseline?.inputTokens || 0), Number(incoming.inputTokens || 0));
    const outputTokens = Math.max(Number(baseline?.outputTokens || 0), Number(incoming.outputTokens || 0));
    statuses[sessionId] = {
      text: String(incoming.text || baseline?.text || 'Working in background'),
      tokens: Math.max(Number(baseline?.tokens || 0), Number(incoming.tokens || 0), inputTokens + outputTokens),
      inputTokens,
      outputTokens,
      startedAt: incoming.startedAt || baseline?.startedAt || Date.now(),
      can_interrupt: incoming.can_interrupt ?? baseline?.can_interrupt ?? true,
      updatedAt: Date.now(),
    };
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(statuses));
  } catch { /* ignore unavailable storage */ }
};

export const clearPersistedActiveTurnStatus = (sessionId?: string | null) => {
  if (!sessionId) return;
  try {
    const statuses = readStatuses();
    if (!statuses[sessionId]) return;
    delete statuses[sessionId];
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(statuses));
  } catch { /* ignore unavailable storage */ }
};
