import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';
import { authenticatedFetch } from '../../utils/api';
import DailyInputUsageModal from './DailyInputUsageModal';
import { useVisualPerformanceMode } from '../../hooks/useVisualPerformanceMode';
import {
  readStoredTokenBudgetSnapshot,
  TOKEN_BUDGET_EVENT,
  type TokenBudgetSnapshot,
} from '../chat/utils/tokenBudgetEvents';
import { CLAUDE_MODELS } from '../../../shared/modelConstants';
import { useSessionTokenTotals } from '../chat/utils/sessionTokenTotals';
import { PROVIDER_UPDATED_EVENT } from '../../utils/appEvents';

/* ── 类型 ─────────────────────────────────────────────────────── */
interface AccountMemory { user: string; bytes: number; pct: number; processCount: number }
interface GpuInfo { used: number; total: number; util: number }
interface SysStats {
  ram:      { total: number; used: number; free: number; pct: number };
  cpu:      number;                    // 瞬时 CPU 利用率 %
  gpus:     GpuInfo[] | null;          // 所有 GPU（每张卡一项）
  memoryByUser: AccountMemory[];
}

type CodexQuotaLimit = {
  key: string;
  scope: string;
  name: string;
  cadence: string;
  percentLeft: number;
  resetAt?: number | null;
  windowDurationMins?: number | null;
  resetText?: string | null;
};

type CodexCredits = {
  hasCredits: boolean;
  unlimited: boolean;
  balance?: string | null;
};

type CodexIndividualLimit = {
  limit: string;
  used: string;
  remainingPercent: number;
  resetsAt: number;
};

type CodexQuotaStatus = {
  model?: string | null;
  account?: string | null;
  cached?: boolean;
  error?: string | null;
  cachedAt?: number | null;
  generatedAt?: string | null;
  planType?: string | null;
  credits?: CodexCredits | null;
  individualLimit?: CodexIndividualLimit | null;
  rateLimitReachedType?: string | null;
  limits?: CodexQuotaLimit[];
};

type DailyInputStatus = {
  day: string;
  timeZone: string;
  userId: number;
  isAdmin: boolean;
  username: string;
  charCount: number;
  eventCount: number;
  inputTokenCount: number;
  outputTokenCount: number;
  outputEventCount: number;
};

// Claude 订阅额度（/usage）：注意是「已用 percentUsed」而非 Codex 的「剩余 percentLeft」
type ClaudeQuotaLimit = {
  key: string;
  name: string;
  cadence: string;
  scope: string;
  percentUsed: number;
  resetText?: string | null;
  // 超额使用（scope==='extra'）：以美元计量的付费额度
  spentText?: string | null;
  spentAmount?: number | null;
  spentLimit?: number | null;
};

type ClaudeQuotaStatus = {
  model?: string | null;
  plan?: string | null;
  cached?: boolean;
  error?: string | null;
  limits?: ClaudeQuotaLimit[];
};

/* ── 北京时间（隔离秒级更新，避免重绘整个 HUD） ────────────────── */
function BeijingClock() {
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
  return <>{time}</>;
}

/* ── 系统统计（10s 轮询；高负载系统下 ps/nvidia-smi 耗时长，频繁轮询会阻塞 Node 事件循环） */
function useSysStats(interval = 10000) {
  const [stats, setStats] = useState<SysStats | null>(null);
  const ref = useRef<ReturnType<typeof setInterval>>();
  useEffect(() => {
    const load = async () => {
      try {
        const r = await authenticatedFetch('/api/sys-stats');
        if (r.ok) setStats(await r.json());
      } catch (_) {}
    };
    load();
    ref.current = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, interval);
    return () => clearInterval(ref.current);
  }, [interval]);
  return stats;
}

