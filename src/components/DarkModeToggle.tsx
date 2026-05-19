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

// 主题轨道背景
const TRACK_BG = {
  light: 'bg-gray-200',
  dark:  'bg-gray-700',
  tech:  'bg-cyan-950',
};

// 滑块偏移（三个位置，轨道80px，滑块24px，内边距4px）
// 左: 4px  中: 28px（居中40px - 12px）  右: 52px（80px - 4px - 24px）
const THUMB_TRANSLATE = {
  light: 'translate-x-1',   // 4px
  dark:  'translate-x-7',   // 28px
  tech:  'translate-x-13',  // 52px
};

function DarkModeToggle({ checked, onToggle, ariaLabel = 'Toggle theme' }: DarkModeToggleProps) {
  const { theme, cycleTheme, isDarkMode, toggleDarkMode } = useTheme();

  // 若外部受控（旧接口），退化为 light/dark 二值切换
  const isControlled = typeof checked === 'boolean' && typeof onToggle === 'function';

  const handleClick = () => {
    if (isControlled) {
      onToggle(!checked);
      return;
    }
    cycleTheme();
  };

  const currentTheme = isControlled ? (checked ? 'dark' : 'light') : theme;

  // 科技主题时按钮外层加霓虹光晕
  const techGlow = currentTheme === 'tech'
    ? 'ring-2 ring-cyan-500/40 shadow-[0_0_12px_rgba(0,212,255,0.35)]'
    : '';

  return (
    <button
      onClick={handleClick}
      className={`relative inline-flex h-8 w-20 items-center rounded-full transition-all duration-300 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-gray-900 ${TRACK_BG[currentTheme]} ${techGlow}`}
      role="button"
      aria-label={ariaLabel}
      title={currentTheme === 'light' ? '浅色模式' : currentTheme === 'dark' ? '深色模式' : '科技模式'}
    >
      <span className="sr-only">{ariaLabel}</span>

      {/* 三档刻度点 */}
      <span className="absolute left-[10px] h-1 w-1 rounded-full bg-white/30" />
      <span className="absolute left-[calc(50%)] h-1 w-1 rounded-full bg-white/30" />
      <span className="absolute right-[10px] h-1 w-1 rounded-full bg-white/30" />

      {/* 滑块 */}
      <span
        className={`${THUMB_TRANSLATE[currentTheme]} h-6 w-6 transform rounded-full bg-white shadow-lg transition-all duration-300 flex items-center justify-center`}
      >
        {THEME_ICONS[currentTheme]}
      </span>
    </button>
  );
}

export default DarkModeToggle;
