import React, { useMemo, useState, useEffect, useCallback } from 'react';
import ReactDOM from 'react-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { useTranslation } from 'react-i18next';
import { normalizeInlineCodeFences, normalizeLatexDelimiters } from '../../utils/chatFormatting';
import { copyTextToClipboard } from '../../../../utils/clipboard';
import { authenticatedFetch } from '../../../../utils/api';
import { useDeviceSettings } from '../../../../hooks/useDeviceSettings';

// ── 消息时间戳 Context：把消息创建时间透传给 ServerImage，用于图片快照 key ──
// 接受 ISO 字符串、毫秒数字、秒级数字或 Date 对象，0/空 表示无时间戳
const MessageTimestampContext = React.createContext<string | number | Date>(0);
type LocalFileOpenHandler = (filePath: string) => void;
const LocalFileOpenContext = React.createContext<LocalFileOpenHandler | undefined>(undefined);

// ── 全局图片灯箱（Portal 渲染，不受消息组件 re-render 影响）────────
let _setLightboxSrc: ((src: string | null) => void) | null = null;
function openLightbox(src: string) { _setLightboxSrc?.(src); }

function GlobalImageLightbox() {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => { _setLightboxSrc = setSrc; return () => { _setLightboxSrc = null; }; }, []);

  const close = useCallback(() => setSrc(null), []);
  useEffect(() => {
    if (!src) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [src, close]);

  if (!src) return null;
  return ReactDOM.createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 cursor-zoom-out"
      onClick={close}
      style={{ backdropFilter: 'blur(4px)' }}
    >
      <img
        src={src}
        alt="enlarged"
        className="max-w-[95vw] max-h-[95vh] object-contain rounded-lg shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      />
    </div>,
    document.body,
  );
}
// 在 App 层挂载一次即可；这里用模块级标记确保只创建一次
let _lightboxMounted = false;
function ensureLightboxMounted() {
  if (_lightboxMounted) return;
  _lightboxMounted = true;
  const container = document.createElement('div');
  container.id = 'image-lightbox-root';
  document.body.appendChild(container);
  // eslint-disable-next-line react/no-deprecated
  (ReactDOM as any).render
    ? (ReactDOM as any).render(React.createElement(GlobalImageLightbox), container)
    : import('react-dom/client').then(({ createRoot }) => createRoot(container).render(React.createElement(GlobalImageLightbox)));
}

type MarkdownProps = {
  children: React.ReactNode;
  className?: string;
  messageTimestamp?: string | number | Date;  // 消息的创建时间戳（ISO字符串/ms/s/Date），用于图片快照 key
  onFileOpen?: LocalFileOpenHandler;
};

type CodeBlockProps = {
  node?: any;
  inline?: boolean;
  className?: string;
  children?: React.ReactNode;
};

const LOCAL_TEXT_FILE_EXTENSION_RE = /\.(?:md|markdown|txt|text|log|csv|tsv|json|jsonl|ya?ml|toml|ini|conf|config|env|sh|bash|zsh|fish|py|r|js|jsx|mjs|cjs|ts|tsx|css|scss|less|html?|xml|sql|java|kt|kts|c|cc|cpp|cxx|h|hpp|rs|go|rb|php|swift|scala|lua|pl|pm|rst|adoc|tex|bib)(?::\d+(?::\d+)?)?$/i;

