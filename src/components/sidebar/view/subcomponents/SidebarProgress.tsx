import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useTodoProgress, type TodoItem } from '../../../../contexts/TodoProgressContext';

/* ── L 形角标（与 HUDOverlay Panel 完全一致，size=10） ─────────── */
function Corner({ pos }: { pos: 'tl' | 'tr' | 'bl' | 'br' }) {
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
  return <span style={{ ...base, ...sides[pos], filter: 'drop-shadow(0 0 4px rgba(0,217,255,0.6))' }} />;
}

/* ── 闪烁点（与 HUDOverlay Dot 完全一致） ────────────────────── */
function Dot({ color = '#00d9ff', ms = 1200 }: { color?: string; ms?: number }) {
  const [on, setOn] = useState(true);
  useEffect(() => {
    const id = setInterval(() => setOn(v => !v), ms);
    return () => clearInterval(id);
  }, [ms]);
  return (
    <span style={{
      display: 'inline-block', width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
      background: on ? color : 'transparent',
      boxShadow: on ? `0 0 8px 2px ${color}99` : 'none',
      transition: 'background 0.12s, box-shadow 0.12s',
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
function TaskRow({ todo }: { todo: TodoItem }) {
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
              style={{ animation: 'tech-blink 1.0s ease-in-out infinite',
                       filter: 'drop-shadow(0 0 4px rgba(0,217,255,0.9))' }} />
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

export default function SidebarProgress() {
  const { todos } = useTodoProgress();
  const { t } = useTranslation('sidebar');

  /* ── 最小化 ──────────────────────────────────────────────────── */
  const [minimized, setMinimized] = useState(false);

  /* ── 面板位置 ────────────────────────────────────────────────── */
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  // x=295：侧边栏（~288px）右侧留 7px 间距；y：底部留 18px 边距
  useEffect(() => { setPos({ x: 295, y: window.innerHeight - panelH - 18 }); }, []);

  /* ── 悬浮球位置 ──────────────────────────────────────────────── */
  const [ballPos, setBallPos] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (minimized && !ballPos) setBallPos({ x: 320, y: window.innerHeight - 80 });
  }, [minimized, ballPos]);

  /* ── 面板宽高（整体尺寸，含标题行） ─────────────────────────── */
  const [panelW, setPanelW] = useState(272); // 贴近左下角：与侧边栏同宽（288px 减去边距）
  const [panelH, setPanelH] = useState(160); // header 34px + 列表区 126px（约 6 条任务）

  /* ── 拖拽 refs ───────────────────────────────────────────────── */
  const panelDragRef = useRef<{ sx: number; sy: number; ix: number; iy: number } | null>(null);
  const ballDragRef  = useRef<{ sx: number; sy: number; ix: number; iy: number; moved: boolean } | null>(null);
  const resizeRef    = useRef<{ sx: number; sy: number; iw: number; ih: number } | null>(null);

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
    e.preventDefault();
    const ix = ballPos?.x ?? 14;
    const iy = ballPos?.y ?? window.innerHeight - 80;
    ballDragRef.current = { sx: e.clientX, sy: e.clientY, ix, iy, moved: false };
    const onMove = (ev: PointerEvent) => {
      if (!ballDragRef.current) return;
      const dx = ev.clientX - ballDragRef.current.sx;
      const dy = ev.clientY - ballDragRef.current.sy;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) ballDragRef.current.moved = true;
      setBallPos({
        x: Math.max(20, Math.min(window.innerWidth  - 20, ballDragRef.current.ix + dx)),
        y: Math.max(20, Math.min(window.innerHeight - 20, ballDragRef.current.iy + dy)),
      });
    };
    const onUp = () => {
      if (!ballDragRef.current?.moved) {
        setPos({ x: 295, y: window.innerHeight - panelH - 18 });
        setMinimized(false);
        setBallPos(null);
      }
      ballDragRef.current = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [ballPos]);

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

  /* 无任务时用 #6abde0（与 SYS MONITOR bar label 同色，清晰可见）
     有任务时用 #00d9ff（与 SYS MONITOR 数值同色）
     全部完成时用 #00e87a（与 SYS MONITOR 绿色进度条同色） */
  const accentColor = allDone ? '#00e87a' : hasTask ? '#00d9ff' : '#6abde0';

  /* ── 最小化悬浮球 ─────────────────────────────────────────────── */
  if (minimized && ballPos) {
    return (
      <div
        onPointerDown={handleBallDown}
        title="展开任务进度"
        style={{
          position: 'fixed',
          left: ballPos.x - 26, top: ballPos.y - 26,
          width: 52, height: 52, borderRadius: '50%',
          background: 'radial-gradient(circle at 35% 35%, rgba(0,80,130,0.95) 0%, rgba(0,18,48,0.97) 100%)',
          border: `1.5px solid ${accentColor}`,
          boxShadow: `0 0 14px ${accentColor}55, 0 2px 8px rgba(0,0,0,0.5)`,
          cursor: 'grab',
          zIndex: 200,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          touchAction: 'none', userSelect: 'none',
          animation: hasTask && !allDone ? 'tech-corner-pulse 2.5s ease-in-out infinite' : undefined,
          ...mono,
        }}
      >
        <ProgressRing pct={pct} size={30} />
        {active > 0 && (
          <span style={{
            position: 'absolute', top: 5, right: 5,
            width: 7, height: 7, borderRadius: '50%',
            background: '#00d9ff', boxShadow: '0 0 5px #00d9ff',
            animation: 'tech-blink 0.8s step-end infinite',
          }} />
        )}
      </div>
    );
  }

  /* ── 列表区实际高度 = 整体高度 - 标题行高度 ──────────────────── */
  const listH = Math.max(40, panelH - HEADER_H);

  /* ── 展开面板 ────────────────────────────────────────────────── */
  return (
    <div style={{
      position: 'fixed',
      left: pos?.x ?? 14,
      top:  pos?.y ?? window.innerHeight - 360,
      width: panelW,
      zIndex: 4,
      ...mono,
    }}>
      {/* 主面板：固定总高度 panelH，flex 列布局 */}
      <div style={{
        position: 'relative',
        height: panelH,
        display: 'flex', flexDirection: 'column',
        background: 'rgba(2,10,24,0.88)',
        border: '1.5px solid rgba(0,185,235,0.65)',
        backdropFilter: 'blur(4px)',
        padding: '0',
        overflow: 'hidden',
      }}>
        {/* 四角 L 形角标（与 SYS MONITOR 一致） */}
        <Corner pos="tl" /><Corner pos="tr" />
        <Corner pos="bl" /><Corner pos="br" />

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
            onClick={e => { e.stopPropagation(); setMinimized(true); setBallPos({ x: 320, y: window.innerHeight - 80 }); }}
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
            <Dot color={accentColor} ms={700} />
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
                <TaskRow todo={todo} />
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
    </div>
  );
}
