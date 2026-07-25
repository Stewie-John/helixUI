import { createContext, useContext, useEffect, useMemo, useState, type ComponentPropsWithoutRef } from 'react';
import type { Components } from 'react-markdown';
import ReactMarkdown from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { normalizeLatexDelimiters } from '../../../../chat/utils/chatFormatting';
import { authenticatedFetch } from '../../../../../utils/api';
import MarkdownCodeBlock from './MarkdownCodeBlock';

type MarkdownPreviewProps = {
  content: string;
  filePath: string;
  projectName?: string;
};

type MarkdownAssetContextValue = {
  filePath: string;
  projectName?: string;
};

const MarkdownAssetContext = createContext<MarkdownAssetContextValue>({
  filePath: '',
});

const EXTERNAL_ASSET_RE = /^(?:https?:|data:|blob:|\/\/)/i;

export function resolveMarkdownAssetPath(source: string, markdownFilePath: string) {
  const value = source.trim();
  if (!value || EXTERNAL_ASSET_RE.test(value) || value.startsWith('#')) {
    return null;
  }

  const decoded = (() => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  })();
  const pathOnly = decoded.replace(/[?#].*$/, '').replace(/\\/g, '/');
  if (pathOnly.startsWith('/')) return pathOnly;

  const baseParts = markdownFilePath.replace(/\\/g, '/').split('/').slice(0, -1);
  for (const part of pathOnly.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (baseParts.length > 1) baseParts.pop();
      continue;
    }
    baseParts.push(part);
  }

  return baseParts.join('/') || null;
}

function MarkdownImage({
  src = '',
  alt = '',
  ...props
}: ComponentPropsWithoutRef<'img'>) {
  const { filePath, projectName } = useContext(MarkdownAssetContext);
  const source = typeof src === 'string' ? src : '';
  const localPath = resolveMarkdownAssetPath(source, filePath);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!localPath || !projectName) {
      setObjectUrl(null);
      setFailed(false);
      return undefined;
    }

    const controller = new AbortController();
    let loadedObjectUrl: string | null = null;
    setObjectUrl(null);
    setFailed(false);

    authenticatedFetch(
      `/api/projects/${encodeURIComponent(projectName)}/files/content?path=${encodeURIComponent(localPath)}`,
      { signal: controller.signal },
    )
      .then((response) => {
        if (!response.ok) throw new Error(`Image request failed (${response.status})`);
        return response.blob();
      })
      .then((blob) => {
        if (controller.signal.aborted) return;
        loadedObjectUrl = URL.createObjectURL(blob);
        setObjectUrl(loadedObjectUrl);
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === 'AbortError') return;
        setFailed(true);
      });

    return () => {
      controller.abort();
      if (loadedObjectUrl) URL.revokeObjectURL(loadedObjectUrl);
    };
  }, [localPath, projectName]);

  if (failed) {
    return (
      <span className="inline-flex max-w-full items-center rounded border border-red-400/40 bg-red-950/20 px-2 py-1 text-xs text-red-400">
        {alt || source}
      </span>
    );
  }

  if (localPath && projectName && !objectUrl) {
    return (
      <span className="inline-block h-20 w-32 max-w-full animate-pulse rounded bg-gray-200 dark:bg-gray-800" />
    );
  }

  return (
    <img
      {...props}
      src={objectUrl || source}
      alt={alt}
      className="h-auto max-w-full rounded-lg"
      loading="lazy"
    />
  );
}

const markdownPreviewComponents: Components = {
  code: MarkdownCodeBlock,
  img: MarkdownImage,
  blockquote: ({ children }) => (
    <blockquote className="border-l-4 border-gray-300 dark:border-gray-600 pl-4 italic text-gray-600 dark:text-gray-400 my-2">
      {children}
    </blockquote>
  ),
  a: ({ href, children }) => (
    <a href={href} className="text-blue-600 dark:text-blue-400 hover:underline" target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div className="overflow-x-auto my-2">
      <table className="min-w-full border-collapse border border-gray-200 dark:border-gray-700">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-gray-50 dark:bg-gray-800">{children}</thead>,
  th: ({ children }) => (
    <th className="px-3 py-2 text-left text-sm font-semibold border border-gray-200 dark:border-gray-700">{children}</th>
  ),
  td: ({ children }) => (
    <td className="px-3 py-2 align-top text-sm border border-gray-200 dark:border-gray-700">{children}</td>
  ),
};

export default function MarkdownPreview({ content, filePath, projectName }: MarkdownPreviewProps) {
  const normalizedContent = useMemo(() => normalizeLatexDelimiters(content), [content]);
  const remarkPlugins = useMemo(() => [remarkGfm, remarkMath], []);
  const rehypePlugins = useMemo(
    () => [[rehypeKatex, { strict: false, throwOnError: false }] as [
      typeof rehypeKatex,
      { strict: boolean; throwOnError: boolean },
    ]],
    [],
  );

  return (
    <MarkdownAssetContext.Provider value={{ filePath, projectName }}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={markdownPreviewComponents}
      >
        {normalizedContent}
      </ReactMarkdown>
    </MarkdownAssetContext.Provider>
  );
}
