import { useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import type { Project } from '../../../types/app';
import type { CodeEditorDiffInfo, CodeEditorFile } from '../types/types';

type UseEditorSidebarOptions = {
  selectedProject: Project | null;
  isMobile: boolean;
  initialWidth?: number;
};

const EDITOR_SIDEBAR_STORAGE_KEY = 'codeEditorSidebarState';

type PersistedEditorSidebarState = {
  projectName?: string;
  projectPath?: string;
  file: CodeEditorFile | null;
  editorWidth: number;
  editorExpanded: boolean;
  hasManualWidth: boolean;
};

const getProjectPath = (project: Project | null) => project?.fullPath || project?.path || '';

const readPersistedEditorState = (): PersistedEditorSidebarState | null => {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const raw = window.sessionStorage.getItem(EDITOR_SIDEBAR_STORAGE_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<PersistedEditorSidebarState>;
    const file = parsed.file as Partial<CodeEditorFile> | null | undefined;
    if (!file?.path || !file.name) {
      return null;
    }

    return {
      projectName: parsed.projectName,
      projectPath: parsed.projectPath,
      file: {
        ...file,
        name: file.name,
        path: file.path,
      },
      editorWidth: typeof parsed.editorWidth === 'number' ? parsed.editorWidth : 540,
      editorExpanded: Boolean(parsed.editorExpanded),
      hasManualWidth: Boolean(parsed.hasManualWidth),
    };
  } catch {
    return null;
  }
};

const writePersistedEditorState = (state: PersistedEditorSidebarState | null) => {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    if (!state?.file) {
      window.sessionStorage.removeItem(EDITOR_SIDEBAR_STORAGE_KEY);
      return;
    }

    window.sessionStorage.setItem(EDITOR_SIDEBAR_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore sessionStorage failures
  }
};

const isPersistedProjectMatch = (
  persisted: PersistedEditorSidebarState,
  selectedProject: Project,
) => {
  const selectedPath = getProjectPath(selectedProject);
  if (persisted.projectName && persisted.projectName === selectedProject.name) {
    return true;
  }
  return Boolean(persisted.projectPath && selectedPath && persisted.projectPath === selectedPath);
};

export const useEditorSidebar = ({
  selectedProject,
  isMobile,
  initialWidth = 540,
}: UseEditorSidebarOptions) => {
  const [editingFile, setEditingFile] = useState<CodeEditorFile | null>(null);
  const [editorWidth, setEditorWidth] = useState(initialWidth);
  const [editorExpanded, setEditorExpanded] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [hasManualWidth, setHasManualWidth] = useState(false);
  const resizeHandleRef = useRef<HTMLDivElement | null>(null);
  const restoredProjectKeyRef = useRef<string | null>(null);

  const handleFileOpen = useCallback(
    (filePath: string, diffInfo: CodeEditorDiffInfo | null = null) => {
      const normalizedPath = filePath.replace(/\\/g, '/');
      const fileName = normalizedPath.split('/').pop() || filePath;

      setEditingFile({
        name: fileName,
        path: filePath,
        projectName: selectedProject?.name,
        diffInfo,
      });
    },
    [selectedProject?.name],
  );

  const handleCloseEditor = useCallback(() => {
    setEditingFile(null);
    setEditorExpanded(false);
    writePersistedEditorState(null);
  }, []);

  const handleToggleEditorExpand = useCallback(() => {
    setEditorExpanded((previous) => !previous);
  }, []);

  const handleResizeStart = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (isMobile) {
        return;
      }

      // After first drag interaction, the editor width is user-controlled.
      setHasManualWidth(true);
      setIsResizing(true);
      event.preventDefault();
    },
    [isMobile],
  );

  useEffect(() => {
    const handleMouseMove = (event: globalThis.MouseEvent) => {
      if (!isResizing) {
        return;
      }

      // Get the main container (parent of EditorSidebar's parent) that contains both left content and editor
      const editorContainer = resizeHandleRef.current?.parentElement;
      const mainContainer = editorContainer?.parentElement;
      if (!mainContainer) {
        return;
      }

      const containerRect = mainContainer.getBoundingClientRect();
      // Calculate new editor width: distance from mouse to right edge of main container
      const newWidth = containerRect.right - event.clientX;

      const minWidth = 300;
      const maxWidth = containerRect.width * 0.8;

      if (newWidth >= minWidth && newWidth <= maxWidth) {
        setEditorWidth(newWidth);
      }
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    if (isResizing) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isResizing]);

  useEffect(() => {
    if (!selectedProject) {
      return;
    }

    const selectedProjectKey = selectedProject.name || getProjectPath(selectedProject);
    if (restoredProjectKeyRef.current === selectedProjectKey) {
      return;
    }

    restoredProjectKeyRef.current = selectedProjectKey;
    const persisted = readPersistedEditorState();
    if (!persisted || !isPersistedProjectMatch(persisted, selectedProject)) {
      return;
    }

    const file = persisted.file;
    if (!file) {
      return;
    }

    setEditingFile({
      ...file,
      projectName: file.projectName || selectedProject.name,
    });
    setEditorWidth(persisted.editorWidth || initialWidth);
    setEditorExpanded(persisted.editorExpanded);
    setHasManualWidth(persisted.hasManualWidth);
  }, [initialWidth, selectedProject]);

  useEffect(() => {
    if (!selectedProject || !editingFile) {
      return;
    }

    writePersistedEditorState({
      projectName: selectedProject.name,
      projectPath: getProjectPath(selectedProject),
      file: {
        ...editingFile,
        projectName: editingFile.projectName || selectedProject.name,
      },
      editorWidth,
      editorExpanded,
      hasManualWidth,
    });
  }, [editingFile, editorExpanded, editorWidth, hasManualWidth, selectedProject]);

  return {
    editingFile,
    editorWidth,
    editorExpanded,
    hasManualWidth,
    resizeHandleRef,
    handleFileOpen,
    handleCloseEditor,
    handleToggleEditorExpand,
    handleResizeStart,
  };
};
