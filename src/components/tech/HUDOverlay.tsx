import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/* ── 类型 ─────────────────────────────────────────────────────── */
interface Proc  { name: string; user: string; pct: number }
interface GpuInfo { used: number; total: number; util: number }
interface SysStats {
  ram:      { total: number; used: number; free: number; pct: number };
  cpu:      number;                    // 瞬时 CPU 利用率 %
  gpus:     GpuInfo[] | null;          // 所有 GPU（每张卡一项）
  topProcs: Proc[];
}

/* ── 北京时间（秒级更新） ──────────────────────────────────────── */
function useBeijingClock() {
  const [time, setTime] = useState('');
  useEffect(() => {
    const tick = () =>
      setTime(new Date().toLocaleTimeString('zh-CN', {
        timeZone: 'Asia/Shanghai', hour12: false,
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      }));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);
  return time;
}

/* ── 系统统计（2.5s 轮询） ─────────────────────────────────────── */
function useSysStats(interval = 2500) {
  const [stats, setStats] = useState<SysStats | null>(null);
  const ref = useRef<ReturnType<typeof setInterval>>();
  useEffect(() => {
    const load = async () => {
      try {
        const r = await fetch('/api/sys-stats');
        if (r.ok) setStats(await r.json());
      } catch (_) {}
    };
    load();
    ref.current = setInterval(load, interval);
    return () => clearInterval(ref.current);
  }, [interval]);
  return stats;
}

/* ── 工具：字节 → GB ────────────────────────────────────────────── */
const toGB = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);

/* ── 进度条颜色 ─────────────────────────────────────────────────── */
function barGradient(pct: number) {
  if (pct < 50) return 'linear-gradient(90deg, #00e87a 0%, #00d9ff 100%)';
  if (pct < 75) return 'linear-gradient(90deg, #00d9ff 0%, #ffd600 100%)';
  return  'linear-gradient(90deg, #ffd600 0%, #ff4444 100%)';
}
function glowColor(pct: number) {
  if (pct < 50) return 'rgba(0,230,120,0.45)';
  if (pct < 75) return 'rgba(0,210,255,0.45)';
  return 'rgba(255,80,80,0.5)';
}

/* ── 仪表盘颜色工具（绿→青→黄→红，与 TokenUsagePie 同款） ──────── */
interface RGB { r: number; g: number; b: number; }
function lerp(a: number, b: number, t: number) { return Math.round(a + (b - a) * t); }
function getGaugeColor(pct: number): RGB {
  const stops = [
    { p: 0,   r: 0,   g: 232, b: 122 },
    { p: 33,  r: 0,   g: 217, b: 255 },
    { p: 66,  r: 255, g: 214, b: 0   },
    { p: 100, r: 255, g: 68,  b: 68  },
  ];
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i], b = stops[i + 1];
    if (pct <= b.p) {
      const t = (pct - a.p) / (b.p - a.p);
      return { r: lerp(a.r, b.r, t), g: lerp(a.g, b.g, t), b: lerp(a.b, b.b, t) };
    }
  }
  return { r: 255, g: 68, b: 68 };
}
function rgbStr(c: RGB, alpha = 1) {
  return alpha < 1 ? `rgba(${c.r},${c.g},${c.b},${alpha})` : `rgb(${c.r},${c.g},${c.b})`;
}
function lightenColor(c: RGB, amount: number): RGB {
  return {
    r: Math.min(255, Math.round(c.r + (255 - c.r) * amount)),
    g: Math.min(255, Math.round(c.g + (255 - c.g) * amount)),
    b: Math.min(255, Math.round(c.b + (255 - c.b) * amount)),
  };
}

