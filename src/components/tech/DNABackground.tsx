/**
 * DNA 背景视频播放器
 *
 * 使用离线预渲染的 WebM 视频（public/dna-bg.webm）替代原来的 Canvas 实时渲染。
 * 视频由 scripts/render-dna-bg.mjs 生成，走浏览器硬件解码，CPU 占用接近 0。
 *
 * 若视频加载失败（首次部署前文件不存在），组件静默隐藏，不影响主界面。
 */

import { useState } from 'react';
import { useVisualPerformanceMode } from '../../hooks/useVisualPerformanceMode';

type DNABackgroundProps = {
  staticFrame?: boolean;
  forceVideo?: boolean;
};

export default function DNABackground({ staticFrame = false, forceVideo = false }: DNABackgroundProps) {
  const [visible, setVisible] = useState(true);
  const { reduceAnimations } = useVisualPerformanceMode();

  if (reduceAnimations && !staticFrame && !forceVideo) {
    return (
      <div
        aria-hidden="true"
        style={{
          position: 'fixed',
          inset: 0,
          width: '100%',
          height: '100%',
          pointerEvents: 'none',
          zIndex: 0,
          backgroundColor: '#020c18',
          backgroundImage:
            'radial-gradient(circle at 20% 20%, rgba(0,190,255,0.17), transparent 46%),' +
            'radial-gradient(circle at 80% 80%, rgba(0,150,220,0.14), transparent 48%)',
        }}
      />
    );
  }

  if (!visible) return null;

  return (
    <video
      src="/dna-bg.webm"
      autoPlay={!staticFrame}
      loop={!staticFrame}
      muted
      playsInline
      preload={staticFrame ? 'auto' : 'metadata'}
      onLoadedData={(event) => {
        if (!staticFrame) return;
        const video = event.currentTarget;
        video.pause();
        if (video.currentTime !== 0) {
          video.currentTime = 0;
        }
      }}
      onError={() => setVisible(false)}
      style={{
        position:   'fixed',
        inset:      0,
        width:      '100%',
        height:     '100%',
        objectFit:  'cover',
        zIndex:     0,
        pointerEvents: 'none',
        opacity:    1,
      }}
      aria-hidden="true"
    />
  );
}
