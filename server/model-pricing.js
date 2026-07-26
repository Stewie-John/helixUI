// 统一的按模型计价表，单位：美元 / 100 万 token。
// 目的是把 Codex 的 credits 和 Claude 的 MTok 价目折算到同一个可比口径（USD），
// 供统计面板的「花销」维度使用。
//
// 数据来源：
//  - Anthropic: https://platform.claude.com/docs/en/about-claude/pricing
//  - OpenAI Codex: https://help.openai.com/en/articles/20001106-codex-rate-card
//    该表以 credits / 1M token 计价，按 1 credit ≈ $0.04 折算为美元。

import { CODEX_CREDIT_RATES, normalizeCodexModel } from './codex-usage-pricing.js';

// 1 credit 的美元单价。可用 CODEX_CREDIT_USD 覆盖（例如企业协议价不同）。
export const CODEX_CREDIT_USD = Number(process.env.CODEX_CREDIT_USD) || 0.04;

// Anthropic 官方价目。cachedInput 对应 cache read（0.1× 基础输入），
// cacheWrite 对应 5 分钟 cache write（1.25× 基础输入）。
const CLAUDE_USD_RATES = new Map([
  ['claude-fable-5', { input: 10, cachedInput: 1, cacheWrite: 12.5, output: 50 }],
  ['claude-opus-5', { input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 25 }],
  ['claude-opus-4-8', { input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 25 }],
  ['claude-opus-4-7', { input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 25 }],
  ['claude-opus-4-6', { input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 25 }],
  ['claude-opus-4-5', { input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 25 }],
  ['claude-opus-4-1', { input: 15, cachedInput: 1.5, cacheWrite: 18.75, output: 75 }],
  // Sonnet 5 在 2026-08-31 前为introductory价 $2/$10，之后回到 $3/$15
  ['claude-sonnet-5', { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 10 }],
  ['claude-sonnet-4-6', { input: 3, cachedInput: 0.3, cacheWrite: 3.75, output: 15 }],
  ['claude-sonnet-4-5', { input: 3, cachedInput: 0.3, cacheWrite: 3.75, output: 15 }],
  ['claude-haiku-4-5', { input: 1, cachedInput: 0.1, cacheWrite: 1.25, output: 5 }],
  ['claude-haiku-3-5', { input: 0.8, cachedInput: 0.08, cacheWrite: 1, output: 4 }],
]);

const SONNET_5_INTRO_ENDS = Date.UTC(2026, 8, 1); // 2026-09-01 起恢复标准价

const normalizeClaudeModel = (model) => {
  // 去掉日期后缀与 [1m] 之类的变体标记：claude-sonnet-4-5-20250929 → claude-sonnet-4-5
  const normalized = String(model || '').trim().toLowerCase().replace(/\[[^\]]*\]/g, '');
  if (!normalized) return null;
  if (CLAUDE_USD_RATES.has(normalized)) return normalized;
  for (const modelId of CLAUDE_USD_RATES.keys()) {
    if (normalized.startsWith(`${modelId}-`)) return modelId;
  }
  return normalized;
};

const claudeRatesFor = (modelId, day) => {
  const rates = CLAUDE_USD_RATES.get(modelId);
  if (!rates) return null;
  if (modelId !== 'claude-sonnet-5') return rates;
  const dayMs = day ? Date.parse(`${day}T00:00:00Z`) : Date.now();
  if (Number.isFinite(dayMs) && dayMs < SONNET_5_INTRO_ENDS) return rates;
  return { input: 3, cachedInput: 0.3, cacheWrite: 3.75, output: 15 };
};

const codexRatesUsdFor = (modelId) => {
  const rates = CODEX_CREDIT_RATES.get(modelId);
  if (!rates) return null;
  return {
    input: rates.input * CODEX_CREDIT_USD,
    cachedInput: rates.cachedInput * CODEX_CREDIT_USD,
    // Codex 计费无独立的 cache write 档，写入按普通输入计价
    cacheWrite: rates.input * CODEX_CREDIT_USD,
    output: rates.output * CODEX_CREDIT_USD,
  };
};

/**
 * 返回某模型的美元费率（每 1M token），未知模型返回 null。
 * @param {string} provider - claude / codex / ...
 * @param {string} model
 * @param {string} [day] - YYYY-MM-DD，用于处理限时价（目前仅 Sonnet 5）
 */
export function getModelUsdRates(provider, model, day) {
  if (provider === 'codex') return codexRatesUsdFor(normalizeCodexModel(model));
  if (provider === 'claude') return claudeRatesFor(normalizeClaudeModel(model), day);
  return null;
}

/**
 * 按模型价目估算花销（美元）。未知模型返回 null，调用方据此标记 hasUnknownPricing。
 *
 * inputTokens 是「含缓存在内的总输入」，与 model_output_events 的存储口径一致；
 * cachedInputTokens 是其中的缓存命中部分，按 0.1× 计价。
 */
export function estimateModelCostUsd({
  provider,
  model,
  day,
  inputTokens = 0,
  cachedInputTokens = 0,
  cacheWriteTokens = 0,
  outputTokens = 0,
}) {
  const rates = getModelUsdRates(provider, model, day);
  if (!rates) return null;
  const totalInput = Math.max(0, Number(inputTokens) || 0);
  const cachedInput = Math.min(totalInput, Math.max(0, Number(cachedInputTokens) || 0));
  const cacheWrite = Math.min(totalInput - cachedInput, Math.max(0, Number(cacheWriteTokens) || 0));
  const uncachedInput = totalInput - cachedInput - cacheWrite;
  const output = Math.max(0, Number(outputTokens) || 0);
  return (
    uncachedInput * rates.input
    + cachedInput * rates.cachedInput
    + cacheWrite * rates.cacheWrite
    + output * rates.output
  ) / 1_000_000;
}
