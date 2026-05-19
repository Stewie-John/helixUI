import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import compression from 'vite-plugin-compression'

export default defineConfig(({ command, mode }) => {
  // Load env file based on `mode` in the current working directory.
  const env = loadEnv(mode, process.cwd(), '')

  const host = env.HOST || '0.0.0.0'
  // When binding to all interfaces (0.0.0.0), proxy should connect to localhost
  // Otherwise, proxy to the specific host the backend is bound to
  const proxyHost = host === '0.0.0.0' ? 'localhost' : host
  const port = env.PORT || 3001

  return {
    plugins: [
      react(),
      // 生成 .gz 预压缩文件（gzip level 9，最优压缩）
      compression({ algorithm: 'gzip', ext: '.gz', threshold: 1024 }),
      // 生成 .br 预压缩文件（Brotli，比 gzip 小 20-30%）
      compression({ algorithm: 'brotliCompress', ext: '.br', threshold: 1024 }),
    ],
    server: {
      host,
      port: parseInt(env.VITE_PORT) || 5173,
      proxy: {
        '/api': `http://${proxyHost}:${port}`,
        '/ws': {
          target: `ws://${proxyHost}:${port}`,
          ws: true
        },
        '/shell': {
          target: `ws://${proxyHost}:${port}`,
          ws: true
        }
      }
    },
    build: {
      outDir: 'dist',
      chunkSizeWarningLimit: 1000,
      // 所有 chunk 全部预加载（并行下载），确保打开文件编辑器、终端等时无延迟
      // 首屏慢的根因是旧 SW 缓存问题（已修复），不是预加载造成的
      rollupOptions: {
        output: {
          manualChunks: {
            // UI 框架核心（首屏必须）
            'vendor-react': ['react', 'react-dom', 'react-router-dom'],
            // Markdown 渲染 + 数学公式（体积大，延迟加载）
            'vendor-markdown': [
              'react-markdown',
              'remark-gfm',
              'remark-math',
              'rehype-katex',
              'rehype-raw',
              'katex',
            ],
            // 代码高亮（体积大，消息渲染时才需要）
            'vendor-highlight': [
              'react-syntax-highlighter',
            ],
            // 国际化（非首屏核心）
            'vendor-i18n': [
              'i18next',
              'react-i18next',
              'i18next-browser-languagedetector',
            ],
            // 代码编辑器（仅 File Editor 页面使用）
            'vendor-codemirror': [
              '@uiw/react-codemirror',
              '@codemirror/lang-css',
              '@codemirror/lang-html',
              '@codemirror/lang-javascript',
              '@codemirror/lang-json',
              '@codemirror/lang-markdown',
              '@codemirror/lang-python',
              '@codemirror/theme-one-dark'
            ],
            // 终端模拟器（仅 Shell 页面使用）
            'vendor-xterm': ['@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-clipboard', '@xterm/addon-webgl'],
          }
        }
      }
    }
  }
})
