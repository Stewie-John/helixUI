import { Moon, Sun, Zap } from 'lucide-react';
import { useTheme } from '../contexts/ThemeContext';

type DarkModeToggleProps = {
  checked?: boolean;
  onToggle?: (nextValue: boolean) => void;
  ariaLabel?: string;
};

// 主题图标映射
const THEME_ICONS = {
  light: <Sun className="h-3.5 w-3.5 text-yellow-500" />,
  dark:  <Moon className="h-3.5 w-3.5 text-indigo-300" />,
  tech:  <Zap className="h-3.5 w-3.5 text-cyan-400" style={{ filter: 'drop-shadow(0 0 4px rgba(0,212,255,0.8))' }} />,
};

// 滑块偏移（三个位置，轨道80px，滑块24px，内边距4px）
// 左: 4px  中: 28px（居中40px - 12px）  右: 52px（80px - 4px - 24px）
const THUMB_OFFSET = {
  light: 4,
  dark: 28,
  tech: 52,
};

type ThemeName = keyof typeof THUMB_OFFSET;

function DarkModeToggle({ checked, onToggle, ariaLabel = 'Toggle theme' }: DarkModeToggleProps) {
  const { theme, cycleTheme } = useTheme();

  // 若外部受控（旧接口），退化为 light/dark 二值切换
  const isControlled = typeof checked === 'boolean' && typeof onToggle === 'function';

  const handleClick = () => {
    if (isControlled) {
      onToggle(!checked);
      return;
    }
    cycleTheme();
  };

  const currentTheme: ThemeName = isControlled ? (checked ? 'dark' : 'light') : (theme as ThemeName);

  return (
    <button
      type="button"
      onClick={handleClick}
      className="theme-mode-toggle relative inline-flex h-8 w-20 shrink-0 items-center overflow-hidden focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-900"
      data-theme={currentTheme}
      aria-label={ariaLabel}
      aria-valuetext={currentTheme}
      title={currentTheme === 'light' ? '浅色模式' : currentTheme === 'dark' ? '深色模式' : '科技模式'}
    >
      <span className="sr-only">{ariaLabel}</span>

      {/* 三档刻度点 */}
      <span className="theme-mode-tick absolute left-[10px] h-1 w-1 bg-white/30" />
      <span className="theme-mode-tick absolute left-[calc(50%)] h-1 w-1 bg-white/30" />
      <span className="theme-mode-tick absolute right-[10px] h-1 w-1 bg-white/30" />

      {/* 滑块 */}
      <span
        className="theme-mode-thumb absolute left-0 top-1 flex h-6 w-6 items-center justify-center bg-white shadow-lg"
        style={{ transform: `translateX(${THUMB_OFFSET[currentTheme]}px)` }}
      >
        {THEME_ICONS[currentTheme]}
      </span>
    </button>
  );
}

export default DarkModeToggle;
