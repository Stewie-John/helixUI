/**
 * Centralized Model Definitions
 * Single source of truth for all supported AI models
 */

/**
 * Claude (Anthropic) Models
 *
 * Note: Claude uses two different formats:
 * - Claude Code aliases ('sonnet', 'opus') resolve by provider and can change over time
 * - Claude API IDs below are official Anthropic model IDs and avoid ambiguous aliases
 */
export const CLAUDE_MODELS = {
  // Official Anthropic API IDs. Claude Code accepts these through the SDK model option.
  OPTIONS: [
    { value: 'claude-fable-5', label: 'Fable 5 (Mythos)' },
    { value: 'claude-opus-5', label: 'Opus 5' },
    { value: 'claude-sonnet-5', label: 'Sonnet 5' },
    { value: 'claude-opus-4-8', label: 'Opus 4.8' },
    { value: 'claude-opus-4-7', label: 'Opus 4.7' },
    { value: 'claude-opus-4-6', label: 'Opus 4.6' },
    { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
    { value: 'claude-sonnet-4-5-20250929', label: 'Sonnet 4.5' },
    { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' }
  ],

  DEFAULT: 'claude-sonnet-4-6'
};

/**
 * Claude Reasoning Effort (思考强度)
 * 对应 Agent SDK 的 `effort` 选项（EffortLevel）。
 * SDK 默认 'high'；各档位是否可用取决于模型能力（见 getClaudeEffortOptions）。
 */
export const CLAUDE_EFFORT_LEVELS = {
  OPTIONS: [
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
    { value: 'xhigh', label: 'XHigh' },
    { value: 'max', label: 'Max' }
  ],

  DEFAULT: 'high'
};

/**
 * 根据模型返回其支持的思考强度档位。
 * 镜像 SDK cli.js 的门控逻辑：
 *  - low/medium/high：所有模型通用
 *  - max：除 haiku 外的模型（opus / sonnet）
 *  - xhigh：仅 opus-4-7 / opus-4-8 / opus-5 / sonnet-5 / fable（更高代际）
 */
export function getClaudeEffortOptions(model) {
  const id = String(model || '').toLowerCase();
  const isHaiku = id.includes('haiku');
  const isOpus = id.includes('opus');
  const supportsXhigh = id.includes('opus-4-7') || id.includes('opus-4-8') || id.includes('opus-5') || id.includes('sonnet-5') || id.includes('fable');
  const supportsMax = !isHaiku; // opus + sonnet
  return CLAUDE_EFFORT_LEVELS.OPTIONS.filter((opt) => {
    if (opt.value === 'xhigh') return supportsXhigh;
    if (opt.value === 'max') return supportsMax;
    return true;
  });
}

/**
 * Cursor Models
 */
export const CURSOR_MODELS = {
  OPTIONS: [
    { value: 'gpt-5.2-high', label: 'GPT-5.2 High' },
    { value: 'gemini-3-pro', label: 'Gemini 3 Pro' },
    { value: 'opus-4.5-thinking', label: 'Claude 4.5 Opus (Thinking)' },
    { value: 'gpt-5.2', label: 'GPT-5.2' },
    { value: 'gpt-5.1', label: 'GPT-5.1' },
    { value: 'gpt-5.1-high', label: 'GPT-5.1 High' },
    { value: 'composer-1', label: 'Composer 1' },
    { value: 'auto', label: 'Auto' },
    { value: 'sonnet-4.5', label: 'Claude 4.5 Sonnet' },
    { value: 'sonnet-4.5-thinking', label: 'Claude 4.5 Sonnet (Thinking)' },
    { value: 'opus-4.5', label: 'Claude 4.5 Opus' },
    { value: 'gpt-5.1-codex', label: 'GPT-5.1 Codex' },
    { value: 'gpt-5.1-codex-high', label: 'GPT-5.1 Codex High' },
    { value: 'gpt-5.1-codex-max', label: 'GPT-5.1 Codex Max' },
    { value: 'gpt-5.1-codex-max-high', label: 'GPT-5.1 Codex Max High' },
    { value: 'opus-4.1', label: 'Claude 4.1 Opus' },
    { value: 'grok', label: 'Grok' }
  ],

  DEFAULT: 'gpt-5'
};

/**
 * Codex (OpenAI) Models
 */
export const CODEX_MODELS = {
  OPTIONS: [
    { value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
    { value: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
    { value: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
    { value: 'gpt-5.5', label: 'GPT-5.5' },
    { value: 'gpt-5.4', label: 'GPT-5.4' },
    { value: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' },
    { value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
    { value: 'gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark' },
    { value: 'gpt-5.5-codex', label: 'GPT-5.5 Codex (API Key)' },
    { value: 'gpt-5.2-codex', label: 'GPT-5.2 Codex' },
    { value: 'gpt-5.2', label: 'GPT-5.2' },
    { value: 'gpt-5.1-codex-max', label: 'GPT-5.1 Codex Max' },
    { value: 'o3', label: 'O3' },
    { value: 'o4-mini', label: 'O4-mini' }
  ],

  DEFAULT: 'gpt-5.6-sol'
};

/**
 * Codex Reasoning Effort
 * Mirrors Codex CLI model_reasoning_effort values
 */
export const CODEX_REASONING_EFFORTS = {
  OPTIONS: [
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
    { value: 'xhigh', label: 'XHigh' },
    { value: 'max', label: 'Max' },
    { value: 'ultra', label: 'Ultra' }
  ],

  DEFAULT: 'medium'
};

// Kept in sync with the native Codex CLI model catalog. Do not offer a
// reasoning level for a model that app-server would reject.
const CODEX_REASONING_LEVELS_BY_MODEL = {
  'gpt-5.6-sol': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  'gpt-5.6-terra': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  'gpt-5.6-luna': ['low', 'medium', 'high', 'xhigh', 'max'],
};

export function getCodexReasoningEffortOptions(model) {
  const supported = new Set(
    CODEX_REASONING_LEVELS_BY_MODEL[model] || ['low', 'medium', 'high', 'xhigh'],
  );
  return CODEX_REASONING_EFFORTS.OPTIONS.filter(({ value }) => supported.has(value));
}

/**
 * Codex Speed / Service Tier
 * Mapped to Codex config key: service_tier
 */
export const CODEX_SPEED_OPTIONS = {
  OPTIONS: [
    { value: 'auto', label: 'Auto' },
    { value: 'default', label: 'Default' },
    { value: 'fast', label: 'Fast' }
  ],

  DEFAULT: 'auto'
};

/**
 * Gemini Models
 */
export const GEMINI_MODELS = {
  OPTIONS: [
    { value: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro Preview' },
    { value: 'gemini-3-pro-preview', label: 'Gemini 3 Pro Preview' },
    { value: 'gemini-3-flash-preview', label: 'Gemini 3 Flash Preview' },
    { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    { value: 'gemini-2.0-flash-lite', label: 'Gemini 2.0 Flash Lite' },
    { value: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
    { value: 'gemini-2.0-pro-exp', label: 'Gemini 2.0 Pro Experimental' },
    { value: 'gemini-2.0-flash-thinking-exp', label: 'Gemini 2.0 Flash Thinking' }
  ],

  DEFAULT: 'gemini-2.5-flash'
};
