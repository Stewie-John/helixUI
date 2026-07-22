import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useTodoProgress, type TodoItem } from '../../../../contexts/TodoProgressContext';
import type { AppTab } from '../../../../types/app';
import { useVisualPerformanceMode } from '../../../../hooks/useVisualPerformanceMode';

/* ── L 形角标（与 HUDOverlay Panel 完全一致，size=10） ─────────── */
function Corner({ pos, animate = true }: { pos: 'tl' | 'tr' | 'bl' | 'br'; animate?: boolean }) {
  const C = '#00d9ff'; const bw = 1.5; const size = 10;
  const base: React.CSSProperties = {
    position: 'absolute', width: size, height: size,
    background: 'transparent', boxSizing: 'border-box', pointerEvents: 'none',
  };
  const sides: Record<string, React.CSSProperties> = {
    tl: { top: 0,    left: 0,  borderTop:    `${bw}px solid ${C}`, borderLeft:  `${bw}px solid ${C}` },
    tr: { top: 0,    right: 0, borderTop:    `${bw}px solid ${C}`, borderRight: `${bw}px solid ${C}` },
    bl: { bottom: 0, left: 0,  borderBottom: `${bw}px solid ${C}`, borderLeft:  `${bw}px solid ${C}` },
    br: { bottom: 0, right: 0, borderBottom: `${bw}px solid ${C}`, borderRight: `${bw}px solid ${C}` },
  };
  return <span style={{ ...base, ...sides[pos], filter: animate ? 'drop-shadow(0 0 4px rgba(0,217,255,0.6))' : 'none' }} />;
}

/* ── 闪烁点（与 HUDOverlay Dot 完全一致） ────────────────────── */
function Dot({ color = '#00d9ff', ms = 1200, animate = true }: { color?: string; ms?: number; animate?: boolean }) {
  return (
    <span style={{
      display: 'inline-block', width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
      background: color,
      boxShadow: `0 0 8px 2px ${color}99`,
      animation: animate ? `tech-blink ${ms * 2}ms step-end infinite` : undefined,
      willChange: animate ? 'opacity' : undefined,
      marginRight: 5,
    }} />
  );
}

/* ── 进度环 ───────────────────────────────────────────────────── */
function ProgressRing({ pct, size = 32 }: { pct: number; size?: number }) {
  const r    = size / 2 - 3.5;
  const circ = 2 * Math.PI * r;
  const color = pct >= 1 ? '#00e87a' : '#00d9ff';
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ flexShrink: 0 }}>
      <circle cx={size/2} cy={size/2} r={r}
        fill="none" stroke="rgba(0,60,100,0.45)" strokeWidth="2.5" />
      <circle cx={size/2} cy={size/2} r={r}
        fill="none" stroke={color} strokeWidth="2.5"
        strokeDasharray={`${circ * pct} ${circ}`}
        strokeLinecap="round"
        transform={`rotate(-90 ${size/2} ${size/2})`}
        style={{ transition: 'stroke-dasharray 0.5s ease, stroke 0.4s',
                 filter: `drop-shadow(0 0 3px ${color}99)` }}
      />
      <text x={size/2} y={size/2} dominantBaseline="central" textAnchor="middle"
        fontSize={size < 30 ? 7 : 8.5} fontFamily="'Courier New',monospace"
        fill={color} style={{ textShadow: `0 0 6px ${color}` }}>
        {Math.round(pct * 100)}%
      </text>
    </svg>
  );
}

