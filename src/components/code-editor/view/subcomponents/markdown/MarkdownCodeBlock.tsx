import { useState } from 'react';
import type { ComponentProps } from 'react';
import { copyTextToClipboard } from '../../../../../utils/clipboard';
import { useDeviceSettings } from '../../../../../hooks/useDeviceSettings';

type MarkdownCodeBlockProps = {
  inline?: boolean;
  node?: unknown;
} & ComponentProps<'code'>;

export default function MarkdownCodeBlock({
  inline,
  className,
  children,
  node: _node,
  ...props
}: MarkdownCodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const { isMobile } = useDeviceSettings({ trackPWA: false });
  const rawContent = Array.isArray(children) ? children.join('') : String(children ?? '');
  const looksMultiline = /[\r\n]/.test(rawContent);
  const isBlock = Boolean(className && /^language-/.test(className));
  const shouldRenderInline = inline || (!isBlock && !looksMultiline);

  if (shouldRenderInline) {
    return (
      <code
        className={`font-mono text-[0.9em] px-1.5 py-0.5 rounded-md bg-gray-100 text-gray-900 border border-gray-200 dark:bg-gray-800/60 dark:text-gray-100 dark:border-gray-700 whitespace-pre-wrap break-words ${className || ''}`}
        {...props}
      >
        {children}
      </code>
    );
  }

  const languageMatch = /language-(\w+)/.exec(className || '');
  const language = languageMatch ? languageMatch[1] : 'text';
  const lineCount = Math.max(1, rawContent.split(/\r?\n/).filter((line) => line.trim().length > 0).length);

  if (isMobile && !expanded) {
    return (
      <div
        className="flex items-center gap-2 my-2 px-3 py-2 font-mono text-sm cursor-pointer transition-colors rounded-lg bg-gray-900 border border-gray-700 text-gray-300 hover:border-gray-500"
        onClick={() => setExpanded(true)}
        title="Click to expand code"
      >
        {language !== 'text' && (
          <span className="text-xs text-gray-500 font-sans font-medium uppercase flex-shrink-0">[{language}]</span>
        )}
        <span className="flex-1 truncate text-gray-400">
          {language !== 'text' ? language.toUpperCase() : 'Code'} block · {lineCount} line{lineCount === 1 ? '' : 's'}
        </span>
        <span className="text-gray-500 flex-shrink-0 text-xs">...</span>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            setExpanded(true);
          }}
          className="flex-shrink-0 flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 bg-gray-800 hover:bg-gray-700 px-2 py-0.5 rounded transition-colors border border-gray-600"
        >
          Expand
        </button>
      </div>
    );
  }

  return (
    <div className="relative group my-2">
      {language !== 'text' && (
        <div className="absolute top-2 left-3 z-10 text-xs text-gray-400 font-medium uppercase">{language}</div>
      )}

      <button
        type="button"
        onClick={() =>
          copyTextToClipboard(rawContent).then((success) => {
            if (success) {
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            }
          })}
        className="absolute top-2 right-2 z-10 opacity-0 group-hover:opacity-100 transition-opacity text-xs px-2 py-1 rounded-md bg-gray-700/80 hover:bg-gray-700 text-white border border-gray-600"
      >
        {copied ? 'Copied!' : 'Copy'}
      </button>

      <pre
        className="rounded-lg bg-gray-900 text-gray-100 border border-gray-700"
        style={{
          margin: 0,
          fontSize: '0.875rem',
          padding: language !== 'text' ? '2rem 1rem 1rem 1rem' : '1rem',
          overflowX: 'auto',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
        }}
      >
        <code>{rawContent}</code>
      </pre>
      {isMobile && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="w-full flex items-center justify-center gap-1 mt-1 text-xs py-1 rounded transition-colors text-gray-500 hover:text-gray-300 hover:bg-gray-800"
        >
          Collapse
        </button>
      )}
    </div>
  );
}
