/**
 * 离线渲染 DNA 背景动画 v2
 * 用法：node scripts/render-dna-bg.mjs
 * 输出：public/dna-bg.webm
 *
 * v2 核心改进：
 *  1. B-DNA 大沟/小沟：strand2 相位偏移 144°（非对称的 180°），
 *     碱基对横档长短交替，清晰体现大沟宽（216°）/ 小沟窄（144°）的真实结构
 *  2. 真实飘动：整体横向正弦漂移 + 螺旋轴行波弯曲（蠕虫状摆动）
 *  3. AT/GC 区分着色：AT=琥珀金，GC=薄荷青
 *  4. 大沟区柔和高光填充，小沟区暗色填充
 *  5. Strand1 青色系 / Strand2 洋红系，双链视觉区分
 *
 * 无缝循环：drift=1周期，wave=2周期，helix旋转近似无缝（≈10.2圈）
 */

import { createCanvas } from 'canvas';
import { spawn }        from 'child_process';
import path             from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ──────────────────────────────────────────
   输出参数
────────────────────────────────────────── */
const W      = 1920;
const H      = 1080;
const FPS    = 30;
const FRAMES = 480;          // 16s，1个完整漂移周期
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const OUT    = path.resolve(__dirname, '../public/dna-bg.webm');

/* ──────────────────────────────────────────
   B-DNA 大沟/小沟参数
   minor groove ≈ 144° = 2π×0.40，major groove ≈ 216° = 2π×0.60
────────────────────────────────────────── */
const GROOVE_PHASE = 2 * Math.PI * 0.40;   // Strand2 相对 Strand1 的相位偏移
const MAX_RUNG     = 2 * Math.sin(GROOVE_PHASE / 2);  // ≈1.902，归一化分母

/* ──────────────────────────────────────────
   颜色工具
────────────────────────────────────────── */
// Strand1: 纯蓝→靛蓝（5'→3'）— 干净蓝色，无青色/绿色污染
function s1Col(n) {
  return [Math.round(20 + 30*n), Math.round(60 + 60*n), 255];
}
// Strand2: 洋红→紫（3'→5'，互补链）
function s2Col(n) {
  return [Math.round(210 - 30*n), Math.round(10 + 20*n), Math.round(255 - 10*n)];
}
function darkS1(n) { const [r,g,b]=s1Col(n); return [r*.20|0, g*.20|0, b*.45|0]; }
function darkS2(n) { const [r,g,b]=s2Col(n); return [r*.25|0, g*.12|0, b*.40|0]; }

// AT/GC 碱基对判断（伪随机序列，seed决定）
const seqBond = (seed, i) =>
  [2,3,2,3][((seed*1664525 + i*1013904223) & 0x7fffffff) % 4];

/* ──────────────────────────────────────────
   绘制球体（含辉光）
────────────────────────────────────────── */
function drawSphere(ctx, x, y, r, mr,mg,mb, dr,dg,db, alpha, glow) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  if (glow) {
    ctx.shadowColor = `rgba(${mr},${mg},${mb},0.70)`;
    ctx.shadowBlur  = r * 0.9;
    const g = ctx.createRadialGradient(x - r*.30, y - r*.30, r*.05, x, y, r);
    g.addColorStop(0.0, `rgba(240,252,255,${alpha*.92})`);
    g.addColorStop(0.3, `rgba(${mr},${mg},${mb},${alpha})`);
    g.addColorStop(1.0, `rgba(${dr},${dg},${db},${alpha*.72})`);
    ctx.fillStyle = g;
  } else {
    ctx.shadowBlur = 0;
    ctx.fillStyle  = `rgba(${mr},${mg},${mb},${alpha})`;
  }
  ctx.fill();
  ctx.shadowBlur = 0;
}

