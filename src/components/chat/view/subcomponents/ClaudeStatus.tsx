import { useEffect, useRef, useState, useCallback } from 'react';
import { useWebSocket } from '../../../../contexts/WebSocketContext';
import { getProviderLabel } from '../../utils/providerLabels';
import { ClawdSprite, type ClawdState } from './ClawdSprite';
import { useCrabHome } from './CrabHome';
import { CrabGame } from './CrabGame';

type ClaudeStatusProps = {
  status: {
    text?: string;
    tokens?: number;
    inputTokens?: number;
    outputTokens?: number;
    startedAt?: number | string;
    can_interrupt?: boolean;
  } | null;
  onAbort?: () => void;
  isLoading: boolean;
  provider?: string;
};

const ACTION_WORDS = [
  'Thinking',      'Reasoning',     'Inferring',     'Contemplating',
  'Synthesizing',  'Orchestrating', 'Distilling',    'Crystallizing',
  'Traversing',    'Propagating',   'Extrapolating', 'Converging',
  'Introspecting', 'Calibrating',   'Unraveling',    'Percolating',
  'Simulating',    'Correlating',   'Abstracting',   'Iterating',
];

const parseStartedAt = (startedAt?: number | string | null) => {
  if (typeof startedAt === 'number' && Number.isFinite(startedAt)) {
    return startedAt;
  }
  if (typeof startedAt === 'string' && startedAt.trim()) {
    const numeric = Number(startedAt);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
    const parsed = Date.parse(startedAt);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
};

// ─── Pixel Crab ──────────────────────────────────────────────────────────────
// P=3px per unit, canvas=22×16 units (66×48 px)
// Rows 0-11: crab body + legs, rows 12-15: keyboard
const P = 3;
const CW = 22; // canvas cols
const CH = 16; // canvas rows

type Px = readonly [number, number];
const range = (x1: number, x2: number, y: number): Px[] =>
  Array.from({ length: x2 - x1 + 1 }, (_, i) => [x1 + i, y] as const);

// ── Body (orange shell) ──────────────────────────────────────────────────────
const BODY: Px[] = [
  ...range(8, 13, 1),   // 顶冠
  ...range(6, 15, 2),   // 上壳
  ...range(5, 16, 3),   // 眼行
  ...range(5, 16, 4),   // 中壳
  ...range(5, 16, 5),   // 下壳
  ...range(6, 15, 6),   // 腹
];
// 高光
const SHINE: Px[] = [[8,2],[9,2],[10,2],[8,3]];
// 眼睛
const EYES: Px[] = [[7,3],[8,3],[13,3],[14,3]];

// ── Claws ────────────────────────────────────────────────────────────────────
// 左螯：从 col 5 向左伸出
const LCLAW: Px[] = [
  [2,1],[3,1],                        // 螯尖上
  [1,2],[2,2],[3,2],[4,2],            // 上臂
  [0,3],[1,3],[2,3],[3,3],[4,3],      // 中臂（与身体相接）
  [1,4],[2,4],[3,4],[4,4],            // 下臂
  [2,5],[3,5],                        // 螯尖下
];
// 右螯（镜像）
const RCLAW: Px[] = [
  [18,1],[19,1],
  [17,2],[18,2],[19,2],[20,2],
  [17,3],[18,3],[19,3],[20,3],[21,3],
  [17,4],[18,4],[19,4],[20,4],
  [18,5],[19,5],
];

// ── Legs（3 对，每侧清晰可见）────────────────────────────────────────────────
// 左腿：从身体左下角（col 5-6, row 6-7）向左下方延伸
const LLEGS: Px[] = [
  // 第1对（前腿）
  [4,6],[3,7],[2,7],[1,8],
  // 第2对（中腿）
  [4,7],[3,8],[2,9],[1,9],
  // 第3对（后腿）
  [5,8],[4,9],[3,9],[2,10],[1,10],
];
// 右腿（镜像，从 col 16-17 向右下）
const RLEGS: Px[] = [
  [17,6],[18,7],[19,7],[20,8],
  [17,7],[18,8],[19,9],[20,9],
  [16,8],[17,9],[18,9],[19,10],[20,10],
];

// ── Antennae ─────────────────────────────────────────────────────────────────
const ANT: Px[] = [[8,0],[13,0],[7,1],[8,1],[13,1],[14,1]];

// ── Keyboard（rows 12-15, cols 2-19）────────────────────────────────────────
// 键盘框体
const KB_FRAME: Px[] = [
  ...range(2, 19, 12),  // 顶边
  ...range(2, 19, 13),  // 键行
  ...range(2, 19, 14),  // 空格行
  ...range(2, 19, 15),  // 底边
];
// 普通按键（亮一些，row 13，每隔1格）
const KEYS: Px[] = [
  [3,13],[4,13],
  [6,13],[7,13],
  [9,13],[10,13],
  [12,13],[13,13],
  [15,13],[16,13],
  [18,13],[19,13],
];
// 打字时点亮的按键（橙色）
const KEYS_GROUP_A: Px[] = [[6,13],[7,13],[12,13],[13,13]];
const KEYS_GROUP_B: Px[] = [[9,13],[10,13],[3,13],[4,13]];
const KEYS_GROUP_C: Px[] = [[15,13],[16,13],[18,13],[19,13]];
// 空格键（row 14 中间）
const SPACEBAR: Px[] = range(5, 16, 14);

// ── Render helper ─────────────────────────────────────────────────────────────
function px(pixels: Px[], fill: string, key: string) {
  return pixels.map(([x, y], i) => (
    <rect key={`${key}${i}`} x={x * P} y={y * P} width={P} height={P} fill={fill} />
  ));
}

const C = {
  body:    '#D45E00',
  shine:   '#F07830',
  claw:    '#A03800',
  eye:     '#111827',
  ant:     '#F5A623',
  leg:     '#B85000',
  kb:      '#181828',     // 键盘体
  key:     '#2e2e48',     // 普通键
  keyLit:  '#E85D04',     // 打字时亮起的键
  space:   '#252538',     // 空格键
  spaceLit:'#C04A00',     // 打字时空格
} as const;

const CRAB_CSS = `
  @keyframes crab-lclaw-type {
    0%,100% { transform: translateY(0px); }
    50%      { transform: translateY(-${P*2}px); }
  }
  @keyframes crab-rclaw-type {
    0%,100% { transform: translateY(-${P*2}px); }
    50%      { transform: translateY(0px); }
  }
  @keyframes crab-body-bounce {
    0%,100% { transform: translateY(0px); }
    50%      { transform: translateY(-${P}px); }
  }
  @keyframes crab-idle-sway {
    0%,100% { transform: translateX(0px); }
    25%      { transform: translateX(-${P}px); }
    75%      { transform: translateX(${P}px); }
  }
  @keyframes crab-idle-lclaw {
    0%,100% { transform: translateY(0px); }
    50%      { transform: translateY(-${P}px); }
  }
  @keyframes crab-idle-rclaw {
    0%,100% { transform: translateY(-${P}px); }
    50%      { transform: translateY(0px); }
  }
  @keyframes crab-blink {
    0%,88%,100% { transform: scaleY(1); }
    93%          { transform: scaleY(0.1); }
  }
  @keyframes crab-key-a {
    0%,30%,100% { opacity:0.25; }
    10%,20%     { opacity:1; }
  }
  @keyframes crab-key-b {
    0%,50%,100% { opacity:0.25; }
    30%,45%     { opacity:1; }
  }
  @keyframes crab-key-c {
    0%,80%,100% { opacity:0.25; }
    60%,75%     { opacity:1; }
  }
  @keyframes crab-space-press {
    0%,100%     { opacity:0.3; }
    50%         { opacity:0.9; }
  }
  @keyframes status-cursor {
    0%,49%  { opacity: 1; }
    50%,99% { opacity: 0; }
  }
`;

// ── 5种工作模式参数 ───────────────────────────────────────────────────────────
type CrabMode = 'idle' | 'think' | 'read' | 'write' | 'bash' | 'search';

// 根据状态文本推断螃蟹模式
function getCrabMode(text: string): CrabMode {
  const t = text.toLowerCase();
  if (!t) return 'think';
  if (t.includes('bash') || t.includes('run') || t.includes('exec') || t.includes('debug') || t.includes('compil')) return 'bash';
  if (t.includes('search') || t.includes('grep') || t.includes('glob') || t.includes('travers') || t.includes('propagat')) return 'search';
  if (t.includes('read') || t.includes('view') || t.includes('inspect') || t.includes('review') || t.includes('converge') || t.includes('percolat') || t.includes('correlat')) return 'read';
  if (t.includes('write') || t.includes('edit') || t.includes('creat') || t.includes('generat') || t.includes('distill') || t.includes('crystal') || t.includes('iter') || t.includes('synth') || t.includes('orchestrat') || t.includes('calibrat') || t.includes('abstract')) return 'write';
  return 'think'; // think/reason/analyze/infer/contemplate/extrapolate/introspect/unravel/simulate
}

// 模式 → 动画参数
const MODE_CFG: Record<CrabMode, {
  bodyAnim: string; bodyDur: string;
  lclawAnim: string; lclawDur: string;
  rclawAnim: string; rclawDur: string;
  keys: 'none' | 'sparse' | 'full' | 'blaze';
  keyDur: string;
  spaceDur: string;
  keyColor: string;
  blink: boolean;
}> = {
  idle:   { bodyAnim:'crab-idle-sway',   bodyDur:'3s',    lclawAnim:'crab-idle-lclaw', lclawDur:'2.5s', rclawAnim:'crab-idle-rclaw', rclawDur:'2.5s', keys:'none',   keyDur:'0.6s',  spaceDur:'0.4s',  keyColor:C.keyLit, blink:true  },
  think:  { bodyAnim:'crab-body-bounce', bodyDur:'1.8s',  lclawAnim:'crab-idle-lclaw', lclawDur:'2.8s', rclawAnim:'crab-idle-rclaw', rclawDur:'2.8s', keys:'none',   keyDur:'1.2s',  spaceDur:'1.0s',  keyColor:C.keyLit, blink:true  },
  read:   { bodyAnim:'crab-body-bounce', bodyDur:'1.2s',  lclawAnim:'crab-lclaw-type', lclawDur:'1.5s', rclawAnim:'crab-idle-rclaw', rclawDur:'3s',   keys:'sparse', keyDur:'1.2s',  spaceDur:'1.0s',  keyColor:'#C04A00', blink:false },
  write:  { bodyAnim:'crab-body-bounce', bodyDur:'0.4s',  lclawAnim:'crab-lclaw-type', lclawDur:'0.5s', rclawAnim:'crab-rclaw-type', rclawDur:'0.5s', keys:'full',   keyDur:'0.6s',  spaceDur:'0.4s',  keyColor:C.keyLit, blink:false },
  bash:   { bodyAnim:'crab-body-bounce', bodyDur:'0.12s', lclawAnim:'crab-lclaw-type', lclawDur:'0.15s',rclawAnim:'crab-rclaw-type', rclawDur:'0.15s',keys:'blaze',  keyDur:'0.18s', spaceDur:'0.12s', keyColor:'#facc15', blink:false },
  search: { bodyAnim:'crab-body-bounce', bodyDur:'0.8s',  lclawAnim:'crab-lclaw-type', lclawDur:'0.9s', rclawAnim:'crab-rclaw-type', rclawDur:'1.1s', keys:'sparse', keyDur:'0.8s',  spaceDur:'0.6s',  keyColor:'#38bdf8', blink:false },
};

function PixelCrab({ mode, showKeyboard = true }: { mode: CrabMode; showKeyboard?: boolean }) {
  const cfg = MODE_CFG[mode];

  return (
    <>
      <style>{CRAB_CSS}</style>
      <svg
        width={CW * P}
        height={(showKeyboard ? CH : 11) * P}
        style={{ imageRendering: 'pixelated', display: 'block', flexShrink: 0 }}
        aria-hidden="true"
      >
        {/* ── 键盘（仅工作态显示；在「小窝」里隐藏，只剩螃蟹本体）──── */}
        {showKeyboard && (
          <>
            {px(KB_FRAME, C.kb, 'kb')}
            {px(KEYS,     C.key, 'ky')}
            {px(SPACEBAR, C.space, 'sp')}

            {/* 按键亮起：sparse=仅A组, full=A+B+C, blaze=所有同时亮 */}
            {cfg.keys !== 'none' && (
              <>
                <g style={{ animation: `crab-key-a ${cfg.keyDur} ease-in-out infinite` }}>
                  {px(KEYS_GROUP_A, cfg.keyColor, 'ka')}
                </g>
                {(cfg.keys === 'full' || cfg.keys === 'blaze') && (
                  <g style={{ animation: `crab-key-b ${cfg.keyDur} ease-in-out infinite ${cfg.keys === 'blaze' ? '0s' : '0.2s'}` }}>
                    {px(KEYS_GROUP_B, cfg.keyColor, 'kb2')}
                  </g>
                )}
                {(cfg.keys === 'full' || cfg.keys === 'blaze') && (
                  <g style={{ animation: `crab-key-c ${cfg.keyDur} ease-in-out infinite ${cfg.keys === 'blaze' ? '0s' : '0.4s'}` }}>
                    {px(KEYS_GROUP_C, cfg.keyColor, 'kc')}
                  </g>
                )}
                <g style={{ animation: `crab-space-press ${cfg.spaceDur} ease-in-out infinite 0.1s` }}>
                  {px(SPACEBAR, C.spaceLit, 'sl')}
                </g>
              </>
            )}
          </>
        )}

        {/* ── 触角（不参与动画）───────────────────────────── */}
        {px(ANT, C.ant, 'ant')}

        {/* ── 身体动画组──────────────────────────────────── */}
        <g style={{ animation: `${cfg.bodyAnim} ${cfg.bodyDur} ease-in-out infinite` }}>
          {px(BODY,  C.body,  'bd')}
          {px(SHINE, C.shine, 'sh')}

          {/* 眼睛（think/idle 模式眨眼）*/}
          <g style={cfg.blink ? {
            transformOrigin: `${10.5 * P}px ${3.5 * P}px`,
            animation: 'crab-blink 4s ease-in-out infinite',
          } : undefined}>
            {px(EYES, C.eye, 'ey')}
          </g>

          {/* 腿跟随身体 */}
          {px(LLEGS, C.leg, 'll')}
          {px(RLEGS, C.leg, 'rl')}
        </g>

        {/* ── 螯（独立动画）────────────────────────────────── */}
        <g style={{ transformOrigin: `${2.5 * P}px ${3 * P}px`, animation: `${cfg.lclawAnim} ${cfg.lclawDur} ease-in-out infinite` }}>
          {px(LCLAW, C.claw, 'lc')}
        </g>
        <g style={{ transformOrigin: `${19.5 * P}px ${3 * P}px`, animation: `${cfg.rclawAnim} ${cfg.rclawDur} ease-in-out infinite` }}>
          {px(RCLAW, C.claw, 'rc')}
        </g>
      </svg>
    </>
  );
}

// 工作模式（getCrabMode 输出）→ Clawd 状态行
const MODE_TO_STATE: Record<CrabMode, ClawdState> = {
  idle: 'idle', think: 'think', read: 'scan', search: 'look', write: 'type', bash: 'type',
};
// 个别模式加速/减速（bash 疯狂敲键盘）
const MODE_DUR_SCALE: Partial<Record<CrabMode, number>> = { bash: 0.5, search: 0.85 };

// ─── 空闲态：输入框上的桌宠入口 + 通知（点开进「螃蟹之家」养成）──────────────────
const HOVER_PHRASES = ['点我回家玩玩～', '宝宝累了吗？戳戳我', '进来看看小窝嘛'];
const pick = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

function IdleCrabPet() {
  const home = useCrabHome();
  const [open, setOpen] = useState(false);
  const [hovering, setHovering] = useState(false);
  const [hoverPhrase, setHoverPhrase] = useState('');
  const [notice, setNotice] = useState<string>('');   // 底栏弹出的提醒气泡
  const lastNoticeRef = useRef(0);
  const seenRef = useRef<string>('');
  const containerRef = useRef<HTMLDivElement | null>(null);

  // ── 待机漫步：螃蟹在整条横行里随机、自由地左右走动 ──────────────────────
  const [pos, setPos] = useState(50);        // 当前水平位置（0~100，%）
  const [walking, setWalking] = useState(false);
  const [facingLeft, setFacingLeft] = useState(false);
  const [moveDur, setMoveDur] = useState(4); // 本段位移时长（秒），驱动 CSS transition
  const posRef = useRef(pos);
  posRef.current = pos;

  useEffect(() => {
    if (open) return; // 打开小窝面板时停止漫步
    let alive = true;
    let standTimer = 0;
    let walkTimer = 0;
    const step = () => {
      if (!alive) return;
      const cur = posRef.current;
      // 随机新目标 8%~92%，确保与当前至少差 15%，避免原地微动
      let target = cur;
      for (let i = 0; i < 6; i++) {
        const t = 8 + Math.random() * 84;
        if (Math.abs(t - cur) > 15) { target = t; break; }
      }
      const dist = Math.abs(target - cur);
      const dur = Math.max(1.5, dist / 11); // 速度约 11%/秒，距离越远走越久
      setFacingLeft(target < cur);
      setMoveDur(dur);
      setWalking(true);
      setPos(target);
      walkTimer = window.setTimeout(() => {
        if (!alive) return;
        setWalking(false);
        // 到达后站立停留 2~5s（眨眼/张望），再启程
        standTimer = window.setTimeout(step, 2000 + Math.random() * 3000);
      }, dur * 1000);
    };
    // 首次延迟一会儿再开始漫步
    standTimer = window.setTimeout(step, 1200 + Math.random() * 1500);
    return () => { alive = false; window.clearTimeout(standTimer); window.clearTimeout(walkTimer); };
  }, [open]);

  // 点击面板外部时关闭
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // 状态过低时弹通知气泡（节流 ≥45s，且仅在面板关闭时打扰）
  const alertKey = home.alerts.map((a) => a.key).join(',');
  useEffect(() => {
    if (open || home.alerts.length === 0) return;
    const now = Date.now();
    if (alertKey === seenRef.current && now - lastNoticeRef.current < 45_000) return;
    if (now - lastNoticeRef.current < 12_000) return;
    seenRef.current = alertKey;
    lastNoticeRef.current = now;
    const top = home.alerts[0];
    setNotice(`${top.emoji} ${top.label}`);
    const id = window.setTimeout(() => setNotice(''), 6000);
    return () => window.clearTimeout(id);
  }, [alertKey, open, home.alerts]);

  const idleState: ClawdState = home.isSick ? 'error' : 'idle';
  const badge = home.alerts.length;

  // 待机时螃蟹状态：生病→error；漫步中→scan（扫视/走动）；否则 idle 眨眼
  const walkState: ClawdState = home.isSick ? 'error' : walking ? 'scan' : idleState;

  return (
    <div className="w-full mb-1 sm:mb-2">
      {/* 整条横行作为螃蟹的活动舞台：无边框、透明，螃蟹贴底自由左右漫步 */}
      <div ref={containerRef} className="relative w-full h-[84px] sm:h-[104px] overflow-visible select-none">
        {/* 漫步中的螃蟹：用合成层位移，避免 left 动画每帧触发布局。 */}
        <div
          className="absolute inset-x-0 bottom-0 flex justify-center pointer-events-none"
          style={{
            transform: `translate3d(${pos - 50}%, 0, 0)`,
            transition: `transform ${moveDur}s linear`,
            willChange: 'transform',
          }}
        >
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            onMouseEnter={() => { setHovering(true); setHoverPhrase(pick(HOVER_PHRASES)); }}
            onMouseLeave={() => setHovering(false)}
            className="tech-bare pointer-events-auto relative block p-0 border-0 bg-transparent cursor-pointer opacity-95 hover:opacity-100 transition-opacity"
            title="点我回家玩玩～"
          >
            <ClawdSprite state={walkState} size={92} flip={facingLeft} />
            {/* 未读提醒红点 */}
            {badge > 0 && !open && (
              <span className="absolute top-1 right-1 min-w-[16px] h-[16px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center shadow">{badge}</span>
            )}

            {/* 悬停气泡（跟随螃蟹移动） */}
            {hovering && !open && !notice && (
              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-0.5 whitespace-nowrap px-2 py-1 rounded-lg bg-gray-800 text-white text-[10px] shadow-md pointer-events-none">
                Lv.{home.level} {home.title} · {hoverPhrase}
              </div>
            )}
            {/* 状态提醒气泡（跟随螃蟹移动） */}
            {notice && !open && (
              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-0.5 whitespace-nowrap px-2 py-1 rounded-lg bg-orange-500 text-white text-[10px] shadow-md pointer-events-none animate-bounce">
                {notice}
              </div>
            )}
          </button>
        </div>

        {open && <CrabGame api={home} onClose={() => setOpen(false)} />}
      </div>
    </div>
  );
}

// ─── 工作态：工作中的螃蟹 sprite 也可点击进「螃蟹之家」──────────────────────────
// 与 IdleCrabPet 互斥（同一时刻只渲染其一），因此各自独立调用 useCrabHome 不会
// 造成双份 localStorage 写入 / 双倍衰减计时。
function WorkingCrabPet({ crabMode }: { crabMode: CrabMode }) {
  const home = useCrabHome();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // 点击面板外部时关闭
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  return (
    <div ref={containerRef} className="flex-shrink-0 self-end relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="tech-bare block p-0 border-0 bg-transparent cursor-pointer"
        title="点我回家玩玩～"
      >
        <ClawdSprite state={MODE_TO_STATE[crabMode]} size={92} durScale={MODE_DUR_SCALE[crabMode] ?? 1} />
      </button>
      {open && <CrabGame api={home} onClose={() => setOpen(false)} />}
    </div>
  );
}

// ─── Terminal-style status text ──────────────────────────────────────────────
// 颜色映射：根据操作关键字返回终端色
function getActionColor(t: string): string {
  if (t.includes('read') || t.includes('view') || t.includes('inspect') || t.includes('review')) return '#fb923c';  // 橙
  if (t.includes('write') || t.includes('edit') || t.includes('creat') || t.includes('generat')) return '#facc15';  // 黄
  if (t.includes('bash') || t.includes('run') || t.includes('exec') || t.includes('debug')) return '#4ade80';       // 绿
  if (t.includes('search') || t.includes('grep') || t.includes('glob') || t.includes('summar')) return '#38bdf8';   // 蓝
  if (t.includes('think') || t.includes('reason') || t.includes('analyz') || t.includes('evaluat') || t.includes('plan')) return '#a78bfa'; // 紫
  if (t.includes('work') || t.includes('process') || t.includes('comput')) return '#f97316';                        // 深橙
  return '#fb923c'; // 默认橙
}

function TerminalText({ text, elapsed }: { text: string; elapsed: number }) {
  const [dotPhase, setDotPhase] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setDotPhase(p => (p + 1) % 4), 400);
    return () => window.clearInterval(id);
  }, []);

  const dots = ['', '.', '..', '...'][dotPhase];
  const actionColor = getActionColor(text.toLowerCase());

  // 识别文件路径，高亮显示
  const pathRe = /(\/[^\s"'<>]+)/g;
  const parts: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = pathRe.exec(text)) !== null) {
    if (m.index > last) {
      parts.push(<span key={`t${last}`} style={{ color: actionColor }}>{text.slice(last, m.index)}</span>);
    }
    parts.push(<span key={`p${m.index}`} style={{ color: '#fcd34d' }}>{m[0]}</span>);
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    parts.push(<span key={`te${last}`} style={{ color: actionColor }}>{text.slice(last)}</span>);
  }

  return (
    <span className="font-mono text-xs sm:text-sm leading-tight select-none" style={{ textShadow: '0 1px 2px rgba(0,0,0,0.28)' }}>
      <span className="tech-status-dot" />
      <span style={{ color: '#4ade80' }}>$&nbsp;</span>
      {parts}
      {/* 动画省略号（覆盖文字末尾的静态空间） */}
      <span style={{ color: actionColor, minWidth: '1.5ch', display: 'inline-block' }}>{dots}</span>
      <span style={{ color: '#60a5fa' }} className="ml-2">({elapsed}s)</span>
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
export default function ClaudeStatus({
  status,
  onAbort,
  isLoading,
  provider = 'claude',
}: ClaudeStatusProps) {
  const { isConnected } = useWebSocket();
  const [elapsedTime, setElapsedTime] = useState(0);
  const [disconnectDismissed, setDisconnectDismissed] = useState(false);
  // Normal reconnects finish within a few seconds. Keep those silent and only
  // surface a warning when the connection is genuinely unavailable.
  const [showDisconnected, setShowDisconnected] = useState(false);
  const providerLabel = getProviderLabel(provider);

  useEffect(() => {
    if (isConnected) {
      setDisconnectDismissed(false);
      setShowDisconnected(false);
      return;
    }
    const timer = setTimeout(() => setShowDisconnected(true), 10000);
    return () => clearTimeout(timer);
  }, [isConnected]);

  useEffect(() => {
    if (!isLoading) {
      sessionStorage.removeItem('task_start_time');
      setElapsedTime(0);
      return;
    }
    // 刷新恢复：复用已存储的开始时间，使 elapsed 连续
    const statusStartedAt = parseStartedAt(status?.startedAt);
    const stored = sessionStorage.getItem('task_start_time');
    const storedStartTime = stored ? parseInt(stored, 10) : null;
    const startTime = statusStartedAt || storedStartTime || Date.now();
    sessionStorage.setItem('task_start_time', String(startTime));

    setDisconnectDismissed(false);
    setElapsedTime(Math.max(0, Math.floor((Date.now() - startTime) / 1000)));
    const timer = window.setInterval(() => {
      setElapsedTime(Math.floor((Date.now() - startTime) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [isLoading, status?.startedAt]);

  const actionIndex = Math.floor(elapsedTime / 2) % ACTION_WORDS.length;
  // 当后端没有返回具体工具名时（空串或仅 'Processing'），用前端循环词
  const backendText = status?.text && status.text !== 'Processing' ? status.text : '';
  const statusText  = backendText || ACTION_WORDS[actionIndex];
  // The status row is strictly per turn. Context usage and Goal totals are
  // separate cumulative metrics and must never be used as a fallback here.
  const displayInput = status?.inputTokens ?? 0;
  // ↓：流式估算从第一个 content chunk 就开始增长，outputTokens 不为 0 即显示
  const displayOutput = status?.outputTokens ?? 0;
  // 工作中时始终显示 token 行，有值就填数字，否则显示 ---
  const showTokenRow = isLoading;
  const canInterrupt = status?.can_interrupt !== false;
  // 根据当前动作文字推断螃蟹模式（5种工作态 + idle）
  const crabMode = isLoading ? getCrabMode(statusText) : 'idle';

  // ── 断连警告 ────────────────────────────────────────────────────────────
  if (showDisconnected && !isConnected && !disconnectDismissed) {
    return (
      <div className="w-full mb-2 animate-in slide-in-from-bottom duration-300">
        <div className="flex items-center mx-auto bg-red-900/90 text-white rounded-lg shadow-lg px-2.5 py-2 sm:px-3 border border-red-700/60 gap-2">
          <div className="flex-shrink-0">
            <ClawdSprite state="error" size={36} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="font-medium text-xs sm:text-sm">与服务器连接已断开</div>
            <div className="text-red-300 text-xs mt-0.5">正在重连，未确认的 {providerLabel} 命令会在连接恢复后自动重发</div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {onAbort && (
              <button type="button" onClick={onAbort}
                className="text-xs bg-red-600 hover:bg-red-700 text-white px-2.5 py-1.5 rounded-md transition-colors">
                取消
              </button>
            )}
            <button type="button" onClick={() => setDisconnectDismissed(true)}
              className="text-xs bg-gray-600 hover:bg-gray-500 text-white px-2.5 py-1.5 rounded-md transition-colors">
              确定
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── 未加载时：可点击互动的桌宠（点开「小窝」摸摸/投喂）──────────────────────
  if (!isLoading) {
    return <IdleCrabPet />;
  }

  // ── Processing 状态条 ────────────────────────────────────────────────────
  return (
    <div className="w-full mb-3 sm:mb-6 animate-in slide-in-from-bottom duration-300">
      {/* 主状态栏：无边框、透明背景，螃蟹与终端文字直接融入页面背景 */}
      <div className="flex items-center mx-auto px-1 py-0.5 gap-3 sm:gap-4">
        {/* 螃蟹工作动画（sprite）—— 放大，无框，可点击进「螃蟹之家」 */}
        <WorkingCrabPet crabMode={crabMode} />

        {/* 终端文字区 */}
        <div className="flex-1 min-w-0 overflow-hidden">
          <TerminalText text={statusText} elapsed={elapsedTime} />
          {/* token 行：工作中始终显示，数字实时更新 */}
          {showTokenRow && (
            <div className="text-[10px] sm:text-xs font-mono mt-0.5">
              <span
                title={provider === 'codex'
                  ? '本轮累计模型输入 tokens（包含本轮读取的会话上下文，与 Codex 官方口径一致）'
                  : '本轮累计模型输入 tokens（包含缓存命中的上下文）'}
                style={{ color: '#86efac' }}
              >
                ↑{displayInput > 0 ? displayInput.toLocaleString() : '---'}
              </span>
              <span className="mx-1" style={{ color: '#4b5563' }}>·</span>
              <span title="本轮累计模型输出 tokens（实时增长）" style={{ color: '#93c5fd' }}>
                ↓{displayOutput > 0 ? displayOutput.toLocaleString() : '0'}
              </span>
              <span className="ml-3" style={{ color: '#60a5fa' }}>esc to stop</span>
            </div>
          )}
        </div>

        {/* Stop 按钮 */}
        {canInterrupt && onAbort && (
          <button
            type="button"
            onClick={onAbort}
            className="flex-shrink-0 text-xs bg-red-700/70 hover:bg-red-600 text-white px-2.5 py-1.5 sm:px-3 sm:py-2 rounded-lg transition-colors flex items-center gap-1 font-medium border border-red-600/30"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
            <span className="hidden sm:inline">Stop</span>
          </button>
        )}
      </div>
    </div>
  );
}
