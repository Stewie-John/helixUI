// Official Codex token-based rate card, in credits per 1M tokens.
// Source: https://help.openai.com/en/articles/20001106-codex-rate-card
const CODEX_CREDIT_RATES = new Map([
  ['gpt-5.6-sol', { input: 125, cachedInput: 12.5, output: 750 }],
  ['gpt-5.6-terra', { input: 62.5, cachedInput: 6.25, output: 375 }],
  ['gpt-5.6-luna', { input: 25, cachedInput: 2.5, output: 150 }],
  ['gpt-5.5', { input: 125, cachedInput: 12.5, output: 750 }],
  ['gpt-5.5-cyber', { input: 500, cachedInput: 50, output: 3000 }],
  ['gpt-5.4', { input: 62.5, cachedInput: 6.25, output: 375 }],
  ['gpt-5.4-mini', { input: 18.75, cachedInput: 1.875, output: 113 }],
  ['gpt-5.3-codex', { input: 43.75, cachedInput: 4.375, output: 350 }],
  ['gpt-5.2', { input: 43.75, cachedInput: 4.375, output: 350 }],
]);

const normalizeCodexModel = (model) => {
  const normalized = String(model || '').trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'gpt-5.6' || normalized.startsWith('gpt-5.6-sol')) return 'gpt-5.6-sol';
  for (const modelId of CODEX_CREDIT_RATES.keys()) {
    if (normalized === modelId || normalized.startsWith(`${modelId}-`)) return modelId;
  }
  return normalized;
};

const estimateCodexCredits = ({ model, inputTokens = 0, cachedInputTokens = 0, outputTokens = 0 }) => {
  const normalizedModel = normalizeCodexModel(model);
  const rates = CODEX_CREDIT_RATES.get(normalizedModel);
  if (!rates) return null;
  const totalInput = Math.max(0, Number(inputTokens) || 0);
  const cachedInput = Math.min(totalInput, Math.max(0, Number(cachedInputTokens) || 0));
  const uncachedInput = totalInput - cachedInput;
  const output = Math.max(0, Number(outputTokens) || 0);
  return (
    uncachedInput * rates.input
    + cachedInput * rates.cachedInput
    + output * rates.output
  ) / 1_000_000;
};

export { CODEX_CREDIT_RATES, estimateCodexCredits, normalizeCodexModel };
