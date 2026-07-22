import { useEffect, useRef } from 'react';
import { Folder, Search } from 'lucide-react';
import type { TFunction } from 'i18next';
import type { LoadingProgress } from '../../../../types/app';

type SidebarProjectsStateProps = {
  isLoading: boolean;
  loadingProgress: LoadingProgress | null;
  projectsCount: number;
  filteredProjectsCount: number;
  t: TFunction;
};

/* ═══════════════════════════════════════════════════════════════
   旋转 DNA 双螺旋 Loading 动画（Canvas 球棍模型，单链，高速旋转）
═══════════════════════════════════════════════════════════════ */
function DNALoader({ progress }: { progress: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef   = useRef<number>(0);
  const phaseRef  = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const W = 110, H = 180;
    canvas.width  = W;
    canvas.height = H;
    const cx = W / 2;
    const amp    = 30;   // 振幅
    const period = 90;   // 一整圈像素高度（短 = 圈数多）
    const SPEED  = 0.007; // 旋转速度（较背景快很多）
    const BP_STEP = period / 12; // 每圈12个碱基对

    /* 径向渐变球体 */
    const drawSphere = (
      x: number, y: number, r: number,
      mr: number, mg: number, mb: number,
      dr: number, dg: number, db: number,
      alpha: number,
    ) => {
      const grd = ctx.createRadialGradient(
        x - r * 0.32, y - r * 0.32, r * 0.05,
        x, y, r,
      );
      grd.addColorStop(0.00, `rgba(240, 252, 255, ${alpha * 0.95})`);
      grd.addColorStop(0.30, `rgba(${mr},${mg},${mb},${alpha})`);
      grd.addColorStop(1.00, `rgba(${dr},${dg},${db},${alpha * 0.7})`);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = grd;
      ctx.fill();
    };

    const drawFrame = () => {
      ctx.clearRect(0, 0, W, H);

      const phase = phaseRef.current;
      const half  = H / 2;

      /* 预计算碱基对位置 */
      type Pt = { y: number; x1: number; x2: number; cos_a: number; sin_a: number; idx: number };
      const pts: Pt[] = [];
      let idx = 0;
      for (let y = -half - 10; y <= half + 10; y += BP_STEP) {
        const angle = (2 * Math.PI * y) / period + phase;
        pts.push({
          y: y + half,
          x1:    cx + amp * Math.sin(angle),
          x2:    cx - amp * Math.sin(angle),
          cos_a: Math.cos(angle),
          sin_a: Math.sin(angle),
          idx:   idx++,
        });
      }

      const rMin = 3, rMax = 8;

      /* ── 后方球 ──────────────────────────────────────── */
      for (const p of pts) {
        if (p.cos_a >= 0) continue;
        const d = (p.cos_a + 1) * 0.5;
        drawSphere(p.x1, p.y, rMin + (rMax - rMin) * d,
          100, 185, 255,  18, 65, 145,  0.7 * (0.18 + 0.82 * d));
      }
      for (const p of pts) {
        if (p.cos_a <= 0) continue;
        const d = 1 - (p.cos_a + 1) * 0.5;
        drawSphere(p.x2, p.y, rMin + (rMax - rMin) * d,
          165, 130, 255,  45, 18, 115,  0.7 * (0.18 + 0.82 * d));
      }

      /* ── 横档 + 氢键点 ───────────────────────────────── */
      for (const p of pts) {
        const vis = Math.abs(p.sin_a);
        const ra  = 0.7 * (0.30 + 0.50 * vis);
        ctx.beginPath();
        ctx.moveTo(p.x1, p.y);
        ctx.lineTo(p.x2, p.y);
        ctx.strokeStyle = `rgba(210, 238, 255, ${ra})`;
        ctx.lineWidth   = 0.6 + 0.9 * vis;
        ctx.stroke();

        // 氢键点（2-3个）
        const bonds   = p.idx % 2 === 0 ? 2 : 3;
        const dotR    = 1.2 + 2.0 * vis;
        const rungLen = Math.abs(p.x1 - p.x2);
        const offsets = bonds === 2
          ? [-rungLen * 0.22, rungLen * 0.22]
          : [-rungLen * 0.25, 0, rungLen * 0.25];
        for (const ox of offsets) {
          ctx.beginPath();
          ctx.arc(cx + ox, p.y, dotR, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(235, 250, 255, ${0.7 * (0.55 + 0.45 * vis)})`;
          ctx.fill();
        }
      }

      /* ── 前方球 ──────────────────────────────────────── */
      for (const p of pts) {
        if (p.cos_a < 0) continue;
        const d = (p.cos_a + 1) * 0.5;
        const r = rMin + (rMax - rMin) * d;
        if (d > 0.80) {
          ctx.shadowColor = 'rgba(120,210,255,0.7)';
          ctx.shadowBlur  = r * 1.6;
        }
        drawSphere(p.x1, p.y, r, 110, 195, 255, 18, 65, 145, 0.7 * (0.18 + 0.82 * d));
        ctx.shadowBlur = 0;
      }
      for (const p of pts) {
        if (p.cos_a > 0) continue;
        const d = 1 - (p.cos_a + 1) * 0.5;
        const r = rMin + (rMax - rMin) * d;
        if (d > 0.80) {
          ctx.shadowColor = 'rgba(180,140,255,0.65)';
          ctx.shadowBlur  = r * 1.6;
        }
        drawSphere(p.x2, p.y, r, 175, 140, 255, 45, 18, 115, 0.7 * (0.18 + 0.82 * d));
        ctx.shadowBlur = 0;
      }

      /* ── 进度光环（底部弧线，跟随 progress） ─────────── */
      const arcY  = H - 10;
      const arcR  = 38;
      const start = -Math.PI * 0.85;
      const end   = start + Math.PI * 1.70 * Math.max(0.02, progressRef.current);
      ctx.beginPath();
      ctx.arc(cx, arcY, arcR, -Math.PI * 0.85, -Math.PI * 0.85 + Math.PI * 1.70, false);
      ctx.strokeStyle = 'rgba(0,80,120,0.35)';
      ctx.lineWidth = 2.5;
      ctx.stroke();
      const grad = ctx.createLinearGradient(cx - arcR, arcY, cx + arcR, arcY);
      grad.addColorStop(0,   'rgba(100,200,255,0.9)');
      grad.addColorStop(0.5, 'rgba(160,220,255,1.0)');
      grad.addColorStop(1,   'rgba(200,160,255,0.9)');
      ctx.beginPath();
      ctx.arc(cx, arcY, arcR, start, end, false);
      ctx.strokeStyle = grad;
      ctx.lineWidth   = 2.5;
      ctx.shadowColor = 'rgba(100,200,255,0.6)';
      ctx.shadowBlur  = 6;
      ctx.stroke();
      ctx.shadowBlur = 0;
    };

    let lastTime = 0;
    const animate = (ts: number) => {
      const elapsed = ts - lastTime;
      // This loader is decorative; 30 fps is visually smooth and halves the
      // expensive canvas gradients/shadows during the initial project scan.
      if (lastTime === 0 || elapsed >= 33) {
        const dt = Math.min(lastTime === 0 ? 33 : elapsed, 66);
        lastTime = ts;
        phaseRef.current += SPEED * dt;
        drawFrame();
      }
      animRef.current = requestAnimationFrame(animate);
    };
    animRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animRef.current);
  }, []);

  /* progress 变化时无需重启 canvas，光环读的是闭包外 progress 参数
     通过 ref 传入让动画循环实时读取 */
  const progressRef = useRef(progress);
  progressRef.current = progress;

  return (
    <canvas
      ref={canvasRef}
      style={{ display: 'block', margin: '0 auto', imageRendering: 'auto' }}
      aria-hidden="true"
    />
  );
}

/* ── 闪烁扫描线文字 ─────────────────────────────────────────── */
function ScanText({ children }: { children: React.ReactNode }) {
  return (
    <span style={{
      fontFamily: "'Courier New', Consolas, monospace",
      fontSize: 10,
      letterSpacing: '0.18em',
      color: '#00d9ff',
      textShadow: '0 0 8px rgba(0,217,255,0.7)',
      textTransform: 'uppercase' as const,
    }}>{children}</span>
  );
}

/* ═══════════════════════════════════════════════════════════════
   主组件
═══════════════════════════════════════════════════════════════ */
export default function SidebarProjectsState({
  isLoading,
  loadingProgress,
  projectsCount,
  filteredProjectsCount,
  t,
}: SidebarProjectsStateProps) {
  if (isLoading) {
    const current = loadingProgress?.current ?? 0;
    const total   = loadingProgress?.total   ?? 0;
    const pct     = total > 0 ? current / total : 0;
    const projName = loadingProgress?.currentProject
      ? loadingProgress.currentProject.split('-').slice(-2).join('/')
      : null;

    /* ── tech 主题专用 sci-fi 版本（body.tech 时生效）──
       非 tech 主题降级为原始简洁版                     */
    return (
      <>
        {/* ── Tech sci-fi 版（仅 .tech 主题显示） ────────── */}
        <div className="tech-dna-loading hidden">
          <div style={{ textAlign: 'center', padding: '16px 8px 8px' }}>
            {/* DNA 旋转动画 */}
            <DNALoader progress={pct} />

            {/* SYSTEM INIT 文字 */}
            <div style={{ marginTop: 6, marginBottom: 4 }}>
              <ScanText>SYSTEM INIT</ScanText>
            </div>

            {/* 进度文字 */}
            {total > 0 && (
              <div style={{
                fontFamily: "'Courier New', monospace",
                fontSize: 11,
                color: 'rgba(0,210,255,0.85)',
                marginBottom: 3,
              }}>
                <span style={{ color: '#00e87a' }}>{current}</span>
                <span style={{ color: 'rgba(0,160,200,0.6)' }}>/{total}</span>
                <span style={{ color: 'rgba(0,140,180,0.5)', fontSize: 9, marginLeft: 4 }}>PROJECTS</span>
              </div>
            )}

            {/* 当前项目名 */}
            {projName && (
              <div style={{
                fontFamily: 'monospace',
                fontSize: 9,
                color: 'rgba(0,180,240,0.55)',
                letterSpacing: '0.08em',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                maxWidth: 140,
                margin: '0 auto',
              }}>
                {projName}
              </div>
            )}
          </div>
        </div>

        {/* ── 通用版（非 tech 主题，也作为 tech 主题的 fallback）── */}
        <div className="tech-dna-loading-default">
          <div className="text-center py-12 md:py-8 px-4">
            <div className="w-12 h-12 bg-muted rounded-lg flex items-center justify-center mx-auto mb-4 md:mb-3">
              <div className="w-6 h-6 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
            </div>
            <h3 className="text-base font-medium text-foreground mb-2 md:mb-1">{t('projects.loadingProjects')}</h3>
            {total > 0 ? (
              <div className="space-y-2">
                <div className="w-full bg-muted rounded-full h-2 overflow-hidden">
                  <div
                    className="bg-primary h-full transition-all duration-300 ease-out"
                    style={{ width: `${pct * 100}%` }}
                  />
                </div>
                <p className="text-sm text-muted-foreground">{current}/{total} {t('projects.projects')}</p>
                {projName && (
                  <p className="text-xs text-muted-foreground/70 truncate max-w-[200px] mx-auto">
                    {projName}
                  </p>
                )}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{t('projects.fetchingProjects')}</p>
            )}
          </div>
        </div>
      </>
    );
  }

  if (projectsCount === 0) {
    return (
      <div className="text-center py-12 md:py-8 px-4">
        <div className="w-12 h-12 bg-muted rounded-lg flex items-center justify-center mx-auto mb-4 md:mb-3">
          <Folder className="w-6 h-6 text-muted-foreground" />
        </div>
        <h3 className="text-base font-medium text-foreground mb-2 md:mb-1">{t('projects.noProjects')}</h3>
        <p className="text-sm text-muted-foreground">{t('projects.runClaudeCli')}</p>
      </div>
    );
  }

  if (filteredProjectsCount === 0) {
    return (
      <div className="text-center py-12 md:py-8 px-4">
        <div className="w-12 h-12 bg-muted rounded-lg flex items-center justify-center mx-auto mb-4 md:mb-3">
          <Search className="w-6 h-6 text-muted-foreground" />
        </div>
        <h3 className="text-base font-medium text-foreground mb-2 md:mb-1">{t('projects.noMatchingProjects')}</h3>
        <p className="text-sm text-muted-foreground">{t('projects.tryDifferentSearch')}</p>
      </div>
    );
  }

  return null;
}
