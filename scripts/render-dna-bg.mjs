/**
 * 离线渲染 DNA 背景动画为 WebM 视频
 * 用法：node scripts/render-dna-bg.mjs
 * 输出：public/dna-bg.webm（硬件可解码，替代 Canvas 实时渲染）
 *
 * 循环周期：speed 比值 10:8:11，公共周期 ≈ 15708ms（480帧@30fps 近似无缝）
 */

import { createCanvas } from 'canvas';
import { spawn }        from 'child_process';
import path             from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ── 输出参数 ─────────────────────────────── */
const W       = 1920;
const H       = 1080;
const FPS     = 30;
const FRAMES  = 480;           // 16s，覆盖 ≈1 个完整公共周期
const FFMPEG  = '/mnt/data/bks/conda_envs/r_jupyter/bin/ffmpeg';
const OUT     = path.resolve(__dirname, '../public/dna-bg.webm');

/* ── 颜色工具 ─────────────────────────────── */
const BP_BONDS = [2, 3, 2, 3];
const seqBond = (seed, i) =>
  BP_BONDS[((seed * 1664525 + i * 1013904223) & 0x7fffffff) % 4];

function getS1Color(yNorm) {
  const t = (Math.sin(yNorm * Math.PI * 4) + 1) * 0.5;
  return [Math.round(20 + 90 * (1 - t)), Math.round(120 + 130 * t), Math.round(200 + 55 * (1 - t))];
}
function getS2Color(yNorm) {
  const t = (Math.sin(yNorm * Math.PI * 4 + Math.PI) + 1) * 0.5;
  return [Math.round(80 + 175 * t), Math.round(0 + 40 * t), Math.round(255 - 60 * t)];
}
function darkS1(y) { const [r,g,b]=getS1Color(y); return [Math.round(r*.18),Math.round(g*.35),Math.round(b*.57)]; }
function darkS2(y) { const [r,g,b]=getS2Color(y); return [Math.round(r*.28),Math.round(g*.18),Math.round(b*.45)]; }

/* ── 绘制球 ───────────────────────────────── */
function drawSphere(ctx, x, y, r, mr, mg, mb, dr, dg, db, alpha, glow) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  if (glow) {
    ctx.shadowColor = `rgba(${mr},${mg},${mb},0.65)`;
    ctx.shadowBlur  = r * 1.5;
    const grd = ctx.createRadialGradient(x - r*.32, y - r*.32, r*.05, x, y, r);
    grd.addColorStop(0.00, `rgba(240,252,255,${alpha*.95})`);
    grd.addColorStop(0.30, `rgba(${mr},${mg},${mb},${alpha})`);
    grd.addColorStop(1.00, `rgba(${dr},${dg},${db},${alpha*.75})`);
    ctx.fillStyle = grd;
  } else {
    ctx.shadowBlur = 0;
    ctx.fillStyle  = `rgba(${mr},${mg},${mb},${alpha})`;
  }
  ctx.fill();
  ctx.shadowBlur = 0;
}

