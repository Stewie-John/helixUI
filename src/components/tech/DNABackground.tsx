/**
 * DNA 背景视频播放器
 *
 * 使用离线预渲染的 WebM 视频（public/dna-bg.webm）替代原来的 Canvas 实时渲染。
 * 视频由 scripts/render-dna-bg.mjs 生成，走浏览器硬件解码，CPU 占用接近 0。
 *
 * 若视频加载失败（首次部署前文件不存在），组件静默隐藏，不影响主界面。
 */

import { useState } from 'react';

export default function DNABackground() {
  const [visible, setVisible] = useState(true);

  if (!visible) return null;

  return (
    <video
      src="/dna-bg.webm"
      autoPlay
      loop
      muted
      playsInline
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
