import { EditorView } from '@codemirror/view';
import { unifiedMergeView } from '@codemirror/merge';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { Prec, type Extension } from '@codemirror/state';
import { tags as t } from '@lezer/highlight';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useCodeEditorDocument } from '../hooks/useCodeEditorDocument';
import { useCodeEditorSettings } from '../hooks/useCodeEditorSettings';
import { useEditorKeyboardShortcuts } from '../hooks/useEditorKeyboardShortcuts';
import type { CodeEditorFile } from '../types/types';
import {
  createMinimapExtension,
  createScrollToFirstChunkExtension,
  getLanguageExtensions,
  logLanguage,
  logHighlightTags,
} from '../utils/editorExtensions';
import { getEditorStyles } from '../utils/editorStyles';
import { createEditorToolbarPanelExtension } from '../utils/editorToolbarPanel';
import { createLogScrollMemoryExtension } from '../utils/logScrollMemory';
import { exportMarkdownPdf } from '../utils/exportMarkdownPdf';
import CodeEditorFooter from './subcomponents/CodeEditorFooter';
import CodeEditorHeader from './subcomponents/CodeEditorHeader';
import CodeEditorLoadingState from './subcomponents/CodeEditorLoadingState';
import CodeEditorSurface from './subcomponents/CodeEditorSurface';
import CodeEditorBinaryFile from './subcomponents/CodeEditorBinaryFile';

type CodeEditorProps = {
  file: CodeEditorFile;
  onClose: () => void;
  projectPath?: string;
  isSidebar?: boolean;
  isExpanded?: boolean;
  onToggleExpand?: (() => void) | null;
  onPopOut?: (() => void) | null;
};

const markdownSoftWrapExtension = EditorView.theme({
  '&.cm-editor': {
    maxWidth: '100%',
    backgroundColor: '#1e1e1e',
    color: '#d4d4d4',
  },
  '.cm-scroller': {
    overflowX: 'auto',
  },
  '.cm-gutters': {
    backgroundColor: '#1e1e1e',
    color: '#858585',
    borderRight: '1px solid #2d2d2d',
  },
  '.cm-activeLineGutter': {
    backgroundColor: '#2a2d2e',
    color: '#c6c6c6',
  },
  '.cm-content': {
    maxWidth: '100%',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    wordBreak: 'break-word',
    caretColor: '#aeafad',
    lineHeight: '1.55',
    paddingTop: '10px',
    paddingBottom: '16px',
  },
  '.cm-line': {
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    wordBreak: 'break-word',
    color: '#d4d4d4',
    padding: '0 14px',
  },
  '.cm-activeLine': {
    backgroundColor: '#2a2d2e',
  },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: '#264f78',
  },
  '.cm-cursor': {
    borderLeftColor: '#aeafad',
  },
});

const markdownHighlightStyle = HighlightStyle.define([
  { tag: t.heading1, color: '#569cd6', fontWeight: '800' },
  { tag: t.heading2, color: '#4fc1ff', fontWeight: '760' },
  { tag: t.heading3, color: '#9cdcfe', fontWeight: '720' },
  { tag: t.heading, color: '#9cdcfe', fontWeight: '700' },
  { tag: t.strong, color: '#dcdcaa', fontWeight: '750' },
  { tag: t.emphasis, color: '#ce9178', fontStyle: 'italic' },
  { tag: [t.link, t.url], color: '#3794ff', textDecoration: 'underline' },
  { tag: t.monospace, color: '#ce9178', backgroundColor: 'rgba(206, 145, 120, 0.12)' },
  { tag: t.quote, color: '#6a9955', fontStyle: 'italic' },
  { tag: t.list, color: '#d7ba7d' },
  { tag: [t.processingInstruction, t.meta, t.punctuation], color: '#808080' },
  { tag: [t.atom, t.bool, t.number], color: '#b5cea8' },
  { tag: [t.string, t.character], color: '#ce9178' },
  { tag: t.comment, color: '#6a9955' },
  { tag: t.invalid, color: '#f44747' },
]);

