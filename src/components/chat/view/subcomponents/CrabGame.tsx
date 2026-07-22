import { useState } from 'react';
import { ClawdSprite } from './ClawdSprite';
import {
  CrabRoom, ShrimpGame, FOODS, ACHS, ROOM_CSS,
  type CrabHomeApi, type CrabStats,
} from './CrabHome';

// ════════════════════════════════════════════════════════════════════════════
//  螃蟹之家 —— 全屏沉浸式养成（房间铺满浏览器，UI 为高对比浮层）
//  借鉴动森/星露谷：「家」始终是背景，模块以毛玻璃面板叠加其上
// ════════════════════════════════════════════════════════════════════════════

// 让「螃蟹之家」完全脱离 tech 科技主题的按钮皮肤（八边切角/深蓝底/辉光），
// 并恢复圆角；彩色 UI 按钮用 .cg-* 辅助类重新上色（优先级高于 .tech button）。
const CRAB_APP_CSS = `
  .tech .crab-app button{ clip-path:none!important; -webkit-clip-path:none!important; filter:none!important; background:transparent!important; border:0!important; }
  /* 彻底清除 tech 主题在按钮上的焦点蓝框 / outline / ring / 伪元素辉光 */
  .tech .crab-app button:focus,
  .tech .crab-app button:focus-visible,
  .tech .crab-app button:active{ outline:0!important; outline-offset:0!important; box-shadow:none!important; -webkit-tap-highlight-color:transparent!important; }
  .tech .crab-app button::before,
  .tech .crab-app button::after{ content:none!important; display:none!important; }
  .tech .crab-app .rounded-full{ border-radius:9999px!important }
  .tech .crab-app .rounded-3xl{ border-radius:1.5rem!important }
  .tech .crab-app .rounded-2xl{ border-radius:1rem!important }
  .tech .crab-app .rounded-xl{ border-radius:.75rem!important }
  .tech .crab-app .rounded-lg{ border-radius:.5rem!important }
  .tech .crab-app .rounded-md{ border-radius:.375rem!important }
  .tech .crab-app .rounded-sm{ border-radius:.25rem!important }
  .tech .crab-app .cg-amber{ background:#fbbf24!important; color:#451a03!important }
  .tech .crab-app .cg-amber:hover{ background:#f59e0b!important }
  .tech .crab-app .cg-pink{ background:#f472b6!important; color:#fff!important }
  .tech .crab-app .cg-pink:hover{ background:#ec4899!important }
  .tech .crab-app .cg-white{ background:rgba(255,255,255,.96)!important }
  .tech .crab-app .cg-white:hover{ background:#fff!important }
  .tech .crab-app .cg-glass{ background:rgba(255,255,255,.10)!important; color:rgba(255,255,255,.8)!important }
  .tech .crab-app .cg-glass:hover{ background:rgba(255,255,255,.20)!important; color:#fff!important }
  .tech .crab-app .cg-muted{ background:rgba(140,140,160,.22)!important; color:#9ca3af!important }
`;

type Tab = 'room' | 'shop' | 'bag' | 'arcade' | 'tasks' | 'achs';
const TABS: { id: Tab; icon: string; label: string }[] = [
  { id: 'room', icon: '🏠', label: '房间' },
  { id: 'shop', icon: '🛒', label: '商店' },
  { id: 'bag', icon: '🎒', label: '背包' },
  { id: 'arcade', icon: '🎮', label: '游戏厅' },
  { id: 'tasks', icon: '📋', label: '任务' },
  { id: 'achs', icon: '🏆', label: '成就' },
];

const STAT_META: { key: keyof CrabStats; label: string; emoji: string; color: string }[] = [
  { key: 'hunger', label: '饱食', emoji: '🍤', color: '#f59e0b' },
  { key: 'mood', label: '心情', emoji: '😊', color: '#ec4899' },
  { key: 'energy', label: '精力', emoji: '⚡', color: '#22c55e' },
  { key: 'clean', label: '清洁', emoji: '🛁', color: '#38bdf8' },
];

function StatPill({ meta, value }: { meta: typeof STAT_META[number]; value: number }) {
  const low = value < 28;
  return (
    <div className="flex items-center gap-2 min-w-[148px]">
      <span className="text-base leading-none">{meta.emoji}</span>
      <div className="flex-1">
        <div className="flex justify-between text-[10px] mb-0.5">
          <span className="text-white/80 font-medium">{meta.label}</span>
          <span className={`tabular-nums font-semibold ${low ? 'text-red-300' : 'text-white/90'}`}>{Math.round(value)}</span>
        </div>
        <div className="h-2 rounded-full bg-black/25 overflow-hidden">
          <div className="h-full rounded-full transition-all duration-500" style={{ width: `${Math.round(value)}%`, background: low ? '#ef4444' : meta.color }} />
        </div>
      </div>
    </div>
  );
}