/* ──────────────────────────────────────────
   绘制单条螺旋（大沟小沟 + 飘动）
────────────────────────────────────────── */
function drawHelix(ctx, frame, cxAbs, phase, A, amp, period, tilt, seed, fp) {
  const { driftAmp, driftPhase0,
          waveAmp, waveLen, waveSpeed, wavePh0 } = fp;

  const half   = H / 2;
  const BP_STEP = period / 14;
  const t      = frame / FRAMES;              // 0→1，1个完整循环

  // 整体横向漂移（1个完整正弦周期，无缝）
  const driftX = driftAmp * Math.sin(2 * Math.PI * t + driftPhase0);

  // 螺旋轴行波相位（2个完整周期，无缝）
  const wavePh = wavePh0 + frame * waveSpeed;

  ctx.save();
  ctx.translate(cxAbs + driftX, half);
  ctx.rotate(tilt);

  /* 计算所有碱基对节点 */
  const pts = [];
  let bpIdx = 0;
  for (let y = -half - 20; y <= half + 20; y += BP_STEP) {
    const a1  = (2 * Math.PI * y) / period + phase;
    const a2  = a1 + GROOVE_PHASE;
    // 轴线弯曲：行波偏移
    const axW = waveAmp * Math.sin(2 * Math.PI * y / waveLen + wavePh);
    pts.push({
      y, bpIdx: bpIdx++,
      x1: axW + amp * Math.sin(a1),
      x2: axW + amp * Math.sin(a2),
      cos1: Math.cos(a1), cos2: Math.cos(a2),
      sin1: Math.sin(a1),
      axW,
      yN: Math.max(0, Math.min(1, (y + half) / H)),
    });
  }

  const rMin = 4.0, rMax = 11.5;

  /* ── 1. 骨架线 ── */
  for (let i = 0; i < pts.length - 1; i++) {
    const p = pts[i], q = pts[i+1];
    const [r,g,b] = s1Col(p.yN);
    const dep = ((p.cos1 + q.cos1) * .5 + 1) * .5;
    ctx.beginPath(); ctx.moveTo(p.x1, p.y); ctx.lineTo(q.x1, q.y);
    ctx.strokeStyle = `rgba(${r},${g},${b},${A*.55*(0.35+0.65*dep)})`;
    ctx.lineWidth = 1.6; ctx.stroke();
  }
  for (let i = 0; i < pts.length - 1; i++) {
    const p = pts[i], q = pts[i+1];
    const [r,g,b] = s2Col(p.yN);
    const dep = ((p.cos2 + q.cos2) * .5 + 1) * .5;
    ctx.beginPath(); ctx.moveTo(p.x2, p.y); ctx.lineTo(q.x2, q.y);
    ctx.strokeStyle = `rgba(${r},${g},${b},${A*.55*(0.35+0.65*dep)})`;
    ctx.lineWidth = 1.6; ctx.stroke();
  }

  /* ── 2. 大沟/小沟填充（相邻碱基对之间的四边形区域）── */
  for (let i = 0; i < pts.length - 1; i++) {
    const p = pts[i], q = pts[i+1];
    const rl_p = Math.abs(p.x1 - p.x2);
    const rl_q = Math.abs(q.x1 - q.x2);
    if (rl_p < 3 || rl_q < 3) continue;        // 链交叉处跳过
    const grooveR = (rl_p + rl_q) / 2 / (amp * MAX_RUNG);  // 0=小沟, 1=大沟
    const vis     = (Math.abs(p.sin1) + Math.abs(q.sin1)) * .5;
    if (vis < 0.15) continue;

    ctx.beginPath();
    ctx.moveTo(p.x1, p.y); ctx.lineTo(p.x2, p.y);
    ctx.lineTo(q.x2, q.y); ctx.lineTo(q.x1, q.y);
    ctx.closePath();

    if (grooveR > 0.50) {
      // 大沟：柔和青色高光，体现宽敞、DNA结合蛋白易接近
      const fa = A * 0.10 * grooveR * vis;
      ctx.fillStyle = `rgba(60,200,255,${fa})`;
    } else if (grooveR < 0.25) {
      // 小沟：深色填充，体现狭窄深邃
      const fa = A * 0.07 * (1 - grooveR) * vis;
      ctx.fillStyle = `rgba(0,15,55,${fa})`;
    } else {
      continue;
    }
    ctx.fill();
  }

  /* ── 3. 后方球（深度排序：先画背面） ── */
  for (const p of pts) {
    if (p.cos1 >= 0) continue;
    const d = (p.cos1+1)*.5, r=rMin+(rMax-rMin)*d, a=A*(.18+.82*d);
    const [mr,mg,mb]=s1Col(p.yN), [dr2,dg2,db2]=darkS1(p.yN);
    drawSphere(ctx, p.x1, p.y, r, mr,mg,mb, dr2,dg2,db2, a, false);
  }
  for (const p of pts) {
    if (p.cos2 >= 0) continue;
    const d = (p.cos2+1)*.5, r=rMin+(rMax-rMin)*d, a=A*(.18+.82*d);
    const [mr,mg,mb]=s2Col(p.yN), [dr2,dg2,db2]=darkS2(p.yN);
    drawSphere(ctx, p.x2, p.y, r, mr,mg,mb, dr2,dg2,db2, a, false);
  }

  /* ── 4. 碱基对横档 + 氢键点 + 碱基字母 ── */
  const BP_CHARS = [['A','T'],['G','C'],['T','A'],['C','G']];
  for (const p of pts) {
    const vis    = Math.abs(p.sin1);
    const rungA  = A * (0.30 + 0.55*vis);
    if (rungA < 0.04) continue;

    const rungLen = Math.abs(p.x1 - p.x2);
    const midX    = (p.x1 + p.x2) * .5;
    const bonds   = seqBond(seed, p.bpIdx);
    const isGC    = bonds === 3;
    const [s1r,s1g,s1b] = s1Col(p.yN);
    const [s2r,s2g,s2b] = s2Col(p.yN);
    const mr = (s1r+s2r)/2|0, mg = ((s1g+s2g)/2+22)|0, mb2 = ((s1b+s2b)/2+18)|0;

    // 横档线（GC略粗，反映3条氢键）
    if (rungLen > 1) {
      ctx.beginPath(); ctx.moveTo(p.x1, p.y); ctx.lineTo(p.x2, p.y);
      ctx.strokeStyle = `rgba(${mr},${mg},${mb2},${rungA})`;
      ctx.lineWidth   = (isGC ? 1.1 : 0.8) + 1.2*vis;
      ctx.stroke();
    }

    // 氢键点：AT=琥珀金，GC=薄荷青
    const dotR   = 1.7 + 2.8*vis;
    const dotA   = A * (0.55 + 0.40*vis);
    const offs   = bonds === 2
      ? [-rungLen*.22, rungLen*.22]
      : [-rungLen*.26, 0, rungLen*.26];
    for (const ox of offs) {
      ctx.beginPath(); ctx.arc(midX + ox, p.y, dotR, 0, Math.PI*2);
      ctx.fillStyle = isGC
        ? `rgba(100,255,210,${dotA})`   // GC：薄荷
        : `rgba(255,222,80,${dotA})`;   // AT：金黄
      ctx.fill();
    }

    // 碱基字母（稀疏显示）
    if (vis > 0.72 && rungLen > 14 && p.bpIdx % 4 === 0) {
      const pair = BP_CHARS[((seed*1664525 + p.bpIdx*1013904223) & 0x7fffffff) % 4];
      const tA   = A * (0.50 + 0.35*vis);
      ctx.font          = 'bold 7px monospace';
      ctx.textAlign     = 'center';
      ctx.textBaseline  = 'middle';
      ctx.fillStyle = `rgba(${s1r},${s1g},${s1b},${tA})`;
      ctx.fillText(pair[0], p.x1 * .74, p.y);
      ctx.fillStyle = `rgba(${s2r},${s2g},${s2b},${tA})`;
      ctx.fillText(pair[1], p.x2 * .74, p.y);
    }
  }

  /* ── 5. 磷酸骨架刻度线 ── */
  for (let i = 0; i < pts.length; i += 3) {
    const p = pts[i];
    const tLen = 4 + 2*Math.abs(p.cos1);
    const tA   = A * .35 * Math.abs(p.cos1);
    if (tA < 0.04) continue;
    const [r1,g1,b1] = s1Col(p.yN), [r2,g2,b2] = s2Col(p.yN);
    ctx.beginPath(); ctx.moveTo(p.x1, p.y-tLen/2); ctx.lineTo(p.x1, p.y+tLen/2);
    ctx.strokeStyle = `rgba(${r1},${g1},${b1},${tA})`; ctx.lineWidth=1.0; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(p.x2, p.y-tLen/2); ctx.lineTo(p.x2, p.y+tLen/2);
    ctx.strokeStyle = `rgba(${r2},${g2},${b2},${tA})`; ctx.stroke();
  }

  /* ── 6. 前方球（深度排序：后画正面，覆盖骨架和横档） ── */
  for (const p of pts) {
    if (p.cos1 < 0) continue;
    const d = (p.cos1+1)*.5, r=rMin+(rMax-rMin)*d, a=A*(.18+.82*d);
    const [mr,mg,mb]=s1Col(p.yN), [dr2,dg2,db2]=darkS1(p.yN);
    drawSphere(ctx, p.x1, p.y, r, mr,mg,mb, dr2,dg2,db2, a, d>.80);
  }
  for (const p of pts) {
    if (p.cos2 < 0) continue;
    const d = (p.cos2+1)*.5, r=rMin+(rMax-rMin)*d, a=A*(.18+.82*d);
    const [mr,mg,mb]=s2Col(p.yN), [dr2,dg2,db2]=darkS2(p.yN);
    drawSphere(ctx, p.x2, p.y, r, mr,mg,mb, dr2,dg2,db2, a, d>.80);
  }

  ctx.restore();
}