function useDailyInputStatus() {
  const [status, setStatus] = useState<DailyInputStatus | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await authenticatedFetch('/api/user/daily-input', { cache: 'no-store' });
      if (!response.ok) throw new Error(`Daily input request failed (${response.status})`);
      const next = await response.json() as DailyInputStatus;
      setStatus(next);
      setUpdatedAt(Date.now());
    } catch (error) {
      console.warn('Could not load daily input total:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    let alignedTimer: number | null = null;
    const scheduleAlignedRefresh = () => {
      const delay = 10000 - (Date.now() % 10000) + 25;
      alignedTimer = window.setTimeout(() => {
        if (document.visibilityState === 'visible') void refresh();
        scheduleAlignedRefresh();
      }, delay);
    };
    scheduleAlignedRefresh();
    let refreshTimer: number | null = null;
    const handleInputChanged = () => {
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => { void refresh(); }, 500);
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    window.addEventListener('helix:daily-input-changed', handleInputChanged);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      if (alignedTimer !== null) window.clearTimeout(alignedTimer);
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      window.removeEventListener('helix:daily-input-changed', handleInputChanged);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [refresh]);

  return { status, updatedAt, loading, refresh };
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
function MiniGauge({ pct, label, reduceMotion = false }: { pct: number; label?: string; reduceMotion?: boolean }) {
  // 半圆仪表盘：cx=19 cy=19 r=14，viewBox 38×22
  const cx = 19, cy = 19, r = 14;
  const displayPct = Math.max(0, Math.min(100, pct));
  const gradientId = `gauge-${useId().replace(/:/g, '')}`;

  const arcPath = (p1: number, p2: number) => {
    const a1 = Math.PI * (1 - p1 / 100);
    const a2 = Math.PI * (1 - p2 / 100);
    const x1 = cx + r * Math.cos(a1), y1 = cy - r * Math.sin(a1);
    const x2 = cx + r * Math.cos(a2), y2 = cy - r * Math.sin(a2);
    return `M${x1.toFixed(2)} ${y1.toFixed(2)} A${r} ${r} 0 0 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
  };

  const gaugeArc = arcPath(0, 100);

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

  // 指针稍微超出弧面；浏览器负责插值，不再逐帧触发 React 渲染。
  const needleLen   = r + 2.5;

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
        <defs>
          <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#00e87a" />
            <stop offset="33%" stopColor="#00d9ff" />
            <stop offset="66%" stopColor="#ffd600" />
            <stop offset="100%" stopColor="#ff4444" />
          </linearGradient>
        </defs>
        <path d={gaugeArc} fill="none" stroke={`url(#${gradientId})`} strokeOpacity="0.18" strokeWidth="2.5" />
        <path
          d={gaugeArc}
          fill="none"
          pathLength="100"
          stroke={`url(#${gradientId})`}
          strokeDasharray={`${displayPct} 100`}
          strokeWidth="2.5"
          style={{ transition: reduceMotion ? 'none' : 'stroke-dasharray 700ms cubic-bezier(0.22, 1, 0.36, 1)' }}
        />
        {ticks.map((t, i) => (
          <line key={`tk${i}`} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2}
            stroke={t.color} strokeWidth={t.width} strokeLinecap="round" />
        ))}
        <line
          x1={cx}
          y1={cy}
          x2={cx - needleLen}
          y2={cy}
          stroke={rgbStr(needleColor)}
          strokeWidth="1.5"
          strokeLinecap="round"
          transform={`rotate(${displayPct * 1.8} ${cx} ${cy})`}
        />
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

/* ── L 形角标（确保 background: transparent） ──────────────────── */
function Corner({ pos, size = 40, animate = true }: { pos: 'tl' | 'tr' | 'bl' | 'br'; size?: number; animate?: boolean }) {
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
  return <span style={{ ...base, ...sides[pos], filter: animate ? 'drop-shadow(0 0 4px rgba(0,217,255,0.5))' : 'none' }} />;
}

/* ── HUD 信息面板（带角标框） ─────────────────────────────────── */
function Panel({
  children,
  w = 260,
  style,
  critical = false,
  reduceMotion = false,
}: {
  children: React.ReactNode;
  w?: number;
  style?: React.CSSProperties;
  critical?: boolean;
  reduceMotion?: boolean;
}) {
  return (
    <div style={{
      position: 'relative', width: w,
      padding: '12px 15px',
      background: critical ? 'rgba(40,2,2,0.76)' : 'rgba(2,12,28,0.72)',
      border: critical ? '1px solid rgba(255,50,50,0.9)' : '1px solid rgba(0,185,235,0.42)',
      contain: 'layout style',
      animation: critical ? `hud-alert-blink ${reduceMotion ? 1.6 : 0.7}s ease-in-out infinite` : undefined,
      ...style,
    }}>
      <Corner pos="tl" size={10} animate={!reduceMotion} />
      <Corner pos="tr" size={10} animate={!reduceMotion} />
      <Corner pos="bl" size={10} animate={!reduceMotion} />
      <Corner pos="br" size={10} animate={!reduceMotion} />
      {children}
    </div>
  );
}

function DailyInputPanel({
  status,
  loading,
  onRefresh,
  w,
  reduceMotion,
}: {
  status: DailyInputStatus | null;
  loading: boolean;
  onRefresh: () => Promise<void>;
  w: number;
  reduceMotion: boolean;
}) {
  const { t } = useTranslation();
  const [showDetails, setShowDetails] = useState(false);

  return (
    <Panel
      w={w}
      reduceMotion={reduceMotion}
      style={{
        marginBottom: 10,
        padding: '10px 15px 11px',
        background: 'linear-gradient(180deg, rgba(7,31,47,0.55), rgba(2,14,28,0.5))',
        pointerEvents: 'auto',
        cursor: 'pointer',
      }}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={() => setShowDetails(true)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setShowDetails(true);
          }
        }}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, outline: 'none', minWidth: 0 }}
      >
        <div style={{ minWidth: 0, flex: '1 1 auto', overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 5, minWidth: 0 }}>
            <Dot color="#6dffba" ms={1500} animate={!reduceMotion && !loading} />
            <span style={{ color: '#6dffba', fontSize: 10.5, fontWeight: 800, lineHeight: 1.18, letterSpacing: '0.12em', textShadow: '0 0 8px rgba(109,255,186,0.45)', whiteSpace: 'normal', overflowWrap: 'anywhere', flex: '1 1 auto' }}>
              {t('hud.dailyInput', { defaultValue: 'DAILY ACTIVITY' })}
            </span>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                void onRefresh();
              }}
              onPointerDown={(event) => event.stopPropagation()}
              title={t('buttons.refresh')}
              style={{ pointerEvents: 'auto', border: 0, background: 'none', color: '#6dffba', padding: 0, cursor: 'pointer', opacity: loading ? 0.9 : 0.5, fontSize: 12, lineHeight: 1 }}
            >
              <RefreshCw size={11} strokeWidth={2.4} style={{ display: 'block' }} />
            </button>
          </div>
          <div style={{ color: 'rgba(170,226,220,0.58)', fontSize: 9, marginTop: 4, letterSpacing: '0.05em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {status ? `${status.username} · ${status.day}` : loading ? t('common.loading', { defaultValue: 'Loading...' }) : '—'}
          </div>
        </div>
        <div style={{ textAlign: 'right', flex: '0 1 126px', width: 126, minWidth: 0, overflow: 'hidden' }}>
          <div style={{ color: '#f4fff9', fontSize: 18, fontWeight: 900, lineHeight: 1, fontVariantNumeric: 'tabular-nums', textShadow: '0 0 11px rgba(109,255,186,0.4)' }}>
            {(status?.charCount || 0).toLocaleString()}
          </div>
          <div style={{ color: 'rgba(109,255,186,0.62)', fontSize: 8.5, letterSpacing: '0.12em', marginTop: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {t('hud.charactersToday', { defaultValue: 'CHARS TODAY' })}
          </div>
          <div style={{ color: '#76e6ff', fontSize: 10, fontWeight: 800, lineHeight: 1.1, marginTop: 5, fontVariantNumeric: 'tabular-nums' }}>
            ↑{(status?.inputTokenCount || 0).toLocaleString()}
          </div>
          <div style={{ color: 'rgba(118,230,255,0.72)', fontSize: 8, letterSpacing: '0.08em', marginTop: 2, whiteSpace: 'normal', lineHeight: 1.15 }}>
            {t('hud.modelInputToday')}
          </div>
          <div style={{ color: '#d6a7ff', fontSize: 10, fontWeight: 800, lineHeight: 1.1, marginTop: 5, fontVariantNumeric: 'tabular-nums' }}>
            ↓{(status?.outputTokenCount || 0).toLocaleString()}
          </div>
          <div style={{ color: 'rgba(196,126,255,0.7)', fontSize: 8, letterSpacing: '0.08em', marginTop: 2, whiteSpace: 'normal', lineHeight: 1.15 }}>
            {t('hud.modelOutputToday')}
          </div>
        </div>
      </div>
      {status && (
        <DailyInputUsageModal
          open={showDetails}
          account={{ userId: status.userId, username: status.username, isAdmin: status.isAdmin }}
          onClose={() => setShowDetails(false)}
        />
      )}
    </Panel>
  );
}

/* ── 随机数据流 ─────────────────────────────────────────────────── */
function Stream({ animate = true }: { animate?: boolean }) {
  const streamRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const gen = () => Array.from({ length: 20 }, () =>
      Math.random() > 0.5 ? String(Math.floor(Math.random() * 10))
        : String.fromCharCode(0x41 + Math.floor(Math.random() * 6))
    ).join('');
    const update = () => {
      if (streamRef.current) streamRef.current.textContent = gen();
    };
    update();
    if (!animate) return;
    const id = setInterval(update, 600);
    return () => clearInterval(id);
  }, [animate]);
  return <div ref={streamRef} aria-hidden="true" style={{ fontFamily: 'monospace', fontSize: 8, color: 'rgba(0,210,255,0.60)', letterSpacing: '0.1em', marginTop: 6, userSelect: 'none' }} />;
}

const mono: React.CSSProperties = { fontFamily: "'Courier New', Consolas, monospace" };

