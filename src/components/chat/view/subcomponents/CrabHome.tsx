import { useEffect, useRef, useState } from 'react';
import { ClawdSprite, type ClawdState } from './ClawdSprite';

// ════════════════════════════════════════════════════════════════════════════
//  螃蟹之家 —— 养成（tamagotchi）核心状态 + 可复用房间 + 小游戏
//  纯本地、零 API；四维状态按真实时间衰减，所有数据存 localStorage
// ════════════════════════════════════════════════════════════════════════════

export type CrabStats = { hunger: number; mood: number; energy: number; clean: number };
export type Counters = { totalFeed: number; totalWork: number; totalPlay: number; shrimpCaught: number };
export type Tasks = { date: string; fed: number; played: number; worked: number; claimed: string[] };

const HOME_KEY = 'crab_home_v2';
const DEFAULT_STATS: CrabStats = { hunger: 72, mood: 72, energy: 72, clean: 72 };
const DECAY_PER_HOUR: CrabStats = { hunger: 11, mood: 8, energy: 13, clean: 7 };
const LEVEL_STEP = 80;
const TITLES = ['蟹卵', '萌新蟹', '打工蟹', '熟练蟹', '学者蟹', '教授蟹', '院士蟹', '诺奖蟹'];
const ALERT_THRESHOLD = 28;

const clamp = (n: number) => Math.max(0, Math.min(100, n));
const today = () => new Date().toISOString().slice(0, 10);

// ── 商店食物 ──
export type Food = { id: string; name: string; emoji: string; cost: number; hunger?: number; mood?: number; energy?: number; clean?: number };
export const FOODS: Food[] = [
  { id: 'shrimp', name: '小虾', emoji: '🦐', cost: 5, hunger: 18, mood: 2 },
  { id: 'burger', name: '蟹堡', emoji: '🍔', cost: 14, hunger: 40, mood: 6 },
  { id: 'cake', name: '蛋糕', emoji: '🍰', cost: 12, hunger: 12, mood: 22 },
  { id: 'coffee', name: '咖啡', emoji: '☕', cost: 10, energy: 32, mood: 3 },
  { id: 'seaweed', name: '海带', emoji: '🥬', cost: 8, hunger: 16, clean: 10 },
];

// ── 每日任务 ──
export type TaskDef = { id: string; label: string; field: 'fed' | 'played' | 'worked'; need: number; reward: number };
export const TASKS: TaskDef[] = [
  { id: 'feed3', label: '投喂 3 次', field: 'fed', need: 3, reward: 15 },
  { id: 'play1', label: '玩 1 局游戏', field: 'played', need: 1, reward: 15 },
  { id: 'work2', label: '打工 2 次', field: 'worked', need: 2, reward: 20 },
];

// ── 成就 ──
export type AchDef = { id: string; name: string; desc: string; icon: string; test: (s: Counters & { level: number; coins: number }) => boolean };
export const ACHS: AchDef[] = [
  { id: 'firstfeed', name: '第一口', desc: '第一次投喂螃蟹', icon: '🍤', test: (s) => s.totalFeed >= 1 },
  { id: 'lv5', name: '打工达蟹', desc: '等级达到 Lv.5', icon: '⭐', test: (s) => s.level >= 5 },
  { id: 'shrimp30', name: '捕虾能手', desc: '累计接住 30 只虾', icon: '🦐', test: (s) => s.shrimpCaught >= 30 },
  { id: 'rich', name: '小富蟹', desc: '攒够 100 贝壳', icon: '🐚', test: (s) => s.coins >= 100 },
  { id: 'work20', name: '卷王之蟹', desc: '累计打工 20 次', icon: '💻', test: (s) => s.totalWork >= 20 },
  { id: 'play10', name: '游戏高手', desc: '玩 10 局小游戏', icon: '🎮', test: (s) => s.totalPlay >= 10 },
];

type Saved = {
  stats: CrabStats; exp: number; coins: number;
  food: Record<string, number>; counters: Counters; tasks: Tasks; ts: number;
};

const EMPTY_COUNTERS: Counters = { totalFeed: 0, totalWork: 0, totalPlay: 0, shrimpCaught: 0 };
const freshTasks = (t?: Partial<Tasks>): Tasks =>
  t && t.date === today()
    ? { date: t.date, fed: t.fed ?? 0, played: t.played ?? 0, worked: t.worked ?? 0, claimed: t.claimed ?? [] }
    : { date: today(), fed: 0, played: 0, worked: 0, claimed: [] };

function loadSaved(): Saved {
  try {
    const raw = localStorage.getItem(HOME_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<Saved>;
      if (p && p.stats) {
        return {
          stats: {
            hunger: clamp(p.stats.hunger ?? DEFAULT_STATS.hunger),
            mood: clamp(p.stats.mood ?? DEFAULT_STATS.mood),
            energy: clamp(p.stats.energy ?? DEFAULT_STATS.energy),
            clean: clamp(p.stats.clean ?? DEFAULT_STATS.clean),
          },
          exp: Math.max(0, p.exp ?? 0),
          coins: Math.max(0, p.coins ?? 20),
          food: p.food ?? {},
          counters: { ...EMPTY_COUNTERS, ...(p.counters ?? {}) },
          tasks: freshTasks(p.tasks),
          ts: p.ts ?? Date.now(),
        };
      }
    }
  } catch {
    /* ignore */
  }
  return { stats: { ...DEFAULT_STATS }, exp: 0, coins: 20, food: {}, counters: { ...EMPTY_COUNTERS }, tasks: freshTasks(), ts: Date.now() };
}

