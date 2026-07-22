import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../../utils/api';
import type { CodeEditorFile } from '../types/types';
import { isBinaryFile } from '../utils/binaryFile';

type UseCodeEditorDocumentParams = {
  file: CodeEditorFile;
  projectPath?: string;
};

const getErrorMessage = (error: unknown) => {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
};

const AUTO_REFRESH_INTERVAL_MS = 1500;

const shouldAutoRefreshFile = (fileName: string) => fileName.toLowerCase().endsWith('.log');

export const useCodeEditorDocument = ({ file, projectPath }: UseCodeEditorDocumentParams) => {
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isBinary, setIsBinary] = useState(false);
  const fileProjectName = file.projectName ?? projectPath;
  const filePath = file.path;
  const fileName = file.name;
  const fileDiffNewString = file.diffInfo?.new_string;
  const fileDiffOldString = file.diffInfo?.old_string;
  const contentRef = useRef(content);
  const lastLoadedContentRef = useRef('');

  useEffect(() => {
    contentRef.current = content;
  }, [content]);

  useEffect(() => {
    const loadFileContent = async () => {
      try {
        setLoading(true);
        setIsBinary(false);

        // Check if file is binary by extension
        if (isBinaryFile(file.name)) {
          setIsBinary(true);
          setLoading(false);
          return;
        }

        // Diff payload may already include full old/new snapshots, so avoid disk read.
        if (file.diffInfo && fileDiffNewString !== undefined && fileDiffOldString !== undefined) {
          setContent(fileDiffNewString);
          setLoading(false);
          return;
        }

        if (!fileProjectName) {
          throw new Error('Missing project identifier');
        }

        const response = await api.readFile(fileProjectName, filePath);
        if (!response.ok) {
          throw new Error(`Failed to load file: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        const nextContent = data.content;
        lastLoadedContentRef.current = nextContent;
        setContent(nextContent);
      } catch (error) {
        const message = getErrorMessage(error);
        console.error('Error loading file:', error);
        setContent(`// Error loading file: ${message}\n// File: ${fileName}\n// Path: ${filePath}`);
      } finally {
        setLoading(false);
      }
    };

    loadFileContent();
  }, [file.diffInfo, file.name, fileDiffNewString, fileDiffOldString, fileName, filePath, fileProjectName]);

  useEffect(() => {
    if (
      file.diffInfo ||
      !shouldAutoRefreshFile(fileName) ||
      isBinaryFile(fileName) ||
      !fileProjectName
    ) {
      return;
    }

    let isMounted = true;
    let requestInFlight = false;

    const refreshIfChanged = async () => {
      if (requestInFlight || document.visibilityState === 'hidden') {
        return;
      }

      requestInFlight = true;
      try {
        const response = await api.readFile(fileProjectName, filePath);
        if (!response.ok) {
          return;
        }

        const data = await response.json();
        const nextContent = data.content;
        if (!isMounted || typeof nextContent !== 'string') {
          return;
        }

        if (nextContent === lastLoadedContentRef.current) {
          return;
        }

        // Avoid overwriting unsaved local edits. Once the editor matches disk again,
        // automatic refresh resumes normally.
        if (contentRef.current !== lastLoadedContentRef.current) {
          return;
        }

        lastLoadedContentRef.current = nextContent;
        setContent(nextContent);
      } catch {
        // Polling should be silent; the initial load path already reports visible errors.
      } finally {
        requestInFlight = false;
      }
    };

    const intervalId = window.setInterval(refreshIfChanged, AUTO_REFRESH_INTERVAL_MS);
    return () => {
      isMounted = false;
      window.clearInterval(intervalId);
    };
  }, [file.diffInfo, fileName, filePath, fileProjectName]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveError(null);

    try {
      if (!fileProjectName) {
        throw new Error('Missing project identifier');
      }

      const response = await api.saveFile(fileProjectName, filePath, content);

      if (!response.ok) {
        const contentType = response.headers.get('content-type');
        if (contentType?.includes('application/json')) {
          const errorData = await response.json();
          throw new Error(errorData.error || `Save failed: ${response.status}`);
        }

        const textError = await response.text();
        console.error('Non-JSON error response:', textError);
        throw new Error(`Save failed: ${response.status} ${response.statusText}`);
      }

      await response.json();
      lastLoadedContentRef.current = content;

      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2000);
    } catch (error) {
      const message = getErrorMessage(error);
      console.error('Error saving file:', error);
      setSaveError(message);
    } finally {
      setSaving(false);
    }
  }, [content, filePath, fileProjectName]);

  const handleDownload = useCallback(() => {
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');

    anchor.href = url;
    anchor.download = file.name;

    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);

    URL.revokeObjectURL(url);
  }, [content, file.name]);

  return {
    content,
    setContent,
    loading,
    saving,
    saveSuccess,
    saveError,
    isBinary,
    handleSave,
    handleDownload,
  };
};
