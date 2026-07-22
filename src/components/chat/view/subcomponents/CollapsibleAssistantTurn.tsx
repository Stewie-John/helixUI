import { useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { CircleCheck } from 'lucide-react';

import type { ChatMessage } from '../../types/types';

export interface AssistantTurnItem {
  message: ChatMessage;
  index: number;
}

interface CollapsibleAssistantTurnProps {
  items: AssistantTurnItem[];
  renderItem: (item: AssistantTurnItem) => ReactNode;
  // 是否为对话中「最新的回复块」。最新回复默认展开，更早的默认折叠。
  isLatest: boolean;
  // True only after the provider's turn-complete state has been observed (or
  // when a later user turn proves this historical turn is closed).
  isComplete: boolean;
}

// 一个「回复块」：用户提问之后连续的所有非 user 消息（assistant 文本、工具调用、
// 工具结果、思考、通知等）聚合为一个整体，默认折叠成一行「展开回复」按钮。
// 设计动机：助手回复往往很长（多步工具调用），默认只显示用户的提问，便于快速翻找
// 历史问题；需要时点开查看完整回复，可再次收起。
// 折叠默认值（派生）：最新回复块（isLatest）或正在流式生成（isStreaming）默认展开，
// 其余默认折叠。用户手动点开/收起后以 override 覆盖派生值；当一个回复块不再是最新时，
// 若用户从未手动操作过，它会自动跟随派生值收起——从而实现「只有最新回复默认展开，
// 更早的自动折叠」。
function CollapsibleAssistantTurn({ items, renderItem, isLatest, isComplete }: CollapsibleAssistantTurnProps) {
  const { t } = useTranslation('chat');
  const hasStreaming = items.some((it) => it.message.isStreaming);
  // null = 未手动操作，跟随派生默认值；true/false = 用户手动覆盖
  const [override, setOverride] = useState<boolean | null>(null);
  const expanded = override ?? (isLatest || hasStreaming);

  // 折叠态预览：取回复块中第一条有意义的助手文本，截断到 ~60 字，便于辨认是哪段回复
  const preview = (() => {
    for (const it of items) {
      const m = it.message;
      if (m.type === 'assistant' && !m.isToolUse && typeof m.content === 'string' && m.content.trim()) {
        return m.content.trim().replace(/\s+/g, ' ').slice(0, 60);
      }
    }
    for (const it of items) {
      const m = it.message;
      const txt =
        (typeof m.content === 'string' && m.content) ||
        (typeof m.displayText === 'string' && m.displayText) ||
        '';
      if (txt.trim()) return txt.trim().replace(/\s+/g, ' ').slice(0, 60);
    }
    return '';
  })();

  const toolCount = items.filter((it) => it.message.isToolUse).length;

  if (!expanded) {
    return (
      <div className="w-full py-0.5">
        <button
          type="button"
          onClick={() => setOverride(true)}
          className="group flex items-center gap-2 text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 transition-colors max-w-full"
        >
          <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
          <span className="font-medium flex-shrink-0">
            {t('assistantTurn.expand', { defaultValue: '展开回复' })}
          </span>
          {toolCount > 0 && (
            <span className="flex-shrink-0 opacity-70">
              · {t('assistantTurn.steps', { defaultValue: '{{n}} 步', n: toolCount })}
            </span>
          )}
          {isComplete && (
            <span className="flex items-center gap-1.5 flex-shrink-0 text-emerald-300 font-bold">
              <CircleCheck className="w-4 h-4" aria-hidden="true" />
              {t('assistantTurn.completeShort', { defaultValue: '已完成' })}
            </span>
          )}
          {preview && (
            <span className="truncate opacity-60 font-normal">{preview}</span>
          )}
        </button>
      </div>
    );
  }

  return (
    <div className="w-full">
      <button
        type="button"
        onClick={() => setOverride(false)}
        className="flex items-center gap-2 text-xs text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300 transition-colors mb-1"
      >
        <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
        <span>{t('assistantTurn.collapse', { defaultValue: '收起回复' })}</span>
      </button>
      {items.map((it) => renderItem(it))}
      {isComplete && (
        <div
          data-turn-complete
          className="flex items-center gap-3 mt-4 mb-2 py-1.5 text-emerald-200"
          role="status"
          aria-label={t('assistantTurn.complete', { defaultValue: '本轮已完成' })}
        >
          <span className="h-0.5 flex-1 bg-emerald-300/75" aria-hidden="true" />
          <CircleCheck className="w-5 h-5 flex-shrink-0 drop-shadow-[0_0_5px_rgba(110,231,183,0.65)]" aria-hidden="true" />
          <span className="text-sm font-bold tracking-wide drop-shadow-[0_0_4px_rgba(110,231,183,0.45)]">
            {t('assistantTurn.complete', { defaultValue: '本轮已完成' })}
          </span>
          <span className="h-0.5 flex-1 bg-emerald-300/75" aria-hidden="true" />
        </div>
      )}
    </div>
  );
}

export default CollapsibleAssistantTurn;