function applyDecay(s: CrabStats, ms: number): CrabStats {
  const h = Math.max(0, ms) / 3_600_000;
  return {
    hunger: clamp(s.hunger - DECAY_PER_HOUR.hunger * h),
    mood: clamp(s.mood - DECAY_PER_HOUR.mood * h),
    energy: clamp(s.energy - DECAY_PER_HOUR.energy * h),
    clean: clamp(s.clean - DECAY_PER_HOUR.clean * h),
  };
}
const addStats = (s: CrabStats, d: Partial<CrabStats>): CrabStats => ({
  hunger: clamp(s.hunger + (d.hunger ?? 0)),
  mood: clamp(s.mood + (d.mood ?? 0)),
  energy: clamp(s.energy + (d.energy ?? 0)),
  clean: clamp(s.clean + (d.clean ?? 0)),
});

function levelInfo(exp: number) {
  let level = 1, need = LEVEL_STEP, rem = exp;
  while (rem >= need && level < TITLES.length) { rem -= need; level += 1; need = LEVEL_STEP * level; }
  return { level, inLevel: rem, need, title: TITLES[Math.min(level - 1, TITLES.length - 1)] };
}

export type Alert = { key: keyof CrabStats; label: string; emoji: string };
const ALERT_CFG: Record<keyof CrabStats, { label: string; emoji: string }> = {
  hunger: { label: '我饿了，喂喂我嘛～', emoji: '🍤' },
  clean: { label: '想洗澡澡了…', emoji: '🛁' },
  energy: { label: '好困哦，想睡觉', emoji: '😴' },
  mood: { label: '宝宝陪陪我好不好', emoji: '🥺' },
};

// ─── 养成状态 hook（单一数据源）────────────────────────────────────────────────
export function useCrabHome() {
  const init = useRef(loadSaved());
  const [stats, setStats] = useState<CrabStats>(() => applyDecay(init.current.stats, Date.now() - init.current.ts));
  const [exp, setExp] = useState(init.current.exp);
  const [coins, setCoins] = useState(init.current.coins);
  const [food, setFood] = useState<Record<string, number>>(init.current.food);
  const [counters, setCounters] = useState<Counters>(init.current.counters);
  const [tasks, setTasks] = useState<Tasks>(init.current.tasks);
  const tsRef = useRef(Date.now());

  useEffect(() => {
    try {
      localStorage.setItem(HOME_KEY, JSON.stringify({ stats, exp, coins, food, counters, tasks, ts: Date.now() } satisfies Saved));
    } catch {
      /* ignore */
    }
  }, [stats, exp, coins, food, counters, tasks]);

  // 每 5s 衰减
  useEffect(() => {
    const id = window.setInterval(() => {
      const now = Date.now();
      const dt = now - tsRef.current;
      tsRef.current = now;
      setStats((s) => applyDecay(s, dt));
    }, 5000);
    return () => window.clearInterval(id);
  }, []);
  // 跨天刷新任务
  useEffect(() => { setTasks((t) => freshTasks(t)); }, []);

  const bumpTask = (field: 'fed' | 'played' | 'worked') =>
    setTasks((t) => { const n = freshTasks(t); return { ...n, [field]: n[field] + 1 }; });

  const feed = () => {
    setStats((s) => addStats(s, { hunger: 24, mood: 5 })); setExp((e) => e + 8); setCoins((c) => c + 2);
    setCounters((c) => ({ ...c, totalFeed: c.totalFeed + 1 })); bumpTask('fed');
  };
  const pet = () => { setStats((s) => addStats(s, { mood: 20 })); setExp((e) => e + 5); setCoins((c) => c + 1); };
  const clean = () => { setStats((s) => addStats(s, { clean: 40, mood: 3 })); setExp((e) => e + 8); setCoins((c) => c + 3); };
  const sleep = () => { setStats((s) => addStats(s, { energy: 45 })); setExp((e) => e + 6); setCoins((c) => c + 2); };
  const work = () => {
    setStats((s) => addStats(s, { mood: 12, energy: -8 })); setExp((e) => e + 15); setCoins((c) => c + 6);
    setCounters((c) => ({ ...c, totalWork: c.totalWork + 1 })); bumpTask('worked');
  };
  const playWin = (caught: number) => {
    const gain = Math.min(40, caught * 4);
    setStats((s) => addStats(s, { mood: gain, energy: -6 })); setExp((e) => e + Math.round(gain / 2)); setCoins((c) => c + caught);
    setCounters((c) => ({ ...c, totalPlay: c.totalPlay + 1, shrimpCaught: c.shrimpCaught + caught })); bumpTask('played');
  };

  const buyFood = (id: string): boolean => {
    const f = FOODS.find((x) => x.id === id);
    if (!f || coins < f.cost) return false;
    setCoins((c) => c - f.cost);
    setFood((inv) => ({ ...inv, [id]: (inv[id] ?? 0) + 1 }));
    return true;
  };
  const useFood = (id: string): Food | null => {
    const f = FOODS.find((x) => x.id === id);
    if (!f || (food[id] ?? 0) <= 0) return null;
    setFood((inv) => ({ ...inv, [id]: Math.max(0, (inv[id] ?? 0) - 1) }));
    setStats((s) => addStats(s, { hunger: f.hunger, mood: f.mood, energy: f.energy, clean: f.clean }));
    setExp((e) => e + 4);
    setCounters((c) => ({ ...c, totalFeed: c.totalFeed + 1 })); bumpTask('fed');
    return f;
  };
  const claimTask = (id: string) => {
    const def = TASKS.find((t) => t.id === id);
    if (!def) return;
    const n = freshTasks(tasks);
    if (n.claimed.includes(id) || n[def.field] < def.need) return;
    setCoins((c) => c + def.reward);
    setTasks((t) => { const nn = freshTasks(t); return { ...nn, claimed: [...nn.claimed, id] }; });
  };

  const lv = levelInfo(exp);
  const isSick = stats.hunger < 12 || stats.mood < 12 || stats.energy < 12 || stats.clean < 12;
  const alerts: Alert[] = (Object.keys(ALERT_CFG) as (keyof CrabStats)[])
    .filter((k) => stats[k] < ALERT_THRESHOLD)
    .map((k) => ({ key: k, label: ALERT_CFG[k].label, emoji: ALERT_CFG[k].emoji }));

  const nt = freshTasks(tasks);
  const taskList = TASKS.map((d) => ({
    ...d, progress: Math.min(nt[d.field], d.need), done: nt[d.field] >= d.need, claimed: nt.claimed.includes(d.id),
  }));
  const achState = { ...counters, level: lv.level, coins };
  const achList = ACHS.map((a) => ({ ...a, unlocked: a.test(achState) }));

  return {
    stats, exp, coins, food, counters, ...lv, isSick, alerts,
    feed, pet, clean, sleep, work, playWin, buyFood, useFood, claimTask,
    taskList, achList,
  };
}

