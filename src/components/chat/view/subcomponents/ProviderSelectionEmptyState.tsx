import React, { useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import SessionProviderLogo from '../../../llm-logo-provider/SessionProviderLogo';
import NextTaskBanner from '../../../NextTaskBanner.jsx';
import {
  CLAUDE_MODELS,
  CURSOR_MODELS,
  CODEX_MODELS,
  CODEX_REASONING_EFFORTS,
  getCodexReasoningEffortOptions,
  CODEX_SPEED_OPTIONS,
  GEMINI_MODELS
} from '../../../../../shared/modelConstants';
import type { CustomProvider, ProjectSession, SessionProvider } from '../../../../types/app';
import { BUILTIN_PROVIDERS } from '../../../../types/app';
import { storeSelectedProvider } from '../../../../utils/appEvents';

interface ProviderSelectionEmptyStateProps {
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  provider: SessionProvider;
  setProvider: (next: SessionProvider) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement>;
  claudeModel: string;
  setClaudeModel: (model: string) => void;
  cursorModel: string;
  setCursorModel: (model: string) => void;
  codexModel: string;
  setCodexModel: (model: string) => void;
  codexReasoningEffort: string;
  setCodexReasoningEffort: (effort: string) => void;
  codexSpeed: string;
  setCodexSpeed: (speed: string) => void;
  geminiModel: string;
  setGeminiModel: (model: string) => void;
  tasksEnabled: boolean;
  isTaskMasterInstalled: boolean | null;
  onShowAllTasks?: (() => void) | null;
  setInput: React.Dispatch<React.SetStateAction<string>>;
}

type ProviderDef = {
  id: SessionProvider;
  name: string;
  infoKey: string;
  accent: string;
  ring: string;
  check: string;
};

const PROVIDERS: ProviderDef[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    infoKey: 'providerSelection.providerInfo.anthropic',
    accent: 'border-primary',
    ring: 'ring-primary/15',
    check: 'bg-primary text-primary-foreground',
  },
  {
    id: 'cursor',
    name: 'Cursor',
    infoKey: 'providerSelection.providerInfo.cursorEditor',
    accent: 'border-violet-500 dark:border-violet-400',
    ring: 'ring-violet-500/15',
    check: 'bg-violet-500 text-white',
  },
  {
    id: 'codex',
    name: 'Codex',
    infoKey: 'providerSelection.providerInfo.openai',
    accent: 'border-emerald-600 dark:border-emerald-400',
    ring: 'ring-emerald-600/15',
    check: 'bg-emerald-600 dark:bg-emerald-500 text-white',
  },
  {
    id: 'gemini',
    name: 'Gemini',
    infoKey: 'providerSelection.providerInfo.google',
    accent: 'border-blue-500 dark:border-blue-400',
    ring: 'ring-blue-500/15',
    check: 'bg-blue-500 text-white',
  },
];

function getModelConfig(p: SessionProvider) {
  if (p === 'claude') return CLAUDE_MODELS;
  if (p === 'codex') return CODEX_MODELS;
  if (p === 'gemini') return GEMINI_MODELS;
  if (p === 'cursor') return CURSOR_MODELS;
  return null; // custom provider — no fixed options list
}

function getModelValue(p: SessionProvider, c: string, cu: string, co: string, g: string) {
  if (p === 'claude') return c;
  if (p === 'codex') return co;
  if (p === 'gemini') return g;
  if (p === 'cursor') return cu;
  return localStorage.getItem(`custom-model-${p}`) || '';
}

function loadCustomProviders(): CustomProvider[] {
  try {
    return JSON.parse(localStorage.getItem('custom-providers') || '[]');
  } catch {
    return [];
  }
}