export function resolveLocalFileHref(href?: string) {
  if (!href) return null;

  let value = href.trim();
  try {
    value = decodeURIComponent(value);
  } catch {
    // Keep the original value when a partial percent escape cannot be decoded.
  }

  if (
    /^(?:https?|mailto|tel|data|blob):/i.test(value)
    || value.startsWith('//')
    || value.startsWith('#')
  ) {
    return null;
  }

  value = value
    .replace(/^file:\/\//i, '')
    .replace(/^sandbox:/i, '')
    .replace(/^vscode:\/\/file/i, '')
    .replace(/[?#].*$/, '')
    .replace(/:(\d+)(?::\d+)?$/, '');

  const isAbsoluteFile = (
    value.startsWith('/')
    || /^[A-Za-z]:[\\/]/.test(value)
  ) && LOCAL_TEXT_FILE_EXTENSION_RE.test(value);
  const isRelativeFile = (
    value.startsWith('./')
    || value.startsWith('../')
    || (!value.startsWith('/') && value.includes('/'))
  ) && LOCAL_TEXT_FILE_EXTENSION_RE.test(value);

  return isAbsoluteFile || isRelativeFile ? value : null;
}

function MarkdownLink({ href, children }: { href?: string; children?: React.ReactNode }) {
  const onFileOpen = React.useContext(LocalFileOpenContext);
  const localFilePath = resolveLocalFileHref(href);

  return (
    <a
      href={href}
      className="text-[#0969da] dark:text-[#58a6ff] hover:underline"
      target={localFilePath && onFileOpen ? undefined : '_blank'}
      rel={localFilePath && onFileOpen ? undefined : 'noopener noreferrer'}
      title={localFilePath || undefined}
      onClick={localFilePath && onFileOpen
        ? (event) => {
          event.preventDefault();
          onFileOpen(localFilePath);
        }
        : undefined}
    >
      {children}
    </a>
  );
}

const codexTerminalSyntaxTheme: Record<string, React.CSSProperties> = {
  'code[class*="language-"]': {
    color: '#e2e6ff',
    background: 'transparent',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
  },
  // Codex TUI's dark default: two_face Catppuccin Mocha TextMate scopes.
  'comment': { color: '#9fa6c5' },
  'keyword': { color: '#d0a9ff' },
  'operator': { color: '#8fe9dc' },
  'function': { color: '#90bbff' },
  'function-variable': { color: '#90bbff' },
  'string': { color: '#72f27a' },
  'number': { color: '#f6ab7d' },
  'boolean': { color: '#f6ab7d' },
  'property': { color: '#8fe9dc' },
  'class-name': { color: '#f1d58f' },
  'builtin': { color: '#f08da9' },
  'inserted': { color: '#72f27a' },
  'deleted': { color: '#f08da9' },
  'punctuation': { color: '#9fa6c5' },
  'parameter': { color: '#ef9bac' },
  'constant': { color: '#f6ab7d' },
  'regex': { color: '#f4afe0' },
  'tag': { color: '#90bbff' },
  'attr-name': { color: '#f1d58f' },
};

const terminalAccentPattern = /(✓|✔|✗|×|⚠|(?:已|正在)(?:完成|更新|修复|构建|重启|生成|检查|加载|保存|运行|连接)?|完成|成功|通过|失败|错误|警告|运行|检查|修改|创建|删除|读取|写入|搜索|调用|批准|构建|重启|加载|保存|连接|\bHTTP\s+\d+\b|\b\d+(?:\.\d+)?(?:ms|s|KB|MB|GB|%)?\b)/g;
const terminalAccentTokenPattern = /^(?:✓|✔|✗|×|⚠|(?:已|正在)(?:完成|更新|修复|构建|重启|生成|检查|加载|保存|运行|连接)?|完成|成功|通过|失败|错误|警告|运行|检查|修改|创建|删除|读取|写入|搜索|调用|批准|构建|重启|加载|保存|连接|HTTP\s+\d+|\d+(?:\.\d+)?(?:ms|s|KB|MB|GB|%)?)$/;

function getTerminalAccentClass(value: string) {
  if (/^(✗|×|失败|错误)/.test(value)) return 'codex-terminal-error';
  if (/^(⚠|警告)/.test(value)) return 'codex-terminal-warning';
  if (/^(✓|✔|已完成|完成|成功|通过)/.test(value)) return 'codex-terminal-success';
  if (/^\d|^HTTP\s+\d/.test(value)) return 'codex-terminal-info';
  return 'codex-terminal-action';
}

function renderTerminalAccents(children: React.ReactNode): React.ReactNode {
  const englishPattern = /([A-Za-z][A-Za-z0-9]*(?:[._:/+-][A-Za-z0-9]+)*)/g;
  const englishState = { index: 0 };
  const collectText = (node: React.ReactNode): string =>
    React.Children.toArray(node)
      .map(child => {
        if (typeof child === 'string') return child;
        if (!React.isValidElement(child)) return '';
        return collectText((child.props as { children?: React.ReactNode }).children);
      })
      .join('');
  const containsChinese = /[\u3400-\u9fff]/.test(collectText(children));

  const renderText = (text: string, keyPrefix: string): React.ReactNode[] =>
    text.split(terminalAccentPattern).flatMap((part, partIndex) => {
      if (!part) return [];
      if (terminalAccentTokenPattern.test(part)) {
        return [
          <span key={`${keyPrefix}-status-${partIndex}`} className={getTerminalAccentClass(part)}>
            {part}
          </span>,
        ];
      }
      if (!containsChinese) return [part];

      return part.split(englishPattern).map((token, tokenIndex) => {
        if (!englishPattern.test(token)) {
          englishPattern.lastIndex = 0;
          return token;
        }
        englishPattern.lastIndex = 0;
        const colorIndex = englishState.index++ % 6;
        return (
          <span
            key={`${keyPrefix}-english-${partIndex}-${tokenIndex}`}
            className={`codex-terminal-english-${colorIndex}`}
          >
            {token}
          </span>
        );
      });
    });

  const renderNode = (node: React.ReactNode, keyPrefix: string): React.ReactNode =>
    React.Children.map(node, (child, childIndex) => {
      const childKey = `${keyPrefix}-${childIndex}`;
      if (typeof child === 'string') return renderText(child, childKey);
      if (!React.isValidElement(child)) return child;

      const elementType = typeof child.type === 'string' ? child.type : '';
      if (elementType === 'code' || elementType === 'pre' || elementType === 'a') return child;
      const props = child.props as { children?: React.ReactNode; className?: string };
      if (/\b(?:katex|math-(?:inline|display))\b/.test(props.className || '')) return child;
      if (props.children === undefined) return child;
      return React.cloneElement(
        child as React.ReactElement<{ children?: React.ReactNode }>,
        undefined,
        renderNode(props.children, childKey)
      );
    });

  return renderNode(children, 'text');
}

const LazySyntaxHighlighter = React.lazy(async () => {
  const [
    prismLight,
    javascript,
    typescript,
    json,
    bash,
    python,
    markup,
    css,
    diff,
  ] = await Promise.all([
    import('react-syntax-highlighter/dist/esm/prism-light'),
    import('react-syntax-highlighter/dist/esm/languages/prism/javascript'),
    import('react-syntax-highlighter/dist/esm/languages/prism/typescript'),
    import('react-syntax-highlighter/dist/esm/languages/prism/json'),
    import('react-syntax-highlighter/dist/esm/languages/prism/bash'),
    import('react-syntax-highlighter/dist/esm/languages/prism/python'),
    import('react-syntax-highlighter/dist/esm/languages/prism/markup'),
    import('react-syntax-highlighter/dist/esm/languages/prism/css'),
    import('react-syntax-highlighter/dist/esm/languages/prism/diff'),
  ]);
  const SyntaxHighlighter = prismLight.default as any;
  SyntaxHighlighter.registerLanguage('javascript', javascript.default);
  SyntaxHighlighter.registerLanguage('typescript', typescript.default);
  SyntaxHighlighter.registerLanguage('json', json.default);
  SyntaxHighlighter.registerLanguage('bash', bash.default);
  SyntaxHighlighter.registerLanguage('python', python.default);
  SyntaxHighlighter.registerLanguage('markup', markup.default);
  SyntaxHighlighter.registerLanguage('css', css.default);
  SyntaxHighlighter.registerLanguage('diff', diff.default);
  SyntaxHighlighter.alias('javascript', ['js']);
  SyntaxHighlighter.alias('typescript', ['ts']);
  SyntaxHighlighter.alias('bash', ['shell', 'sh']);
  SyntaxHighlighter.alias('markup', ['html', 'xml']);
  return { default: SyntaxHighlighter };
}) as React.ComponentType<any>;

const CodeBlock = ({ node: _node, inline, className, children, ...props }: CodeBlockProps) => {
  const { t } = useTranslation('chat');
  const { isMobile } = useDeviceSettings({ trackPWA: false });
  // 直接读 DOM class，与 CSS ".tech" 选择器用同一来源，最可靠
  const isTech = typeof document !== 'undefined' && document.documentElement.classList.contains('tech');
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const raw = Array.isArray(children) ? children.join('') : String(children ?? '');
  const looksMultiline = /[\r\n]/.test(raw);
  // react-markdown v10 不再传递 inline prop；用 className 判断：块级代码块有 language-* 类
  const isBlock = Boolean(className && /^language-/.test(className));
  const shouldInline = !isBlock && (!looksMultiline || inline === true);

  if (shouldInline) {
    return (
      <code
        className={`font-mono text-[0.9em] px-1.5 py-0.5 rounded-md bg-gray-100 text-[#a16207] border border-gray-200 dark:bg-gray-800/60 dark:text-[#fde68a] dark:border-gray-700 whitespace-pre-wrap break-words ${className || ''
          }`}
        {...props}
      >
        {children}
      </code>
    );
  }

  const match = /language-(\w+(?:-\w+)*)/.exec(className || '');
  const language = match ? match[1] : 'text';

  // 折叠预览：取第一行，超长则截断
  // 只有真正多行（内容行数 > 1）或首行超长才折叠，单行代码块不折叠
  const firstLine = raw.split('\n')[0];
  const contentLines = raw.split('\n').filter(l => l.trim().length > 0);
  const hasMoreLines = contentLines.length > 1 || firstLine.length > 120;
  const previewText = firstLine.length > 120 ? firstLine.slice(0, 120) : firstLine;
  const shouldShowCollapsedPreview = !expanded && (hasMoreLines || isMobile);
  const lineCount = Math.max(1, contentLines.length || raw.split(/\r?\n/).length);
  const collapsedSummary = isMobile
    ? `${language && language !== 'text' ? language.toUpperCase() : 'Code'} block · ${lineCount} line${lineCount === 1 ? '' : 's'}`
    : previewText;

  // 折叠状态：单行预览 + 展开按钮
  if (shouldShowCollapsedPreview) {
    return (
      <div
        className={`flex items-center gap-2 my-2 px-3 py-2 font-mono text-sm cursor-pointer transition-colors ${
          isTech
            ? 'rounded-none border-l-2 border-cyan-400/60 bg-transparent hover:border-cyan-400'
            : 'rounded-lg bg-gray-900 border border-gray-700 text-gray-300 hover:border-gray-500'
        }`}
        onClick={() => setExpanded(true)}
        title="Click to expand code"
      >
        {language && language !== 'text' && (
          <span className="text-xs text-gray-500 font-sans font-medium uppercase flex-shrink-0">[{language}]</span>
        )}
        <span className="flex-1 min-w-0 overflow-hidden">
          {!isMobile && language !== 'text' ? (
            <React.Suspense fallback={<span style={{ color: '#e2e6ff' }}>{collapsedSummary}</span>}>
              <LazySyntaxHighlighter
                language={language}
                style={codexTerminalSyntaxTheme}
                PreTag="span"
                CodeTag="span"
                customStyle={{
                  display: 'block',
                  margin: 0,
                  padding: 0,
                  background: 'transparent',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  color: '#e2e6ff',
                  textShadow: 'none',
                }}
              >
                {collapsedSummary}
              </LazySyntaxHighlighter>
            </React.Suspense>
          ) : (
            <span className="block truncate" style={isTech ? { color: '#CCCCCC' } : undefined}>
              {collapsedSummary}
            </span>
          )}
        </span>
        <span className="text-gray-500 flex-shrink-0 text-xs">…</span>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setExpanded(true); }}
          className="flex-shrink-0 flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 bg-gray-800 hover:bg-gray-700 px-2 py-0.5 rounded transition-colors border border-gray-600"
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
          Expand
        </button>
      </div>
    );
  }

  // 展开状态：完整代码块。使用原生 <pre>，避免为每条消息加载 Prism 高亮器。
  const copyBtn = (
    <button
      type="button"
      onClick={() =>
        copyTextToClipboard(raw).then((success) => {
          if (success) { setCopied(true); setTimeout(() => setCopied(false), 2000); }
        })
      }
      className={`absolute top-2 right-2 z-10 opacity-0 group-hover:opacity-100 focus:opacity-100 active:opacity-100 transition-opacity text-xs px-2 py-1 ${isTech ? 'border border-cyan-400/50 text-cyan-400 hover:bg-cyan-400/10' : 'rounded-md bg-gray-700/80 hover:bg-gray-700 text-white border border-gray-600'}`}
      title={copied ? t('codeBlock.copied') : t('codeBlock.copyCode')}
    >
      {copied ? (
        <span className="flex items-center gap-1">
          <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
          </svg>
          {t('codeBlock.copied')}
        </span>
      ) : (
        <span className="flex items-center gap-1">
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
            <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"></path>
          </svg>
          {t('codeBlock.copy')}
        </span>
      )}
    </button>
  );

  const collapseBtn = hasMoreLines && (
    <button
      type="button"
      onClick={() => setExpanded(false)}
      className={`w-full flex items-center justify-center gap-1 mt-1 text-xs py-1 rounded transition-colors ${isTech ? 'text-cyan-400/60 hover:text-cyan-400' : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800'}`}
    >
      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" />
      </svg>
      Collapse
    </button>
  );

  return (
    <div className="relative group my-2" style={isTech ? { borderLeft: '2px solid rgba(148,226,213,0.40)' } : undefined}>
      {language && language !== 'text' && (
        <div
          className={`absolute top-2 left-3 z-10 text-xs font-medium uppercase ${isTech ? '' : 'text-gray-400'}`}
          style={isTech ? { color: '#8fe9dc', letterSpacing: '0.1em' } : undefined}
        >
          {language}
        </div>
      )}
      {copyBtn}
      <div className={isTech ? '' : 'rounded-lg bg-gray-900 text-gray-100 border border-gray-700'}>
        <React.Suspense fallback={<code>{raw}</code>}>
          <LazySyntaxHighlighter
            language={language === 'text' ? 'text' : language}
            style={codexTerminalSyntaxTheme}
            PreTag="div"
            wrapLongLines={false}
            customStyle={{
              margin: 0,
              background: 'transparent',
              fontSize: '0.875rem',
              padding: language && language !== 'text' ? '2rem 1rem 1rem 1rem' : '1rem',
            color: isTech ? '#e2e6ff' : undefined,
            textShadow: 'none',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
              overflowX: 'auto',
              whiteSpace: 'pre',
            }}
          >
            {raw}
          </LazySyntaxHighlighter>
        </React.Suspense>
      </div>
      {collapseBtn}
    </div>
  );
};

const markdownComponents = {
  // 去掉 react-markdown 默认的 <pre> 包裹，让 CodeBlock 自己管理容器
  // 否则 white-space:pre 会强制展开所有行
  pre: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  code: CodeBlock,
  blockquote: ({ children }: { children?: React.ReactNode }) => (
    <blockquote className="border-l-4 border-[#14b8a6] dark:border-[#5eead4] pl-4 italic text-[#57606a] dark:text-[#94a3b8] my-2">
      {children}
    </blockquote>
  ),
  a: MarkdownLink,
  p: ({ children }: { children?: React.ReactNode }) => <div className="mb-2 last:mb-0">{renderTerminalAccents(children)}</div>,
  li: ({ children }: { children?: React.ReactNode }) => <li>{renderTerminalAccents(children)}</li>,
  table: ({ children }: { children?: React.ReactNode }) => (
    <div className="overflow-x-auto my-2">
      <table className="min-w-full border-collapse border border-gray-200 dark:border-gray-700">{children}</table>
    </div>
  ),
  thead: ({ children }: { children?: React.ReactNode }) => <thead className="bg-gray-50 dark:bg-gray-800">{children}</thead>,
  th: ({ children }: { children?: React.ReactNode }) => (
    <th className="px-3 py-2 text-left text-sm font-semibold border border-gray-200 dark:border-gray-700">{children}</th>
  ),
  td: ({ children }: { children?: React.ReactNode }) => (
    <td className="px-3 py-2 align-top text-sm border border-gray-200 dark:border-gray-700">{children}</td>
  ),
};

// 匹配任意 Unix 绝对路径中以图片扩展名结尾的文件路径
const IMAGE_PATH_RE = /(\/[^\s"'`<>]+?\.(?:png|jpg|jpeg|gif|svg|webp|bmp))/gi;

// 将文本中所有裸路径提取并替换为特殊代码块（单张/多张统一处理）
function injectImagePaths(text: string): string {
  const matches = Array.from(new Set(text.match(IMAGE_PATH_RE) ?? []));
  if (matches.length === 0) return text;

  // 把原始路径从文本中移除，避免重复显示
  let cleaned = text.replace(IMAGE_PATH_RE, '');

  // 用特殊代码块注入图片集合，交给 CodeBlock 渲染
  const block = '```img-gallery\n' + matches.join('\n') + '\n```';
  return cleaned + '\n\n' + block;
}

// 单张图片组件，支持点击放大（通过全局 Portal 灯箱）
// 重试延迟序列（ms）：2s, 4s, 8s, 16s, 30s
const RETRY_DELAYS = [2000, 4000, 8000, 16000, 30000];

// ── 模块级图片缓存（跨组件挂载/卸载持久化，防止流式渲染反复重启下载）──────
type ImageCacheEntry = {
  status: 'loading' | 'done' | 'error';
  blobUrl?: string;
  retryCount: number;
  promise?: Promise<void>;
  subscribers: Set<() => void>;
};
const imageCache = new Map<string, ImageCacheEntry>();

function fetchImageCached(apiSrc: string): ImageCacheEntry {
  const existing = imageCache.get(apiSrc);
  if (existing) return existing;

  const entry: ImageCacheEntry = { status: 'loading', retryCount: 0, subscribers: new Set() };

  const doFetch = () => {
    entry.promise = authenticatedFetch(apiSrc)
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.blob();
      })
      .then(blob => {
        entry.status = 'done';
        entry.blobUrl = URL.createObjectURL(blob);
        entry.subscribers.forEach(fn => fn());
      })
      .catch(() => {
        const delay = RETRY_DELAYS[entry.retryCount] ?? null;
        if (delay !== null) {
          entry.retryCount++;
          entry.subscribers.forEach(fn => fn());
          setTimeout(doFetch, delay);
        } else {
          entry.status = 'error';
          entry.subscribers.forEach(fn => fn());
        }
      });
  };
  doFetch();
  imageCache.set(apiSrc, entry);
  return entry;
}

// 订阅缓存条目状态变化的 hook
function useImageCache(apiSrc: string) {
  const [, forceUpdate] = React.useState(0);
  const entry = React.useMemo(() => fetchImageCached(apiSrc), [apiSrc]);

  useEffect(() => {
    const cb = () => forceUpdate(c => c + 1);
    entry.subscribers.add(cb);
    return () => { entry.subscribers.delete(cb); };
  }, [entry]);

  return entry;
}

// ── DNA 双螺旋加载动画 ─────────────────────────────────────────────────────
function DnaSpinner() {
  return (
    <svg width="32" height="32" viewBox="0 0 40 40" className="animate-spin" style={{ animationDuration: '2.5s' }}>
      {[0, 1, 2, 3, 4, 5].map(i => {
        const angle = (i / 6) * Math.PI * 2;
        const r = 12;
        const cx1 = 20 + Math.cos(angle) * r;
        const cy = 6 + i * 5;
        const cx2 = 20 - Math.cos(angle) * r;
        const opacity = 0.3 + Math.abs(Math.cos(angle)) * 0.7;
        return (
          <g key={i}>
            <circle cx={cx1} cy={cy} r="2.5" fill="#60a5fa" opacity={opacity} />
            <circle cx={cx2} cy={cy} r="2.5" fill="#f472b6" opacity={opacity} />
            <line x1={cx1} y1={cy} x2={cx2} y2={cy} stroke="#6b7280" strokeWidth="0.8" opacity={opacity * 0.5} />
          </g>
        );
      })}
    </svg>
  );
}

function ServerImage({ src, small = false }: { src: string; small?: boolean }) {
  // 所有 hooks 必须在最顶部
  const msgTsRaw = React.useContext(MessageTimestampContext);
  const msgTsMs = React.useMemo(() => {
    if (!msgTsRaw) return 0;
    const n = typeof msgTsRaw === 'number' ? msgTsRaw : Number(new Date(msgTsRaw as any));
    if (!Number.isFinite(n) || n <= 0) return 0;
    return n <= 1e11 ? n * 1000 : n;
  }, [msgTsRaw]);
  const mountTs = React.useRef(Date.now());
  const stableTs = msgTsMs > 0 ? msgTsMs : mountTs.current;
  const apiSrc = `/api/image?path=${encodeURIComponent(src || '')}&t=${stableTs}&snapshot=1`;

  // 通过模块级缓存下载图片（fetch 不依赖 DOM，流式重渲染不会打断下载）
  const entry = useImageCache(apiSrc);

  useEffect(() => { ensureLightboxMounted(); }, []);

  if (!src || typeof src !== 'string') return null;

  const placeholderH = small ? '160px' : '200px';

  // 加载失败（已用完所有重试机会）
  if (entry.status === 'error') {
    return (
      <div
        className="flex flex-col items-center justify-center rounded-lg bg-gray-100 dark:bg-gray-800 cursor-pointer"
        style={{ minHeight: placeholderH, maxWidth: '100%', width: small ? '240px' : '360px' }}
        onClick={() => { imageCache.delete(apiSrc); fetchImageCached(apiSrc); }}
      >
        <span className="text-2xl mb-1">⚠</span>
        <span className="text-xs text-gray-400 dark:text-gray-500">图片加载失败</span>
        <span className="text-xs text-blue-400 mt-0.5">点击重试</span>
      </div>
    );
  }

  // 下载完成
  if (entry.status === 'done' && entry.blobUrl) {
    return (
      <img
        src={entry.blobUrl}
        alt={src.split('/').pop() ?? 'image'}
        className="rounded-lg shadow-md cursor-zoom-in hover:opacity-90 transition-opacity object-contain"
        style={{ maxHeight: small ? '240px' : '320px', maxWidth: '100%' }}
        onClick={() => openLightbox(entry.blobUrl!)}
      />
    );
  }

  // 加载中：DNA 动画占位
  return (
    <div
      className="flex flex-col items-center justify-center rounded-lg bg-gray-50 dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700"
      style={{ minHeight: placeholderH, maxWidth: '100%', width: small ? '240px' : '360px' }}
    >
      <DnaSpinner />
      <span className="text-xs text-gray-400 dark:text-gray-500 mt-2 max-w-[200px] truncate px-2">
        {src.split('/').pop()}
      </span>
      {entry.retryCount > 0 && (
        <span className="text-[10px] text-gray-400 mt-0.5">重试中 ({entry.retryCount}/{RETRY_DELAYS.length})</span>
      )}
    </div>
  );
}

// 图片画廊：多张横向排列可滚动，单张居中稍大
function ImageGallery({ paths }: { paths: string[] }) {
  if (paths.length === 0) return null;

  if (paths.length === 1) {
    return (
      <div className="my-2">
        <ServerImage src={paths[0]} small={false} />
      </div>
    );
  }

  return (
    <div className="flex gap-3 overflow-x-auto py-2 my-2 scrollbar-thin scrollbar-thumb-gray-300 dark:scrollbar-thumb-gray-600">
      {paths.map((p) => (
        <div key={p} className="flex-shrink-0">
          <ServerImage src={p} small={true} />
          <div className="text-xs text-gray-400 mt-1 max-w-[200px] truncate">{p.split('/').pop()}</div>
        </div>
      ))}
    </div>
  );
}

// 扩展 CodeBlock：拦截 img-gallery 语言标记
const CodeBlockWithGallery = ({ node, inline, className, children, ...props }: CodeBlockProps) => {
  const match = /language-(\w+(?:-\w+)*)/.exec(className || '');
  const language = match ? match[1] : '';

  if (language === 'img-gallery') {
    const raw = Array.isArray(children) ? children.join('') : String(children ?? '');
    const paths = raw.trim().split('\n').filter((p): p is string => typeof p === 'string' && p.trim().length > 0);
    return <ImageGallery paths={paths} />;
  }

  return <CodeBlock node={node} inline={inline} className={className} {...props}>{children}</CodeBlock>;
};

const markdownComponentsWithImage = {
  ...markdownComponents,
  code: CodeBlockWithGallery,
};

export function Markdown({
  children,
  className,
  messageTimestamp = 0 as string | number | Date,
  onFileOpen,
}: MarkdownProps) {
  const raw = String(children ?? '');
  // 将裸露的图片路径收集并注入 img-gallery 代码块
  const content = normalizeInlineCodeFences(injectImagePaths(normalizeLatexDelimiters(raw)));
  const remarkPlugins = useMemo(() => [remarkGfm, remarkMath], []);
  const rehypePlugins = useMemo(
    () => [[rehypeKatex, { strict: false, throwOnError: false }] as [typeof rehypeKatex, { strict: boolean; throwOnError: boolean }]],
    [],
  );

  return (
    // 通过 Context 将消息时间戳传递给嵌套的 ServerImage，实现稳定的快照 key
    <LocalFileOpenContext.Provider value={onFileOpen}>
      <MessageTimestampContext.Provider value={messageTimestamp}>
        <div className={className}>
          <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={markdownComponentsWithImage as any}>
            {content}
          </ReactMarkdown>
        </div>
      </MessageTimestampContext.Provider>
    </LocalFileOpenContext.Provider>
  );
}
