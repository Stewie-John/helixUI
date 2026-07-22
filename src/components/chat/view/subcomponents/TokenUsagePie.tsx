type TokenUsagePieProps = {
  used: number;
  total: number;
  resetKey?: string | number | null;
  onRefresh?: () => void;
  refreshing?: boolean;
};

function lerp(a: number, b: number, t: number) {
  return Math.round(a + (b - a) * t);
}

interface RGB { r: number; g: number; b: number; }

// 渐变色：绿→青→黄→红（与状态栏同款）
function getGaugeColor(pct: number): RGB {
  const stops = [
    { p: 0,   r: 0,   g: 232, b: 122 },  // #00e87a
    { p: 33,  r: 0,   g: 217, b: 255 },  // #00d9ff
    { p: 66,  r: 255, g: 214, b: 0   },  // #ffd600
    { p: 100, r: 255, g: 68,  b: 68  },  // #ff4444
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

function rgb(c: RGB, alpha = 1) {
  return alpha < 1 ? `rgba(${c.r},${c.g},${c.b},${alpha})` : `rgb(${c.r},${c.g},${c.b})`;
}

// 与白色混合提亮颜色
function lighten(c: RGB, amount: number): RGB {
  return {
    r: Math.min(255, Math.round(c.r + (255 - c.r) * amount)),
    g: Math.min(255, Math.round(c.g + (255 - c.g) * amount)),
    b: Math.min(255, Math.round(c.b + (255 - c.b) * amount)),
  };
}

import { useId, useRef } from 'react';

export default function TokenUsagePie({ used, total, resetKey, onRefresh, refreshing = false }: TokenUsagePieProps) {
  if (used == null || total == null || total <= 0) return null;

  const rawPct = Math.min(100, (used / total) * 100);

  // Keep a per-session high-water mark. Within one active session the context
  // meter should grow monotonically; a decrease is only valid after compaction
  // or when switching sessions, both of which change resetKey.
  const lastValidPctRef = useRef(rawPct);
  const resetKeyRef = useRef(resetKey);
  const hasConcreteResetKey = Boolean(resetKey && !String(resetKey).startsWith('no-session:'));
  if (hasConcreteResetKey && resetKeyRef.current !== resetKey) {
    resetKeyRef.current = resetKey;
    lastValidPctRef.current = rawPct;
  } else if (used > 0) {
    lastValidPctRef.current = Math.max(lastValidPctRef.current, rawPct);
  }
  const targetPct = used > 0 ? lastValidPctRef.current : lastValidPctRef.current;

  // The browser interpolates the arc and needle on the compositor. This keeps
  // live token growth smooth without rebuilding the SVG on every animation frame.
  const percentage = targetPct;
  const curColor = getGaugeColor(percentage);
  const needleColor = lighten(curColor, 0.42);  // 指针比表盘稍亮

  // 仪表盘几何：半圆弧，从左(180°)到右(0°)
  const cx = 24, cy = 24, r = 18;
  const gradientId = `token-gauge-${useId().replace(/:/g, '')}`;

  // 生成从 p1% 到 p2% 的弧段路径（沿半圆）
  const arcPath = (p1: number, p2: number) => {
    const a1 = Math.PI * (1 - p1 / 100);
    const a2 = Math.PI * (1 - p2 / 100);
    const x1 = cx + r * Math.cos(a1);
    const y1 = cy - r * Math.sin(a1);
    const x2 = cx + r * Math.cos(a2);
    const y2 = cy - r * Math.sin(a2);
    return `M${x1.toFixed(2)} ${y1.toFixed(2)} A${r} ${r} 0 0 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
  };

  const gaugeArc = arcPath(0, 100);

  // 刻度线：0/20/40/60/80/100% 长线，其余短线
  const ticks = Array.from({ length: 11 }, (_, i) => {
    const p = i * 10;
    const isMajor = p % 20 === 0;
    const angle = Math.PI * (1 - p / 100);
    const rOuter = r;
    const rInner = isMajor ? r - 5 : r - 3;
    return {
      x1: (cx + rOuter * Math.cos(angle)).toFixed(2),
      y1: (cy - rOuter * Math.sin(angle)).toFixed(2),
      x2: (cx + rInner * Math.cos(angle)).toFixed(2),
      y2: (cy - rInner * Math.sin(angle)).toFixed(2),
      color: rgb(getGaugeColor(p), isMajor ? 0.78 : 0.45),
      width: isMajor ? '1.3' : '0.75',
    };
  });

  // 指针：从圆心延伸至弧面外 3px（超出表盘）
  const needleLen = r + 3;

  return (
    <button
      type="button"
      onClick={onRefresh}
      disabled={!onRefresh || refreshing}
      className="tech-bare flex items-center gap-1.5 text-xs rounded-md px-1 py-0.5 transition-colors hover:bg-accent/60 disabled:cursor-default disabled:hover:bg-transparent"
      title={`${used.toLocaleString()} / ${total.toLocaleString()} tokens${onRefresh ? ' - click to refresh' : ''}`}
    >
      {/* 仪表盘 SVG，高度裁切到半圆弧面 */}
      <svg
        width="48"
        height="27"
        viewBox="0 0 48 27"
        className={refreshing ? 'animate-pulse' : undefined}
      >
        <defs>
          <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#00e87a" />
            <stop offset="33%" stopColor="#00d9ff" />
            <stop offset="66%" stopColor="#ffd600" />
            <stop offset="100%" stopColor="#ff4444" />
          </linearGradient>
        </defs>
        {/* 背景弧：暗淡的全量程渐变 */}
        <path d={gaugeArc} fill="none" stroke={`url(#${gradientId})`} strokeOpacity="0.18" strokeWidth="3" />
        {/* 前景弧：由浏览器线性插值，不触发 React 逐帧渲染 */}
        <path
          d={gaugeArc}
          fill="none"
          pathLength="100"
          stroke={`url(#${gradientId})`}
          strokeDasharray={`${percentage} 100`}
          strokeWidth="3"
          style={{ transition: 'stroke-dasharray 900ms linear' }}
        />
        {/* 刻度线：长短交替（20的倍数为长线） */}
        {ticks.map((t, i) => (
          <line key={`tk${i}`} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2}
            stroke={t.color} strokeWidth={t.width} strokeLinecap="round" />
        ))}
        {/* 指针：超出弧面，颜色比表盘浅 */}
        <line
          x1={cx}
          y1={cy}
          x2={cx - needleLen}
          y2={cy}
          stroke={rgb(needleColor)}
          strokeWidth="1.8"
          strokeLinecap="round"
          transform={`rotate(${percentage * 1.8} ${cx} ${cy})`}
        />
        {/* 中心圆点 */}
        <circle cx={cx} cy={cy} r="2" fill={rgb(curColor)} />
      </svg>
      <span style={{ color: rgb(curColor), minWidth: '4.2ch', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
        {percentage.toFixed(1)}%
      </span>
    </button>
  );
}