/* ── 单条任务行 ────────────────────────────────────────────────── */
function TaskRow({ todo, animate = true }: { todo: TodoItem; animate?: boolean }) {
  const isDone   = todo.status === 'completed';
  const isActive = todo.status === 'in_progress';

  /* 颜色全部对齐 HUDOverlay 亮度标准 */
  const textColor = isDone
    ? 'rgba(100,190,140,0.75)'   // 完成：绿色略淡
    : isActive
      ? '#00d9ff'                 // 进行中：与 HUD 数值同色
      : 'rgba(185,230,255,0.88)'; // 待定：与 HUD 进程名同色

  const textShadow = isDone
    ? 'none'
    : isActive
      ? '0 0 10px rgba(0,217,255,0.6)'
      : '0 0 5px rgba(0,200,255,0.20)';

  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 8,
      padding: '5px 0',
      opacity: isDone ? 0.60 : 1,
    }}>
      {/* 状态图标 */}
      <div style={{ flexShrink: 0, marginTop: 2 }}>
        {isDone ? (
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
            <circle cx="6.5" cy="6.5" r="6" stroke="rgba(0,200,120,0.80)" strokeWidth="1" />
            <circle cx="6.5" cy="6.5" r="3"  fill="rgba(0,200,120,0.80)" />
            <path d="M4 6.5l1.6 1.6 2.8-3.2" stroke="#00e87a" strokeWidth="1.2"
              strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : isActive ? (
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
            <circle cx="6.5" cy="6.5" r="6" stroke="#00d9ff" strokeWidth="1"
              style={{ filter: 'drop-shadow(0 0 3px rgba(0,217,255,0.7))' }} />
            <circle cx="6.5" cy="6.5" r="2.5" fill="#00d9ff"
              style={{
                animation: animate ? 'tech-blink 1.0s ease-in-out infinite' : undefined,
                filter: 'drop-shadow(0 0 4px rgba(0,217,255,0.9))',
              }} />
          </svg>
        ) : (
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
            <circle cx="6.5" cy="6.5" r="6" stroke="rgba(100,170,220,0.60)" strokeWidth="1" />
          </svg>
        )}
      </div>

      {/* 文字 */}
      <span style={{
        fontSize: 11, lineHeight: 1.45,
        fontFamily: 'system-ui, -apple-system, sans-serif',
        color: textColor,
        textShadow,
        textDecoration: isDone ? 'line-through' : 'none',
        textDecorationColor: 'rgba(80,160,100,0.55)',
        wordBreak: 'break-word',
        fontWeight: isActive ? 600 : 400,
      }}>
        {todo.content}
      </span>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   主面板
══════════════════════════════════════════════════════════════ */
const HEADER_H = 34; // 标题行固定高度（px，扁平化）
const mono: React.CSSProperties = { fontFamily: "'Courier New', Consolas, monospace" };
const BALL_SIZE = 52;
const BALL_MIN_MOVE = 2;
const BALL_MIN_MARGIN = 20;
const BALL_RIGHT_MARGIN = 18;
const BALL_STATUS_GAP = 18;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

type HudPanelRect = { left: number; right: number; top: number; bottom: number; width: number; height: number };

export default function SidebarProgress({ activeTab, docked = false }: { activeTab?: AppTab; docked?: boolean }) {
  const { todos } = useTodoProgress();
  const { t } = useTranslation('sidebar');
  const isShellTab = activeTab === 'shell' || activeTab === 'terminal';

  /* ── 最小化 ──────────────────────────────────────────────────── */
  const [minimized, setMinimized] = useState(isShellTab);
  const minimizedByShellRef = useRef(isShellTab);
  const shellManuallyExpandedRef = useRef(false);

  /* ── 面板位置 ────────────────────────────────────────────────── */
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  /* ── 悬浮球位置 ──────────────────────────────────────────────── */
  const [ballPos, setBallPos] = useState<{ x: number; y: number } | null>(null);

  /* ── HUD Overlay 面板位置信息（用于把悬浮球锚定到右下状态栏上方） ─── */

  /* ── 面板宽高（整体尺寸，含标题行） ─────────────────────────── */
  const [panelW, setPanelW] = useState(272); // 贴近左下角：与侧边栏同宽（288px 减去边距）
  const [panelH, setPanelH] = useState(160); // header 34px + 列表区 126px（约 6 条任务）
  const { reduceAnimations } = useVisualPerformanceMode();
  const animationEnabled = !reduceAnimations;

  const hudPanelRectRef = useRef<HudPanelRect | null>(null);

  const resolveHudRect = useCallback((): HudPanelRect | null => {
    if (hudPanelRectRef.current) return hudPanelRectRef.current;
    if (typeof window === 'undefined') return null;
    const panel = document.querySelector<HTMLElement>('[data-hud-panel]');
    if (!panel) return null;
    const r = panel.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
  }, []);

  const getSidebarRight = useCallback(() => {
    const sidebar = document.querySelector<HTMLElement>('[data-sidebar-content]');
    return Math.round(sidebar?.getBoundingClientRect().right ?? 384);
  }, []);

  const getDefaultPanelPos = useCallback(() => ({
    x: getSidebarRight() + 8,
    y: window.innerHeight - panelH - 18,
  }), [getSidebarRight, panelH]);

  const getDefaultBallPos = useCallback(() => {
    const hudRect = resolveHudRect();
    const preferredX = window.innerWidth - BALL_RIGHT_MARGIN - BALL_SIZE / 2;
    const preferredY = hudRect?.height && hudRect.height > 0
      ? hudRect.top - BALL_SIZE / 2 - BALL_STATUS_GAP
      : window.innerHeight - BALL_MIN_MARGIN - BALL_SIZE / 2 - BALL_STATUS_GAP;

    return {
      x: clamp(
        preferredX,
        BALL_MIN_MARGIN + BALL_SIZE / 2,
        window.innerWidth - BALL_MIN_MARGIN - BALL_SIZE / 2,
      ),
      y: clamp(
        preferredY,
        BALL_MIN_MARGIN + BALL_SIZE / 2,
        window.innerHeight - BALL_MIN_MARGIN - BALL_SIZE / 2,
      ),
    };
  }, [resolveHudRect]);

  const clampBallPos = useCallback((x: number, y: number) => ({
    x: clamp(x, BALL_MIN_MARGIN + BALL_SIZE / 2, window.innerWidth - BALL_MIN_MARGIN - BALL_SIZE / 2),
    y: clamp(y, BALL_MIN_MARGIN + BALL_SIZE / 2, window.innerHeight - BALL_MIN_MARGIN - BALL_SIZE / 2),
  }), []);

  useEffect(() => {
    const handleHudPanelPos = (e: Event) => {
      const detail = (e as CustomEvent<HudPanelRect | null>).detail;
      const detailRect = detail ?? resolveHudRect();
      hudPanelRectRef.current = detailRect;
      if (isBallAutoPositionedRef.current && minimized) {
        setBallPos(getDefaultBallPos());
      }
    };

    window.addEventListener('hud-panel-pos', handleHudPanelPos);
    return () => window.removeEventListener('hud-panel-pos', handleHudPanelPos);
  }, [getDefaultBallPos, minimized]);

  useEffect(() => {
    if (isShellTab) {
      if (!shellManuallyExpandedRef.current) {
        minimizedByShellRef.current = true;
        isBallAutoPositionedRef.current = true;
        setMinimized(true);
        setBallPos((prev) => {
          if (isBallAutoPositionedRef.current || !prev) return getDefaultBallPos();
          return prev;
        });
      }
      return;
    }

    shellManuallyExpandedRef.current = false;
    if (minimizedByShellRef.current) {
      minimizedByShellRef.current = false;
      setMinimized(false);
      setBallPos(null);
    }
  }, [isShellTab, getDefaultBallPos]);

  useEffect(() => {
    const syncDefaultPosition = () => {
      setPos((prev) => {
        const minX = getSidebarRight() + 8;
        if (!prev) return getDefaultPanelPos();
        return {
          x: Math.max(minX, Math.min(window.innerWidth - 60, prev.x)),
          y: Math.max(0, Math.min(window.innerHeight - 60, prev.y)),
        };
      });
    };

    syncDefaultPosition();
    window.addEventListener('resize', syncDefaultPosition);
    return () => window.removeEventListener('resize', syncDefaultPosition);
  }, [getDefaultPanelPos, getSidebarRight]);

  useEffect(() => {
    if (!minimized) return;
    const next = getDefaultBallPos();
    setBallPos((prev) => {
      if (!prev || isBallAutoPositionedRef.current) {
        return (prev && prev.x === next.x && prev.y === next.y) ? prev : next;
      }
      return prev;
    });
  }, [minimized, getDefaultBallPos]);

  /* ── 拖拽 refs ───────────────────────────────────────────────── */
  const panelDragRef = useRef<{ sx: number; sy: number; ix: number; iy: number } | null>(null);
  const ballDragRef  = useRef<{ sx: number; sy: number; ix: number; iy: number; moved: boolean } | null>(null);
  const lastBallDragMovedRef = useRef(false);
  const resizeRef    = useRef<{ sx: number; sy: number; iw: number; ih: number } | null>(null);
  const isBallAutoPositionedRef = useRef(true);

  const expandFromBall = useCallback(() => {
    if (isShellTab) {
      shellManuallyExpandedRef.current = true;
      minimizedByShellRef.current = false;
    }
    isBallAutoPositionedRef.current = false;
    setPos(getDefaultPanelPos());
    setMinimized(false);
    setBallPos(null);
  }, [isShellTab, getDefaultPanelPos]);

  /* ── 面板拖拽 ────────────────────────────────────────────────── */
  const handlePanelDragDown = useCallback((e: React.PointerEvent) => {
    if ((e as any).button !== 0) return;
    e.preventDefault();
    const ix = pos?.x ?? 8;
    const iy = pos?.y ?? window.innerHeight - panelH - 100;
    panelDragRef.current = { sx: e.clientX, sy: e.clientY, ix, iy };
    const onMove = (ev: PointerEvent) => {
      if (!panelDragRef.current) return;
      const { sx, sy, ix, iy } = panelDragRef.current;
      setPos({
        x: Math.max(0, Math.min(window.innerWidth  - 60, ix + ev.clientX - sx)),
        y: Math.max(0, Math.min(window.innerHeight - 60, iy + ev.clientY - sy)),
      });
    };
    const onUp = () => {
      panelDragRef.current = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [pos]);

  /* ── 悬浮球拖拽 ──────────────────────────────────────────────── */
  const handleBallDown = useCallback((e: React.PointerEvent) => {
    if (ballDragRef.current) return;
    if (e.pointerType === 'mouse' && (e as React.MouseEvent).button !== 0) return;
    if (e.pointerType === 'mouse') {
      e.preventDefault();
    }
    e.stopPropagation();
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch { /* ignore */ }

    const defaultPos = getDefaultBallPos();
    const ix = ballPos?.x ?? defaultPos.x;
    const iy = ballPos?.y ?? defaultPos.y;
    ballDragRef.current = { sx: e.clientX, sy: e.clientY, ix, iy, moved: false };

    const onMove = (ev: PointerEvent) => {
      if (!ballDragRef.current) return;
      const dx = ev.clientX - ballDragRef.current.sx;
      const dy = ev.clientY - ballDragRef.current.sy;
      if (Math.abs(dx) > BALL_MIN_MOVE || Math.abs(dy) > BALL_MIN_MOVE) {
        if (!ballDragRef.current.moved) ballDragRef.current.moved = true;
        isBallAutoPositionedRef.current = false;
      }
      setBallPos(clampBallPos(ballDragRef.current.ix + dx, ballDragRef.current.iy + dy));
    };

    const onUp = () => {
      const moved = ballDragRef.current?.moved ?? false;
      lastBallDragMovedRef.current = moved;
      ballDragRef.current = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);

      if (!moved) {
        isBallAutoPositionedRef.current = true;
        expandFromBall();
      }
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }, [ballPos, clampBallPos, expandFromBall, getDefaultBallPos]);

  /* ── 宽高同时缩放 ────────────────────────────────────────────── */
  const handleResizeDown = useCallback((e: React.PointerEvent) => {
    e.stopPropagation(); e.preventDefault();
    resizeRef.current = { sx: e.clientX, sy: e.clientY, iw: panelW, ih: panelH };
    const onMove = (ev: PointerEvent) => {
      if (!resizeRef.current) return;
      setPanelW(Math.max(180, resizeRef.current.iw + ev.clientX - resizeRef.current.sx));
      setPanelH(Math.max(100, resizeRef.current.ih + ev.clientY - resizeRef.current.sy));
    };
    const onUp = () => {
      resizeRef.current = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [panelW, panelH]);

  /* ── 统计 ────────────────────────────────────────────────────── */
  const done    = todos.filter(t => t.status === 'completed').length;
  const active  = todos.filter(t => t.status === 'in_progress').length;
  const pct     = todos.length > 0 ? done / todos.length : 0;
  const allDone = todos.length > 0 && done === todos.length;
  const hasTask = todos.length > 0;

  const displayBallPos = minimized ? (ballPos ?? getDefaultBallPos()) : null;

  /* 无任务时用 #6abde0（与 SYS MONITOR bar label 同色，清晰可见）
     有任务时用 #00d9ff（与 SYS MONITOR 数值同色）
     全部完成时用 #00e87a（与 SYS MONITOR 绿色进度条同色） */
  const accentColor = allDone ? '#00e87a' : hasTask ? '#00d9ff' : '#6abde0';

  if (docked) {
    return (
      <aside
        className="hidden lg:flex shrink-0 border-r border-cyan-400/15 bg-background/45 backdrop-blur-sm"
        style={{
          width: 'clamp(176px, 14vw, 260px)',
          minWidth: 176,
          maxWidth: 260,
          padding: '0 8px',
          boxSizing: 'border-box',
          ...mono,
        }}
      >
        <div
          style={{
            position: 'relative',
            width: '100%',
            height: panelH,
            display: 'flex',
            flexDirection: 'column',
            background: 'rgba(2,10,24,0.58)',
            borderLeft: '1px solid rgba(0,185,235,0.16)',
            borderRight: '1px solid rgba(0,185,235,0.18)',
            overflow: 'hidden',
          }}
        >
          <Corner pos="tl" animate={animationEnabled} />
          <Corner pos="tr" animate={animationEnabled} />
          <Corner pos="bl" animate={animationEnabled} />
          <Corner pos="br" animate={animationEnabled} />

          <div
            style={{
              height: HEADER_H,
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
              padding: '0 10px',
              borderBottom: '1px solid rgba(0,160,210,0.20)',
              userSelect: 'none',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>
              <Dot color={accentColor} ms={700} animate={animationEnabled} />
              <span
                style={{
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontSize: 9.5,
                  letterSpacing: '0.16em',
                  fontWeight: 700,
                  color: accentColor,
                  textShadow: `0 0 8px ${accentColor}`,
                }}
              >
                {allDone ? t('progress.complete') : t('progress.label')}
              </span>
            </div>

            {hasTask && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                <ProgressRing pct={pct} size={28} />
                <span style={{ fontSize: 9.5, color: '#00d9ff', fontWeight: 700 }}>
                  {done}/{todos.length}
                </span>
              </div>
            )}
          </div>

          <div
            style={{
              flex: 1,
              overflowY: 'auto',
              scrollbarWidth: 'thin',
              padding: '6px 10px 14px',
            }}
          >
            {hasTask ? (
              todos.map((todo, i) => (
                <div
                  key={todo.id ?? i}
                  style={{ borderBottom: i < todos.length - 1 ? '1px solid rgba(0,100,150,0.14)' : 'none' }}
                >
                  <TaskRow todo={todo} animate={animationEnabled} />
                </div>
              ))
            ) : (
              <div
                style={{
                  paddingTop: 10,
                  fontSize: 10,
                  color: '#6abde0',
                  letterSpacing: '0.08em',
                  lineHeight: 1.7,
                }}
              >
                {t('progress.waiting')}
                <br />
                <span style={{ fontSize: 9, color: 'rgba(100,170,220,0.50)' }}>
                  {t('progress.hint')}
                </span>
              </div>
            )}
          </div>
        </div>
      </aside>
    );
  }

  /* ── 最小化悬浮球 ─────────────────────────────────────────────── */
  if (displayBallPos) {
    if (typeof document === 'undefined') {
      return null;
    }

    return createPortal(
      <div
        onPointerDown={handleBallDown}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (lastBallDragMovedRef.current) {
            lastBallDragMovedRef.current = false;
            return;
          }
          isBallAutoPositionedRef.current = true;
          expandFromBall();
        }}
        title="展开任务进度"
        style={{
          position: 'fixed',
          left: displayBallPos.x - BALL_SIZE / 2, top: displayBallPos.y - BALL_SIZE / 2,
          width: BALL_SIZE, height: BALL_SIZE, borderRadius: '50%',
          background: 'radial-gradient(circle at 35% 35%, rgba(0,80,130,0.95) 0%, rgba(0,18,48,0.97) 100%)',
          border: `1.5px solid ${accentColor}`,
          boxShadow: `0 0 14px ${accentColor}55, 0 2px 8px rgba(0,0,0,0.5)`,
          cursor: 'grab',
          zIndex: 10000,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          touchAction: 'none', userSelect: 'none',
          animation: animationEnabled && hasTask && !allDone
            ? 'tech-corner-pulse 2.5s ease-in-out infinite'
            : undefined,
          ...mono,
        }}
      >
        <ProgressRing pct={pct} size={30} />
        {active > 0 && (
          <span style={{
            position: 'absolute', top: 5, right: 5,
            width: 7, height: 7, borderRadius: '50%',
            background: '#00d9ff', boxShadow: '0 0 5px #00d9ff',
            animation: animationEnabled ? 'tech-blink 0.8s step-end infinite' : undefined,
          }} />
        )}
      </div>,
      document.body,
    );
  }

  /* ── 列表区实际高度 = 整体高度 - 标题行高度 ──────────────────── */
  const listH = Math.max(40, panelH - HEADER_H);

  /* ── 展开面板 ────────────────────────────────────────────────── */
  if (typeof document === 'undefined') {
    return null;
  }

  return createPortal(
    <div style={{
      position: 'fixed',
      left: pos?.x ?? 14,
      top:  pos?.y ?? window.innerHeight - 360,
      width: panelW,
      zIndex: 9999,
      ...mono,
    }}>
      {/* 主面板：固定总高度 panelH，flex 列布局 */}
      <div style={{
        position: 'relative',
        height: panelH,
        display: 'flex', flexDirection: 'column',
        background: 'rgba(2,10,24,0.88)',
        border: '1.5px solid rgba(0,185,235,0.65)',
        contain: 'layout style',
        padding: '0',
        overflow: 'hidden',
      }}>
        {/* 四角 L 形角标（与 SYS MONITOR 一致） */}
        <Corner pos="tl" animate={animationEnabled} />
        <Corner pos="tr" animate={animationEnabled} />
        <Corner pos="bl" animate={animationEnabled} />
        <Corner pos="br" animate={animationEnabled} />

        {/* ── 标题行（拖拽把手，固定高度） ─────────────────────── */}
        <div
          onPointerDown={handlePanelDragDown}
          style={{
            flexShrink: 0,
            height: HEADER_H,
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '0 10px 0 10px',
            borderBottom: '1px solid rgba(0,160,210,0.20)',
            cursor: 'grab', userSelect: 'none', touchAction: 'none',
          }}
        >
          {/* 左：macOS 风格最小化圆点（亮蓝，内含 − 图标） */}
          <button
            className="tech-minimize-btn"
          onClick={e => {
            e.stopPropagation();
            minimizedByShellRef.current = false;
            isBallAutoPositionedRef.current = true;
            setMinimized(true);
            setBallPos(getDefaultBallPos());
          }}
            title={t('progress.minimize')}
            style={{
              flexShrink: 0,
              width: 10, height: 10, borderRadius: '50%',
              background: 'rgba(0,110,125,1)',
              border: '1.5px solid rgba(59,117,125,0.80)',
              boxShadow: '0 0 4px rgba(0,112,125,0.39)',
              cursor: 'pointer', pointerEvents: 'auto',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              transition: 'background 0.15s, box-shadow 0.15s',
              padding: 0, marginRight: 8,
            }}
            onMouseEnter={e => {
              const el = e.currentTarget as HTMLElement;
              el.style.background = 'rgba(0,120,125,1)';
              el.style.boxShadow = '0 0 7px rgba(0,118,125,0.55)';
            }}
            onMouseLeave={e => {
              const el = e.currentTarget as HTMLElement;
              el.style.background = 'rgba(0,110,125,1)';
              el.style.boxShadow = '0 0 4px rgba(0,112,125,0.39)';
            }}
          >
            <svg width="5" height="1.5" viewBox="0 0 5 1.5" style={{ opacity: 0.85 }}>
              <rect x="0" y="0" width="5" height="1.5" rx="0.75" fill="rgba(0,30,60,0.9)" />
            </svg>
          </button>

          {/* 状态点 + 标题 */}
          <div style={{ display: 'flex', alignItems: 'center', flex: 1 }}>
            <Dot color={accentColor} ms={700} animate={animationEnabled} />
            <span style={{
              fontSize: 9.5, letterSpacing: '0.20em', fontWeight: 700,
              color: accentColor,
              textShadow: `0 0 8px ${accentColor}`,
            }}>
              {allDone ? t('progress.complete') : t('progress.label')}
            </span>
          </div>

          {/* 右：进度环 + 计数 */}
          {hasTask && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <ProgressRing pct={pct} size={32} />
              <span style={{
                fontSize: 9.5, color: '#00d9ff', fontWeight: 700,
                textShadow: '0 0 7px rgba(0,217,255,0.5)',
              }}>
                {done}/{todos.length}
              </span>
            </div>
          )}
        </div>

        {/* ── 任务列表（占满剩余高度，可滚动） ─────────────────── */}
        <div style={{
          flex: 1,
          height: listH,
          overflowY: 'auto',
          scrollbarWidth: 'none',
          padding: '4px 10px 18px',
        }}>
          {hasTask ? (
            todos.map((todo, i) => (
              <div key={todo.id ?? i}
                style={{ borderBottom: i < todos.length - 1 ? '1px solid rgba(0,100,150,0.14)' : 'none' }}>
                <TaskRow todo={todo} animate={animationEnabled} />
              </div>
            ))
          ) : (
            <div style={{
              paddingTop: 10,
              fontSize: 10, color: '#6abde0',   /* 与 HUDOverlay bar label 同色 */
              letterSpacing: '0.08em', lineHeight: 1.7,
            }}>
              {t('progress.waiting')}
              <br />
              <span style={{ fontSize: 9, color: 'rgba(100,170,220,0.50)' }}>
                {t('progress.hint')}
              </span>
            </div>
          )}
        </div>

          {/* ── 右下角缩放手柄（宽 + 高同时） ───────────────────── */}
        <div
          onPointerDown={handleResizeDown}
          title="拖拽调整大小"
          style={{
            position: 'absolute', bottom: 2, right: 2,
            width: 14, height: 14, cursor: 'nwse-resize',
            pointerEvents: 'auto', touchAction: 'none',
            display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-end',
            opacity: 0.40,
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.opacity = '0.90'; }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.opacity = '0.40'; }}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <path d="M9 1L1 9M6 1L1 6M9 4L4 9"
              stroke="rgba(0,200,255,0.8)" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
        </div>
      </div>
    </div>,
    document.body,
  );
}