export function CrabGame({ api, onClose }: { api: CrabHomeApi; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('room');
  const idleState = api.isSick ? 'error' : 'idle';
  const expPct = Math.round((api.inLevel / api.need) * 100);

  return (
    <div className="crab-app fixed inset-0 z-[120] flex flex-col bg-black overflow-hidden" onClick={(e) => e.stopPropagation()}>
      <style>{ROOM_CSS}</style>
      <style>{CRAB_APP_CSS}</style>

      {/* ── 房间全屏背景 ── */}
      <div className="absolute inset-0">
        <CrabRoom api={api} fill />
      </div>

      {/* ── 顶部状态浮层（深色毛玻璃 + 白字，高对比）── */}
      <header className="relative z-10 m-3 rounded-2xl px-4 py-2.5 flex items-center gap-4 flex-wrap
        bg-gradient-to-r from-slate-900/85 to-slate-800/80 backdrop-blur-md shadow-xl border border-white/10">
        <div className="w-12 h-12 rounded-full bg-white/10 ring-2 ring-amber-300/60 flex items-center justify-center overflow-hidden shrink-0">
          <ClawdSprite state={idleState} size={40} />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-bold text-white text-base drop-shadow">Clawd</span>
            <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-amber-400 text-amber-950 shadow">Lv.{api.level} · {api.title}</span>
          </div>
          <div className="mt-1 flex items-center gap-2">
            <div className="w-36 h-2 rounded-full bg-black/30 overflow-hidden">
              <div className="h-full rounded-full bg-gradient-to-r from-amber-300 to-rose-400 transition-all" style={{ width: `${expPct}%` }} />
            </div>
            <span className="text-[10px] text-white/70 tabular-nums">EXP {api.inLevel}/{api.need}</span>
          </div>
        </div>

        {/* 四维状态 */}
        <div className="flex items-center gap-4 flex-wrap">
          {STAT_META.map((m) => <StatPill key={m.key} meta={m} value={api.stats[m.key]} />)}
        </div>

        <div className="ml-auto flex items-center gap-3">
          <span className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-amber-400/95 text-amber-950 font-bold text-sm shadow">🐚 {api.coins}</span>
          <button type="button" onClick={onClose}
            className="cg-glass w-9 h-9 rounded-xl bg-white/10 hover:bg-white/20 text-white/90 hover:text-white flex items-center justify-center text-xl leading-none transition" title="关闭">×</button>
        </div>
      </header>

      {/* ── 模块浮层（非房间 tab 时叠加在房间之上）── */}
      {tab !== 'room' && (
        <div className="relative z-10 flex-1 min-h-0 flex items-center justify-center p-4" onClick={() => setTab('room')}>
          <div onClick={(e) => e.stopPropagation()}
            className="w-full max-w-[680px] max-h-full overflow-y-auto rounded-2xl bg-white/97 dark:bg-zinc-900/97 backdrop-blur-md shadow-2xl border border-white/40 p-5">
            {tab === 'shop' && <ShopModule api={api} />}
            {tab === 'bag' && <BagModule api={api} />}
            {tab === 'arcade' && <ArcadeModule api={api} />}
            {tab === 'tasks' && <TasksModule api={api} />}
            {tab === 'achs' && <AchsModule api={api} />}
          </div>
        </div>
      )}

      {/* ── 底部标签导航（始终可见，高对比药丸）── */}
      <nav className="relative z-20 mx-auto mb-4 mt-auto flex items-center gap-1.5 px-2 py-2 rounded-2xl
        bg-slate-900/85 backdrop-blur-md shadow-xl border border-white/10">
        {TABS.map((t) => (
          <button key={t.id} type="button" onClick={() => setTab(t.id)}
            className={`px-3.5 py-2 rounded-xl flex flex-col items-center gap-0.5 min-w-[58px] transition ${tab === t.id ? 'cg-amber bg-amber-400 text-amber-950 shadow scale-105' : 'cg-glass text-white/75 hover:bg-white/10 hover:text-white'}`}>
            <span className="text-xl leading-none">{t.icon}</span>
            <span className="text-[11px] font-medium">{t.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}

// 模块统一标题
function ModuleHead({ title, right }: { title: string; right?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between mb-4">
      <h3 className="font-bold text-lg text-gray-800 dark:text-gray-100">{title}</h3>
      {right}
    </div>
  );
}

// ─── 🛒 商店 ──────────────────────────────────────────────────────────────────
function ShopModule({ api }: { api: CrabHomeApi }) {
  const [flash, setFlash] = useState<string | null>(null);
  const buy = (id: string) => { if (api.buyFood(id)) { setFlash(id); window.setTimeout(() => setFlash(null), 600); } };
  return (
    <div>
      <ModuleHead title="🛒 海鲜杂货铺" right={<span className="text-sm font-bold text-amber-600 dark:text-amber-400">🐚 {api.coins}</span>} />
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {FOODS.map((f) => {
          const afford = api.coins >= f.cost;
          const effects = [f.hunger && `🍤+${f.hunger}`, f.mood && `😊+${f.mood}`, f.energy && `⚡+${f.energy}`, f.clean && `🛁+${f.clean}`].filter(Boolean).join('  ');
          return (
            <div key={f.id} className={`rounded-2xl border-2 p-3 flex flex-col items-center gap-1.5 transition ${flash === f.id ? 'border-green-400 bg-green-50 dark:bg-green-900/25 scale-105' : 'border-gray-100 dark:border-white/10 bg-gray-50 dark:bg-zinc-800/60'}`}>
              <span className="text-4xl">{f.emoji}</span>
              <span className="text-sm font-semibold text-gray-800 dark:text-gray-100">{f.name}</span>
              <span className="text-[10px] text-gray-500 dark:text-gray-400 text-center leading-tight min-h-[14px]">{effects}</span>
              <button type="button" disabled={!afford} onClick={() => buy(f.id)}
                className={`mt-1 w-full py-1.5 rounded-xl text-sm font-bold transition ${afford ? 'cg-amber bg-amber-400 hover:bg-amber-500 text-amber-950 active:scale-95 shadow' : 'cg-muted bg-gray-200 dark:bg-white/5 text-gray-400 cursor-not-allowed'}`}>🐚 {f.cost}</button>
            </div>
          );
        })}
      </div>
      <p className="mt-4 text-xs text-gray-500 dark:text-gray-400">买来的食物存进 🎒 背包，去背包里喂给螃蟹～</p>
    </div>
  );
}

// ─── 🎒 背包 ──────────────────────────────────────────────────────────────────
function BagModule({ api }: { api: CrabHomeApi }) {
  const owned = FOODS.filter((f) => (api.food[f.id] ?? 0) > 0);
  const [eaten, setEaten] = useState<string | null>(null);
  const eat = (id: string) => { if (api.useFood(id)) { setEaten(id); window.setTimeout(() => setEaten(null), 700); } };
  return (
    <div>
      <ModuleHead title="🎒 背包" />
      {owned.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-14 text-gray-400 gap-3">
          <span className="text-5xl">🍽️</span>
          <span className="text-sm">背包空空的，去商店买点吃的吧～</span>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {owned.map((f) => (
            <div key={f.id} className={`relative rounded-2xl border-2 p-3 flex flex-col items-center gap-1.5 transition ${eaten === f.id ? 'border-pink-400 bg-pink-50 dark:bg-pink-900/25 scale-105' : 'border-gray-100 dark:border-white/10 bg-gray-50 dark:bg-zinc-800/60'}`}>
              <span className="absolute top-2 right-2.5 text-xs font-extrabold text-amber-600 dark:text-amber-400">×{api.food[f.id]}</span>
              <span className="text-4xl">{f.emoji}</span>
              <span className="text-sm font-semibold text-gray-800 dark:text-gray-100">{f.name}</span>
              <button type="button" onClick={() => eat(f.id)}
                className="cg-pink mt-1 w-full py-1.5 rounded-xl text-sm font-bold bg-pink-400 hover:bg-pink-500 text-white active:scale-95 transition shadow">喂给它 🍽️</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── 🎮 游戏厅 ────────────────────────────────────────────────────────────────
function ArcadeModule({ api }: { api: CrabHomeApi }) {
  const [playing, setPlaying] = useState(false);
  const [last, setLast] = useState<number | null>(null);
  const onEnd = (score: number) => { setPlaying(false); setLast(score); api.playWin(score); };
  return (
    <div>
      <ModuleHead title="🎮 游戏厅 · 接虾大作战" />
      <div className="relative rounded-2xl overflow-hidden border-2 border-sky-200 dark:border-white/10"
        style={{ height: 380, background: 'linear-gradient(180deg,#bfe9ff 0%,#e9f8ff 100%)' }}>
        {playing ? <ShrimpGame onEnd={onEnd} /> : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
            <ClawdSprite state="happy" size={84} />
            <p className="text-sm text-gray-600 text-center max-w-[70%]">15 秒内尽量多点中掉落的 🦐，<br />每只 +1 心情、+1 贝壳！</p>
            {last !== null && <p className="text-base font-bold text-amber-600">上局接住 🦐 ×{last}</p>}
            <button type="button" onClick={() => { setPlaying(true); setLast(null); }}
              className="cg-amber px-6 py-2.5 rounded-2xl bg-amber-400 hover:bg-amber-500 text-amber-950 font-bold active:scale-95 transition shadow-lg">▶ 开始游戏</button>
          </div>
        )}
      </div>
      <div className="mt-3 flex items-center gap-5 text-xs text-gray-500 dark:text-gray-400">
        <span>累计游玩 <b className="text-gray-700 dark:text-gray-200">{api.counters.totalPlay}</b> 局</span>
        <span>历史接虾 <b className="text-gray-700 dark:text-gray-200">{api.counters.shrimpCaught}</b> 只</span>
      </div>
    </div>
  );
}

// ─── 📋 每日任务 ──────────────────────────────────────────────────────────────
function TasksModule({ api }: { api: CrabHomeApi }) {
  return (
    <div>
      <ModuleHead title="📋 每日任务" right={<span className="text-xs text-gray-400">每天 0 点刷新</span>} />
      <div className="flex flex-col gap-3">
        {api.taskList.map((t) => (
          <div key={t.id} className="rounded-2xl border-2 border-gray-100 dark:border-white/10 p-3.5 bg-gray-50 dark:bg-zinc-800/60 flex items-center gap-4">
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-gray-800 dark:text-gray-100">{t.label}</div>
              <div className="mt-2 flex items-center gap-2">
                <div className="flex-1 h-2 rounded-full bg-gray-200 dark:bg-white/10 overflow-hidden">
                  <div className="h-full rounded-full bg-amber-400 transition-all" style={{ width: `${(t.progress / t.need) * 100}%` }} />
                </div>
                <span className="text-[11px] text-gray-500 dark:text-gray-400 tabular-nums font-medium">{t.progress}/{t.need}</span>
              </div>
            </div>
            <button type="button" disabled={!t.done || t.claimed} onClick={() => api.claimTask(t.id)}
              className={`shrink-0 px-4 py-2 rounded-xl text-sm font-bold transition ${t.claimed ? 'cg-muted bg-gray-200 dark:bg-white/5 text-gray-400' : t.done ? 'cg-amber bg-amber-400 hover:bg-amber-500 text-amber-950 active:scale-95 shadow' : 'cg-muted bg-gray-200 dark:bg-white/5 text-gray-400 cursor-not-allowed'}`}>
              {t.claimed ? '已领取' : `🐚 +${t.reward}`}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── 🏆 成就 ──────────────────────────────────────────────────────────────────
function AchsModule({ api }: { api: CrabHomeApi }) {
  const unlocked = api.achList.filter((a) => a.unlocked).length;
  return (
    <div>
      <ModuleHead title="🏆 成就" right={<span className="text-xs text-gray-400">{unlocked}/{ACHS.length} 已解锁</span>} />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {api.achList.map((a) => (
          <div key={a.id} className={`rounded-2xl border-2 p-3.5 flex items-center gap-3 transition ${a.unlocked ? 'border-amber-300 bg-amber-50 dark:bg-amber-900/20' : 'border-gray-100 dark:border-white/10 bg-gray-50 dark:bg-zinc-800/60 opacity-65'}`}>
            <span className={`text-3xl ${a.unlocked ? '' : 'grayscale'}`}>{a.icon}</span>
            <div className="min-w-0">
              <div className="text-sm font-bold text-gray-800 dark:text-gray-100">{a.name}</div>
              <div className="text-xs text-gray-500 dark:text-gray-400 truncate">{a.desc}</div>
            </div>
            {a.unlocked && <span className="ml-auto text-[10px] px-2 py-1 rounded-full bg-amber-400 text-amber-950 font-bold shrink-0">已达成</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