export default function ProviderSelectionEmptyState({
  selectedSession,
  currentSessionId,
  provider,
  setProvider,
  textareaRef,
  claudeModel,
  setClaudeModel,
  cursorModel,
  setCursorModel,
  codexModel,
  setCodexModel,
  codexReasoningEffort,
  setCodexReasoningEffort,
  codexSpeed,
  setCodexSpeed,
  geminiModel,
  setGeminiModel,
  tasksEnabled,
  isTaskMasterInstalled,
  onShowAllTasks,
  setInput,
}: ProviderSelectionEmptyStateProps) {
  const { t } = useTranslation('chat');
  const nextTaskPrompt = t('tasks.nextTaskPrompt', { defaultValue: 'Start the next task' });
  const [customProviders, setCustomProviders] = useState<CustomProvider[]>(() => loadCustomProviders());
  const [customModelInput, setCustomModelInput] = useState<string>(() =>
    !BUILTIN_PROVIDERS.has(provider) ? (localStorage.getItem(`custom-model-${provider}`) || '') : ''
  );

  const selectProvider = (next: SessionProvider) => {
    setProvider(next);
    storeSelectedProvider(next);
    if (!BUILTIN_PROVIDERS.has(next)) {
      const cp = loadCustomProviders().find((p) => p.id === next);
      setCustomModelInput(localStorage.getItem(`custom-model-${next}`) || cp?.model || '');
    }
    setTimeout(() => textareaRef.current?.focus(), 100);
  };

  const handleModelChange = (value: string) => {
    if (provider === 'claude') { setClaudeModel(value); }
    else if (provider === 'codex') { setCodexModel(value); localStorage.setItem('codex-model', value); }
    else if (provider === 'gemini') { setGeminiModel(value); localStorage.setItem('gemini-model', value); }
    else if (provider === 'cursor') { setCursorModel(value); localStorage.setItem('cursor-model', value); }
    else {
      setCustomModelInput(value);
      localStorage.setItem(`custom-model-${provider}`, value);
    }
  };
  const handleCodexReasoningEffortChange = (value: string) => {
    if (provider !== 'codex') return;
    setCodexReasoningEffort(value);
  };
  const handleCodexSpeedChange = (value: string) => {
    if (provider !== 'codex') return;
    setCodexSpeed(value);
  };

  const modelConfig = getModelConfig(provider);
  const isCustom = !BUILTIN_PROVIDERS.has(provider);
  const currentModel = isCustom
    ? customModelInput
    : getModelValue(provider, claudeModel, cursorModel, codexModel, geminiModel);

  // 自定义 Provider 列表变化时（storage event）同步更新
  React.useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key === 'custom-providers') setCustomProviders(loadCustomProviders());
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, []);

  /* ── New session — provider picker ── */
  if (!selectedSession && !currentSessionId) {
    return (
      <div className="flex items-center justify-center h-full px-4">
        <div className="w-full max-w-md">
          {/* Heading */}
          <div className="text-center mb-8">
            <h2 className="text-lg sm:text-xl font-semibold text-foreground tracking-tight">
              {t('providerSelection.title')}
            </h2>
            <p className="text-[13px] text-muted-foreground mt-1">
              {t('providerSelection.description')}
            </p>
          </div>

          {/* Provider cards — grid, built-in + custom */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-2.5 mb-6">
            {PROVIDERS.map((p) => {
              const active = provider === p.id;
              return (
                <button
                  key={p.id}
                  onClick={() => selectProvider(p.id)}
                  className={`
                    relative flex flex-col items-center gap-2.5 pt-5 pb-4 px-2
                    rounded-xl border-[1.5px] transition-all duration-150
                    active:scale-[0.97]
                    ${active
                      ? `${p.accent} ${p.ring} ring-2 bg-card shadow-sm`
                      : 'border-border bg-card/60 hover:bg-card hover:border-border/80'
                    }
                  `}
                >
                  <SessionProviderLogo
                    provider={p.id}
                    className={`w-9 h-9 transition-transform duration-150 ${active ? 'scale-110' : ''}`}
                  />
                  <div className="text-center">
                    <p className="text-[13px] font-semibold text-foreground leading-none">{p.name}</p>
                    <p className="text-[10px] text-muted-foreground mt-1 leading-tight">{t(p.infoKey)}</p>
                  </div>
                  {active && (
                    <div className={`absolute -top-1 -right-1 w-[18px] h-[18px] rounded-full ${p.check} flex items-center justify-center shadow-sm`}>
                      <Check className="w-2.5 h-2.5" strokeWidth={3} />
                    </div>
                  )}
                </button>
              );
            })}

            {/* 自定义 Provider 卡片 */}
            {customProviders.map((cp) => {
              const active = provider === cp.id;
              return (
                <button
                  key={cp.id}
                  onClick={() => selectProvider(cp.id)}
                  className={`
                    relative flex flex-col items-center gap-2.5 pt-5 pb-4 px-2
                    rounded-xl border-[1.5px] transition-all duration-150
                    active:scale-[0.97]
                    ${active
                      ? 'border-orange-500 dark:border-orange-400 ring-orange-500/15 ring-2 bg-card shadow-sm'
                      : 'border-border bg-card/60 hover:bg-card hover:border-border/80'
                    }
                  `}
                >
                  <SessionProviderLogo
                    provider={cp.id}
                    className={`w-9 h-9 transition-transform duration-150 ${active ? 'scale-110' : ''}`}
                  />
                  <div className="text-center">
                    <p className="text-[13px] font-semibold text-foreground leading-none">{cp.name}</p>
                    <p className="text-[10px] text-muted-foreground mt-1 leading-tight">{cp.description || cp.model}</p>
                  </div>
                  {active && (
                    <div className="absolute -top-1 -right-1 w-[18px] h-[18px] rounded-full bg-orange-500 text-white flex items-center justify-center shadow-sm">
                      <Check className="w-2.5 h-2.5" strokeWidth={3} />
                    </div>
                  )}
                </button>
              );
            })}
          </div>

          {/* Model picker — appears after provider is chosen */}
          <div className={`transition-all duration-200 ${provider ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-1 pointer-events-none'}`}>
            <div className="flex items-center justify-center gap-2 mb-5">
              <span className="text-sm text-muted-foreground">{t('providerSelection.selectModel')}</span>
              {isCustom ? (
                <input
                  type="text"
                  value={currentModel}
                  onChange={(e) => handleModelChange(e.target.value)}
                  placeholder="model name"
                  className="pl-3 pr-3 py-1.5 text-sm font-medium bg-muted/50 border border-border/60 rounded-lg text-foreground hover:bg-muted transition-colors focus:outline-none focus:ring-2 focus:ring-orange-500/20 w-48"
                />
              ) : (
                <div className="relative">
                  <select
                    value={currentModel}
                    onChange={(e) => handleModelChange(e.target.value)}
                    tabIndex={-1}
                    className="appearance-none w-auto max-w-[15rem] pl-3 pr-7 py-1.5 text-sm font-medium bg-muted/50 border border-border/60 rounded-lg text-foreground cursor-pointer hover:bg-muted transition-colors focus:outline-none focus:ring-2 focus:ring-primary/20"
                    title={currentModel}
                  >
                    {modelConfig!.OPTIONS.map(({ value, label }: { value: string; label: string }) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                  <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground pointer-events-none" />
                </div>
              )}
            </div>

            {provider === 'codex' && (
              <div className="flex items-center justify-center gap-2 mb-5 flex-wrap">
                <div className="relative">
                  <select
                    value={codexReasoningEffort || CODEX_REASONING_EFFORTS.DEFAULT}
                    onChange={(e) => handleCodexReasoningEffortChange(e.target.value)}
                    tabIndex={-1}
                    className="appearance-none w-auto max-w-[7.5rem] pl-3 pr-7 py-1.5 text-sm font-medium bg-muted/50 border border-border/60 rounded-lg text-foreground cursor-pointer hover:bg-muted transition-colors focus:outline-none focus:ring-2 focus:ring-primary/20"
                    title={t('input.codexReasoningEffort', { defaultValue: 'Reasoning effort' })}
                  >
                    {getCodexReasoningEffortOptions(codexModel).map(({ value, label }: { value: string; label: string }) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                  <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground pointer-events-none" />
                </div>

                <div className="relative">
                  <select
                    value={codexSpeed || CODEX_SPEED_OPTIONS.DEFAULT}
                    onChange={(e) => handleCodexSpeedChange(e.target.value)}
                    tabIndex={-1}
                    className="appearance-none w-auto max-w-[7.5rem] pl-3 pr-7 py-1.5 text-sm font-medium bg-muted/50 border border-border/60 rounded-lg text-foreground cursor-pointer hover:bg-muted transition-colors focus:outline-none focus:ring-2 focus:ring-primary/20"
                    title={t('input.codexSpeed', { defaultValue: 'Speed' })}
                  >
                    {CODEX_SPEED_OPTIONS.OPTIONS.map(({ value, label }: { value: string; label: string }) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                  <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground pointer-events-none" />
                </div>
              </div>
            )}

            <p className="text-center text-sm text-muted-foreground/70">
              {isCustom
                ? `Ready · ${customProviders.find((cp) => cp.id === provider)?.name || provider} · ${currentModel || '(set model above)'}`
                : ({
                    claude: t('providerSelection.readyPrompt.claude', { model: claudeModel }),
                    cursor: t('providerSelection.readyPrompt.cursor', { model: cursorModel }),
                    codex: t('providerSelection.readyPrompt.codex', { model: codexModel }),
                    gemini: t('providerSelection.readyPrompt.gemini', { model: geminiModel }),
                  } as Record<string, string>)[provider]
              }
            </p>
          </div>

          {/* Task banner */}
          {provider && tasksEnabled && isTaskMasterInstalled && (
            <div className="mt-5">
              <NextTaskBanner onStartTask={() => setInput(nextTaskPrompt)} onShowAllTasks={onShowAllTasks} />
            </div>
          )}
        </div>
      </div>
    );
  }

  /* ── Existing session — continue prompt ── */
  if (selectedSession) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center px-6 max-w-md">
          <p className="text-lg font-semibold text-foreground mb-1.5">{t('session.continue.title')}</p>
          <p className="text-sm text-muted-foreground leading-relaxed">{t('session.continue.description')}</p>

          {tasksEnabled && isTaskMasterInstalled && (
            <div className="mt-5">
              <NextTaskBanner onStartTask={() => setInput(nextTaskPrompt)} onShowAllTasks={onShowAllTasks} />
            </div>
          )}
        </div>
      </div>
    );
  }

  return null;
}
