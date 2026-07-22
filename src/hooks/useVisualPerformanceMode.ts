import { useEffect, useMemo, useState } from 'react';

export interface VisualPerformanceMode {
  /** 开启轻量化渲染（减少闪烁、降速、减弱高频动效） */
  reduceAnimations: boolean;
  /** 当前标签页在前台可见（离屏时可暂停大部分循环动画） */
  shouldAnimate: boolean;
}

function detectLowPowerHints(): boolean {
  if (typeof navigator === 'undefined') return false;

  const cores = typeof navigator.hardwareConcurrency === 'number' ? navigator.hardwareConcurrency : 8;
  const deviceMemory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const memory = typeof deviceMemory === 'number' ? deviceMemory : 16;

  return cores <= 4 || memory <= 4;
}

function detectReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * 统一的可视化降负载策略：
 * - 系统开启减动效偏好
 * - 低配置设备（CPU/内存很小）
 * - 页面未激活（隐藏标签页）
 */
export function useVisualPerformanceMode(): VisualPerformanceMode {
  const initialReduce = useMemo(
    () => detectReducedMotion() || detectLowPowerHints(),
    [],
  );

  const [reduceAnimations, setReduceAnimations] = useState(initialReduce);
  const [isVisible, setIsVisible] = useState(() =>
    typeof document === 'undefined' ? true : document.visibilityState === 'visible',
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');

    const updateReducedMotion = () => {
      setReduceAnimations(detectReducedMotion() || detectLowPowerHints());
    };

    const updateVisibility = () => {
      setIsVisible(document.visibilityState === 'visible');
    };

    updateReducedMotion();
    updateVisibility();

    if (media.addEventListener) {
      media.addEventListener('change', updateReducedMotion);
    } else {
      media.addListener(updateReducedMotion as EventListener);
    }
    document.addEventListener('visibilitychange', updateVisibility);

    return () => {
      if (media.removeEventListener) {
        media.removeEventListener('change', updateReducedMotion);
      } else {
        media.removeListener(updateReducedMotion as EventListener);
      }
      document.removeEventListener('visibilitychange', updateVisibility);
    };
  }, []);

  return {
    reduceAnimations,
    shouldAnimate: isVisible,
  };
}