/* ──────────────────────────────────────────
   背景网格
────────────────────────────────────────── */
function drawGrid(ctx) {
  const CELL = 68;
  ctx.strokeStyle = 'rgba(0,160,220,0.40)';
  ctx.lineWidth   = 0.6;
  for (let x=0; x<=W; x+=CELL) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke(); }
  for (let y=0; y<=H; y+=CELL) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke(); }
}

/* ──────────────────────────────────────────
   Matrix 字符雨（ATGC 序列）
────────────────────────────────────────── */
const RAIN_CHARS  = 'ATGC0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const FONT_SIZE   = 13;
const RAIN_RATIOS = [0.27, 0.42, 0.63, 0.86];

function initRain() {
  return RAIN_RATIOS.map((ratio, i) => {
    const trailLen = 16, maxY = H * .58, seed = i * 12345;
    return {
      colX: W * ratio,
      y:    (maxY / RAIN_RATIOS.length) * i + 20,
      speed: 1.4 + (i % 2) * .5,
      trail: Array.from({length: trailLen+2}, (_,k) => RAIN_CHARS[(seed + k*7919) % RAIN_CHARS.length]),
      trailLen, tickChar: 0,
    };
  });
}

function updateRain(drops, f) {
  const maxY = H * .58;
  for (let di=0; di<drops.length; di++) {
    const d = drops[di];
    d.y += d.speed;
    if (d.y > maxY + d.trailLen * FONT_SIZE) d.y = -(d.trailLen * FONT_SIZE);
    if (++d.tickChar >= 3) {
      d.tickChar = 0;
      const idx = (f*97 + di*37) % d.trail.length;
      d.trail[idx] = RAIN_CHARS[(f*13 + di*31 + idx*7) % RAIN_CHARS.length];
    }
  }
}