const vscodeDarkThemeExtension = EditorView.theme({
  '&': {
    height: '100%',
  },
  '&.cm-editor': {
    height: '100%',
    backgroundColor: '#1e1e1e',
    color: '#d4d4d4',
    fontFamily: '"Cascadia Code", "Fira Code", Consolas, "Courier New", monospace',
  },
  '.cm-scroller': {
    backgroundColor: '#1e1e1e',
    color: '#d4d4d4',
    lineHeight: '1.55',
  },
  '.cm-content': {
    caretColor: '#aeafad',
    paddingTop: '10px',
    paddingBottom: '16px',
  },
  '.cm-line': {
    padding: '0 14px',
  },
  '.cm-gutters': {
    backgroundColor: '#1e1e1e',
    color: '#858585',
    borderRight: '1px solid #2d2d2d',
  },
  '.cm-activeLine': {
    backgroundColor: '#2a2d2e',
  },
  '.cm-activeLineGutter': {
    backgroundColor: '#2a2d2e',
    color: '#c6c6c6',
  },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: '#264f78',
  },
  '.cm-cursor': {
    borderLeftColor: '#aeafad',
  },
  '.cm-matchingBracket, .cm-nonmatchingBracket': {
    backgroundColor: '#3b514d',
    outline: '1px solid #888',
  },
  '.cm-foldGutter .cm-gutterElement': {
    color: '#858585',
  },
});

const vscodeHighlightStyle = HighlightStyle.define([
  { tag: t.keyword, color: '#569cd6' },
  { tag: [t.name, t.deleted, t.character, t.macroName], color: '#d4d4d4' },
  { tag: [t.propertyName, t.variableName], color: '#9cdcfe' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.labelName], color: '#dcdcaa' },
  { tag: [t.color, t.constant(t.name), t.standard(t.name)], color: '#4fc1ff' },
  { tag: [t.definition(t.name), t.separator], color: '#d4d4d4' },
  { tag: [t.className, t.typeName], color: '#4ec9b0' },
  { tag: [t.number, t.bool, t.null, t.atom], color: '#b5cea8' },
  { tag: [t.string, t.special(t.string)], color: '#ce9178' },
  { tag: [t.regexp, t.escape], color: '#d16969' },
  { tag: [t.comment, t.quote], color: '#6a9955' },
  { tag: t.meta, color: '#9cdcfe' },
  { tag: logHighlightTags.levelError, color: '#ff5f87', fontWeight: '600' },
  { tag: logHighlightTags.levelWarning, color: '#ffd166', fontWeight: '600' },
  { tag: logHighlightTags.levelInfo, color: '#00d4ff', fontWeight: '600' },
  { tag: logHighlightTags.levelDebug, color: '#8b949e', fontWeight: '600' },
  { tag: logHighlightTags.timestamp, color: '#6cb6ff' },
  { tag: logHighlightTags.ipAddress, color: '#7ee787' },
  { tag: logHighlightTags.path, color: '#a78bfa' },
  { tag: logHighlightTags.statusSuccess, color: '#3ee6a3' },
  { tag: logHighlightTags.statusRedirect, color: '#00d4ff' },
  { tag: logHighlightTags.statusClientError, color: '#ffd166' },
  { tag: logHighlightTags.statusServerError, color: '#ff5f87' },
  { tag: t.strong, fontWeight: 'bold' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.link, color: '#3794ff', textDecoration: 'underline' },
  { tag: t.heading, color: '#569cd6', fontWeight: 'bold' },
  { tag: t.invalid, color: '#f44747' },
]);