export type CrabHomeApi = ReturnType<typeof useCrabHome>;

// ════════════════════════════════════════════════════════════════════════════
//  房间场景（可缩放，供全屏游戏复用）
// ════════════════════════════════════════════════════════════════════════════
export const ROOM_CSS = `
  @keyframes crab-bubble-rise { 0%{transform:translateY(0) scale(.6);opacity:0} 25%{opacity:.9} 100%{transform:translateY(-46px) scale(1.1);opacity:0} }
  @keyframes crab-zzz { 0%{transform:translateY(0) scale(.7);opacity:0} 25%{opacity:1} 100%{transform:translate(10px,-22px) scale(1.1);opacity:0} }
  @keyframes crab-star-tw { 0%,100%{opacity:.25} 50%{opacity:1} }
  @keyframes crab-heart-pop { 0%{transform:scale(.4);opacity:0} 30%{opacity:1} 100%{transform:scale(1.3) translateY(-20px);opacity:0} }
`;

type Phase = 'day' | 'dusk' | 'night';
export function phaseNow(): Phase {
  const h = new Date().getHours();
  if (h >= 6 && h < 17) return 'day';
  if (h >= 17 && h < 20) return 'dusk';
  return 'night';
}
const WALL_BG: Record<Phase, string> = {
  day: 'linear-gradient(180deg,#fde9c8 0%,#fbd9a8 100%)',
  dusk: 'linear-gradient(180deg,#f6c39b 0%,#e8a07e 100%)',
  night: 'linear-gradient(180deg,#3a3460 0%,#2a2747 100%)',
};
const SKY_BG: Record<Phase, string> = {
  day: 'linear-gradient(180deg,#8fd3ff 0%,#cdeeff 100%)',
  dusk: 'linear-gradient(180deg,#ff9e6d 0%,#ffd9a0 100%)',
  night: 'linear-gradient(180deg,#10183a 0%,#1f2b54 100%)',
};

