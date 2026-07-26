import { useEffect } from 'react';

/**
 * 模态框按 Escape 关闭。
 *
 * 只在 keydown 的捕获阶段监听 document：模态框里的输入框往往会 stopPropagation
 * 掉自己的按键，冒泡阶段收不到 Escape。
 */
export function useEscapeKey(isActive: boolean, onEscape: () => void) {
  useEffect(() => {
    if (!isActive) return undefined;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onEscape();
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [isActive, onEscape]);
}