const logCoolHighlightStyle = HighlightStyle.define([
  { tag: logHighlightTags.levelError, color: '#ff5f87', fontWeight: '600' },
  { tag: logHighlightTags.levelWarning, color: '#ffd166', fontWeight: '600' },
  { tag: logHighlightTags.levelInfo, color: '#00d4ff', fontWeight: '600' },
  { tag: logHighlightTags.levelDebug, color: '#8b949e', fontWeight: '600' },
  { tag: logHighlightTags.timestamp, color: '#6cb6ff' },
  { tag: logHighlightTags.ipAddress, color: '#7ee787' },
  { tag: logHighlightTags.path, color: '#a78bfa' },
  { tag: logHighlightTags.statusSuccess, color: '#3ee6a3' },
  { tag: logHighlightTags.statusRedirect, color: '#00d4ff' },
  { tag: logHighlightTags.statusClientError, color: '#ffd166' },
  { tag: logHighlightTags.statusServerError, color: '#ff5f87' },
  { tag: [t.string, t.special(t.string), t.character], color: '#a78bfa' },
  { tag: [t.number, t.bool, t.null, t.atom], color: '#7dd3fc' },
  { tag: [t.regexp, t.escape], color: '#c084fc' },
]);

const TEXT_DOCUMENT_EXTENSIONS = new Set([
  'txt',
  'text',
  'log',
  'md',
  'markdown',
  'rst',
  'adoc',
  'csv',
  'tsv',
  'ini',
  'conf',
  'config',
  'properties',
  'env',
  'gitignore',
  'dockerignore',
]);

const isTextDocument = (filename: string) => {
  const lowerName = filename.toLowerCase();
  if (lowerName === '.env' || lowerName.startsWith('.env.')) return true;
  const extension = lowerName.split('.').pop() || '';
  return TEXT_DOCUMENT_EXTENSIONS.has(extension);
};

const isLogDocument = (filename: string) => filename.toLowerCase().endsWith('.log');
const isMarkdownFilename = (filename: string) => {
  const extension = filename.split('.').pop()?.toLowerCase();
  return extension === 'md' || extension === 'markdown';
};

const looksLikeLogDocument = (content: string) => {
  const lines = content.split('\n').slice(0, 80);
  const logLineCount = lines.filter((line) => (
    /^\s*(?:\[[^\]]+\]\s*)?\[(?:INFO|WARN|WARNING|ERROR|DEBUG|TRACE|FATAL|CRITICAL|NOTICE|SUCCESS|OK)\]/i.test(line)
    || /^\s*\[?\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}/.test(line)
  )).length;

  return logLineCount >= 3;
};