// ── 家具 / 装饰 SVG（暖色像素风，借鉴星露谷小屋）──────────────────────────────
function Bed() {
  return (
    <svg width="76" height="46" viewBox="0 0 76 46" style={{ imageRendering: 'pixelated' }}>
      {/* 床架 */}
      <rect x="0" y="12" width="6" height="32" fill="#8a5a32" /><rect x="70" y="18" width="6" height="26" fill="#8a5a32" />
      <rect x="2" y="8" width="6" height="8" rx="2" fill="#a06b3c" />
      {/* 床垫 */}
      <rect x="4" y="20" width="68" height="18" rx="3" fill="#caa06a" /><rect x="4" y="20" width="68" height="6" fill="#dcb685" />
      {/* 被子 */}
      <rect x="24" y="22" width="48" height="16" rx="3" fill="#7fb3e0" /><rect x="24" y="22" width="48" height="5" rx="2" fill="#a3cdf0" />
      <rect x="30" y="30" width="6" height="6" fill="#ffffff" opacity=".35" /><rect x="44" y="29" width="6" height="6" fill="#ffffff" opacity=".35" />
      {/* 枕头 */}
      <rect x="8" y="18" width="18" height="13" rx="4" fill="#f6c2d2" /><rect x="11" y="21" width="11" height="5" rx="2" fill="#fff" opacity=".6" />
      {/* 床腿 */}
      <rect x="6" y="40" width="5" height="6" fill="#6f4724" /><rect x="65" y="40" width="5" height="6" fill="#6f4724" />
    </svg>
  );
}
function Bowl() {
  return (
    <svg width="40" height="28" viewBox="0 0 40 28" style={{ imageRendering: 'pixelated' }}>
      <ellipse cx="20" cy="23" rx="18" ry="4" fill="#00000022" />
      <path d="M3 13 h34 a17 8 0 0 1 -34 0 z" fill="#6b6b8c" /><path d="M3 13 h34 a17 3 0 0 0 -34 0 z" fill="#8688ad" />
      <rect x="11" y="6" width="7" height="8" rx="3.5" fill="#e8924a" /><rect x="19" y="5" width="7" height="9" rx="3.5" fill="#f4b964" />
      <rect x="15" y="8" width="6" height="6" rx="3" fill="#d2742f" /><circle cx="22" cy="9" r="1.4" fill="#fff" opacity=".5" />
    </svg>
  );
}
function Tub() {
  return (
    <svg width="56" height="40" viewBox="0 0 56 40" style={{ imageRendering: 'pixelated' }}>
      <rect x="3" y="14" width="50" height="20" rx="9" fill="#eef4fa" /><rect x="3" y="14" width="50" height="7" rx="6" fill="#fbfdff" />
      <rect x="7" y="18" width="42" height="12" rx="6" fill="#7ec3e6" /><rect x="7" y="18" width="42" height="4" rx="3" fill="#a6dcf3" />
      <circle cx="16" cy="22" r="2.4" fill="#dff3ff" /><circle cx="28" cy="21" r="3" fill="#dff3ff" /><circle cx="39" cy="23" r="2" fill="#dff3ff" />
      <rect x="47" y="4" width="4" height="12" rx="1" fill="#c2cbd4" /><rect x="44" y="4" width="9" height="4" rx="2" fill="#c2cbd4" />
      <rect x="6" y="32" width="5" height="6" fill="#aeb7c0" /><rect x="45" y="32" width="5" height="6" fill="#aeb7c0" />
    </svg>
  );
}
function Desk() {
  return (
    <svg width="56" height="46" viewBox="0 0 56 46" style={{ imageRendering: 'pixelated' }}>
      {/* 显示器 */}
      <rect x="12" y="6" width="32" height="22" rx="2" fill="#1b1c33" /><rect x="14" y="8" width="28" height="18" fill="#0d241a" />
      <rect x="16" y="11" width="16" height="2" fill="#4ade80" /><rect x="16" y="15" width="22" height="2" fill="#38bdf8" />
      <rect x="16" y="19" width="12" height="2" fill="#facc15" /><rect x="16" y="23" width="18" height="2" fill="#f472b6" />
      <rect x="25" y="28" width="6" height="4" fill="#2a2a3e" /><rect x="20" y="32" width="16" height="3" fill="#3a3a52" />
      {/* 桌面 + 键盘 */}
      <rect x="2" y="35" width="52" height="5" rx="1" fill="#a8763c" /><rect x="2" y="35" width="52" height="2" fill="#c89a5e" />
      <rect x="18" y="33" width="20" height="3" rx="1" fill="#d8d8e2" />
      <rect x="5" y="40" width="4" height="6" fill="#7c4f2e" /><rect x="47" y="40" width="4" height="6" fill="#7c4f2e" />
    </svg>
  );
}
function Plant() {
  return (
    <svg width="28" height="42" viewBox="0 0 28 42" style={{ imageRendering: 'pixelated' }}>
      <path d="M14 22 C4 15 4 4 14 1 C24 4 24 15 14 22 Z" fill="#4caf76" />
      <path d="M14 24 C7 22 4 13 6 7" stroke="#3a8d5d" strokeWidth="1.6" fill="none" />
      <path d="M14 20 C20 17 22 9 20 5" stroke="#5cc086" strokeWidth="1.4" fill="none" />
      <rect x="6" y="24" width="16" height="14" rx="2" fill="#c2703f" /><rect x="6" y="24" width="16" height="4" fill="#a85a30" /><rect x="6" y="24" width="16" height="14" rx="2" fill="url(#pg)" opacity=".25" />
      <defs><linearGradient id="pg" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#fff" /><stop offset="1" stopColor="#000" /></linearGradient></defs>
    </svg>
  );
}
function Lamp() {
  return (
    <svg width="26" height="60" viewBox="0 0 26 60" style={{ imageRendering: 'pixelated' }}>
      <path d="M4 18 h18 l-3 -12 h-12 z" fill="#f2cf6a" /><path d="M4 18 h18 l-1 -3 h-16 z" fill="#fde9a8" />
      <rect x="11" y="18" width="4" height="34" fill="#9b8050" /><rect x="6" y="52" width="14" height="5" rx="2" fill="#7c663e" />
    </svg>
  );
}

type FurnitureKey = 'bed' | 'bowl' | 'tub' | 'desk';
const FURNITURE: Record<FurnitureKey, { x: number; label: string; act: ClawdState; hold: number }> = {
  bed: { x: 13, label: '😴 睡觉', act: 'rest', hold: 2600 },
  bowl: { x: 33, label: '🍤 投喂', act: 'happy', hold: 1700 },
  desk: { x: 60, label: '💻 打工', act: 'type', hold: 2400 },
  tub: { x: 86, label: '🛁 洗澡', act: 'idle', hold: 1900 },
};

type Pop = { id: number; emoji: string; x: number };
const FURN_COMP: Record<FurnitureKey, () => JSX.Element> = { bed: Bed, bowl: Bowl, tub: Tub, desk: Desk };

// 暖色墙裙/踢脚线/木地板色板（高对比，避免暗背景灰字）
const FLOOR_BG: Record<Phase, string> = {
  day: 'linear-gradient(180deg,#e0b97e 0%,#c69a5a 100%)',
  dusk: 'linear-gradient(180deg,#cf9a64 0%,#b07c45 100%)',
  night: 'linear-gradient(180deg,#7d6748 0%,#5f4d36 100%)',
};
const WAINSCOT: Record<Phase, string> = { day: '#e7c9a0', dusk: '#d8ab78', night: '#4a4068' };