/* ── 绘制单条螺旋 ──────────────────────────── */
function drawHelix(ctx, W, H, cx, phase, A, amp, period, tilt, seed) {
  const half     = H / 2;
  const BP_STEP  = period / 14;

  ctx.save();
  ctx.translate(cx, half);
  ctx.rotate(tilt);

  const pts = [];
  let bpIdx = 0;
  for (let y = -half - 20; y <= half + 20; y += BP_STEP) {
    const angle = (2 * Math.PI * y) / period + phase;
    pts.push({
      y, bpIdx: bpIdx++,
      x1:    amp * Math.sin(angle),
      x2:   -amp * Math.sin(angle),
      cos_a: Math.cos(angle),
      sin_a: Math.sin(angle),
      yNorm: Math.max(0, Math.min(1, (y + half) / H)),
    });
  }

  const rMin = 4.0, rMax = 11.5;

  // 骨架连接线
  if (pts.length > 1) {
    for (let i = 0; i < pts.length - 1; i++) {
      const p = pts[i], q = pts[i+1];
      const [r1,g1,b1] = getS1Color(p.yNorm);
      const da = A * .55 * (.35 + .65 * ((( p.cos_a + q.cos_a)/2 + 1)*.5));
      ctx.beginPath(); ctx.moveTo(p.x1,p.y); ctx.lineTo(q.x1,q.y);
      ctx.strokeStyle = `rgba(${r1},${g1},${b1},${da})`; ctx.lineWidth=1.6; ctx.stroke();
    }
    for (let i = 0; i < pts.length - 1; i++) {
      const p = pts[i], q = pts[i+1];
      const [r2,g2,b2] = getS2Color(p.yNorm);
      const da = A * .55 * (.35 + .65 * (1-((p.cos_a+q.cos_a)/2+1)*.5));
      ctx.beginPath(); ctx.moveTo(p.x2,p.y); ctx.lineTo(q.x2,q.y);
      ctx.strokeStyle = `rgba(${r2},${g2},${b2},${da})`; ctx.lineWidth=1.6; ctx.stroke();
    }
  }

  // 后方球
  for (const p of pts) {
    if (p.cos_a >= 0) continue;
    const d=( p.cos_a+1)*.5, r=rMin+(rMax-rMin)*d, a=A*(.18+.82*d);
    const [mr,mg,mb]=getS1Color(p.yNorm), [dr2,dg2,db2]=darkS1(p.yNorm);
    drawSphere(ctx,p.x1,p.y,r,mr,mg,mb,dr2,dg2,db2,a,false);
  }
  for (const p of pts) {
    if (p.cos_a <= 0) continue;
    const d=1-(p.cos_a+1)*.5, r=rMin+(rMax-rMin)*d, a=A*(.18+.82*d);
    const [mr,mg,mb]=getS2Color(p.yNorm), [dr2,dg2,db2]=darkS2(p.yNorm);
    drawSphere(ctx,p.x2,p.y,r,mr,mg,mb,dr2,dg2,db2,a,false);
  }

  // 横档 + 氢键 + 碱基标签
  const BP_CHARS=[['A','T'],['G','C'],['T','A'],['C','G']];
  for (const p of pts) {
    const vis=Math.abs(p.sin_a), rungA=A*(.30+.55*vis);
    if (rungA<.04) continue;
    const [s1r,s1g,s1b]=getS1Color(p.yNorm);
    const [s2r,s2g,s2b]=getS2Color(p.yNorm);
    if (Math.abs(p.x1-p.x2)>1) {
      const mr=Math.round((s1r+s2r)/2), mg=Math.round((s1g+s2g)/2+20), mb2=Math.round((s1b+s2b)/2+15);
      ctx.beginPath(); ctx.moveTo(p.x1,p.y); ctx.lineTo(p.x2,p.y);
      ctx.strokeStyle=`rgba(${mr},${mg},${mb2},${rungA})`; ctx.lineWidth=0.8+1.2*vis; ctx.stroke();
    }
    const bonds=seqBond(seed,p.bpIdx), isGC=bonds===3;
    const dotR=1.6+2.8*vis, dotAlpha=A*(.55+.40*vis);
    const rungLen=Math.abs(p.x1-p.x2);
    const offsets=bonds===2?[-rungLen*.22,rungLen*.22]:[-rungLen*.26,0,rungLen*.26];
    for (const ox of offsets) {
      ctx.beginPath(); ctx.arc(ox,p.y,dotR,0,Math.PI*2);
      ctx.fillStyle=isGC?`rgba(200,240,255,${dotAlpha})`:`rgba(255,248,215,${dotAlpha})`; ctx.fill();
    }
    if (vis>0.72&&rungLen>14&&p.bpIdx%4===0) {
      const pair=BP_CHARS[((seed*1664525+p.bpIdx*1013904223)&0x7fffffff)%4];
      const tAlpha=A*(.50+.35*vis);
      ctx.font='bold 7px monospace'; ctx.textAlign='center'; ctx.textBaseline='middle';
      ctx.fillStyle=`rgba(${s1r},${s1g},${s1b},${tAlpha})`; ctx.fillText(pair[0],p.x1*.72,p.y);
      ctx.fillStyle=`rgba(${s2r},${s2g},${s2b},${tAlpha})`; ctx.fillText(pair[1],p.x2*.72,p.y);
    }
  }

  // 磷酸骨架刻度
  for (let i=0; i<pts.length; i+=3) {
    const p=pts[i], tickLen=4+2*Math.abs(p.cos_a), tA=A*.35*Math.abs(p.cos_a);
    if (tA<.04) continue;
    const [r1,g1,b1]=getS1Color(p.yNorm), [r2,g2,b2]=getS2Color(p.yNorm);
    ctx.beginPath(); ctx.moveTo(p.x1,p.y-tickLen/2); ctx.lineTo(p.x1,p.y+tickLen/2);
    ctx.strokeStyle=`rgba(${r1},${g1},${b1},${tA})`; ctx.lineWidth=1.0; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(p.x2,p.y-tickLen/2); ctx.lineTo(p.x2,p.y+tickLen/2);
    ctx.strokeStyle=`rgba(${r2},${g2},${b2},${tA})`; ctx.stroke();
  }

  // 前方球
  for (const p of pts) {
    if (p.cos_a<0) continue;
    const d=(p.cos_a+1)*.5, r=rMin+(rMax-rMin)*d, a=A*(.18+.82*d);
    const [mr,mg,mb]=getS1Color(p.yNorm), [dr2,dg2,db2]=darkS1(p.yNorm);
    drawSphere(ctx,p.x1,p.y,r,mr,mg,mb,dr2,dg2,db2,a,d>0.80);
  }
  for (const p of pts) {
    if (p.cos_a>0) continue;
    const d=1-(p.cos_a+1)*.5, r=rMin+(rMax-rMin)*d, a=A*(.18+.82*d);
    const [mr,mg,mb]=getS2Color(p.yNorm), [dr2,dg2,db2]=darkS2(p.yNorm);
    drawSphere(ctx,p.x2,p.y,r,mr,mg,mb,dr2,dg2,db2,a,d>0.80);
  }

  ctx.restore();
}

