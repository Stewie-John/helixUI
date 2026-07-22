// ─── Clawd sprite 渲染器（petdex clawd-4 雪碧图，9 行 × 8 列）────────────────────
// sprite sheet: 1536×1872，每帧 192×208；每行一个状态，列为帧
const SHEET_URL = '/mascot/clawd-4/spritesheet.webp';
const FRAME_W = 192;
const FRAME_H = 208;
const SHEET_COLS = 8;
const SHEET_ROWS = 9;

export type ClawdState = 'idle' | 'scan' | 'look' | 'happy' | 'think' | 'error' | 'wave' | 'type' | 'rest';

// 状态 → {行号, 非空帧数, 循环秒数}（帧数实测自雪碧图 alpha）
export const CLAWD_STATE: Record<ClawdState, { row: number; frames: number; dur: number }> = {
  idle:  { row: 0, frames: 6, dur: 1.4 },  // 待机眨眼
  scan:  { row: 1, frames: 8, dur: 1.0 },  // 眼睛扫视 → 读文件/走动
  look:  { row: 2, frames: 8, dur: 1.0 },  // 扫视2 → 搜索
  happy: { row: 3, frames: 4, dur: 0.55 }, // 撒花蹦跳 → 投喂/开心
  think: { row: 4, frames: 5, dur: 0.9 },  // 举手「!」→ 思考
  error: { row: 5, frames: 8, dur: 1.1 },  // X眼 ERROR → 断连/生病
  wave:  { row: 6, frames: 6, dur: 0.8 },  // 张臂 → 摸摸
  type:  { row: 7, frames: 6, dur: 0.5 },  // 敲键盘 → 写代码/打工
  rest:  { row: 8, frames: 6, dur: 1.6 },  // 待机变体 → 睡觉
};

export function ClawdSprite({
  state,
  size = 46,
  durScale = 1,
  flip = false,
  className,
}: {
  state: ClawdState;
  size?: number;
  durScale?: number;
  flip?: boolean;       // 水平翻转（横着走时朝向）
  className?: string;
}) {
  const cfg = CLAWD_STATE[state];
  const scale = size / FRAME_H;        // 以高度对齐目标尺寸
  const fw = FRAME_W * scale;
  const fh = FRAME_H * scale;
  const animName = `clawd-${state}-${Math.round(size)}`;
  // background-position-x 从 0 步进到 -(帧数×帧宽)，steps(帧数) 逐帧播放
  const css = `@keyframes ${animName}{from{background-position-x:0}to{background-position-x:-${(cfg.frames * fw).toFixed(2)}px}}`;
  return (
    <>
      <style>{css}</style>
      <div
        aria-hidden="true"
        className={className}
        style={{
          width: `${fw.toFixed(2)}px`,
          height: `${fh.toFixed(2)}px`,
          backgroundImage: `url(${SHEET_URL})`,
          backgroundRepeat: 'no-repeat',
          backgroundSize: `${(SHEET_COLS * fw).toFixed(2)}px ${(SHEET_ROWS * fh).toFixed(2)}px`,
          backgroundPositionY: `-${(cfg.row * fh).toFixed(2)}px`,
          imageRendering: 'pixelated',
          animation: `${animName} ${(cfg.dur * durScale).toFixed(2)}s steps(${cfg.frames}) infinite`,
          transform: flip ? 'translateZ(0) scaleX(-1)' : 'translateZ(0)',
          willChange: 'background-position, transform',
          contain: 'strict',
          flexShrink: 0,
        }}
      />
    </>
  );
}
