import { useEffect, useRef, useState, useCallback } from 'react';
import { useWebSocket } from '../../../../contexts/WebSocketContext';

type ClaudeStatusProps = {
  status: {
    text?: string;
    tokens?: number;
    inputTokens?: number;
    outputTokens?: number;
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

function PixelCrab({ mode }: { mode: CrabMode }) {
  const cfg = MODE_CFG[mode];
  const isIdle = mode === 'idle';

  return (
    <>
      <style>{CRAB_CSS}</style>
      <svg
        width={CW * P}
        height={CH * P}
        style={{ imageRendering: 'pixelated', display: 'block', flexShrink: 0 }}
        aria-hidden="true"
      >
        {/* ── 键盘框体（始终可见）──────────────────────────── */}
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
    <span className="font-mono text-xs sm:text-sm leading-tight select-none">
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
  provider: _provider = 'claude',
}: ClaudeStatusProps) {
  const { isConnected } = useWebSocket();
  const [elapsedTime, setElapsedTime] = useState(0);
  const [disconnectDismissed, setDisconnectDismissed] = useState(false);

  useEffect(() => {
    if (isConnected) setDisconnectDismissed(false);
  }, [isConnected]);

  useEffect(() => {
    if (!isLoading) {
      sessionStorage.removeItem('task_start_time');
      setElapsedTime(0);
      return;
    }
    // 刷新恢复：复用已存储的开始时间，使 elapsed 连续
    const stored = sessionStorage.getItem('task_start_time');
    const startTime = stored ? parseInt(stored, 10) : Date.now();
    if (!stored) sessionStorage.setItem('task_start_time', String(startTime));

    setDisconnectDismissed(false);
    const timer = window.setInterval(() => {
      setElapsedTime(Math.floor((Date.now() - startTime) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [isLoading]);

  const actionIndex = Math.floor(elapsedTime / 2) % ACTION_WORDS.length;
  // 当后端没有返回具体工具名时（空串或仅 'Processing'），用前端循环词
  const backendText = status?.text && status.text !== 'Processing' ? status.text : '';
  const statusText  = backendText || ACTION_WORDS[actionIndex];
  // 真实 token：优先使用从 Anthropic API 流式事件中提取的细分数据；
  // 若尚未获得（模型仍在"思考"阶段），则以时间估算值兜底，保证始终有数字显示。
  const hasRealTokens = (status?.inputTokens ?? 0) > 0 || (status?.outputTokens ?? 0) > 0;
  const canInterrupt = status?.can_interrupt !== false;
  // 根据当前动作文字推断螃蟹模式（5种工作态 + idle）
  const crabMode = isLoading ? getCrabMode(statusText) : 'idle';

  // ── 断连警告 ────────────────────────────────────────────────────────────
  if (!isConnected && !disconnectDismissed) {
    return (
      <div className="w-full mb-3 sm:mb-6 animate-in slide-in-from-bottom duration-300">
        <div className="flex items-center mx-auto bg-red-900/90 text-white rounded-xl shadow-lg px-3 py-2.5 sm:px-4 sm:py-3 border border-red-700/60 gap-3">
          <div className="flex-shrink-0">
            <PixelCrab mode="idle" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="font-medium text-xs sm:text-sm">与服务器连接已断开</div>
            <div className="text-red-300 text-xs mt-0.5">正在重连中，命令可能未发送成功，请稍候或刷新页面重试</div>
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

  // ── 未加载时：显示 idle 小条（螃蟹始终存在）──────────────────────────────
  if (!isLoading) {
    return (
      <div className="w-full mb-1 sm:mb-2">
        <div className="flex items-center mx-auto px-2 py-1 gap-2 opacity-40 hover:opacity-70 transition-opacity">
          <PixelCrab mode="idle" />
          <span className="text-xs font-mono" style={{ color: '#6b7280' }}>Claude ready</span>
        </div>
      </div>
    );
  }

  // ── Processing 状态条 ────────────────────────────────────────────────────
  return (
    <div className="w-full mb-3 sm:mb-6 animate-in slide-in-from-bottom duration-300">
      {/* 主状态栏：纯黑背景，终端风格 */}
      <div className="flex items-center mx-auto bg-[#0c0c0c] text-white rounded-xl shadow-xl border border-[#2a2a2a] px-3 py-2 sm:px-4 sm:py-2.5 gap-3 sm:gap-4">
        {/* 螃蟹打字动画 */}
        <div className="flex-shrink-0 self-end">
          <PixelCrab mode={crabMode} />
        </div>

        {/* 终端文字区 */}
        <div className="flex-1 min-w-0 overflow-hidden">
          <TerminalText text={statusText} elapsed={elapsedTime} />
          {/* token 区：有真实数据时显示精确值，否则显示占位符表示"统计中" */}
          <div className="text-xs font-mono mt-0.5 hidden sm:block">
            {hasRealTokens ? (
              <>
                <span title="输入 tokens（含缓存命中）" style={{ color: '#86efac' }}>
                  ↑{(status?.inputTokens ?? 0).toLocaleString()}
                </span>
                <span className="mx-1" style={{ color: '#4b5563' }}>·</span>
                <span title="输出 tokens" style={{ color: '#93c5fd' }}>
                  ↓{(status?.outputTokens ?? 0).toLocaleString()}
                </span>
                <span className="ml-3" style={{ color: '#60a5fa' }}>esc to stop</span>
              </>
            ) : (
              /* 等待第一个 API 响应返回 usage 数据，显示占位符避免空白 */
              <span style={{ color: '#374151' }}>↑ --- · ↓ ---</span>
            )}
          </div>
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