export function CrabRoom({ api, height = 340, fill = false }: { api: CrabHomeApi; height?: number; fill?: boolean }) {
  const { feed, clean, sleep, work, pet, isSick, title, level } = api;
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [measuredH, setMeasuredH] = useState(height);
  useEffect(() => {
    if (!fill) { setMeasuredH(height); return; }
    const el = wrapRef.current; if (!el) return;
    setMeasuredH(el.clientHeight || height);
    const ro = new ResizeObserver((ents) => { for (const e of ents) setMeasuredH(e.contentRect.height); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fill, height]);
  const H = fill ? measuredH : height;
  const s = H / 210; // 相对原始 210 逻辑高度的缩放
  const crabSize = Math.round(66 * s);
  const floorH = Math.max(52 * s, H * 0.30);

  const [phase, setPhase] = useState<Phase>(phaseNow);
  const [crabX, setCrabX] = useState(50);
  const [facing, setFacing] = useState<1 | -1>(1);
  const [act, setAct] = useState<ClawdState>('idle');
  const [travelMs, setTravelMs] = useState(900);
  const [phrase, setPhrase] = useState('');
  const [pops, setPops] = useState<Pop[]>([]);
  const [bubbles, setBubbles] = useState(false);

  const crabXRef = useRef(crabX); crabXRef.current = crabX;
  const busyRef = useRef(false);
  const t1 = useRef<number | null>(null);
  const t2 = useRef<number | null>(null);
  const popId = useRef(0);

  useEffect(() => { const id = window.setInterval(() => setPhase(phaseNow()), 60_000); return () => window.clearInterval(id); }, []);
  useEffect(() => { if (isSick && !busyRef.current) setAct('error'); }, [isSick]);
  useEffect(() => () => { if (t1.current) window.clearTimeout(t1.current); if (t2.current) window.clearTimeout(t2.current); }, []);

  const spawnPops = (emoji: string, n: number) => {
    const added: Pop[] = Array.from({ length: n }, () => ({ id: popId.current++, emoji, x: Math.random() * 30 - 15 }));
    setPops((p) => [...p, ...added]);
    window.setTimeout(() => setPops((p) => p.slice(added.length)), 1000);
  };

  const goAndDo = (targetX: number, action: ClawdState, holdMs: number, fn?: () => void, say?: string, pop?: string) => {
    if (busyRef.current) return;
    busyRef.current = true;
    const from = crabXRef.current;
    const travel = Math.round(Math.min(1600, Math.max(360, Math.abs(targetX - from) * 16)));
    setTravelMs(travel); setFacing(targetX >= from ? 1 : -1); setAct('scan'); setCrabX(targetX);
    if (say) setPhrase(say);
    t1.current = window.setTimeout(() => {
      setAct(action);
      if (pop === 'bubble') setBubbles(true); else if (pop) spawnPops(pop, 4);
      fn?.();
      t2.current = window.setTimeout(() => { setBubbles(false); setPhrase(''); setAct(isSick ? 'error' : 'idle'); busyRef.current = false; }, holdMs);
    }, travel + 40);
  };

  useEffect(() => {
    const id = window.setInterval(() => {
      if (busyRef.current) return;
      goAndDo(10 + Math.random() * 80, 'idle', 200);
    }, 5200);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const doFurniture = (k: FurnitureKey) => {
    const f = FURNITURE[k];
    const phrases: Record<FurnitureKey, string> = { bowl: '呜姆呜姆，好吃！', desk: '哒哒哒…代码敲起来！', bed: 'Zzz… 充电中', tub: '搓澡澡好舒服～' };
    const fns: Record<FurnitureKey, () => void> = { bowl: feed, desk: work, bed: sleep, tub: clean };
    const popMap: Record<FurnitureKey, string> = { bowl: '❤', desk: '✨', bed: '💤', tub: 'bubble' };
    goAndDo(f.x, f.act, f.hold, fns[k], phrases[k], popMap[k]);
  };
  const doPet = () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setAct('wave'); setPhrase('嘿嘿，宝宝的手好温柔～'); pet(); spawnPops('❤', 3);
    t2.current = window.setTimeout(() => { setPhrase(''); setAct(isSick ? 'error' : 'idle'); busyRef.current = false; }, 1400);
  };

  const wallH = H - floorH;
  const isNight = phase === 'night';
  const winLeft = 13, winTop = 20 * s, winW = 92 * s, winH = 66 * s;
  return (
    <div ref={wrapRef}
      className={fill ? 'absolute inset-0 overflow-hidden' : 'relative w-full overflow-hidden rounded-xl'}
      style={fill ? { background: WALL_BG[phase] } : { height, background: WALL_BG[phase] }}>
      <style>{ROOM_CSS}</style>

      {/* ── 墙面 ───────────────────────────────────────────── */}
      {/* 墙纸：柔和竖纹 + 细点纹 */}
      <div className="absolute inset-x-0 top-0 pointer-events-none" style={{ height: wallH, backgroundImage: 'repeating-linear-gradient(90deg,rgba(255,255,255,.06) 0 22px,rgba(0,0,0,.035) 22px 44px)' }} />
      <div className="absolute inset-x-0 top-0 pointer-events-none" style={{ height: wallH, backgroundImage: 'radial-gradient(rgba(255,255,255,.10) 1px,transparent 1.4px)', backgroundSize: `${22 * s}px ${22 * s}px`, opacity: .5 }} />
      {/* 来自窗口的暖光晕染（白天/黄昏） */}
      {!isNight && <div className="absolute pointer-events-none" style={{ left: 0, top: 0, width: '60%', height: wallH, background: `radial-gradient(ellipse at 22% 30%, ${phase === 'dusk' ? 'rgba(255,180,120,.30)' : 'rgba(255,240,200,.40)'} 0%, transparent 60%)` }} />}
      {/* 顶部装饰线（crown molding） */}
      <div className="absolute inset-x-0 top-0" style={{ height: Math.max(5, 6 * s), background: isNight ? 'linear-gradient(#6a5d90,#534a72)' : 'linear-gradient(#d8ad72,#c2914f)', boxShadow: '0 2px 4px rgba(0,0,0,.12)' }} />

      {/* 三角彩旗（pennant garland）填充上墙空白 */}
      <div className="absolute inset-x-0 pointer-events-none" style={{ top: 8 * s, height: 14 * s }}>
        <div className="absolute inset-x-6 top-0 border-t border-dashed" style={{ borderColor: isNight ? 'rgba(255,255,255,.25)' : 'rgba(120,80,40,.4)' }} />
        {Array.from({ length: 16 }).map((_, i) => {
          const cols = ['#ff8da1', '#ffd166', '#7fd1c4', '#9db4ff', '#caa6ff'];
          return (
            <span key={i} className="absolute" style={{
              left: `${4 + (i + 0.5) / 16 * 92}%`, top: 0, transform: 'translateX(-50%)',
              width: 0, height: 0, borderLeft: `${5 * s}px solid transparent`, borderRight: `${5 * s}px solid transparent`,
              borderTop: `${9 * s}px solid ${cols[i % cols.length]}`, filter: 'drop-shadow(0 1px 1px rgba(0,0,0,.12))', opacity: isNight ? .85 : 1,
            }} />
          );
        })}
      </div>

      {/* 大窗：天空渐变 + 日月 + 云/星 + 田字格 + 窗台 + 束起的窗帘 */}
      <div className="absolute rounded-t-[14px] rounded-b-md shadow-lg" style={{ left: `${winLeft}%`, top: winTop - 4 * s, width: winW + 8 * s, height: winH + 8 * s, background: '#8a5e38', transform: 'translateX(-4px)' }} />
      <div className="absolute overflow-hidden rounded-t-[12px] rounded-b-sm" style={{ left: `${winLeft}%`, top: winTop, width: winW, height: winH, background: SKY_BG[phase], boxShadow: 'inset 0 0 14px rgba(0,0,0,.18)' }}>
        {isNight ? (
          <>
            <div className="absolute rounded-full" style={{ width: 18 * s, height: 18 * s, right: 12 * s, top: 9 * s, background: 'radial-gradient(circle at 38% 35%,#fffef0,#e7e2bf)', boxShadow: '0 0 10px 3px rgba(253,246,201,.55)' }} />
            {[[12, 14], [34, 28], [58, 12], [24, 44], [68, 36], [48, 50], [80, 22], [16, 36]].map(([x, y], i) => (
              <span key={i} className="absolute bg-white rounded-full" style={{ left: x * s, top: y * s, width: 2 * s, height: 2 * s, animation: `crab-star-tw ${1.5 + i * 0.3}s ease-in-out infinite` }} />
            ))}
          </>
        ) : (
          <>
            <div className="absolute rounded-full" style={{ width: 20 * s, height: 20 * s, right: 12 * s, top: 8 * s, background: phase === 'dusk' ? 'radial-gradient(circle at 40% 40%,#ffd0a0,#ff7a59)' : 'radial-gradient(circle at 40% 40%,#fffbe0,#ffe27a)', boxShadow: `0 0 16px 5px ${phase === 'dusk' ? 'rgba(255,140,90,.6)' : 'rgba(255,235,150,.75)'}` }} />
            <div className="absolute rounded-full bg-white/80" style={{ width: 26 * s, height: 10 * s, left: 10 * s, top: 30 * s }} />
            <div className="absolute rounded-full bg-white/80" style={{ width: 14 * s, height: 7 * s, left: 26 * s, top: 26 * s }} />
            <div className="absolute rounded-full bg-white/65" style={{ width: 20 * s, height: 8 * s, left: 48 * s, top: 44 * s }} />
            {/* 远处草坡 */}
            <div className="absolute inset-x-0 bottom-0 rounded-t-[40%]" style={{ height: 14 * s, background: phase === 'dusk' ? 'linear-gradient(#9bbf7a,#86ab66)' : 'linear-gradient(#bfe39a,#9fd178)' }} />
          </>
        )}
        {/* 田字格窗棂 */}
        <div className="absolute inset-x-0 top-1/2 -translate-y-1/2" style={{ height: 3 * s, background: '#8a5e38' }} />
        <div className="absolute inset-y-0 left-1/2 -translate-x-1/2" style={{ width: 3 * s, background: '#8a5e38' }} />
      </div>
      {/* 窗台 */}
      <div className="absolute rounded-sm" style={{ left: `calc(${winLeft}% - ${6 * s}px)`, top: winTop + winH + 3 * s, width: winW + 12 * s, height: 5 * s, background: '#a06b3c', boxShadow: '0 2px 4px rgba(0,0,0,.2)' }} />
      {/* 束起的窗帘 */}
      {[-1, 1].map((d) => (
        <div key={d} className="absolute pointer-events-none" style={{ left: d < 0 ? `calc(${winLeft}% - ${2 * s}px)` : `calc(${winLeft}% + ${winW - 10 * s}px)`, top: winTop - 2 * s, width: 12 * s, height: winH * 0.62, background: 'linear-gradient(180deg,#e58f6c,#d97a55)', borderRadius: '6px 6px 10px 10px', boxShadow: 'inset -2px 0 4px rgba(0,0,0,.18)' }} />
      ))}

      {/* 墙面画廊：当前段位证书 + 挂钟 + 贝壳挂画（错落排布） */}
      <Frame x="42%" top={26 * s} w={38 * s} h={32 * s} ring="#d4af37" bg="#fffdf0" night={isNight}>
        <span style={{ fontSize: 13 * s }}>{level >= TITLES.length ? '🏅' : '📜'}</span>
        <span style={{ fontSize: 5.5 * s, color: '#9a7b16', lineHeight: 1, fontWeight: 700 }}>{title}</span>
      </Frame>
      <Frame x="58%" top={22 * s} w={24 * s} h={24 * s} round ring="#9c6b43" bg="#fff7ea" night={isNight}>
        <span style={{ fontSize: 13 * s }}>🕐</span>
      </Frame>
      <Frame x="70%" top={30 * s} w={32 * s} h={26 * s} ring="#9bb0c4" bg="#eaf4ff" night={isNight}>
        <span style={{ fontSize: 14 * s }}>🐚</span>
      </Frame>

      {/* 木隔板 + 摆件，填充中部墙面 */}
      <div className="absolute" style={{ left: '50%', top: wallH - 30 * s, width: 64 * s, transform: 'translateX(-50%)' }}>
        <div className="flex items-end justify-center" style={{ gap: 2 * s, fontSize: 13 * s, lineHeight: 1 }}>
          <span>📚</span><span>🪴</span><span>🏆</span><span>🧸</span>
        </div>
        <div style={{ height: 4 * s, marginTop: -1 * s, borderRadius: 2, background: 'linear-gradient(#b07c45,#8a5a32)', boxShadow: '0 3px 4px rgba(0,0,0,.22)' }} />
      </div>

      {/* 墙裙 + 踢脚线 */}
      <div className="absolute inset-x-0" style={{ top: wallH - 18 * s, height: 18 * s, background: WAINSCOT[phase], borderTop: `${Math.max(2, 2 * s)}px solid rgba(255,255,255,.15)`, boxShadow: 'inset 0 6px 8px rgba(0,0,0,.05)' }} />
      <div className="absolute inset-x-0" style={{ top: wallH - 4 * s, height: 4 * s, background: isNight ? '#3b3358' : '#a8763c' }} />

      {/* ── 地板 ───────────────────────────────────────────── */}
      <div className="absolute inset-x-0 bottom-0 overflow-hidden" style={{ height: floorH, background: FLOOR_BG[phase] }}>
        {/* 透视木板缝（向远处收拢） */}
        <div className="absolute inset-0 pointer-events-none" style={{ backgroundImage: 'repeating-linear-gradient(90deg,rgba(0,0,0,.07) 0 1px,transparent 1px 70px)' }} />
        <div className="absolute inset-x-0 pointer-events-none" style={{ top: 0, height: '50%', backgroundImage: 'repeating-linear-gradient(0deg,rgba(0,0,0,.05) 0 1px,transparent 1px 14px)' }} />
        {/* 近窗暖光铺地 */}
        {!isNight && <div className="absolute pointer-events-none" style={{ inset: 0, background: 'radial-gradient(ellipse at 22% 0%, rgba(255,240,200,.45) 0%, transparent 55%)' }} />}
        {/* 地板高光 */}
        <div className="absolute inset-x-0 top-0 pointer-events-none" style={{ height: '40%', background: 'linear-gradient(180deg,rgba(255,255,255,.10),transparent)' }} />
      </div>

      {/* 圆地毯（双层带边） */}
      <div className="absolute rounded-[50%] pointer-events-none" style={{ left: '50%', bottom: floorH * 0.10, width: '52%', height: floorH * 0.62, transform: 'translateX(-50%)', background: 'radial-gradient(ellipse,#f6cdd8 0%,#ecaabb 55%,#dd8aa4 100%)', boxShadow: '0 4px 10px rgba(0,0,0,.18)' }} />
      <div className="absolute rounded-[50%] pointer-events-none" style={{ left: '50%', bottom: floorH * 0.16, width: '40%', height: floorH * 0.44, transform: 'translateX(-50%)', border: `${2 * s}px dashed rgba(255,255,255,.55)` }} />

      {/* ── 家具（含落地接触阴影） ───────────────────────────── */}
      {(Object.keys(FURNITURE) as FurnitureKey[]).map((k) => {
        const F = FURN_COMP[k];
        return (
          <button key={k} type="button" onClick={() => doFurniture(k)} title={FURNITURE[k].label}
            className="absolute group" style={{ left: `${FURNITURE[k].x}%`, bottom: floorH * 0.42, transform: `translateX(-50%) scale(${s})`, transformOrigin: 'bottom center' }}>
            <span className="absolute left-1/2 -translate-x-1/2 rounded-[50%] bg-black/22 pointer-events-none" style={{ bottom: -4, width: '88%', height: 9, filter: 'blur(1px)' }} />
            <F />
            <span className="opacity-0 group-hover:opacity-100 transition-opacity absolute -top-7 left-1/2 -translate-x-1/2 whitespace-nowrap text-[10px] px-2 py-0.5 rounded-md bg-gray-900/85 text-white shadow">{FURNITURE[k].label}</span>
          </button>
        );
      })}
      {/* 盆栽 + 台灯（装饰，带阴影） */}
      <div className="absolute" style={{ left: '95%', bottom: floorH * 0.42, transform: `translateX(-50%) scale(${s})`, transformOrigin: 'bottom center' }}>
        <span className="absolute left-1/2 -translate-x-1/2 rounded-[50%] bg-black/20 pointer-events-none" style={{ bottom: -4, width: '80%', height: 7, filter: 'blur(1px)' }} /><Plant />
      </div>
      <div className="absolute" style={{ left: '5%', bottom: floorH * 0.42, transform: `translateX(-50%) scale(${s})`, transformOrigin: 'bottom center' }}>
        <span className="absolute left-1/2 -translate-x-1/2 rounded-[50%] bg-black/20 pointer-events-none" style={{ bottom: -4, width: '70%', height: 7, filter: 'blur(1px)' }} /><Lamp />
        {phase !== 'day' && <div className="absolute rounded-full pointer-events-none" style={{ left: '50%', top: 2, transform: 'translateX(-50%)', width: 74, height: 74, background: 'radial-gradient(circle,rgba(255,236,170,.6) 0%,transparent 70%)' }} />}
      </div>

      {/* 夜晚整体压暗氛围 + 全局暖角晕影 */}
      {isNight && <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(ellipse at 50% 62%,transparent 28%,rgba(18,14,38,.5) 100%)' }} />}
      <div className="absolute inset-0 pointer-events-none" style={{ boxShadow: 'inset 0 0 120px rgba(60,30,10,.18)' }} />

      {/* ── 螃蟹 ───────────────────────────────────────────── */}
      <button type="button" onClick={doPet} className="absolute z-10" title="摸摸我 🤚"
        style={{ left: `${crabX}%`, bottom: floorH * 0.46, transform: 'translateX(-50%)', transition: `left ${travelMs}ms linear` }}>
        <div className="relative">
          {/* 影子 */}
          <div className="absolute rounded-[50%] bg-black/25 pointer-events-none" style={{ left: '50%', bottom: -3 * s, transform: 'translateX(-50%)', width: crabSize * 0.74, height: crabSize * 0.16, filter: 'blur(1px)' }} />
          <ClawdSprite state={act} size={crabSize} flip={facing === -1} />
          {pops.map((p) => (
            <span key={p.id} className="absolute pointer-events-none text-pink-500" style={{ left: `calc(50% + ${p.x}px)`, top: -4, fontSize: 14 * s, animation: 'crab-heart-pop .95s ease-out forwards' }}>{p.emoji}</span>
          ))}
          {act === 'rest' && <span className="absolute pointer-events-none text-indigo-300 font-bold" style={{ left: '60%', top: -6, fontSize: 13 * s, animation: 'crab-zzz 1.4s ease-in-out infinite' }}>z</span>}
          {bubbles && [0, 1, 2].map((i) => (
            <span key={i} className="absolute pointer-events-none rounded-full bg-sky-200/80 border border-white" style={{ left: `${30 + i * 18}%`, top: -6 - i * 4, width: (6 + i * 2) * s, height: (6 + i * 2) * s, animation: `crab-bubble-rise ${1 + i * 0.3}s ease-out infinite` }} />
          ))}
        </div>
      </button>

      {/* 台词气泡（白底深字，高对比，带小尾巴）*/}
      {phrase && (
        <div className="absolute left-1/2 -translate-x-1/2 px-3.5 py-2 rounded-2xl bg-white text-gray-800 shadow-xl border border-black/5 text-center font-medium"
          style={{ top: 12 * s, maxWidth: '70%', fontSize: Math.max(11, 7 * s) }}>{phrase}
          <span className="absolute left-1/2 -translate-x-1/2 -bottom-1.5 w-3 h-3 bg-white rotate-45 border-b border-r border-black/5" />
        </div>
      )}
      {isSick && <div className="absolute top-3 right-3 z-20 text-[11px] px-2 py-1 rounded-md bg-red-600 text-white shadow animate-pulse">螃蟹生病了，快照顾它！</div>}

      {/* 房间内快捷照顾按钮（仅非全屏时显示，全屏直接点家具/用底栏） */}
      {!fill && (
        <div className="absolute left-1/2 -translate-x-1/2 flex gap-2 z-20" style={{ bottom: 8 * Math.min(s, 2) }}>
          <RoomBtn onClick={() => doFurniture('bowl')} label="投喂">🍤</RoomBtn>
          <RoomBtn onClick={doPet} label="摸摸">🤚</RoomBtn>
          <RoomBtn onClick={() => doFurniture('bed')} label="睡觉">😴</RoomBtn>
          <RoomBtn onClick={() => doFurniture('tub')} label="洗澡">🛁</RoomBtn>
          <RoomBtn onClick={() => doFurniture('desk')} label="打工">💻</RoomBtn>
        </div>
      )}
    </div>
  );
}

// 墙面相框（统一画廊风格：外木框 + 内衬 + 内容）
function Frame({ x, top, w, h, round, ring, bg, night, children }:
  { x: string; top: number; w: number; h: number; round?: boolean; ring: string; bg: string; night?: boolean; children: React.ReactNode }) {
  return (
    <div className="absolute flex flex-col items-center justify-center"
      style={{
        left: x, top, width: w, height: h, transform: 'translateX(-50%)',
        background: bg, border: `${Math.max(2, w * 0.06)}px solid ${ring}`,
        borderRadius: round ? '50%' : Math.max(3, w * 0.08),
        boxShadow: '0 4px 8px rgba(0,0,0,.22)', filter: night ? 'brightness(.86)' : undefined,
      }}>
      {children}
    </div>
  );
}

function RoomBtn({ onClick, children, label }: { onClick: () => void; children: React.ReactNode; label?: string }) {
  return (
    <button type="button" onClick={onClick} title={label}
      className="cg-white group/btn relative w-11 h-11 rounded-xl bg-white/95 hover:bg-white shadow-md hover:shadow-lg text-xl flex items-center justify-center active:scale-90 transition border border-black/5">
      {children}
      {label && <span className="opacity-0 group-hover/btn:opacity-100 transition absolute -top-6 left-1/2 -translate-x-1/2 whitespace-nowrap text-[10px] px-1.5 py-0.5 rounded bg-gray-900/85 text-white">{label}</span>}
    </button>
  );
}

// ─── 小游戏：接虾 ─────────────────────────────────────────────────────────────
type Shrimp = { id: number; x: number; y: number };
export function ShrimpGame({ onEnd }: { onEnd: (score: number) => void }) {
  const [shrimps, setShrimps] = useState<Shrimp[]>([]);
  const [score, setScore] = useState(0);
  const [left, setLeft] = useState(15);
  const idRef = useRef(0);
  const scoreRef = useRef(0); scoreRef.current = score;

  useEffect(() => {
    const spawn = window.setInterval(() => setShrimps((s) => [...s, { id: idRef.current++, x: 8 + Math.random() * 82, y: 0 }]), 720);
    const fall = window.setInterval(() => setShrimps((s) => s.map((it) => ({ ...it, y: it.y + 7 })).filter((it) => it.y < 100)), 90);
    const clock = window.setInterval(() => setLeft((l) => l - 1), 1000);
    return () => { window.clearInterval(spawn); window.clearInterval(fall); window.clearInterval(clock); };
  }, []);
  useEffect(() => { if (left <= 0) onEnd(scoreRef.current); }, [left, onEnd]);

  return (
    <div className="absolute inset-0">
      <div className="absolute top-2 left-2 text-xs text-white font-mono bg-black/40 px-2 py-0.5 rounded z-10">⏱ {left}s · 🦐 {score}</div>
      {shrimps.map((s) => (
        <button key={s.id} type="button" className="absolute select-none" style={{ left: `${s.x}%`, top: `${s.y}%`, transform: 'translate(-50%,-50%)', fontSize: 22, lineHeight: 1 }}
          onClick={() => { setScore((v) => v + 1); setShrimps((arr) => arr.filter((it) => it.id !== s.id)); }}>🦐</button>
      ))}
    </div>
  );
}
