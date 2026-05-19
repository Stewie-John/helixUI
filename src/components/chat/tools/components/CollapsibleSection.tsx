import React, { useState, useEffect, useRef } from 'react';

interface CollapsibleSectionProps {
  title: string;
  toolName?: string;
  open?: boolean;
  action?: React.ReactNode;
  onTitleClick?: () => void;
  children: React.ReactNode;
  className?: string;
}

/**
 * Reusable collapsible section with consistent styling.
 *
 * 关键：用内部 state 追踪展开/收起，open prop 仅作为初始值。
 * 原生 <details open={prop}> 在每次 React 重渲染时会被强制覆盖，
 * 导致用户手动展开的块在流式输出/消息更新时被自动合上（#bug）。
 * 改为 state 后，React reconciliation 只与 state 比对，不再强制合上。
 */
export const CollapsibleSection: React.FC<CollapsibleSectionProps> = ({
  title,
  toolName,
  open = false,
  action,
  onTitleClick,
  children,
  className = ''
}) => {
  const [isOpen, setIsOpen] = useState(open);
  // 用户是否已手动操作过（展开或折叠）
  // 手动操作后不再响应 prop 变化，防止工具完成时父组件把 open 改为 false
  // 强制折叠用户已手动展开的内容（"读着读着自动折回去"的根本原因）
  const userInteractedRef = useRef(false);
  const prevOpenRef = useRef(open);
  useEffect(() => {
    if (open !== prevOpenRef.current) {
      prevOpenRef.current = open;
      // 用户未手动操作时才同步（如 autoExpandTools 设置变化），
      // 已手动操作则忽略 prop 变化，保留用户的选择
      if (!userInteractedRef.current) {
        setIsOpen(open);
      }
    }
  }, [open]);

  return (
    <details
      className={`relative group/details ${className}`}
      open={isOpen}
      onToggle={(e) => {
        // isTrusted=true：用户真实点击触发的 toggle → 处理
        // isTrusted=false：React reconcile 改 open 属性时浏览器补发的 toggle → 忽略，
        // 否则会出现"点开后立刻折回"的竞态（React 用旧 state 短暂把 open 改回 false）
        if (!e.isTrusted) return;
        userInteractedRef.current = true;
        setIsOpen((e.currentTarget as HTMLDetailsElement).open);
      }}
    >
      <summary className="flex items-center gap-1.5 text-xs cursor-pointer py-0.5 select-none group-open/details:sticky group-open/details:top-0 group-open/details:z-10 group-open/details:bg-background group-open/details:-mx-1 group-open/details:px-1">
        <svg
          className="w-3 h-3 text-gray-400 dark:text-gray-500 transition-transform duration-150 group-open/details:rotate-90 flex-shrink-0"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
        {toolName && (
          <span className="font-medium text-gray-500 dark:text-gray-400 flex-shrink-0">{toolName}</span>
        )}
        {toolName && (
          <span className="text-gray-300 dark:text-gray-600 text-[10px] flex-shrink-0">/</span>
        )}
        {onTitleClick ? (
          <button
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onTitleClick(); }}
            className="text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 font-mono hover:underline truncate flex-1 text-left transition-colors"
          >
            {title}
          </button>
        ) : (
          <span className="text-gray-600 dark:text-gray-400 truncate flex-1">
            {title}
          </span>
        )}
        {action && <span className="flex-shrink-0 ml-1">{action}</span>}
      </summary>
      <div className="mt-1.5 pl-[18px]">
        {children}
      </div>
    </details>
  );
};
