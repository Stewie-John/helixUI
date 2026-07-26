import { useState, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { MouseEvent, MutableRefObject } from 'react';
import type { CodeEditorFile } from '../types/types';
import CodeEditor from './CodeEditor';

type EditorSidebarProps = {
  editingFile: CodeEditorFile | null;
  isMobile: boolean;
  editorExpanded: boolean;
  editorWidth: number;
  hasManualWidth: boolean;
  resizeHandleRef: MutableRefObject<HTMLDivElement | null>;
  onResizeStart: (event: MouseEvent<HTMLDivElement>) => void;
  onCloseEditor: () => void;
  onToggleEditorExpand: () => void;
  projectPath?: string;
  fillSpace?: boolean;
};

// Minimum width for the left content (file tree, chat, etc.)
const MIN_LEFT_CONTENT_WIDTH = 200;
// Minimum width for the editor sidebar
const MIN_EDITOR_WIDTH = 280;

export default function EditorSidebar({
  editingFile,
  isMobile,
  editorExpanded,
  editorWidth,
  hasManualWidth,
  resizeHandleRef,
  onResizeStart,
  onCloseEditor,
  onToggleEditorExpand,
  projectPath,
  fillSpace,
}: EditorSidebarProps) {
  const [poppedOut, setPoppedOut] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const [effectiveWidth, setEffectiveWidth] = useState(editorWidth);
  // In files tab, fill the remaining width unless user has dragged manually.
  const useFlexLayout = editorExpanded || (fillSpace && !hasManualWidth);

  const refreshEditorLayout = useCallback(() => {
    window.dispatchEvent(new Event('resize'));
  }, []);

  const updateWidth = useCallback(() => {
    if (!containerRef.current) return;
    const parentElement = containerRef.current.parentElement;
    if (!parentElement) return;

    const containerWidth = parentElement.clientWidth;
    const maxEditorWidth = containerWidth - MIN_LEFT_CONTENT_WIDTH;

    if (maxEditorWidth < MIN_EDITOR_WIDTH) {
      setPoppedOut(true);
      return;
    }

    const nextWidth = Math.min(editorWidth, maxEditorWidth);
    setEffectiveWidth((previous) => (previous === nextWidth ? previous : nextWidth));
  }, [editorWidth]);

  useEffect(() => {
    setPoppedOut(false);
    setEffectiveWidth(editorWidth);
  }, [editingFile?.path, editorWidth]);

  // Adjust editor width when container size changes to ensure buttons are always visible.
  useLayoutEffect(() => {
    if (!editingFile || isMobile || poppedOut) return;

    const refresh = () => {
      updateWidth();
      refreshEditorLayout();
    };

    refresh();
    const firstFrame = requestAnimationFrame(refresh);
    const secondFrame = requestAnimationFrame(() => requestAnimationFrame(refresh));
    const delayedRefresh = window.setTimeout(refresh, 120);
    window.addEventListener('resize', updateWidth);

    // Also use ResizeObserver for more accurate detection.
    const resizeObserver = new ResizeObserver(updateWidth);
    const parentEl = containerRef.current?.parentElement;
    if (parentEl) {
      resizeObserver.observe(parentEl);
    }
    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }

    return () => {
      window.removeEventListener('resize', updateWidth);
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
      window.clearTimeout(delayedRefresh);
      resizeObserver.disconnect();
    };
  }, [editingFile, isMobile, poppedOut, refreshEditorLayout, updateWidth]);

  if (!editingFile) {
    return null;
  }

  if (isMobile || poppedOut) {
    return (
      <CodeEditor
        file={editingFile}
        onClose={() => {
          setPoppedOut(false);
          onCloseEditor();
        }}
        projectPath={projectPath}
        isSidebar={false}
      />
    );
  }

  return (
    <div ref={containerRef} className={`flex h-full min-w-0 ${useFlexLayout ? 'flex-1' : 'flex-shrink-0'}`}>
      {!editorExpanded && (
        <div
          ref={resizeHandleRef}
          onMouseDown={onResizeStart}
          className="flex-shrink-0 w-1 bg-gray-200 dark:bg-gray-700 hover:bg-blue-500 dark:hover:bg-blue-600 cursor-col-resize transition-colors relative group"
          title="Drag to resize"
        >
          <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-1 bg-blue-500 dark:bg-blue-600 opacity-0 group-hover:opacity-100 transition-opacity" />
        </div>
      )}

      <div
        className={`${editorExpanded ? '' : 'border-l border-gray-200 dark:border-gray-700'} h-full overflow-hidden ${useFlexLayout ? 'flex-1 min-w-0' : `flex-shrink-0 min-w-[${MIN_EDITOR_WIDTH}px]`}`}
        style={useFlexLayout ? undefined : { width: `${effectiveWidth}px`, minWidth: `${MIN_EDITOR_WIDTH}px` }}
      >
        <CodeEditor
          file={editingFile}
          onClose={onCloseEditor}
          projectPath={projectPath}
          isSidebar
          isExpanded={editorExpanded}
          onToggleExpand={onToggleEditorExpand}
          onPopOut={() => setPoppedOut(true)}
        />
      </div>
    </div>
  );
}