export default function CodeEditor({
  file,
  onClose,
  projectPath,
  isSidebar = false,
  isExpanded = false,
  onToggleExpand = null,
  onPopOut = null,
}: CodeEditorProps) {
  const { t, i18n } = useTranslation('codeEditor');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showDiff, setShowDiff] = useState(Boolean(file.diffInfo));
  const [markdownPreview, setMarkdownPreview] = useState(() => isMarkdownFilename(file.name));
  const [pdfExportError, setPdfExportError] = useState<string | null>(null);
  const markdownPreviewRef = useRef<HTMLDivElement>(null);

  const {
    isDarkMode,
    wordWrap,
    minimapEnabled,
    showLineNumbers,
    fontSize,
  } = useCodeEditorSettings();

  const {
    content,
    setContent,
    loading,
    saving,
    saveSuccess,
    saveError,
    isBinary,
    handleSave,
    handleDownload,
  } = useCodeEditorDocument({
    file,
    projectPath,
  });

  const isMarkdownFile = useMemo(() => isMarkdownFilename(file.name), [file.name]);

  useEffect(() => {
    setMarkdownPreview(isMarkdownFilename(file.name));
    setPdfExportError(null);
  }, [file.name, file.path]);

  const handleExportMarkdownPdf = () => {
    if (!markdownPreviewRef.current) return;

    setPdfExportError(null);
    const opened = exportMarkdownPdf({
      root: markdownPreviewRef.current,
      fileName: file.name,
      language: i18n.resolvedLanguage || i18n.language,
    });
    if (!opened) {
      setPdfExportError(t('errors.pdfPopupBlocked'));
    }
  };

  const isPlainTextDocument = useMemo(() => isTextDocument(file.name), [file.name]);
  const isLogFile = useMemo(
    () => isLogDocument(file.name) || looksLikeLogDocument(content),
    [content, file.name],
  );

  const looksLikeMarkdown = useMemo(() => {
    if (isMarkdownFile) return true;
    return /(^|\n)\s{0,3}#{1,6}\s+\S/.test(content)
      || /(^|\n)\s{0,3}[-*+]\s+\S/.test(content)
      || /(^|\n)\s{0,3}```/.test(content)
      || /(^|\n)\s{0,3}>\s+\S/.test(content);
  }, [content, isMarkdownFile]);

  const softWrapEnabled = wordWrap || looksLikeMarkdown || isPlainTextDocument;

  const minimapExtension = useMemo(
    () => (
      createMinimapExtension({
        file,
        showDiff,
        minimapEnabled,
        isDarkMode,
      })
    ),
    [file, isDarkMode, minimapEnabled, showDiff],
  );

  const scrollToFirstChunkExtension = useMemo(
    () => createScrollToFirstChunkExtension({ file, showDiff }),
    [file, showDiff],
  );

  // 对「所有 log 类文件」启用「吸底跟随 + 滚动位置记忆」：
  //   既包含 .log 后缀，也包含按内容识别（looksLikeLogDocument）的日志。
  // 用 isLogFile（布尔）+ file.path 做 key：.log 文件首帧即为 true，按内容识别的日志在
  //   内容加载后从 false 翻成 true「仅一次」→ 扩展构建一次、执行一次 restore（吸底/恢复位置）；
  //   之后 isLogFile 维持 true，依赖不变，扩展不再重建，避免轮询刷新时丢失吸底状态。
  const logScrollMemoryExtension = useMemo(
    () => (isLogFile ? createLogScrollMemoryExtension(file.path) : []),
    [isLogFile, file.path],
  );

  const toolbarPanelExtension = useMemo(
    () => (
      createEditorToolbarPanelExtension({
        file,
        showDiff,
        isSidebar,
        isExpanded,
        onToggleDiff: () => setShowDiff((previous) => !previous),
        onPopOut,
        onToggleExpand: null,
        labels: {
          changes: t('toolbar.changes'),
          previousChange: t('toolbar.previousChange'),
          nextChange: t('toolbar.nextChange'),
          hideDiff: t('toolbar.hideDiff'),
          showDiff: t('toolbar.showDiff'),
          collapse: t('toolbar.collapse'),
          expand: t('toolbar.expand'),
        },
      })
    ),
    [file, isExpanded, isSidebar, onPopOut, showDiff, t],
  );

  const extensions = useMemo(() => {
    const allExtensions: Extension[] = [
      vscodeDarkThemeExtension,
      ...getLanguageExtensions(file.name),
      syntaxHighlighting(vscodeHighlightStyle),
      ...toolbarPanelExtension,
    ];

    if (isLogFile && !isLogDocument(file.name)) {
      allExtensions.push(logLanguage);
    }

    if (file.diffInfo && showDiff && file.diffInfo.old_string !== undefined) {
      allExtensions.push(
        unifiedMergeView({
          original: file.diffInfo.old_string,
          mergeControls: false,
          highlightChanges: true,
          syntaxHighlightDeletions: false,
          gutter: true,
        }),
      );
      allExtensions.push(...minimapExtension);
      allExtensions.push(...scrollToFirstChunkExtension);
    }

    if (softWrapEnabled) {
      allExtensions.push(EditorView.lineWrapping);
    }

    if (softWrapEnabled) {
      allExtensions.push(markdownSoftWrapExtension);
    }

    if (looksLikeMarkdown) {
      allExtensions.push(syntaxHighlighting(markdownHighlightStyle));
    }

    if (isLogFile) {
      allExtensions.push(Prec.highest(syntaxHighlighting(logCoolHighlightStyle)));
    }

    // 日志吸底跟随 + 滚动位置记忆（非 diff 视图时启用）
    if (!showDiff) {
      allExtensions.push(logScrollMemoryExtension);
    }

    return allExtensions;
  }, [
    file.diffInfo,
    file.name,
    isLogFile,
    looksLikeMarkdown,
    softWrapEnabled,
    minimapExtension,
    scrollToFirstChunkExtension,
    showDiff,
    toolbarPanelExtension,
    wordWrap,
    logScrollMemoryExtension,
  ]);

  useEditorKeyboardShortcuts({
    onSave: handleSave,
    onClose,
    dependency: content,
  });

  if (loading) {
    return (
      <CodeEditorLoadingState
        isDarkMode={isDarkMode}
        isSidebar={isSidebar}
        loadingText={t('loading', { fileName: file.name })}
      />
    );
  }

  // Binary file display
  if (isBinary) {
    return (
      <CodeEditorBinaryFile
        file={file}
        isSidebar={isSidebar}
        isFullscreen={isFullscreen}
        onClose={onClose}
        onToggleFullscreen={() => setIsFullscreen((previous) => !previous)}
        title={t('binaryFile.title', 'Binary File')}
        message={t('binaryFile.message', 'The file "{{fileName}}" cannot be displayed in the text editor because it is a binary file.', { fileName: file.name })}
      />
    );
  }

  const outerContainerClassName = isSidebar
    ? 'w-full h-full flex flex-col'
    : `fixed inset-0 z-[9999] md:bg-black/50 md:flex md:items-center md:justify-center md:p-4 ${isFullscreen ? 'md:p-0' : ''}`;

  const innerContainerClassName = isSidebar
    ? 'code-editor-vscode-shell flex flex-col w-full h-full'
    : `code-editor-vscode-shell shadow-2xl flex flex-col w-full h-full md:rounded-lg md:shadow-2xl${
      isFullscreen ? ' md:w-full md:h-full md:rounded-none' : ' md:w-full md:max-w-6xl md:h-[80vh] md:max-h-[80vh]'
    }`;

  return (
    <>
      <style>{getEditorStyles(isDarkMode)}</style>
      <div className={outerContainerClassName}>
        <div className={innerContainerClassName}>
          <CodeEditorHeader
            file={file}
            isSidebar={isSidebar}
            isFullscreen={isFullscreen}
            isMarkdownFile={isMarkdownFile}
            markdownPreview={markdownPreview}
            isExpanded={isExpanded}
            saving={saving}
            saveSuccess={saveSuccess}
            onToggleMarkdownPreview={() => setMarkdownPreview((previous) => !previous)}
            onOpenSettings={() => window.openSettings?.('appearance')}
            onDownload={handleDownload}
            onExportMarkdownPdf={handleExportMarkdownPdf}
            onToggleExpand={onToggleExpand}
            onSave={handleSave}
            onToggleFullscreen={() => setIsFullscreen((previous) => !previous)}
            onClose={onClose}
            labels={{
              showingChanges: t('header.showingChanges'),
              editMarkdown: t('actions.editMarkdown'),
              previewMarkdown: t('actions.previewMarkdown'),
              settings: t('toolbar.settings'),
              download: t('actions.download'),
              exportPdf: t('actions.exportPdf'),
              hideFileTree: t('actions.hideFileTree'),
              showFileTree: t('actions.showFileTree'),
              save: t('actions.save'),
              saving: t('actions.saving'),
              saved: t('actions.saved'),
              fullscreen: t('actions.fullscreen'),
              exitFullscreen: t('actions.exitFullscreen'),
              close: t('actions.close'),
            }}
          />

          {(saveError || pdfExportError) && (
            <div className="px-3 py-1.5 text-xs text-red-700 bg-red-50 border-b border-red-200 dark:bg-red-900/20 dark:text-red-300 dark:border-red-900/40">
              {saveError || pdfExportError}
            </div>
          )}

          <div className="flex-1 overflow-hidden">
            <CodeEditorSurface
              content={content}
              filePath={file.path}
              projectName={file.projectName}
              onChange={setContent}
              markdownPreview={markdownPreview}
              isMarkdownFile={isMarkdownFile}
              isDarkMode={isDarkMode}
              fontSize={fontSize}
              showLineNumbers={showLineNumbers}
              extensions={extensions}
              softWrap={softWrapEnabled}
              markdownPreviewRef={markdownPreviewRef}
            />
          </div>

          <CodeEditorFooter
            content={content}
            linesLabel={t('footer.lines')}
            charactersLabel={t('footer.characters')}
            shortcutsLabel={t('footer.shortcuts')}
          />
        </div>
      </div>
    </>
  );
}
