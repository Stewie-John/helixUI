import React from 'react';
import { useTranslation } from 'react-i18next';
import ThinkingModeSelector from './ThinkingModeSelector';
import TokenUsagePie from './TokenUsagePie';
import { CLAUDE_MODELS, CODEX_MODELS, CURSOR_MODELS, GEMINI_MODELS } from '../../../../../shared/modelConstants';
import type { PermissionMode, Provider } from '../../types/types';

interface ChatInputControlsProps {
  permissionMode: PermissionMode | string;
  onModeSwitch: () => void;
  provider: Provider | string;
  thinkingMode: string;
  setThinkingMode: React.Dispatch<React.SetStateAction<string>>;
  tokenBudget: { used?: number; total?: number } | null;
  slashCommandsCount: number;
  onToggleCommandMenu: () => void;
  hasInput: boolean;
  onClearInput: () => void;
  isUserScrolledUp: boolean;
  hasMessages: boolean;
  onScrollToBottom: () => void;
  claudeModel?: string;
  setClaudeModel?: (model: string) => void;
  cursorModel?: string;
  setCursorModel?: (model: string) => void;
  codexModel?: string;
  setCodexModel?: (model: string) => void;
  geminiModel?: string;
  setGeminiModel?: (model: string) => void;
}

function getModelConfig(p: string) {
  if (p === 'claude') return CLAUDE_MODELS;
  if (p === 'codex') return CODEX_MODELS;
  if (p === 'gemini') return GEMINI_MODELS;
  return CURSOR_MODELS;
}

export default function ChatInputControls({
  permissionMode,
  onModeSwitch,
  provider,
  thinkingMode,
  setThinkingMode,
  tokenBudget,
  slashCommandsCount,
  onToggleCommandMenu,
  hasInput,
  onClearInput,
  isUserScrolledUp,
  hasMessages,
  onScrollToBottom,
  claudeModel,
  setClaudeModel,
  cursorModel,
  setCursorModel,
  codexModel,
  setCodexModel,
  geminiModel,
  setGeminiModel,
}: ChatInputControlsProps) {
  const { t } = useTranslation('chat');

  // 模型选择
  const modelConfig = getModelConfig(provider);
  const currentModel =
    provider === 'claude' ? claudeModel :
    provider === 'codex' ? codexModel :
    provider === 'gemini' ? geminiModel :
    cursorModel;

  const handleModelChange = (value: string) => {
    // claude 模型由 hook 内的 setClaudeModelForSession 统一处理会话隔离存储
    if (provider === 'claude' && setClaudeModel) { setClaudeModel(value); }
    else if (provider === 'codex' && setCodexModel) { setCodexModel(value); localStorage.setItem('codex-model', value); }
    else if (provider === 'gemini' && setGeminiModel) { setGeminiModel(value); localStorage.setItem('gemini-model', value); }
    else if (setCursorModel) { setCursorModel(value); localStorage.setItem('cursor-model', value); }
  };

  return (
    <div className="flex items-center justify-center gap-2 sm:gap-3 flex-wrap">
      <button
        type="button"
        onClick={onModeSwitch}
        className={`px-2.5 py-1 sm:px-3 sm:py-1.5 rounded-lg text-sm font-medium border transition-all duration-200 ${
          permissionMode === 'default'
            ? 'bg-muted/50 text-muted-foreground border-border/60 hover:bg-muted'
            : permissionMode === 'acceptEdits'
              ? 'bg-green-50 dark:bg-green-900/15 text-green-700 dark:text-green-300 border-green-300/60 dark:border-green-600/40 hover:bg-green-100 dark:hover:bg-green-900/25'
              : permissionMode === 'bypassPermissions'
                ? 'bg-orange-50 dark:bg-orange-900/15 text-orange-700 dark:text-orange-300 border-orange-300/60 dark:border-orange-600/40 hover:bg-orange-100 dark:hover:bg-orange-900/25'
                : 'bg-primary/5 text-primary border-primary/20 hover:bg-primary/10'
        }`}
        title={t('input.clickToChangeMode')}
      >
        <div className="flex items-center gap-1.5">
          <div
            className={`w-1.5 h-1.5 rounded-full ${
              permissionMode === 'default'
                ? 'bg-muted-foreground'
                : permissionMode === 'acceptEdits'
                  ? 'bg-green-500'
                  : permissionMode === 'bypassPermissions'
                    ? 'bg-orange-500'
                    : 'bg-primary'
            }`}
          />
          <span>
            {permissionMode === 'default' && t('codex.modes.default')}
            {permissionMode === 'acceptEdits' && t('codex.modes.acceptEdits')}
            {permissionMode === 'bypassPermissions' && t('codex.modes.bypassPermissions')}
            {permissionMode === 'plan' && t('codex.modes.plan')}
          </span>
        </div>
      </button>

      {/* 模型选择下拉框 —— 在有消息的会话中也能切换模型 */}
      {currentModel && (
        <div className="relative">
          <select
            value={currentModel}
            onChange={(e) => handleModelChange(e.target.value)}
            className="appearance-none pl-2.5 pr-6 py-1 sm:py-1.5 text-sm font-medium bg-muted/50 border border-border/60 rounded-lg text-foreground cursor-pointer hover:bg-muted transition-colors focus:outline-none focus:ring-2 focus:ring-primary/20"
          >
            {modelConfig.OPTIONS.map(({ value, label }: { value: string; label: string }) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
          <svg className="absolute right-1.5 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      )}

      {provider === 'claude' && (
        <ThinkingModeSelector selectedMode={thinkingMode} onModeChange={setThinkingMode} onClose={() => {}} className="" />
      )}

      <TokenUsagePie used={tokenBudget?.used || 0} total={tokenBudget?.total || parseInt(import.meta.env.VITE_CONTEXT_WINDOW) || 160000} />

      <button
        type="button"
        onClick={onToggleCommandMenu}
        className="relative w-7 h-7 sm:w-8 sm:h-8 text-muted-foreground hover:text-foreground rounded-lg flex items-center justify-center transition-colors hover:bg-accent/60"
        title={t('input.showAllCommands')}
      >
        <svg className="w-4 h-4 sm:w-5 sm:h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z"
          />
        </svg>
        {slashCommandsCount > 0 && (
          <span
            className="absolute -top-1 -right-1 bg-primary text-primary-foreground text-[10px] font-bold rounded-full w-4 h-4 sm:w-5 sm:h-5 flex items-center justify-center"
          >
            {slashCommandsCount}
          </span>
        )}
      </button>

      {hasInput && (
        <button
          type="button"
          onClick={onClearInput}
          className="w-7 h-7 sm:w-8 sm:h-8 bg-card hover:bg-accent/60 border border-border/50 rounded-lg flex items-center justify-center transition-all duration-200 group shadow-sm"
          title={t('input.clearInput', { defaultValue: 'Clear input' })}
        >
          <svg
            className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-muted-foreground group-hover:text-foreground transition-colors"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      )}

      {isUserScrolledUp && hasMessages && (
        <button
          onClick={onScrollToBottom}
          className="w-7 h-7 sm:w-8 sm:h-8 bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg shadow-sm flex items-center justify-center transition-all duration-200 hover:scale-105"
          title={t('input.scrollToBottom', { defaultValue: 'Scroll to bottom' })}
        >
          <svg className="w-3.5 h-3.5 sm:w-4 sm:h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
          </svg>
        </button>
      )}
    </div>
  );
}
