import CodeMirror from '@uiw/react-codemirror';
import type { Extension } from '@codemirror/state';
import { useEffect } from 'react';
import MarkdownPreview from './markdown/MarkdownPreview';

type CodeEditorSurfaceProps = {
  content: string;
  onChange: (value: string) => void;
  markdownPreview: boolean;
  isMarkdownFile: boolean;
  isDarkMode: boolean;
  fontSize: number;
  showLineNumbers: boolean;
  extensions: Extension[];
  softWrap: boolean;
};

export default function CodeEditorSurface({
  content,
  onChange,
  markdownPreview,
  isMarkdownFile,
  isDarkMode,
  fontSize,
  showLineNumbers,
  extensions,
  softWrap,
}: CodeEditorSurfaceProps) {
  useEffect(() => {
    const refresh = () => window.dispatchEvent(new Event('resize'));
    const firstFrame = requestAnimationFrame(refresh);
    const secondFrame = requestAnimationFrame(() => requestAnimationFrame(refresh));
    const delayedRefresh = window.setTimeout(refresh, 120);

    return () => {
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
      window.clearTimeout(delayedRefresh);
    };
  }, [content, markdownPreview, softWrap]);

  if (markdownPreview && isMarkdownFile) {
    return (
      <div className="h-full overflow-y-auto bg-white dark:bg-gray-900">
        <div className="max-w-4xl mx-auto px-8 py-6 prose prose-sm dark:prose-invert prose-headings:font-semibold prose-a:text-blue-600 dark:prose-a:text-blue-400 prose-code:text-sm prose-pre:bg-gray-900 prose-img:rounded-lg max-w-none break-words [overflow-wrap:anywhere]">
          <MarkdownPreview content={content} />
        </div>
      </div>
    );
  }

  return (
    <CodeMirror
      value={content}
      onChange={onChange}
      extensions={extensions}
      className={softWrap ? 'code-editor-soft-wrap' : undefined}
      theme={isDarkMode ? 'dark' : undefined}
      height="100%"
      style={{
        fontSize: `${fontSize}px`,
        height: '100%',
        maxWidth: '100%',
        overflow: 'hidden',
      }}
      basicSetup={{
        lineNumbers: showLineNumbers,
        foldGutter: true,
        dropCursor: false,
        allowMultipleSelections: false,
        indentOnInput: true,
        bracketMatching: true,
        closeBrackets: true,
        autocompletion: true,
        highlightSelectionMatches: true,
        searchKeymap: true,
      }}
    />
  );
}