/* ── 迷你仪表盘（用于 GPU UTIL / VRAM 各卡） ─────────────────────── */
function MiniGauge({ pct, label }: { pct: number; label?: string }) {
  // 用 ref 记录上一帧角度，用 state 驱动动画帧（平滑指针过渡）
  const [displayPct, setDisplayPct] = useState(pct);
  const animRef = useRef<number | null>(null);
  const fromRef = useRef(pct);

  useEffect(() => {
    const target = pct;
    const start  = fromRef.current;
    if (Math.abs(target - start) < 0.5) { setDisplayPct(target); return; }
    const startTime = performance.now();
    const duration  = 700; // ms，平滑过渡时长

    const step = (now: number) => {
      const t = Math.min((now - startTime) / duration, 1);
      // ease-out cubic
      const ease = 1 - Math.pow(1 - t, 3);
      const cur  = start + (target - start) * ease;
      setDisplayPct(cur);
      if (t < 1) {
        animRef.current = requestAnimationFrame(step);
      } else {
        fromRef.current = target;
      }
    };
    if (animRef.current !== null) cancelAnimationFrame(animRef.current);
    animRef.current = requestAnimationFrame(step);
    return () => { if (animRef.current !== null) cancelAnimationFrame(animRef.current); };
  }, [pct]);

  // 半圆仪表盘：cx=19 cy=19 r=14，viewBox 38×22
  const cx = 19, cy = 19, r = 14;

  const arcPath = (p1: number, p2: number) => {
    const a1 = Math.PI * (1 - p1 / 100);
    const a2 = Math.PI * (1 - p2 / 100);
    const x1 = cx + r * Math.cos(a1), y1 = cy - r * Math.sin(a1);
    const x2 = cx + r * Math.cos(a2), y2 = cy - r * Math.sin(a2);
    return `M${x1.toFixed(2)} ${y1.toFixed(2)} A${r} ${r} 0 0 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
  };

  // 背景弧（全量程，低透明度渐变色）
  const bgSegs = Array.from({ length: 20 }, (_, i) => ({
    d: arcPath(i * 5, i * 5 + 5),
    color: rgbStr(getGaugeColor(i * 5 + 2.5), 0.18),
  }));

  // 前景弧（已使用量，亮色，基于 displayPct 实时渲染）
  const fgSegs: { d: string; color: string }[] = [];
  for (let p = 0; p < displayPct; p += 2) {
    const p2 = Math.min(p + 2, displayPct);
    fgSegs.push({ d: arcPath(p, p2), color: rgbStr(getGaugeColor((p + p2) / 2)) });
  }

  // 刻度线：0/20/40/60/80/100 为长线，每5%一条短线
  const ticks = Array.from({ length: 21 }, (_, i) => {
    const p = i * 5;
    const isMajor = p % 20 === 0;
    const angle = Math.PI * (1 - p / 100);
    const rOut = r;
    const rIn  = isMajor ? r - 4.5 : r - 2.2;
    return {
      x1: (cx + rOut * Math.cos(angle)).toFixed(2),
      y1: (cy - rOut * Math.sin(angle)).toFixed(2),
      x2: (cx + rIn  * Math.cos(angle)).toFixed(2),
      y2: (cy - rIn  * Math.sin(angle)).toFixed(2),
      color: rgbStr(getGaugeColor(p), isMajor ? 0.80 : 0.38),
      width: isMajor ? '1.3' : '0.65',
    };
  });

  // 指针：基于 displayPct，稍微超出弧面 2.5px
  const needleAngle = Math.PI * (1 - displayPct / 100);
  const needleLen   = r + 2.5;
  const nx = (cx + needleLen * Math.cos(needleAngle)).toFixed(2);
  const ny = (cy - needleLen * Math.sin(needleAngle)).toFixed(2);

  const curColor    = getGaugeColor(Math.round(displayPct));
  const needleColor = lightenColor(curColor, 0.42);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
      {label && (
        <span style={{ color: 'rgba(160,220,255,0.92)', fontSize: 8.5, fontWeight: 700, letterSpacing: '0.04em', textShadow: '0 0 5px rgba(0,200,255,0.4)' }}>
          {label}
        </span>
      )}
      {/* overflow:visible 让超出弧面的指针尖端可见 */}
      <svg width="100%" viewBox="0 0 38 22" style={{ overflow: 'visible' }}>
        {bgSegs.map((s, i) => (
          <path key={`bg${i}`} d={s.d} fill="none" stroke={s.color} strokeWidth="2.5" strokeLinecap="butt" />
        ))}
        {fgSegs.map((s, i) => (
          <path key={`fg${i}`} d={s.d} fill="none" stroke={s.color} strokeWidth="2.5" strokeLinecap="butt" />
        ))}
        {ticks.map((t, i) => (
          <line key={`tk${i}`} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2}
            stroke={t.color} strokeWidth={t.width} strokeLinecap="round" />
        ))}
        <line x1={cx} y1={cy} x2={nx} y2={ny}
          stroke={rgbStr(needleColor)} strokeWidth="1.5" strokeLinecap="round" />
        <circle cx={cx} cy={cy} r="1.5" fill={rgbStr(curColor)} />
      </svg>
      <span style={{
        color: rgbStr(curColor),
        fontSize: 9.5, fontWeight: 700,
        textShadow: `0 0 5px ${rgbStr(curColor, 0.6)}`,
      }}>{Math.round(displayPct)}%</span>
    </div>
  );
}

/* ── 彩色进度条 ─────────────────────────────────────────────────── */
function Bar({ pct, label, sub }: { pct: number; label: string; sub?: string }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 3 }}>
        <span style={{ color: '#6abde0', fontSize: 10, letterSpacing: '0.1em', fontWeight: 600 }}>{label}</span>
        <span style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
          <span style={{
            color: '#00d9ff', fontSize: 11, fontWeight: 700,
            textShadow: '0 0 8px rgba(0,217,255,0.7)',
          }}>{pct.toFixed(1)}%</span>
          {sub && <span style={{ color: '#4a9fc8', fontWeight: 400, fontSize: 9 }}>{sub}</span>}
        </span>
      </div>
      {/* 进度轨道 */}
      <div style={{ position: 'relative', height: 7, background: 'rgba(0,60,100,0.45)', border: '1px solid rgba(0,140,190,0.22)' }}>
        <div style={{
          position: 'absolute', left: 0, top: 0, bottom: 0,
          width: `${Math.min(pct, 100)}%`,
          background: barGradient(pct),
          boxShadow: `0 0 10px ${glowColor(pct)}`,
          transition: 'width 0.7s ease',
        }} />
        {[25, 50, 75].map(v => (
          <div key={v} style={{ position: 'absolute', left: `${v}%`, top: 0, bottom: 0, width: 1, background: 'rgba(0,140,190,0.28)' }} />
        ))}
      </div>
    </div>
  );
}

/* ── 闪烁灯 ─────────────────────────────────────────────────────── */
function Dot({ color = '#00d9ff', ms = 1200 }: { color?: string; ms?: number }) {
  const [on, setOn] = useState(true);
  useEffect(() => { const id = setInterval(() => setOn(v => !v), ms); return () => clearInterval(id); }, [ms]);
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

/* ── L 形角标（确保 background: transparent） ──────────────────── */
function Corner({ pos, size = 40 }: { pos: 'tl' | 'tr' | 'bl' | 'br'; size?: number }) {
  const C = '#00d9ff';
  const bw = 2;
  const base: React.CSSProperties = {
    position: 'absolute',
    width: size, height: size,
    background: 'transparent',   // ← 关键：防止继承深色背景
    boxSizing: 'border-box',
  };
  const sides: Record<string, React.CSSProperties> = {
    tl: { top: 0,    left: 0,  borderTop:    `${bw}px solid ${C}`, borderLeft:  `${bw}px solid ${C}` },
    tr: { top: 0,    right: 0, borderTop:    `${bw}px solid ${C}`, borderRight: `${bw}px solid ${C}` },
    bl: { bottom: 0, left: 0,  borderBottom: `${bw}px solid ${C}`, borderLeft:  `${bw}px solid ${C}` },
    br: { bottom: 0, right: 0, borderBottom: `${bw}px solid ${C}`, borderRight: `${bw}px solid ${C}` },
  };
  return <span style={{ ...base, ...sides[pos], filter: 'drop-shadow(0 0 4px rgba(0,217,255,0.5))' }} />;
}

/* ── HUD 信息面板（带角标框） ─────────────────────────────────── */
function Panel({ children, w = 220, style, critical = false }: { children: React.ReactNode; w?: number; style?: React.CSSProperties; critical?: boolean }) {
  return (
    <div style={{
      position: 'relative', width: w,
      padding: '10px 13px',
      background: critical ? 'rgba(40,2,2,0.95)' : 'rgba(2,10,24,0.88)',
      border: critical ? '1px solid rgba(255,50,50,0.85)' : '1px solid rgba(0,155,205,0.28)',
      backdropFilter: 'blur(4px)',
      animation: critical ? 'hud-alert-blink 0.7s ease-in-out infinite' : undefined,
      ...style,
    }}>
      <Corner pos="tl" size={10} />
      <Corner pos="tr" size={10} />
      <Corner pos="bl" size={10} />
      <Corner pos="br" size={10} />
      {children}
    </div>
  );
}

/* ── 随机数据流 ─────────────────────────────────────────────────── */
function Stream() {
  const [d, setD] = useState('');
  useEffect(() => {
    const gen = () => Array.from({ length: 20 }, () =>
      Math.random() > 0.5 ? String(Math.floor(Math.random() * 10))
        : String.fromCharCode(0x41 + Math.floor(Math.random() * 6))
    ).join('');
    setD(gen());
    const id = setInterval(() => setD(gen()), 600);
    return () => clearInterval(id);
  }, []);
  return <div style={{ fontFamily: 'monospace', fontSize: 8, color: 'rgba(0,210,255,0.60)', letterSpacing: '0.1em', marginTop: 6, userSelect: 'none' }}>{d}</div>;
}

const mono: React.CSSProperties = { fontFamily: "'Courier New', Consolas, monospace" };

/* ════════════════════════════════════════════════════════════════
   主组件
   ════════════════════════════════════════════════════════════════ */
export default function HUDOverlay({ sessionName }: { sessionName?: string }) {
  const clock = useBeijingClock();
  const stats = useSysStats(2500);
  const date  = new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });

  // 面板收起 / 展开
  const [isMinimized, setIsMinimized] = useState(false);

  // 悬浮球位置（初始右下角，safe for SSR）
  const [ballPos, setBallPos] = useState<{ x: number; y: number } | null>(null);
  const dragRef = useRef({ dragging: false, startX: 0, startY: 0, origX: 0, origY: 0, moved: false });

  useEffect(() => {
    // 客户端初始化悬浮球默认位置
    setBallPos({ x: window.innerWidth - 40, y: window.innerHeight - 80 });
  }, []);

  const handleMinimize = useCallback(() => {
    setBallPos({ x: window.innerWidth - 40, y: window.innerHeight - 80 });
    setIsMinimized(true);
  }, []);

  const handleBallPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const pos = ballPos ?? { x: window.innerWidth - 40, y: window.innerHeight - 80 };
    dragRef.current = { dragging: true, startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y, moved: false };

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - dragRef.current.startX;
      const dy = ev.clientY - dragRef.current.startY;
      if (Math.abs(dx) > 5 || Math.abs(dy) > 5) dragRef.current.moved = true;
      setBallPos({
        x: Math.max(28, Math.min(window.innerWidth  - 28, dragRef.current.origX + dx)),
        y: Math.max(28, Math.min(window.innerHeight - 28, dragRef.current.origY + dy)),
      });
    };
    const onUp = () => {
      if (!dragRef.current.moved) setIsMinimized(false);
      dragRef.current.dragging = false;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [ballPos]);


  // ── 面板拖拽 & 缩放状态 ─────────────────────────────────────────
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelPos, setPanelPos] = useState<{ left: number; top: number } | null>(null);
  const [panelW, setPanelW] = useState(234);
  const [panelH, setPanelH] = useState<number | null>(null);
  const panelDragRef = useRef<{ sx: number; sy: number; il: number; it: number } | null>(null);
  const panelResizeRef = useRef<{ sx: number; sy: number; iw: number; ih: number } | null>(null);

  const handlePanelDragDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    // 左键或触摸
    if ('button' in e && e.button !== 0) return;
    e.preventDefault();
    const rect = panelRef.current?.getBoundingClientRect();
    const il = rect?.left ?? window.innerWidth - panelW - 16;
    const it = rect?.top  ?? window.innerHeight - 420;
    // 立即固定位置，防止跳动
    setPanelPos({ left: il, top: it });
    panelDragRef.current = { sx: e.clientX, sy: e.clientY, il, it };

    const onMove = (ev: PointerEvent) => {
      if (!panelDragRef.current) return;
      const { sx, sy, il, it } = panelDragRef.current;
      setPanelPos({
        left: Math.max(0, Math.min(window.innerWidth  - 60, il + ev.clientX - sx)),
        top:  Math.max(0, Math.min(window.innerHeight - 60, it + ev.clientY - sy)),
      });
    };
    const onUp = () => {
      panelDragRef.current = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [panelW]);


  // 面板位置/大小/收起状态变化后，广播面板的真实视口坐标
  // 用 useEffect（而非 useLayoutEffect）：DOM 已绘制，panelRef.current 有效，getBoundingClientRect 可靠
  // React 子组件 effect 先于父组件执行，因此 setTimeout(0) 补发保证 AppContent 监听器已注册后能收到
  useEffect(() => {
    const broadcast = () => {
      if (isMinimized || !panelRef.current) {
        window.dispatchEvent(new CustomEvent('hud-panel-pos', { detail: null }));
        return;
      }
      const r = panelRef.current.getBoundingClientRect();
      window.dispatchEvent(new CustomEvent('hud-panel-pos', {
        detail: { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height },
      }));
    };
    broadcast();
    // 延迟补发：父组件 AppContent 的 useEffect 在子组件之后执行，此时监听器已就绪
    const tid = setTimeout(broadcast, 0);
    window.addEventListener('resize', broadcast);
    return () => {
      clearTimeout(tid);
      window.removeEventListener('resize', broadcast);
    };
  }, [isMinimized, panelPos, panelW, panelH]);

  // 卸载时重置
  useEffect(() => () => {
    window.dispatchEvent(new CustomEvent('hud-panel-pos', { detail: null }));
  }, []);

  const handleResizeDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    e.preventDefault();
    const rect = panelRef.current?.getBoundingClientRect();
    panelResizeRef.current = {
      sx: e.clientX, sy: e.clientY,
      iw: rect?.width  ?? panelW,
      ih: rect?.height ?? panelH ?? 400,
    };

    const onMove = (ev: PointerEvent) => {
      if (!panelResizeRef.current) return;
      const { sx, sy, iw, ih } = panelResizeRef.current;
      setPanelW(Math.max(180, iw + ev.clientX - sx));
      setPanelH(Math.max(150, ih + ev.clientY - sy));
    };
    const onUp = () => {
      panelResizeRef.current = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [panelW, panelH]);


  // 进程 GB 计算（用 ram.total）
  const ramTotal = stats?.ram.total ?? 0;
  const procGB = (pct: number) => (pct * ramTotal / 100 / 1024 ** 3).toFixed(1);
  // 内存 ≥95% 触发紧急警报
  const isCritical = (stats?.ram.pct ?? 0) >= 95;

  return (
    <>
      {/* ════ 四角大角标 + 顶/底状态条 ════ */}
      <div style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 3 }}>
        {/* 视口四角 */}
        <Corner pos="tl" size={48} />
        <Corner pos="tr" size={48} />
        <Corner pos="bl" size={48} />
        <Corner pos="br" size={48} />

        {/* 顶部中央标题条 */}
        <div style={{
          position: 'absolute', top: 0, left: '50%', transform: 'translateX(-50%)',
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '2px 18px',
          background: 'rgba(0,14,38,0.75)',
          borderBottom: '1px solid rgba(0,180,230,0.22)',
          borderLeft:   '1px solid rgba(0,180,230,0.12)',
          borderRight:  '1px solid rgba(0,180,230,0.12)',
          backdropFilter: 'blur(8px)', ...mono,
        }}>
          <Dot ms={900} />
          <span style={{ color: '#00d9ff', fontSize: sessionName ? 10.5 : 9.5, letterSpacing: sessionName ? '0.08em' : '0.22em', textShadow: '0 0 8px rgba(0,217,255,0.5)', maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {sessionName || 'AI COMMAND INTERFACE'}
          </span>
          <Dot ms={1300} />
        </div>

      </div>

      {/* ════ 悬浮球（收起状态）════ */}
      {isMinimized && ballPos && (
        <div
          onPointerDown={handleBallPointerDown}
          style={{
            position: 'fixed',
            left: ballPos.x - 26, top: ballPos.y - 26,
            width: 52, height: 52,
            borderRadius: '50%',
            background: 'radial-gradient(circle at 35% 35%, rgba(0,80,130,0.95) 0%, rgba(0,18,48,0.97) 100%)',
            border: `1.5px solid ${isCritical ? 'rgba(255,50,50,0.8)' : 'rgba(0,200,255,0.65)'}`,
            boxShadow: isCritical
              ? '0 0 14px rgba(255,0,0,0.5), 0 2px 8px rgba(0,0,0,0.5)'
              : '0 0 14px rgba(0,200,255,0.45), 0 2px 8px rgba(0,0,0,0.5)',
            cursor: dragRef.current.dragging ? 'grabbing' : 'grab',
            zIndex: 200,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            touchAction: 'none', userSelect: 'none',
            animation: 'tech-corner-pulse 2.5s ease-in-out infinite',
          }}
          title="展开 SYS MONITOR"
        >
          <span style={{ fontSize: 18, lineHeight: 1, filter: `drop-shadow(0 0 6px ${isCritical ? '#ff4444' : '#00d9ff'})` }}>
            {isCritical ? '⚠' : '◈'}
          </span>
          {/* 右上角小闪烁点 */}
          <span style={{
            position: 'absolute', top: 5, right: 5,
            width: 6, height: 6, borderRadius: '50%',
            background: isCritical ? '#ff4444' : '#00d9ff',
            boxShadow: `0 0 5px ${isCritical ? '#ff4444' : '#00d9ff'}`,
            animation: 'tech-blink 0.7s step-end infinite',
          }} />
        </div>
      )}

      {/* ════ SYS MONITOR 面板（展开状态，支持拖拽 + 缩放） ════ */}
      {!isMinimized && (
      <div
        ref={panelRef}
        style={{
          position: 'fixed',
          ...(panelPos ? { left: panelPos.left, top: panelPos.top } : { bottom: 18, right: 14 }),
          zIndex: 4,
          pointerEvents: 'none',
          ...(panelH ? { overflow: 'hidden' } : {}),
          ...mono,
        }}
      >
        <Panel w={panelW} critical={isCritical} style={panelH ? { maxHeight: panelH, overflowY: 'auto' } : {}}>
          {/* 标题行 + 北京时间（作为拖拽把手） */}
          <div
            onPointerDown={handlePanelDragDown}
            style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid rgba(0,160,210,0.2)', paddingBottom: 5, marginBottom: 8, paddingLeft: 4, cursor: 'grab', userSelect: 'none', pointerEvents: 'auto', touchAction: 'none' }}
          >
            {/* macOS 风格最小化圆点（亮蓝，内含 − 图标，移到标题行最左） */}
            <button
              className="tech-minimize-btn"
              onClick={e => { e.stopPropagation(); handleMinimize(); }}
              title="收起为悬浮球"
              style={{
                pointerEvents: 'auto',
                flexShrink: 0,
                width: 10, height: 10, borderRadius: '50%',
                background: 'rgba(0,110,125,1)',
                border: '1.5px solid rgba(59,117,125,0.80)',
                boxShadow: '0 0 4px rgba(0,112,125,0.39)',
                cursor: 'pointer', padding: 0, marginRight: 8,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                transition: 'background 0.15s, box-shadow 0.15s',
              }}
              onMouseEnter={e => {
                e.currentTarget.style.background = 'rgba(0,120,125,1)';
                e.currentTarget.style.boxShadow = '0 0 7px rgba(0,118,125,0.55)';
              }}
              onMouseLeave={e => {
                e.currentTarget.style.background = 'rgba(0,110,125,1)';
                e.currentTarget.style.boxShadow = '0 0 4px rgba(0,112,125,0.39)';
              }}
            >
              <svg width="5" height="1.5" viewBox="0 0 5 1.5" style={{ opacity: 0.85 }}>
                <rect x="0" y="0" width="5" height="1.5" rx="0.75" fill="rgba(0,30,60,0.9)" />
              </svg>
            </button>
            <span style={{ display: 'flex', alignItems: 'center', color: isCritical ? '#ff4444' : '#00d9ff', fontSize: 9.5, letterSpacing: '0.2em', textTransform: 'uppercase', textShadow: isCritical ? '0 0 8px rgba(255,60,60,0.7)' : '0 0 8px rgba(0,217,255,0.5)' }}>
              <Dot color={isCritical ? '#ff4444' : '#00d9ff'} ms={700} />
              {isCritical ? '⚠ CRITICAL' : 'SYS MONITOR'}
            </span>
            <span style={{ color: isCritical ? '#ff6666' : '#00e87a', fontSize: 12, fontWeight: 700, textShadow: isCritical ? '0 0 10px rgba(255,80,80,0.7)' : '0 0 10px rgba(0,230,120,0.6)', letterSpacing: '0.04em' }}>
              {clock}
            </span>
          </div>

          {/* 北京时间副标注 */}
          <div style={{ color: 'rgba(0,160,210,0.5)', fontSize: 8.5, marginTop: -5, marginBottom: 9, letterSpacing: '0.12em' }}>
            BEIJING TIME · UTC+8
          </div>

          {/* RAM 进度条 */}
          {stats ? (
            <Bar
              pct={stats.ram.pct}
              label="RAM"
              sub={`${toGB(stats.ram.used)} / ${toGB(stats.ram.total)} GB`}
            />
          ) : (
            <Bar pct={0} label="RAM" sub="connecting…" />
          )}

          {/* CPU 利用率 */}
          <Bar pct={stats?.cpu ?? 0} label="CPU" />

          {/* GPU UTIL — 仪表盘行 */}
          {stats?.gpus ? (
            <div style={{ marginBottom: 2 }}>
              <span style={{ color: '#6abde0', fontSize: 10, letterSpacing: '0.1em', fontWeight: 600 }}>GPU UTIL</span>
              <div style={{ display: 'flex', gap: 2, marginTop: 2 }}>
                {stats.gpus.map((g, i) => (
                  <MiniGauge key={i} pct={g.util} label={`G${i}`} />
                ))}

              </div>
            </div>
          ) : (
            <div style={{ color: 'rgba(0,140,180,0.4)', fontSize: 9.5, marginBottom: 7 }}>GPU UTIL — N/A</div>
          )}

          {/* VRAM — 仪表盘行 */}
          {stats?.gpus ? (
            <div style={{ marginBottom: 3 }}>
              <span style={{ color: '#6abde0', fontSize: 10, letterSpacing: '0.1em', fontWeight: 600 }}>VRAM</span>
              <div style={{ display: 'flex', gap: 2, marginTop: 2 }}>
                {stats.gpus.map((g, i) => {
                  const pct = Math.round(g.used / g.total * 100);
                  // nvidia-smi 返回 MiB，除以 1024 得到 GiB
                  const usedGiB = (g.used / 1024).toFixed(0);
                  const sub = `${usedGiB}G`;
                  return <MiniGauge key={i} pct={pct} label={sub} />;
                })}
              </div>
            </div>
          ) : (
            <div style={{ color: 'rgba(0,140,180,0.4)', fontSize: 9.5, marginBottom: 7 }}>VRAM — N/A</div>
          )}

          {/* 分隔线 */}
          <div style={{ height: 1.5, background: 'rgba(0,190,240,0.55)', margin: '5px 0', boxShadow: '0 0 6px rgba(0,200,255,0.35)' }} />

          {/* Top 进程标题 */}
          <div style={{ color: '#6abde0', fontSize: 10, letterSpacing: '0.16em', marginBottom: 6, textShadow: '0 0 6px rgba(0,180,230,0.4)' }}>
            TOP PROCESSES
          </div>

          {/* 进程列表 */}
          {(stats?.topProcs ?? []).slice(0, 5).map((p, i) => {
            const gb = procGB(p.pct);
            const barW = Math.min(parseFloat(gb) / (ramTotal / 1024 ** 3) * 100, 100);
            return (
              <div key={i} style={{ marginBottom: 5 }}>
                {/* 进程名(用户) + GB */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 }}>
                  <span style={{
                    color: 'rgba(185,230,255,0.85)', fontSize: 10, fontWeight: 600,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 148,
                    textShadow: '0 0 5px rgba(0,200,255,0.25)',
                  }}>
                    {p.name}
                    <span style={{ color: 'rgba(100,170,220,0.6)', fontWeight: 400 }}>({p.user})</span>
                  </span>
                  <span style={{ color: '#00d9ff', fontSize: 10, fontWeight: 700, flexShrink: 0, textShadow: '0 0 7px rgba(0,217,255,0.5)' }}>
                    {gb} GB
                  </span>
                </div>
                {/* 小进度条 */}
                <div style={{ height: 4, background: 'rgba(0,50,90,0.5)', border: '1px solid rgba(0,110,170,0.2)', position: 'relative' }}>
                  <div style={{
                    position: 'absolute', left: 0, top: 0, bottom: 0,
                    width: `${barW}%`,
                    background: barGradient(barW),
                    boxShadow: `0 0 6px ${glowColor(barW)}`,
                    transition: 'width 0.6s ease',
                  }} />
                </div>
              </div>
            );
          })}

          <Stream />
          {/* 右下角缩放手柄 */}
          <div
            onPointerDown={handleResizeDown}
            title="拖拽调整大小"
            style={{
              position: 'absolute', bottom: 2, right: 2,
              width: 14, height: 14, cursor: 'nwse-resize',
              pointerEvents: 'auto', touchAction: 'none',
              display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-end',
              opacity: 0.4,
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.opacity = '0.9'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.opacity = '0.4'; }}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="rgba(0,200,255,0.8)">
              <path d="M9 1L1 9M6 1L1 6M9 4L4 9" stroke="rgba(0,200,255,0.8)" strokeWidth="1.2" strokeLinecap="round"/>
            </svg>
          </div>
        </Panel>
      </div>
      )}

      {/* CRT 扫描线叠层（从 body::before 迁移为真实 DOM，确保 Windows 浏览器可见） */}
      <div style={{
        position: 'fixed',
        inset: 0,
        pointerEvents: 'none',
        zIndex: 1,
        background: 'repeating-linear-gradient(to bottom, transparent 0px, transparent 3px, rgba(0,210,255,0.016) 3px, rgba(0,210,255,0.016) 4px)',
      }} />

      {/* 移动扫描光条（从 body::after 迁移为真实 DOM） */}
      <div style={{
        position: 'fixed',
        left: 0,
        right: 0,
        height: 2,
        top: 0,
        pointerEvents: 'none',
        zIndex: 2,
        background: 'linear-gradient(to right, transparent, rgba(0,217,255,0.35) 20%, rgba(0,217,255,0.65) 50%, rgba(0,217,255,0.35) 80%, transparent)',
        animation: 'tech-scanline 7s linear infinite',
      }} />
    </>
  );
}