/* ── 绘制背景网格 ──────────────────────────── */
function drawGrid(ctx, W, H) {
  const CELL = 68;
  ctx.strokeStyle = 'rgba(0,160,220,0.40)';
  ctx.lineWidth   = 0.6;
  for (let x=0; x<=W; x+=CELL) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke(); }
  for (let y=0; y<=H; y+=CELL) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke(); }
}

/* ── Matrix Rain 状态 ──────────────────────── */
const RAIN_CHARS  = 'ATGC0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const FONT_SIZE   = 13;
const RAIN_RATIOS = [0.27, 0.42, 0.63, 0.86];

function initRain(W, H) {
  return RAIN_RATIOS.map((ratio, i) => {
    const trailLen = 16;
    const maxY     = H * 0.58;
    // 固定随机种子保证每次渲染一致（Math.random → seeded）
    const seed = i * 12345;
    return {
      colX: W * ratio,
      y:    (maxY / RAIN_RATIOS.length) * i + 20,
      speed: 1.4 + (i % 2) * 0.5,
      trail: Array.from({ length: trailLen + 2 }, (_, k) =>
        RAIN_CHARS[(seed + k * 7919) % RAIN_CHARS.length]),
      trailLen,
      tickChar: 0,
    };
  });
}

function updateRain(drops, W, H, frameIdx) {
  const maxY = H * 0.58;
  for (let di=0; di<drops.length; di++) {
    const d = drops[di];
    d.y += d.speed;
    if (d.y > maxY + d.trailLen * FONT_SIZE) {
      d.y = -(d.trailLen * FONT_SIZE);
    }
    d.tickChar++;
    if (d.tickChar >= 3) {
      d.tickChar = 0;
      // 用帧号+索引做伪随机，保证同一帧内一致
      const idx = (frameIdx * 97 + di * 37) % d.trail.length;
      d.trail[idx] = RAIN_CHARS[(frameIdx * 13 + di * 31 + idx * 7) % RAIN_CHARS.length];
    }
  }
}

