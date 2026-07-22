import type { SessionProvider } from '../../../types/app';

export const TOKEN_BUDGET_STORAGE_KEY = 'claudecodeui.latestTokenBudget';
export const TOKEN_BUDGET_EVENT = 'claudecodeui-token-budget';

export type TokenBudgetSnapshot = {
  used?: number;
  total?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  reasoningOutputTokens?: number;
  provider?: SessionProvider | string;
  sessionId?: string | null;
  source?: string;
  updatedAt?: number;
  [key: string]: unknown;
};

const readNumber = (value: unknown) => {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : 0;
};

export function normalizeTokenBudgetSnapshot(
  budget: Record<string, unknown> | null | undefined,
): TokenBudgetSnapshot | null {
  if (!budget || typeof budget !== 'object') {
    return null;
  }

  const used = readNumber(
    budget.used ??
    budget.totalUsed ??
    budget.total_tokens ??
    budget.token_count,
  );
  const total = readNumber(
    budget.total ??
    budget.contextWindow ??
    budget.context_window ??
    budget.model_context_window,
  );

  if (!used && !total) {
    return null;
  }

  return {
    ...budget,
    used,
    total,
    inputTokens: readNumber(budget.inputTokens ?? budget.input_tokens ?? budget.input),
    outputTokens: readNumber(budget.outputTokens ?? budget.output_tokens ?? budget.output),
    cacheReadTokens: readNumber(
      budget.cacheReadTokens ??
      budget.cacheReadInputTokens ??
      budget.cache_read_tokens ??
      budget.cache_read_input_tokens,
    ),
    cacheCreationTokens: readNumber(
      budget.cacheCreationTokens ??
      budget.cache_creation_input_tokens,
    ),
    reasoningOutputTokens: readNumber(
      budget.reasoningOutputTokens ??
      budget.reasoning_output_tokens,
    ),
    sessionId: typeof budget.sessionId === 'string' ? budget.sessionId : null,
    provider: typeof budget.provider === 'string' ? budget.provider : undefined,
    source: typeof budget.source === 'string' ? budget.source : undefined,
    updatedAt: Date.now(),
  };
}

export function publishTokenBudgetSnapshot(budget: Record<string, unknown> | null | undefined) {
  if (typeof window === 'undefined') {
    return;
  }

  const snapshot = normalizeTokenBudgetSnapshot(budget);
  if (!snapshot) {
    return;
  }

  try {
    window.localStorage.setItem(TOKEN_BUDGET_STORAGE_KEY, JSON.stringify(snapshot));
  } catch { /* ignore */ }

  window.dispatchEvent(new CustomEvent<TokenBudgetSnapshot>(TOKEN_BUDGET_EVENT, { detail: snapshot }));
}

export function readStoredTokenBudgetSnapshot(): TokenBudgetSnapshot | null {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(TOKEN_BUDGET_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    return normalizeTokenBudgetSnapshot(JSON.parse(raw));
  } catch {
    return null;
  }
}