function drawRain(ctx, drops) {
  const maxY = H * .58;
  ctx.font = `${FONT_SIZE}px 'Courier New',monospace`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (const d of drops) {
    for (let i=0; i<d.trailLen; i++) {
      const charY = d.y - i * FONT_SIZE;
      if (charY < -FONT_SIZE || charY > maxY) continue;
      const alpha = Math.min(1, (1-i/d.trailLen)*1.4) * (1-Math.max(0, charY/maxY));
      if (alpha < 0.04) continue;
      if      (i===0) ctx.fillStyle=`rgba(230,248,255,${Math.min(1,alpha*1.2).toFixed(2)})`;
      else if (i< 4)  ctx.fillStyle=`rgba(80,200,240,${alpha.toFixed(2)})`;
      else            ctx.fillStyle=`rgba(0,160,220,${(alpha*.85).toFixed(2)})`;
      ctx.fillText(d.trail[i % d.trail.length], d.colX, charY);
    }
  }
}

/* ──────────────────────────────────────────
   主渲染循环
────────────────────────────────────────── */
async function main() {
  console.log(`渲染 DNA 背景视频 v2（大沟小沟 + 飘动）：${W}×${H} @${FPS}fps ×${FRAMES}帧`);

  const canvas = createCanvas(W, H);
  const ctx    = canvas.getContext('2d');

  /* 三条螺旋定义
     float 参数设计：
       driftPhase0  : 各链漂移起始相位（互不相同，避免同步）
       waveSpeed    : 2π×2/FRAMES 精确保证2个完整波周期无缝循环
       wavePh0      : 行波初始相位
  */
  const WAVE_SPEED_2CYC = 2 * Math.PI * 2 / FRAMES;  // 2周期/视频，无缝

  // 左右摇摆：三条链同相位（driftPhase0 相同），大幅度统一晃动
  // 轴向行波用小幅弯曲（waveAmp 减小）避免模糊
  const helices = [
    {
      cx0: 0.06, phase0: 0.0,  speed: 0.0040, alpha: 0.48, amp: 56, period: 165, tilt:  0.10, seed: 42,
      float: { driftAmp: 55,  driftPhase0: 0.0,
               waveAmp: 7, waveLen: 380, waveSpeed: WAVE_SPEED_2CYC,        wavePh0: 0.0  },
    },
    {
      cx0: 0.54, phase0: 1.8,  speed: 0.0032, alpha: 0.36, amp: 50, period: 150, tilt: -0.15, seed: 1337,
      float: { driftAmp: 55,  driftPhase0: 0.0,
               waveAmp: 6, waveLen: 340, waveSpeed: WAVE_SPEED_2CYC * 0.9,  wavePh0: 1.7  },
    },
    {
      cx0: 0.94, phase0: 3.1,  speed: 0.0044, alpha: 0.32, amp: 45, period: 140, tilt:  0.22, seed: 2025,
      float: { driftAmp: 55,  driftPhase0: 0.0,
               waveAmp: 5, waveLen: 300, waveSpeed: WAVE_SPEED_2CYC * 1.1,  wavePh0: 3.3  },
    },
  ];

  const phases = helices.map(h => h.phase0);
  const dt     = 1000 / FPS;
  const drops  = initRain();

  // 启动 ffmpeg：stdin 接收 raw BGRA，输出 WebM
  const ff = spawn(FFMPEG, [
    '-y',
    '-f', 'rawvideo', '-pix_fmt', 'bgra',
    '-s', `${W}x${H}`, '-r', String(FPS),
    '-i', 'pipe:0',
    '-c:v', 'libvpx-vp9', '-crf', '33', '-b:v', '0',
    '-pix_fmt', 'yuv420p', '-auto-alt-ref', '0',
    OUT,
  ], { stdio: ['pipe', 'inherit', 'inherit'] });

  ff.on('error', err => { console.error('ffmpeg error:', err); process.exit(1); });

  for (let f = 0; f < FRAMES; f++) {
    // 背景色（与 CSS --background 一致）
    ctx.fillStyle = 'rgb(2,8,23)';
    ctx.fillRect(0, 0, W, H);

    drawGrid(ctx);

    helices.forEach((h, i) => {
      phases[i] += h.speed * dt;
      drawHelix(ctx, f, h.cx0 * W, phases[i], h.alpha, h.amp, h.period, h.tilt, h.seed, h.float);
    });

    updateRain(drops, f);
    drawRain(ctx, drops);

    const buf      = canvas.toBuffer('raw');
    const canWrite = ff.stdin.write(buf);
    if (!canWrite) await new Promise(r => ff.stdin.once('drain', r));

    if (f % 30 === 0)
      process.stdout.write(`\r  帧 ${f}/${FRAMES} (${Math.round(f/FRAMES*100)}%)`);
  }

  await new Promise((resolve, reject) => {
    ff.stdin.end();
    ff.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`)));
  });

  console.log(`\n✓ 完成：${OUT}`);
}

main().catch(e => { console.error(e); process.exit(1); });