const formatTokens = (value: unknown) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 1 : 2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}K`;
  return String(Math.round(n));
};

const readTokenMetric = (...values: unknown[]) => {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
};

const formatCodexModelLine = (model?: string | null) => {
  if (!model) return { primary: 'Codex', secondary: '' };
  const match = model.match(/^([^()]+?)(?:\s*\(([^)]*)\))?$/);
  if (!match) return { primary: model, secondary: '' };
  return {
    primary: match[1].trim(),
    secondary: (match[2] || '').replace(/^reasoning\s+/i, '').replace(/,\s*/g, ' · ').trim(),
  };
};

function useGptQuota() {
  const [quota, setQuota] = useState<TokenBudgetSnapshot | null>(() => readStoredTokenBudgetSnapshot());

  useEffect(() => {
    const onBudget = (event: Event) => {
      const detail = (event as CustomEvent<TokenBudgetSnapshot>).detail;
      if (detail) {
        setQuota(detail);
      }
    };
    window.addEventListener(TOKEN_BUDGET_EVENT, onBudget);
    return () => window.removeEventListener(TOKEN_BUDGET_EVENT, onBudget);
  }, []);

  if (quota?.provider && quota.provider !== 'codex') {
    return null;
  }

  return quota;
}

function useActiveProvider(sessionProvider?: string | null) {
  const readProvider = () => sessionProvider || localStorage.getItem('selected-provider') || 'claude';
  const [provider, setProvider] = useState(readProvider);

  useEffect(() => {
    setProvider(readProvider());
  }, [sessionProvider]);

  useEffect(() => {
    const syncProvider = () => setProvider((previous) => {
      const next = readProvider();
      return previous === next ? previous : next;
    });
    const syncProviderFromStorage = (event: StorageEvent) => {
      if (event.key === 'selected-provider') syncProvider();
    };
    window.addEventListener(PROVIDER_UPDATED_EVENT, syncProvider);
    window.addEventListener('storage', syncProviderFromStorage);
    return () => {
      window.removeEventListener(PROVIDER_UPDATED_EVENT, syncProvider);
      window.removeEventListener('storage', syncProviderFromStorage);
    };
  }, [sessionProvider]);

  return provider;
}

const CODEX_QUOTA_CACHE_KEY = 'codex-quota-status-cache';
const CODEX_QUOTA_REQUEST_TIMEOUT_MS = 12000;
// Do not align the client poll with the server's 60s cache window. A matching
// cadence can repeatedly fetch the just-expired snapshot and make the panel
// appear frozen for nearly two minutes.
const CODEX_QUOTA_REFRESH_INTERVAL_MS = 3 * 60 * 1000;
const normalizeCodexQuotaStatus = (value: CodexQuotaStatus): CodexQuotaStatus => ({
  ...value,
  limits: [...(value.limits || [])].sort((a, b) => {
    const aCurrent = a.scope === 'Current model';
    const bCurrent = b.scope === 'Current model';
    if (aCurrent !== bCurrent) return aCurrent ? -1 : 1;
    const scopeOrder = a.scope.localeCompare(b.scope);
    return scopeOrder || (a.windowDurationMins || Number.MAX_SAFE_INTEGER) - (b.windowDurationMins || Number.MAX_SAFE_INTEGER) || a.key.localeCompare(b.key);
  }),
});

const quotaContentKey = (value: CodexQuotaStatus | null) => JSON.stringify(value ? {
  model: value.model,
  planType: value.planType,
  credits: value.credits,
  individualLimit: value.individualLimit,
  rateLimitReachedType: value.rateLimitReachedType,
  limits: value.limits,
  error: value.error,
} : null);

function readCachedCodexQuota(): CodexQuotaStatus | null {
  try {
    const raw = localStorage.getItem(CODEX_QUOTA_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CodexQuotaStatus;
    return parsed && Array.isArray(parsed.limits) ? normalizeCodexQuotaStatus(parsed) : null;
  } catch {
    return null;
  }
}

async function fetchCodexQuotaStatus(forceRefresh = false) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), CODEX_QUOTA_REQUEST_TIMEOUT_MS);
  try {
    return await authenticatedFetch(`/api/codex/quota-status${forceRefresh ? '?refresh=1' : ''}`, {
      signal: controller.signal,
      cache: 'no-store',
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('Codex /status timed out after 12s');
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

function useCodexQuotaStatus(enabled: boolean) {
  // 初始即用本地缓存填充：避免每次刷新面板空白死等后端冷读（codex TUI 冷启动约 9s+）
  const [status, setStatus] = useState<CodexQuotaStatus | null>(() =>
    enabled ? readCachedCodexQuota() : null,
  );
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const loadRef = useRef<((forceRefresh?: boolean) => Promise<void>) | null>(null);

  useEffect(() => {
    if (!enabled) {
      setStatus(null);
      return;
    }

    let cancelled = false;
    // enabled 变化时也用缓存兜底，后台静默刷新
    setStatus((previous) => previous || readCachedCodexQuota());

    const load = async (forceRefresh = false) => {
      try {
        const response = await fetchCodexQuotaStatus(forceRefresh);
        if (!response.ok) {
          let error = 'Codex /status unavailable';
          try {
            const data = await response.json();
            if (data?.error) error = data.error;
          } catch { /* keep fallback */ }
          if (!cancelled) {
            setStatus((previous) =>
              previous?.limits?.length ? { ...previous, cached: true, error } : { error, limits: [] }
            );
          }
          return;
        }
        const data = await response.json();
        if (!cancelled && data?.success && data?.status) {
          const nextStatus = normalizeCodexQuotaStatus(data.status);
          // 仅缓存含有效 limits 的结果，错误态不写缓存
          if (Array.isArray(nextStatus.limits) && nextStatus.limits.length > 0) {
            const snapshotAt = Number(nextStatus.cachedAt)
              || Date.parse(nextStatus.generatedAt || '')
              || Date.now();
            setUpdatedAt(snapshotAt);
            setStatus((previous) => quotaContentKey(previous) === quotaContentKey(nextStatus) ? previous : nextStatus);
            try { localStorage.setItem(CODEX_QUOTA_CACHE_KEY, JSON.stringify(nextStatus)); } catch { /* ignore */ }
          }
        }
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : 'Codex /status unavailable';
          setStatus((previous) =>
            previous?.limits?.length ? { ...previous, cached: true, error: message } : { error: message, limits: [] }
          );
        }
      }
    };

    loadRef.current = load;
    // Account quota is shared by every open tab. Automatic reads use the
    // server snapshot so many tabs cannot repeatedly spawn Codex app-servers.
    void load(false);
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') void load(false);
    }, CODEX_QUOTA_REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [enabled]);

  const refresh = useCallback(async () => {
    await loadRef.current?.(true);
  }, []);

  return { status, updatedAt, refresh };
}

function LimitRow({ limit }: { limit: CodexQuotaLimit }) {
  const pct = Math.max(0, Math.min(100, Number(limit.percentLeft) || 0));
  const usedPct = 100 - pct;
  const label = limit.scope === 'Current model'
    ? limit.name
    : `${limit.scope.replace(/^GPT-/i, '')} · ${limit.name.replace(' limit', '')}`;
  const color = rgbStr(getGaugeColor(usedPct));
  const resetLabel = limit.resetAt
    ? new Date(limit.resetAt * 1000).toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
    : limit.resetText;

  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'baseline', marginBottom: 3 }}>
        <span style={{
          color: 'rgba(218,245,255,0.96)',
          fontSize: 11,
          fontWeight: 800,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {label}
        </span>
        <span style={{ color, fontSize: 12, fontWeight: 900, textShadow: `0 0 8px ${rgbStr(getGaugeColor(usedPct), 0.6)}`, flexShrink: 0 }}>
          {pct.toFixed(0)}% LEFT
        </span>
      </div>
      <div style={{ position: 'relative', height: 8, background: 'rgba(0,70,115,0.55)', border: '1px solid rgba(0,170,220,0.34)' }}>
        <div style={{
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          width: `${pct}%`,
          background: barGradient(usedPct),
          boxShadow: `0 0 8px ${glowColor(usedPct)}`,
        }} />
      </div>
      {resetLabel && (
        <div style={{ color: 'rgba(190,235,255,0.98)', fontSize: 11.5, marginTop: 3, fontWeight: 700 }}>
          resets {resetLabel}
        </div>
      )}
    </div>
  );
}

function GptQuotaPanel({
  quota,
  nativeStatus,
  w,
  reduceMotion,
  updatedAt,
  onRefresh,
  sessionId,
  projectName,
}: {
  quota: TokenBudgetSnapshot | null;
  nativeStatus: CodexQuotaStatus | null;
  w: number;
  reduceMotion: boolean;
  updatedAt: number | null;
	onRefresh: () => void | Promise<void>;
  sessionId?: string | null;
  projectName?: string | null;
}) {
  const { t } = useTranslation('common');
  const sessionTotals = useSessionTokenTotals(sessionId ?? null, projectName, 'codex');
  const hasSessionTotals = sessionTotals.input > 0 || sessionTotals.output > 0;
  // 相对时间：用 i18n key，每 10s 重渲（与 Claude 面板一致）
  const [ageText, setAgeText] = useState('');
  useEffect(() => {
    if (!updatedAt) { setAgeText(''); return; }
    const compute = () => {
      const s = Math.floor((Date.now() - updatedAt) / 1000);
      if (s < 5) return t('time.justNow');
      if (s < 60) return t('time.secondsAgo', { count: s });
      const m = Math.floor(s / 60);
      if (m < 60) return t('time.minutesAgo', { count: m });
      return t('time.hoursAgo', { count: Math.floor(m / 60) });
    };
    setAgeText(compute());
    const id = window.setInterval(() => setAgeText(compute()), 10000);
    return () => clearInterval(id);
  }, [updatedAt, t]);

  // 刷新按钮旋转状态
  const [spinning, setSpinning] = useState(false);
  const spinTimerRef = useRef<number | null>(null);
  const handleRefresh = useCallback(async () => {
    if (spinning) return;
    setSpinning(true);
    if (spinTimerRef.current !== null) clearTimeout(spinTimerRef.current);
    try {
      await onRefresh();
    } finally {
      // codex 冷读较慢；请求很快返回时也保留一点反馈，慢请求则等真实读取结束。
      spinTimerRef.current = window.setTimeout(() => { setSpinning(false); spinTimerRef.current = null; }, 300);
    }
  }, [spinning, onRefresh]);

  const used = readTokenMetric(quota?.used, quota?.total_tokens, quota?.token_count);
  const total = readTokenMetric(quota?.total, quota?.contextWindow, quota?.context_window, quota?.model_context_window);
  const pct = total > 0 ? Math.min(999, used / total * 100) : 0;
  const remaining = total > 0 ? Math.max(0, total - used) : 0;
  const accent = rgbStr(getGaugeColor(Math.min(100, pct)));
  const hasQuota = Boolean(quota && (used || total));
  const nativeLimits = nativeStatus?.limits || [];
  const hasNativeLimits = nativeLimits.length > 0;
  const minLeft = hasNativeLimits
    ? Math.min(...nativeLimits.map((limit) => Math.max(0, Math.min(100, Number(limit.percentLeft) || 0))))
    : 0;
  const currentFiveHourLimit = nativeLimits.find((limit) =>
    limit.scope === 'Current model' && limit.cadence === '5h'
  ) || nativeLimits.find((limit) => limit.cadence === '5h');
  const headlineLeft = currentFiveHourLimit
    ? Math.max(0, Math.min(100, Number(currentFiveHourLimit.percentLeft) || 0))
    : minLeft;
  const modelLine = formatCodexModelLine(nativeStatus?.model);
  const nativeError = nativeStatus?.error;
  const planLabel = nativeStatus?.planType?.replace(/_/g, ' ') || '';
  const credits = nativeStatus?.credits;
  const individualLimit = nativeStatus?.individualLimit;

  return (
    <Panel
      w={w}
      reduceMotion={reduceMotion}
      style={{
        marginBottom: 10,
        padding: '12px 15px 14px',
        background: 'linear-gradient(180deg, rgba(4,24,52,0.48), rgba(2,12,28,0.47))',
      }}
    >
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        borderBottom: '1px solid rgba(0,160,210,0.18)',
        paddingBottom: 7,
        marginBottom: 9,
      }}>
        {/* 左：标题 + 刷新按钮 + 上次更新时间 */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <Dot ms={1100} animate={!reduceMotion} />
            <span style={{
              color: '#00d9ff',
              fontSize: 11,
              letterSpacing: '0.18em',
              fontWeight: 800,
              textShadow: '0 0 8px rgba(0,217,255,0.55)',
            }}>
              GPT QUOTA
            </span>
            <button
              type="button"
              onClick={handleRefresh}
              title={t('buttons.refresh')}
              style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', lineHeight: 1, opacity: spinning ? 0.9 : 0.45, transition: 'opacity 0.15s', pointerEvents: 'auto' }}
              onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.opacity = '0.9'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.opacity = spinning ? '0.9' : '0.45'; }}
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none"
                stroke="#00d9ff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                style={{ display: 'block', animation: spinning ? 'spin 0.8s linear infinite' : 'none' }}>
                <polyline points="23 4 23 10 17 10" />
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
              </svg>
            </button>
          </div>
          {ageText && (
            <span style={{ color: 'rgba(0,217,255,0.38)', fontSize: 9, letterSpacing: '0.06em', paddingLeft: 14 }}>
              {ageText}
            </span>
          )}
        </div>
        <span style={{
          color: nativeError && !hasNativeLimits ? 'rgba(255,180,84,0.98)' : hasNativeLimits ? rgbStr(getGaugeColor(100 - headlineLeft)) : accent,
          fontSize: 16,
          fontWeight: 900,
          letterSpacing: '0.02em',
          textShadow: `0 0 10px ${nativeError && !hasNativeLimits ? 'rgba(255,180,84,0.5)' : hasNativeLimits ? rgbStr(getGaugeColor(100 - headlineLeft), 0.55) : rgbStr(getGaugeColor(Math.min(100, pct)), 0.55)}`,
        }}>
          {hasNativeLimits ? `${headlineLeft.toFixed(0)}%` : nativeError ? 'ERR' : hasQuota ? `${pct.toFixed(1)}%` : 'WAIT'}
        </span>
      </div>

      {hasNativeLimits ? (
        <>
          <div style={{
            color: 'rgba(170,226,250,0.95)',
            fontSize: 11,
            letterSpacing: '0.06em',
            marginTop: -2,
            marginBottom: 9,
            lineHeight: 1.28,
            overflowWrap: 'anywhere',
          }}>
            <span style={{ color: '#e2f7ff', fontWeight: 900 }}>{modelLine.primary}</span>
            {(modelLine.secondary || planLabel || nativeStatus?.cached) && (
              <span style={{ color: 'rgba(136,216,250,0.92)', fontWeight: 700 }}>
                {' · '}{[modelLine.secondary, planLabel, nativeStatus?.cached ? 'cached' : ''].filter(Boolean).join(' · ')}
              </span>
            )}
          </div>
          {nativeLimits.map((limit) => <LimitRow key={limit.key} limit={limit} />)}
          {(credits || individualLimit) && (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', borderTop: '1px solid rgba(0,160,210,0.15)', paddingTop: 5, marginTop: 2, marginBottom: hasQuota ? 5 : 0 }}>
              <span style={{ color: 'rgba(136,216,250,0.95)', fontSize: 10, letterSpacing: '0.08em', fontWeight: 800 }}>CREDITS</span>
              <span style={{ color: 'rgba(218,245,255,0.96)', fontSize: 10.5, fontWeight: 800 }}>
                {individualLimit
                  ? `${individualLimit.used} / ${individualLimit.limit} · ${individualLimit.remainingPercent}% left`
                  : credits?.unlimited ? 'unlimited' : credits?.hasCredits ? `${credits.balance || '0'} available` : 'not enabled'}
              </span>
            </div>
          )}
          {hasQuota && (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', borderTop: '1px solid rgba(0,160,210,0.15)', paddingTop: 5, marginTop: 2 }}>
              <span style={{ color: 'rgba(136,216,250,0.95)', fontSize: 10, letterSpacing: '0.08em', fontWeight: 800 }}>CTX</span>
              <span style={{ color: 'rgba(218,245,255,0.96)', fontSize: 10.5, fontWeight: 800 }}>{formatTokens(used)} / {formatTokens(total)} · {formatTokens(remaining)} left</span>
            </div>
          )}
        </>
      ) : nativeStatus ? (
        <div style={{
          padding: '9px 0 2px',
          color: 'rgba(170,226,250,0.94)',
          fontSize: 11.5,
          lineHeight: 1.45,
        }}>
          <div style={{ color: nativeError ? 'rgba(255,210,150,0.98)' : 'rgba(226,247,255,0.98)', fontWeight: 900, marginBottom: 5 }}>
            {nativeError ? 'Codex /status 不可用' : '等待 Codex 原生 /status'}
          </div>
          <div style={{ overflowWrap: 'anywhere' }}>
            {nativeError || '等待 Codex 返回额度窗口；窗口数量会按账号和模型动态显示。'}
          </div>
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 5 }}>
            <span style={{ color: 'rgba(226,247,255,0.98)', fontSize: 12.5, fontWeight: 900 }}>
              正在读取 Codex /status
            </span>
            <span style={{ color: 'rgba(0,245,142,0.95)', fontSize: 11, fontWeight: 800 }}>
              SYNC
            </span>
          </div>

          <div style={{ position: 'relative', height: 8, background: 'rgba(0,60,100,0.45)', border: '1px solid rgba(0,140,190,0.22)', marginBottom: 8 }}>
            <div style={{
              position: 'absolute',
              left: 0,
              top: 0,
              bottom: 0,
              width: '18%',
              background: 'linear-gradient(90deg, rgba(0,217,255,0.35), rgba(0,232,122,0.75))',
              boxShadow: '0 0 10px rgba(0,217,255,0.3)',
              transition: reduceMotion ? 'none' : 'width 0.7s ease',
            }} />
          </div>

          <div style={{ color: 'rgba(150,220,250,0.92)', fontSize: 10.5, lineHeight: 1.42 }}>
            正在同步额度窗口与 credits；返回多少项就显示多少项。
          </div>
        </>
      )}
      {hasSessionTotals && (
        <div style={{
          marginTop: 9,
          paddingTop: 7,
          borderTop: '1px solid rgba(0,160,210,0.14)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}>
          <span style={{ color: 'rgba(150,220,250,0.6)', fontSize: 9.5, letterSpacing: '0.1em', textTransform: 'uppercase' }}>
            {t('session.tokens', 'Session')}
          </span>
          <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: '0.04em', fontVariantNumeric: 'tabular-nums' }}>
            <span style={{ color: '#00e87a', textShadow: '0 0 8px rgba(0,232,122,0.5)' }}>↑{sessionTotals.input.toLocaleString()}</span>
            <span style={{ color: 'rgba(150,220,250,0.45)', margin: '0 4px' }}>·</span>
            <span style={{ color: '#c47eff', textShadow: '0 0 8px rgba(196,126,255,0.5)' }}>↓{sessionTotals.output.toLocaleString()}</span>
          </span>
        </div>
      )}
    </Panel>
  );
}

/* ════════════════════════════════════════════════════════════════
   Claude 订阅额度面板（独立于 GPT，互不干扰）
   ════════════════════════════════════════════════════════════════ */
// 当前会话选定的 Claude 模型 → 显示名（如 claude-opus-4-7 → Opus 4.7）。
// 优先读会话专属键，无专属记录则回退默认 Sonnet 4.6（与 useChatProviderState 的默认逻辑一致）；零网络、即时。
function readClaudeModelLabel(sessionId?: string | null): string | null {
  try {
    const stored = sessionId ? localStorage.getItem(`claude-model-${sessionId}`) : null;
    const raw = stored || CLAUDE_MODELS.DEFAULT;
    const option = CLAUDE_MODELS.OPTIONS.find((opt: { value: string; label: string }) => opt.value === raw);
    return option ? option.label : raw;
  } catch {
    return null;
  }
}

// 订阅模型变化：切 session（sessionId 变）即时刷新；中途换模型靠自定义事件即时刷新；
// 跨标签页靠 storage 事件刷新。全程零网络延迟。
function useClaudeSessionModelLabel(sessionId: string | null | undefined, enabled: boolean) {
  const [label, setLabel] = useState<string | null>(() => (enabled ? readClaudeModelLabel(sessionId) : null));

  useEffect(() => {
    if (!enabled) {
      setLabel(null);
      return;
    }
    setLabel(readClaudeModelLabel(sessionId));

    const refresh = () => setLabel(readClaudeModelLabel(sessionId));
    const onModelChanged = (event: Event) => {
      const detail = (event as CustomEvent).detail as { sessionId?: string | null } | undefined;
      // 仅当事件指向当前 session（或无明确 session 指向）时才刷新，避免别的会话切换串扰
      if (!detail || !detail.sessionId || !sessionId || detail.sessionId === sessionId) {
        refresh();
      }
    };
    window.addEventListener('claude-model-changed', onModelChanged as EventListener);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener('claude-model-changed', onModelChanged as EventListener);
      window.removeEventListener('storage', refresh);
    };
  }, [sessionId, enabled]);

  return label;
}

// 额度数字本地缓存：面板重开/切回时先用上次结果秒显，再后台刷新（stale-while-revalidate），消除「正在读取」空窗
const CLAUDE_QUOTA_CACHE_KEY = 'claude-quota-status-cache';
function readCachedClaudeQuota(): ClaudeQuotaStatus | null {
  try {
    const raw = localStorage.getItem(CLAUDE_QUOTA_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ClaudeQuotaStatus;
    return parsed && Array.isArray(parsed.limits) ? parsed : null;
  } catch {
    return null;
  }
}

function useClaudeQuotaStatus(enabled: boolean) {
  const [status, setStatus] = useState<ClaudeQuotaStatus | null>(() =>
    enabled ? readCachedClaudeQuota() : null,
  );
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const loadRef = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    if (!enabled) {
      setStatus(null);
      return;
    }

    let cancelled = false;
    setStatus((previous) => previous || readCachedClaudeQuota());

    const load = async () => {
      try {
        const response = await authenticatedFetch('/api/claude/quota-status');
        if (!response.ok) return;
        const data = await response.json();
        if (!cancelled && data?.success && data?.status) {
          setStatus(data.status);
          setUpdatedAt(Date.now());
          try {
            localStorage.setItem(CLAUDE_QUOTA_CACHE_KEY, JSON.stringify(data.status));
          } catch { /* ignore */ }
        }
      } catch {
        if (!cancelled) {
          setStatus((previous) => previous || { error: 'Claude /usage unavailable', limits: [] });
        }
      }
    };

    loadRef.current = load;
    load();
    const id = setInterval(load, 3 * 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [enabled]);

  const refresh = useCallback(() => { loadRef.current?.(); }, []);

  return { status, updatedAt, refresh };
}

function ClaudeLimitRow({ limit }: { limit: ClaudeQuotaLimit }) {
  const usedPct = Math.max(0, Math.min(100, Number(limit.percentUsed) || 0));
  const isExtra = limit.scope === 'extra';
  const color = rgbStr(getGaugeColor(usedPct));

  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'baseline', marginBottom: 3 }}>
        <span style={{
          color: isExtra ? 'rgba(255,210,150,0.98)' : 'rgba(218,245,255,0.96)',
          fontSize: 11,
          fontWeight: 800,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {limit.name}
        </span>
        {/* 超额块优先显示美元金额（$5.45 / $100.00），它比百分比更直观 */}
        {isExtra && limit.spentText ? (
          <span style={{ color: '#ffb454', fontSize: 12, fontWeight: 900, textShadow: '0 0 8px rgba(255,180,84,0.55)', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
            {limit.spentText}
          </span>
        ) : (
          <span style={{ color, fontSize: 12, fontWeight: 900, textShadow: `0 0 8px ${rgbStr(getGaugeColor(usedPct), 0.6)}`, flexShrink: 0 }}>
            {usedPct.toFixed(0)}% USED
          </span>
        )}
      </div>
      <div style={{ position: 'relative', height: 8, background: 'rgba(0,70,115,0.55)', border: `1px solid ${isExtra ? 'rgba(255,180,84,0.40)' : 'rgba(0,170,220,0.34)'}` }}>
        <div style={{
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          width: `${usedPct}%`,
          background: isExtra
            ? 'linear-gradient(90deg, rgba(255,180,84,0.45), rgba(255,140,60,0.9))'
            : barGradient(usedPct),
          boxShadow: isExtra ? '0 0 8px rgba(255,150,60,0.55)' : `0 0 8px ${glowColor(usedPct)}`,
        }} />
      </div>
      {(limit.resetText || isExtra) && (
        <div style={{ color: isExtra ? 'rgba(255,210,160,0.92)' : 'rgba(190,235,255,0.98)', fontSize: 11.5, marginTop: 3, fontWeight: 700 }}>
          {isExtra ? `${usedPct.toFixed(0)}% used` : ''}
          {isExtra && limit.resetText ? ' · ' : ''}
          {limit.resetText ? `resets ${limit.resetText}` : ''}
        </div>
      )}
    </div>
  );
}

function ClaudeQuotaPanel({
  nativeStatus,
  sessionModelLabel,
  w,
  reduceMotion,
  updatedAt,
  onRefresh,
  sessionId,
  projectName,
}: {
  nativeStatus: ClaudeQuotaStatus | null;
  sessionModelLabel: string | null;
  w: number;
  reduceMotion: boolean;
  updatedAt: number | null;
  onRefresh: () => void;
  sessionId?: string | null;
  projectName?: string | null;
}) {
  const { t } = useTranslation('common');
  const sessionTotals = useSessionTokenTotals(sessionId ?? null, projectName);
  const hasSessionTotals = sessionTotals.input > 0 || sessionTotals.output > 0;

  // 相对时间：用 i18n key，每 10s 重渲
  const [ageText, setAgeText] = useState('');
  useEffect(() => {
    if (!updatedAt) { setAgeText(''); return; }
    const compute = () => {
      const s = Math.floor((Date.now() - updatedAt) / 1000);
      if (s < 5) return t('time.justNow');
      if (s < 60) return t('time.secondsAgo', { count: s });
      const m = Math.floor(s / 60);
      if (m < 60) return t('time.minutesAgo', { count: m });
      return t('time.hoursAgo', { count: Math.floor(m / 60) });
    };
    setAgeText(compute());
    const id = window.setInterval(() => setAgeText(compute()), 10000);
    return () => clearInterval(id);
  }, [updatedAt, t]);

  // 刷新按钮旋转状态
  const [spinning, setSpinning] = useState(false);
  const spinTimerRef = useRef<number | null>(null);
  const handleRefresh = useCallback(() => {
    if (spinning) return;
    setSpinning(true);
    onRefresh();
    if (spinTimerRef.current !== null) clearTimeout(spinTimerRef.current);
    spinTimerRef.current = window.setTimeout(() => { setSpinning(false); spinTimerRef.current = null; }, 1400);
  }, [spinning, onRefresh]);
  const nativeLimits = nativeStatus?.limits || [];
  const hasNativeLimits = nativeLimits.length > 0;
  // headline：右上角总览百分比始终与「五小时限额」（即第一行 Current session，每 5h 重置）保持一致。
  // 优先按 scope==='session' 精确匹配五小时限额；退路取第一条限额（即面板第一行）。
  const fiveHourLimit = nativeLimits.find((limit) => limit.scope === 'session') || nativeLimits[0];
  const headlineUsed = fiveHourLimit
    ? Math.max(0, Math.min(100, Number(fiveHourLimit.percentUsed) || 0))
    : 0;
  // 模型用当前 session 选定值（零延迟、随切换即时变化）；套餐/cached 仍来自 /usage
  const showModelLine = Boolean(sessionModelLabel) || Boolean(nativeStatus?.plan) || Boolean(nativeStatus?.cached);

  return (
    <Panel
      w={w}
      reduceMotion={reduceMotion}
      style={{
        marginBottom: 10,
        padding: '12px 15px 14px',
        background: 'linear-gradient(180deg, rgba(4,24,52,0.48), rgba(2,12,28,0.47))',
      }}
    >
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        borderBottom: '1px solid rgba(0,160,210,0.18)',
        paddingBottom: 7,
        marginBottom: 9,
      }}>
        {/* 左：标题 + 刷新按钮 + 上次更新时间 */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <Dot ms={1100} animate={!reduceMotion} />
            <span style={{
              color: '#00d9ff',
              fontSize: 11,
              letterSpacing: '0.18em',
              fontWeight: 800,
              textShadow: '0 0 8px rgba(0,217,255,0.55)',
            }}>
              CLAUDE QUOTA
            </span>
            <button
              type="button"
              onClick={handleRefresh}
              title={t('buttons.refresh')}
              style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', lineHeight: 1, opacity: spinning ? 0.9 : 0.45, transition: 'opacity 0.15s', pointerEvents: 'auto' }}
              onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.opacity = '0.9'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.opacity = spinning ? '0.9' : '0.45'; }}
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none"
                stroke="#00d9ff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                style={{ display: 'block', animation: spinning ? 'spin 0.8s linear infinite' : 'none' }}>
                <polyline points="23 4 23 10 17 10" />
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
              </svg>
            </button>
          </div>
          {ageText && (
            <span style={{ color: 'rgba(0,217,255,0.38)', fontSize: 9, letterSpacing: '0.06em', paddingLeft: 14 }}>
              {ageText}
            </span>
          )}
        </div>
        <span style={{
          color: hasNativeLimits ? rgbStr(getGaugeColor(headlineUsed)) : '#00d9ff',
          fontSize: 16,
          fontWeight: 900,
          letterSpacing: '0.02em',
          textShadow: `0 0 10px ${hasNativeLimits ? rgbStr(getGaugeColor(headlineUsed), 0.55) : 'rgba(0,217,255,0.45)'}`,
        }}>
          {hasNativeLimits ? `${headlineUsed.toFixed(0)}%` : 'WAIT'}
        </span>
      </div>

      {/* 模型 · 套餐 · cached —— 模型来自当前 session（零延迟即时显示），套餐/cached 来自 /usage */}
      {showModelLine && (
        <div style={{
          color: 'rgba(170,226,250,0.95)',
          fontSize: 11,
          letterSpacing: '0.06em',
          marginTop: -2,
          marginBottom: 9,
          lineHeight: 1.28,
          overflowWrap: 'anywhere',
        }}>
          {sessionModelLabel && (
            <span style={{ color: '#e2f7ff', fontWeight: 900 }}>{sessionModelLabel}</span>
          )}
          {(nativeStatus?.plan || nativeStatus?.cached) && (
            <span style={{ color: 'rgba(136,216,250,0.92)', fontWeight: 700 }}>
              {sessionModelLabel ? ' · ' : ''}{[nativeStatus?.plan, nativeStatus?.cached ? 'cached' : ''].filter(Boolean).join(' · ')}
            </span>
          )}
        </div>
      )}

      {hasNativeLimits ? (
        <>
          {nativeLimits.map((limit) => <ClaudeLimitRow key={limit.key} limit={limit} />)}
        </>
      ) : (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 5 }}>
            <span style={{ color: 'rgba(226,247,255,0.98)', fontSize: 12.5, fontWeight: 900 }}>
              正在读取 Claude /usage
            </span>
            <span style={{ color: 'rgba(0,245,142,0.95)', fontSize: 11, fontWeight: 800 }}>
              SYNC
            </span>
          </div>
          <div style={{ position: 'relative', height: 8, background: 'rgba(0,60,100,0.45)', border: '1px solid rgba(0,140,190,0.22)', marginBottom: 8 }}>
            <div style={{
              position: 'absolute',
              left: 0,
              top: 0,
              bottom: 0,
              width: '18%',
              background: 'linear-gradient(90deg, rgba(0,217,255,0.35), rgba(0,232,122,0.75))',
              boxShadow: '0 0 10px rgba(0,217,255,0.3)',
              transition: reduceMotion ? 'none' : 'width 0.7s ease',
            }} />
          </div>
          <div style={{ color: 'rgba(150,220,250,0.92)', fontSize: 10.5, lineHeight: 1.42 }}>
            首次读取需 spawn 一个临时 claude 进程解析 /usage，约 8 秒；结果缓存 3 分钟。
          </div>
        </>
      )}

      {/* Session 累计 token 消耗 */}
      {hasSessionTotals && (
        <div style={{
          marginTop: 9,
          paddingTop: 7,
          borderTop: '1px solid rgba(0,160,210,0.14)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}>
          <span style={{ color: 'rgba(150,220,250,0.6)', fontSize: 9.5, letterSpacing: '0.1em', textTransform: 'uppercase' }}>
            {t('session.tokens', 'Session')}
          </span>
          <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: '0.04em', fontVariantNumeric: 'tabular-nums' }}>
            <span style={{ color: '#00e87a', textShadow: '0 0 8px rgba(0,232,122,0.5)' }}>↑{sessionTotals.input.toLocaleString()}</span>
            <span style={{ color: 'rgba(150,220,250,0.45)', margin: '0 4px' }}>·</span>
            <span style={{ color: '#c47eff', textShadow: '0 0 8px rgba(196,126,255,0.5)' }}>↓{sessionTotals.output.toLocaleString()}</span>
          </span>
        </div>
      )}
    </Panel>
  );
}

/* ════════════════════════════════════════════════════════════════
   主组件
   ════════════════════════════════════════════════════════════════ */
export default function HUDOverlay({
  sessionName,
  sessionId,
  projectName,
  provider,
}: {
  sessionName?: string;
  sessionId?: string | null;
  projectName?: string | null;
  provider?: string | null;
}) {
  const { reduceAnimations, shouldAnimate } = useVisualPerformanceMode();
  const animationEnabled = shouldAnimate && !reduceAnimations;
  const stats = useSysStats(reduceAnimations ? 20000 : 10000);
  const activeProvider = useActiveProvider(provider);
  const showGptQuotaPanel = activeProvider === 'codex';
  const showClaudeQuotaPanel = activeProvider === 'claude';
  const claudeSessionModelLabel = useClaudeSessionModelLabel(sessionId, showClaudeQuotaPanel);
  const gptQuota = useGptQuota();
  const { status: codexQuotaStatus, updatedAt: codexQuotaUpdatedAt, refresh: refreshCodexQuota } = useCodexQuotaStatus(showGptQuotaPanel);
  const { status: claudeQuotaStatus, updatedAt: claudeQuotaUpdatedAt, refresh: refreshClaudeQuota } = useClaudeQuotaStatus(showClaudeQuotaPanel);
  const { status: dailyInputStatus, loading: dailyInputLoading, refresh: refreshDailyInput } = useDailyInputStatus();

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
    if (e.pointerType === 'mouse') {
      e.preventDefault();
    }
    const pos = ballPos ?? { x: window.innerWidth - 40, y: window.innerHeight - 80 };
    dragRef.current = { dragging: true, startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y, moved: false };
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch { /* ignore */ }

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
      window.removeEventListener('pointercancel', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }, [ballPos]);


  // ── 面板拖拽 & 缩放状态 ─────────────────────────────────────────
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelPos, setPanelPos] = useState<{ left: number; top: number } | null>(null);
  const [panelW, setPanelW] = useState(300);
  const [panelH, setPanelH] = useState<number | null>(null);
  // 视口宽度（响应式）：用于在窄屏隐藏顶部居中标题条，避免与右侧 Chat/Shell 标签重叠。
  // 标题条 fixed 居中，短标题时 maxWidth 截断无效，唯有在不够宽时整体隐藏才能根治重叠。
  const [viewportW, setViewportW] = useState(() => (typeof window !== 'undefined' ? window.innerWidth : 1280));
  useEffect(() => {
    const onResize = () => setViewportW(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
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
      setPanelW(Math.max(280, iw + ev.clientX - sx));
      setPanelH(Math.max(180, ih + ev.clientY - sy));
    };
    const onUp = () => {
      panelResizeRef.current = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [panelW, panelH]);


  // 账号聚合内存 GB（后端按全部进程 RSS 求和）
  const accountGB = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);
  // 内存 ≥95% 触发紧急警报
  const isCritical = (stats?.ram.pct ?? 0) >= 95;

  return (
    <>
      {/* ════ 四角大角标 + 顶/底状态条 ════ */}
      <div style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 3 }}>
        {/* 视口四角 */}
        <Corner pos="tl" size={48} animate={animationEnabled} />
        <Corner pos="tr" size={48} animate={animationEnabled} />
        <Corner pos="bl" size={48} animate={animationEnabled} />
        <Corner pos="br" size={48} animate={animationEnabled} />

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
            touchAction: 'manipulation', userSelect: 'none',
            animation: animationEnabled ? 'tech-corner-pulse 2.5s ease-in-out infinite' : undefined,
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
            animation: animationEnabled ? 'tech-blink 0.7s step-end infinite' : undefined,
          }} />
        </div>
      )}

      {/* ════ SYS MONITOR 面板（展开状态，支持拖拽 + 缩放） ════ */}
      {!isMinimized && (
      <div
        ref={panelRef}
        data-hud-panel
        style={{
          position: 'fixed',
          ...(panelPos ? { left: panelPos.left, top: panelPos.top } : { bottom: 18, right: 14 }),
          zIndex: 4,
          pointerEvents: 'none',
          ...(panelH ? { overflow: 'hidden' } : {}),
          ...mono,
        }}
      >
        <DailyInputPanel
          status={dailyInputStatus}
          loading={dailyInputLoading}
          onRefresh={refreshDailyInput}
          w={panelW}
          reduceMotion={reduceAnimations}
        />
        {showGptQuotaPanel && (
          <GptQuotaPanel quota={gptQuota} nativeStatus={codexQuotaStatus} w={panelW} reduceMotion={reduceAnimations} updatedAt={codexQuotaUpdatedAt} onRefresh={refreshCodexQuota} sessionId={sessionId} projectName={projectName} />
        )}
        {showClaudeQuotaPanel && (
          <ClaudeQuotaPanel nativeStatus={claudeQuotaStatus} sessionModelLabel={claudeSessionModelLabel} w={panelW} reduceMotion={reduceAnimations} updatedAt={claudeQuotaUpdatedAt} onRefresh={refreshClaudeQuota} sessionId={sessionId} projectName={projectName} />
        )}
        <Panel
          w={panelW}
          critical={isCritical}
          reduceMotion={reduceAnimations}
          style={panelH ? { maxHeight: panelH, overflowY: 'auto' } : {}}
        >
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
              <Dot color={isCritical ? '#ff4444' : '#00d9ff'} ms={700} animate={animationEnabled} />
              {isCritical ? '⚠ CRITICAL' : 'SYS MONITOR'}
            </span>
            <span style={{ color: isCritical ? '#ff6666' : '#00e87a', fontSize: 12, fontWeight: 700, textShadow: isCritical ? '0 0 10px rgba(255,80,80,0.7)' : '0 0 10px rgba(0,230,120,0.6)', letterSpacing: '0.04em' }}>
              <BeijingClock />
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
                  <MiniGauge key={i} pct={g.util} label={`G${i}`} reduceMotion={reduceAnimations} />
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
                  return <MiniGauge key={i} pct={pct} label={sub} reduceMotion={reduceAnimations} />;
                })}
              </div>
            </div>
          ) : (
            <div style={{ color: 'rgba(0,140,180,0.4)', fontSize: 9.5, marginBottom: 7 }}>VRAM — N/A</div>
          )}

          {/* 分隔线 */}
          <div style={{ height: 1.5, background: 'rgba(0,190,240,0.55)', margin: '5px 0', boxShadow: '0 0 6px rgba(0,200,255,0.35)' }} />

          {/* 按账号聚合的内存占用 */}
          <div style={{ color: '#6abde0', fontSize: 10, letterSpacing: '0.16em', marginBottom: 6, textShadow: '0 0 6px rgba(0,180,230,0.4)' }}>
            MEMORY BY ACCOUNT
          </div>

          {/* 聚合 RSS 最高的五个账号 */}
          {(stats?.memoryByUser ?? []).slice(0, 5).map((account) => {
            const gb = accountGB(account.bytes);
            const barW = Math.min(account.pct, 100);
            return (
              <div key={account.user} style={{ marginBottom: 5 }}>
                {/* 账号 + 进程数 + 聚合 GB */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 }}>
                  <span style={{
                    color: 'rgba(185,230,255,0.85)', fontSize: 10, fontWeight: 600,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 148,
                    textShadow: '0 0 5px rgba(0,200,255,0.25)',
                  }}>
                    {account.user}
                    <span style={{ color: 'rgba(100,170,220,0.6)', fontWeight: 400 }}> ({account.processCount} proc)</span>
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

          <Stream animate={animationEnabled} />
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
      {animationEnabled && (
      <div style={{
        position: 'fixed',
        inset: 0,
        pointerEvents: 'none',
        zIndex: 1,
        background: 'repeating-linear-gradient(to bottom, transparent 0px, transparent 3px, rgba(0,210,255,0.016) 3px, rgba(0,210,255,0.016) 4px)',
      }} />
      )}

      {/* 移动扫描光条（从 body::after 迁移为真实 DOM） */}
      {animationEnabled && (
      <div style={{
        position: 'fixed',
        left: 0,
        right: 0,
        height: 2,
        top: 0,
        pointerEvents: 'none',
        zIndex: 2,
        background: 'linear-gradient(to right, transparent, rgba(0,217,255,0.35) 20%, rgba(0,217,255,0.65) 50%, rgba(0,217,255,0.35) 80%, transparent)',
        animation: 'tech-scanline 9s linear infinite',
      }} />
      )}
    </>
  );
}
