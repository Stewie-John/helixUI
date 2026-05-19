import React, { createContext, useContext, useState, useEffect } from 'react';

const ThemeContext = createContext();

export const useTheme = () => {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
};

// 主题顺序：浅色 → 深色 → 科技
const THEMES = ['light', 'dark', 'tech'];

function applyTheme(theme) {
  const root = document.documentElement;

  // 先清除所有主题类
  root.classList.remove('dark', 'tech');

  if (theme === 'dark') {
    root.classList.add('dark');
  } else if (theme === 'tech') {
    // 科技主题同时激活 dark（继承部分深色样式）和 tech
    root.classList.add('dark', 'tech');
  }

  // 更新 iOS 状态栏和 PWA 主题色
  const statusBarMeta = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
  const themeColorMeta = document.querySelector('meta[name="theme-color"]');

  if (theme === 'light') {
    statusBarMeta?.setAttribute('content', 'default');
    themeColorMeta?.setAttribute('content', '#ffffff');
  } else if (theme === 'dark') {
    statusBarMeta?.setAttribute('content', 'black-translucent');
    themeColorMeta?.setAttribute('content', '#0c1117');
  } else if (theme === 'tech') {
    statusBarMeta?.setAttribute('content', 'black-translucent');
    themeColorMeta?.setAttribute('content', '#020c18');
  }
}

export const ThemeProvider = ({ children }) => {
  const [theme, setTheme] = useState(() => {
    const saved = localStorage.getItem('theme');
    if (saved && THEMES.includes(saved)) return saved;
    // 回退到系统偏好
    if (window.matchMedia?.('(prefers-color-scheme: dark)').matches) return 'dark';
    return 'light';
  });

  // 主题变更时应用到 DOM
  useEffect(() => {
    applyTheme(theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  // 监听系统主题变化（仅在用户未手动设置时生效）
  useEffect(() => {
    if (!window.matchMedia) return;
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (e) => {
      const savedTheme = localStorage.getItem('theme');
      if (!savedTheme) {
        setTheme(e.matches ? 'dark' : 'light');
      }
    };
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  // 循环切换：light → dark → tech → light
  const cycleTheme = () => {
    setTheme(prev => {
      const idx = THEMES.indexOf(prev);
      return THEMES[(idx + 1) % THEMES.length];
    });
  };

  // 向后兼容旧 API
  const isDarkMode = theme === 'dark' || theme === 'tech';
  const toggleDarkMode = () => {
    setTheme(prev => (prev === 'light' ? 'dark' : 'light'));
  };

  return (
    <ThemeContext.Provider value={{ theme, setTheme, cycleTheme, isDarkMode, toggleDarkMode }}>
      {children}
    </ThemeContext.Provider>
  );
};
