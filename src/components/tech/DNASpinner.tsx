import { useEffect, useRef } from 'react';

interface DNASpinnerProps {
  /** sm: 18×26px (行内使用), md: 52×78px (页面级加载) */
  size?: 'sm' | 'md';
}

/**
 * 统一的浅蓝色 DNA 旋转加载动画
 * - 单色浅蓝（#3cc3ff），两条链 + 横档
 * - 3D 深度感：不透明度 + 线宽随 sin(angle) 变化
 */
export default function DNASpinner({ size = 'md' }: DNASpinnerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const W = size === 'sm' ? 18 : 52;
  const H = size === 'sm' ? 26 : 78;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const cW = canvas.width;
    const cH = canvas.height;
    const cx    = cW / 2;
    const ampX  = cW * 0.34;
    const turns = 2.2;
    const N     = 60;         // 每条链分段数
    const nRungs = size === 'sm' ? 7 : 9;  // 横档数
    let phase = 0;
    let raf: number;

    const draw = () => {
      ctx.clearRect(0, 0, cW, cH);

      // 两条链：均为浅蓝 #3cc3ff，相位差 180°
      for (let s = 0; s < 2; s++) {
        const phaseOff = s === 0 ? 0 : Math.PI;
        for (let i = 0; i < N; i++) {
          const t0 = i / N;
          const t1 = (i + 1) / N;
          const y0 = t0 * cH;
          const y1 = t1 * cH;
          const a0 = phase + t0 * turns * Math.PI * 2 + phaseOff;
          const a1 = phase + t1 * turns * Math.PI * 2 + phaseOff;
          const x0 = cx + ampX * Math.cos(a0);
          const x1 = cx + ampX * Math.cos(a1);
          const depth = (Math.sin(a0) + Math.sin(a1)) / 2; // -1 ~ +1
          const alpha = Math.max(0.07, 0.28 + depth * 0.68);
          const lw    = Math.max(0.35, 0.65 + depth * 1.5);
          ctx.strokeStyle = `rgba(60, 195, 255, ${alpha})`;
          ctx.lineWidth = lw;
          ctx.beginPath();
          ctx.moveTo(x0, y0);
          ctx.lineTo(x1, y1);
          ctx.stroke();
        }
      }

      // 横档（rungs）
      for (let i = 0; i < nRungs; i++) {
        const t  = i / (nRungs - 1);
        const y  = t * cH;
        const a  = phase + t * turns * Math.PI * 2;
        const x1 = cx + ampX * Math.cos(a);
        const x2 = cx + ampX * Math.cos(a + Math.PI);
        const vis = Math.abs(Math.sin(a));
        ctx.strokeStyle = `rgba(140, 220, 255, ${0.07 + vis * 0.28})`;
        ctx.lineWidth = 0.5 + vis * 0.6;
        ctx.beginPath();
        ctx.moveTo(x1, y);
        ctx.lineTo(x2, y);
        ctx.stroke();
      }

      phase += 0.048;
      raf = requestAnimationFrame(draw);
    };

    draw();
    return () => cancelAnimationFrame(raf);
  }, [size]);

  return (
    <canvas
      ref={canvasRef}
      width={W}
      height={H}
      style={{ display: 'block' }}
    />
  );
}
