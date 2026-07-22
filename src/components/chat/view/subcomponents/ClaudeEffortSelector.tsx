import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Brain, Zap, Sparkles, Atom, Flame, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { getClaudeEffortOptions, CLAUDE_EFFORT_LEVELS } from '../../../../../shared/modelConstants';

// 各档位的图标与配色（强度递增）
const EFFORT_META: Record<string, { icon: typeof Brain; color: string }> = {
  low: { icon: Zap, color: 'text-gray-500' },
  medium: { icon: Brain, color: 'text-blue-600' },
  high: { icon: Sparkles, color: 'text-indigo-600' },
  xhigh: { icon: Atom, color: 'text-purple-600' },
  max: { icon: Flame, color: 'text-red-600' },
};

type ClaudeEffortSelectorProps = {
  selectedEffort: string;
  onEffortChange: (effort: string) => void;
  model?: string;
  onClose?: () => void;
  className?: string;
};

function ClaudeEffortSelector({ selectedEffort, onEffortChange, model, onClose, className = '' }: ClaudeEffortSelectorProps) {
  const { t } = useTranslation('chat');

  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // 下拉面板的 fixed 定位（用按钮位置实时计算，避免被祖先 overflow 裁剪）
  const [panelPos, setPanelPos] = useState<{ right: number; bottom: number } | null>(null);

  const updatePanelPos = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPanelPos({
      right: Math.max(8, window.innerWidth - rect.right),
      bottom: window.innerHeight - rect.top + 8,
    });
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    updatePanelPos();
    const onScroll = () => updatePanelPos();
    window.addEventListener('resize', onScroll);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('resize', onScroll);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [isOpen, updatePanelPos]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        containerRef.current && !containerRef.current.contains(target) &&
        panelRef.current && !panelRef.current.contains(target)
      ) {
        setIsOpen(false);
        if (onClose) onClose();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  // 当前模型支持的档位
  const options = getClaudeEffortOptions(model);
  const effective = options.some((o) => o.value === selectedEffort) ? selectedEffort : CLAUDE_EFFORT_LEVELS.DEFAULT;
  const currentMeta = EFFORT_META[effective] || EFFORT_META.high;
  const isDefault = effective === CLAUDE_EFFORT_LEVELS.DEFAULT;

  const panel = isOpen && panelPos ? createPortal(
    <div
      ref={panelRef}
      style={{ position: 'fixed', right: panelPos.right, bottom: panelPos.bottom, zIndex: 9999, width: '15rem' }}
      className="bg-white dark:bg-gray-800 rounded-lg shadow-xl border border-gray-200 dark:border-gray-700 overflow-hidden"
    >
      <div className="p-3 border-b border-gray-200 dark:border-gray-700">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
            {t('claudeEffort.selector.title', { defaultValue: 'Thinking effort' })}
          </h3>
          <button
            onClick={() => { setIsOpen(false); if (onClose) onClose(); }}
            className="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded"
          >
            <X className="w-4 h-4 text-gray-500" />
          </button>
        </div>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
          {t('claudeEffort.selector.description', { defaultValue: 'Higher effort = deeper reasoning' })}
        </p>
      </div>

      <div className="py-1">
        {options.map((opt) => {
          const meta = EFFORT_META[opt.value] || EFFORT_META.high;
          const ModeIcon = meta.icon;
          const isSelected = opt.value === effective;
          return (
            <button
              key={opt.value}
              onClick={() => {
                onEffortChange(opt.value);
                setIsOpen(false);
                if (onClose) onClose();
              }}
              className={`w-full px-4 py-2.5 text-left hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors ${isSelected ? 'bg-gray-50 dark:bg-gray-700' : ''
                }`}
            >
              <div className="flex items-center gap-3">
                <div className={`${meta.color}`}>
                  <ModeIcon className="w-5 h-5" />
                </div>
                <span className={`font-medium text-sm ${isSelected ? 'text-gray-900 dark:text-white' : 'text-gray-700 dark:text-gray-300'
                  }`}>
                  {opt.label}
                </span>
                {isSelected && (
                  <span className="ml-auto text-xs bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 px-2 py-0.5 rounded">
                    {t('claudeEffort.selector.active', { defaultValue: 'Active' })}
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>,
    document.body
  ) : null;

  return (
    <div className={`relative ${className}`} ref={containerRef}>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setIsOpen((v) => !v)}
        className={`w-10 h-10 sm:w-10 sm:h-10 rounded-full flex items-center justify-center transition-all duration-200 ${isDefault
            ? 'bg-gray-100 hover:bg-gray-200 dark:bg-cyan-950 dark:hover:bg-cyan-900/80'
            : 'bg-blue-100 hover:bg-blue-200 dark:bg-blue-900 dark:hover:bg-blue-800'
          }`}
        title={t('claudeEffort.buttonTitle', { defaultValue: 'Thinking effort: {{effort}}', effort: effective })}
      >
        <Brain className={`w-5 h-5 ${isDefault ? 'text-gray-500 dark:text-cyan-300' : currentMeta.color}`} />
      </button>
      {panel}
    </div>
  );
}

export default ClaudeEffortSelector;