function drawRain(ctx, drops, H) {
  const maxY = H * 0.58;
  ctx.font         = `${FONT_SIZE}px 'Courier New',monospace`;
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'top';
  for (const d of drops) {
    for (let i=0; i<d.trailLen; i++) {
      const charY = d.y - i * FONT_SIZE;
      if (charY < -FONT_SIZE || charY > maxY) continue;
      const headness = 1 - i / d.trailLen;
      const yFade    = 1 - Math.max(0, charY / maxY);
      const alpha    = Math.min(1, headness * 1.4) * yFade;
      if (alpha < 0.04) continue;
      if (i===0)       ctx.fillStyle=`rgba(230,248,255,${Math.min(1,alpha*1.2).toFixed(2)})`;
      else if (i<4)    ctx.fillStyle=`rgba(80,200,240,${alpha.toFixed(2)})`;
      else             ctx.fillStyle=`rgba(0,160,220,${(alpha*.85).toFixed(2)})`;
      ctx.fillText(d.trail[i % d.trail.length], d.colX, charY);
    }
  }
}

/* ── 主渲染循环 ────────────────────────────── */
async function main() {
  console.log(`渲染 DNA 背景视频：${W}×${H} @ ${FPS}fps × ${FRAMES}帧`);

  const canvas = createCanvas(W, H);
  const ctx    = canvas.getContext('2d');

  const helices = [
    { cx: 0.06, phase: 0.0,  speed: 0.0040, alpha: 0.45, amp: 56, period: 165, tilt:  0.10, seed: 42   },
    { cx: 0.54, phase: 1.8,  speed: 0.0032, alpha: 0.34, amp: 50, period: 150, tilt: -0.15, seed: 1337 },
    { cx: 0.94, phase: 3.1,  speed: 0.0044, alpha: 0.30, amp: 45, period: 140, tilt:  0.22, seed: 2025 },
  ];
  const phases = helices.map(h => h.phase);
  const dt     = 1000 / FPS;   // 每帧毫秒数（固定）

  const drops = initRain(W, H);

  // 启动 ffmpeg：stdin 接收 raw RGBA，输出 WebM
  const ff = spawn(FFMPEG, [
    '-y',
    '-f', 'rawvideo',
    '-pix_fmt', 'bgra',       // node-canvas raw buffer 在 x86 小端机器上为 BGRA
    '-s', `${W}x${H}`,
    '-r', String(FPS),
    '-i', 'pipe:0',
    '-c:v', 'libvpx-vp9',
    '-crf', '33',
    '-b:v', '0',
    '-pix_fmt', 'yuv420p',    // 不需要 alpha，去掉透明通道节省文件大小
    '-auto-alt-ref', '0',
    OUT,
  ], { stdio: ['pipe', 'inherit', 'inherit'] });

  ff.on('error', err => { console.error('ffmpeg error:', err); process.exit(1); });

  for (let f=0; f<FRAMES; f++) {
    // 底层背景色：与 CSS --background: 222.2 84% 4.9% 一致（约 rgb(2,8,23)）
    ctx.fillStyle = 'rgb(2,8,23)';
    ctx.fillRect(0, 0, W, H);

    // 网格
    drawGrid(ctx, W, H);

    // 三条螺旋
    helices.forEach((h, i) => {
      phases[i] += h.speed * dt;
      drawHelix(ctx, W, H, h.cx * W, phases[i], h.alpha, h.amp, h.period, h.tilt, h.seed);
    });

    // Matrix Rain
    updateRain(drops, W, H, f);
    drawRain(ctx, drops, H);

    // 写入 raw RGBA 帧
    const buf = canvas.toBuffer('raw');
    const canWrite = ff.stdin.write(buf);
    if (!canWrite) await new Promise(r => ff.stdin.once('drain', r));

    if (f % 30 === 0) process.stdout.write(`\r  帧 ${f}/${FRAMES} (${Math.round(f/FRAMES*100)}%)`);
  }

  await new Promise((resolve, reject) => {
    ff.stdin.end();
    ff.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`)));
  });

  console.log(`\n完成：${OUT}`);
}

main().catch(e => { console.error(e); process.exit(1); });
