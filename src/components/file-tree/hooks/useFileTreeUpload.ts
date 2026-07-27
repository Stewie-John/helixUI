import { useCallback, useState, useRef } from 'react';
import { Upload } from 'tus-js-client';
import type { Project } from '../../../types/app';
import type { ConflictPolicy, ConflictResolution } from '../view/FileConflictDialog';
import { api } from '../../../utils/api';
import { IS_PLATFORM } from '../../../constants/config';

type UseFileTreeUploadOptions = {
  selectedProject: Project | null;
  rootTargetPath?: string;
  onRefresh: (targetPath?: string) => void;
  showToast: (message: string, type: 'success' | 'error') => void;
};

const RESUMABLE_UPLOAD_THRESHOLD = 50 * 1024 * 1024;
const RESUMABLE_UPLOAD_CHUNK_SIZE = 16 * 1024 * 1024;

const getCurrentAccountKey = () => {
  const token = localStorage.getItem('auth-token');
  if (!token) return 'platform';
  try {
    const encoded = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(encoded));
    return String(payload.userId || payload.username || 'account');
  } catch {
    return 'account';
  }
};

const uploadResumableFile = async ({
  file,
  projectName,
  targetPath,
  relativePath,
  conflictPolicy,
}: {
  file: File;
  projectName: string;
  targetPath: string;
  relativePath: string;
  conflictPolicy: ConflictPolicy;
}) => new Promise<void>((resolve, reject) => {
  const token = localStorage.getItem('auth-token');
  const upload = new Upload(file, {
    endpoint: '/api/files/resumable',
    chunkSize: RESUMABLE_UPLOAD_CHUNK_SIZE,
    retryDelays: [0, 1000, 3000, 5000, 10000, 30000],
    storeFingerprintForResuming: true,
    removeFingerprintOnSuccess: true,
    headers: !IS_PLATFORM && token ? { Authorization: `Bearer ${token}` } : {},
    metadata: {
      filename: file.name.split('/').pop() || file.name,
      projectName,
      targetPath,
      relativePath,
      conflictPolicy,
    },
    fingerprint: async (candidate) => [
      'helix-tus-v1',
      getCurrentAccountKey(),
      projectName,
      targetPath,
      relativePath,
      candidate.size,
      candidate.lastModified,
    ].join(':'),
    onError: reject,
    onSuccess: () => resolve(),
  });

  upload.findPreviousUploads()
    .then((previousUploads) => {
      const resumable = previousUploads
        .filter((candidate) => candidate.uploadUrl)
        .sort((a, b) => Date.parse(b.creationTime) - Date.parse(a.creationTime))[0];
      if (resumable) {
        upload.resumeFromPreviousUpload(resumable);
      }
      upload.start();
    })
    .catch(reject);
});

// Helper function to read all files from a directory entry recursively
const readAllDirectoryEntries = async (directoryEntry: FileSystemDirectoryEntry, basePath = ''): Promise<File[]> => {
  const files: File[] = [];

  const reader = directoryEntry.createReader();
  let entries: FileSystemEntry[] = [];

  // Read all entries from the directory (may need multiple reads)
  let batch: FileSystemEntry[];
  do {
    batch = await new Promise<FileSystemEntry[]>((resolve, reject) => {
      reader.readEntries(resolve, reject);
    });
    entries = entries.concat(batch);
  } while (batch.length > 0);

  // Files to ignore (system files)
  const ignoredFiles = ['.DS_Store', 'Thumbs.db', 'desktop.ini'];

  for (const entry of entries) {
    const entryPath = basePath ? `${basePath}/${entry.name}` : entry.name;

    if (entry.isFile) {
      const fileEntry = entry as FileSystemFileEntry;
      const file = await new Promise<File>((resolve, reject) => {
        fileEntry.file(resolve, reject);
      });

      // Skip ignored files
      if (ignoredFiles.includes(file.name)) {
        continue;
      }

      // Create a new file with the relative path as the name
      const fileWithPath = new File([file], entryPath, {
        type: file.type,
        lastModified: file.lastModified,
      });
      files.push(fileWithPath);
    } else if (entry.isDirectory) {
      const dirEntry = entry as FileSystemDirectoryEntry;
      const subFiles = await readAllDirectoryEntries(dirEntry, entryPath);
      files.push(...subFiles);
    }
  }

  return files;
};

export const useFileTreeUpload = ({
  selectedProject,
  rootTargetPath = '',
  onRefresh,
  showToast,
}: UseFileTreeUploadOptions) => {
  const [isDragOver, setIsDragOver] = useState(false);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [operationLoading, setOperationLoading] = useState(false);
  // 重名冲突对话框状态：非 null 时渲染 Mac 风格弹窗，等待用户选择处理策略
  const [conflictPrompt, setConflictPrompt] = useState<{ conflicts: string[] } | null>(null);
  const conflictResolverRef = useRef<((resolution: ConflictResolution) => void) | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);

  // 由对话框按钮回调：把用户选择回传给正在 await 的上传流程
  const resolveConflict = useCallback((resolution: ConflictResolution) => {
    setConflictPrompt(null);
    const resolver = conflictResolverRef.current;
    conflictResolverRef.current = null;
    resolver?.(resolution);
  }, []);

  // 上传核心：预检重名 → 必要时弹窗取策略 → 带 conflictPolicy 上传。
  // files 的 name 可能含相对路径（文件夹上传时如 "dir/sub/a.txt"）。
  const processUpload = useCallback(
    async (files: File[], targetPath: string) => {
      if (files.length === 0) return;
      setOperationLoading(true);
      try {
        // 相对路径列表（FormData 会丢掉 File.name 里的路径，单独传）
        const relativePaths = files.map((f) => f.name);

        // 1) 预检：询问后端哪些文件已存在
        let conflictPolicy: ConflictPolicy = 'replace';
        try {
          const checkRes = await api.post(
            `/projects/${encodeURIComponent(selectedProject!.name)}/files/check-conflicts`,
            { targetPath, relativePaths },
          );
          if (checkRes.ok) {
            const { conflicts } = await checkRes.json();
            if (Array.isArray(conflicts) && conflicts.length > 0) {
              // 2) 有重名 → 弹 Mac 风格对话框，等待用户选择
              const resolution = await new Promise<ConflictResolution>((resolve) => {
                conflictResolverRef.current = resolve;
                setConflictPrompt({ conflicts });
              });
              if (resolution === 'cancel') {
                setOperationLoading(false);
                return;
              }
              conflictPolicy = resolution;
            }
          }
        } catch (checkErr) {
          // 预检失败不阻断上传，退回默认覆盖行为
          console.warn('Conflict pre-check failed, falling back to replace:', checkErr);
        }

        // Large files use tus so brief disconnects resume from the server's
        // acknowledged offset. Smaller batches retain the low-overhead multipart path.
        const regularFiles = files.filter((file) => file.size <= RESUMABLE_UPLOAD_THRESHOLD);
        const resumableFiles = files.filter((file) => file.size > RESUMABLE_UPLOAD_THRESHOLD);
        let uploaded = 0;
        let skipped = 0;

        if (regularFiles.length > 0) {
          const regularPaths = regularFiles.map((file) => file.name);
          const formData = new FormData();
          formData.append('targetPath', targetPath);
          regularFiles.forEach((file) => {
            const cleanFile = new File([file], file.name.split('/').pop()!, {
              type: file.type,
              lastModified: file.lastModified,
            });
            formData.append('files', cleanFile);
          });
          formData.append('relativePaths', JSON.stringify(regularPaths));
          formData.append('conflictPolicy', conflictPolicy);

          const response = await api.post(
            `/projects/${encodeURIComponent(selectedProject!.name)}/files/upload`,
            formData,
          );
          if (!response.ok) {
            const data = await response.json();
            throw new Error(data.error || 'Upload failed');
          }
          const result = await response.json().catch(() => null);
          uploaded += result?.files?.length ?? regularFiles.length;
          skipped += result?.skipped?.length ?? 0;
        }

        for (const file of resumableFiles) {
          await uploadResumableFile({
            file,
            projectName: selectedProject!.name,
            targetPath,
            relativePath: file.name,
            conflictPolicy,
          });
          uploaded += 1;
        }

        showToast(
          skipped > 0
            ? `已上传 ${uploaded} 个文件，跳过 ${skipped} 个`
            : `已上传 ${uploaded} 个文件`,
          'success',
        );
        onRefresh(targetPath || undefined);
      } catch (err) {
        console.error('Upload error:', err);
        showToast(err instanceof Error ? err.message : 'Upload failed', 'error');
      } finally {
        setOperationLoading(false);
      }
    },
    [selectedProject, onRefresh, showToast],
  );

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    // 内部文件树拖移（移动文件）不含 Files 类型，不触发上传遮罩
    if (!Array.from(e.dataTransfer.types).includes('Files')) return;
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Only set isDragOver to false if we're leaving the entire tree
    if (treeRef.current && !treeRef.current.contains(e.relatedTarget as Node)) {
      setIsDragOver(false);
      setDropTarget(null);
    }
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent, explicitTargetPath?: string) => {
    if (!Array.from(e.dataTransfer.types).includes('Files')) return;
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);

    // The row under the pointer is authoritative. React state can lag one drag event
    // behind, which previously caused folder drops to fall back to the project root.
    const targetPath = explicitTargetPath ?? dropTarget ?? rootTargetPath ?? '';

    try {
      const files: File[] = [];

      // Use DataTransferItemList for folder support
      const items = e.dataTransfer.items;
      if (items) {
        for (const item of Array.from(items)) {
          if (item.kind === 'file') {
            const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;

            if (entry) {
              if (entry.isFile) {
                const file = await new Promise<File>((resolve, reject) => {
                  (entry as FileSystemFileEntry).file(resolve, reject);
                });
                files.push(file);
              } else if (entry.isDirectory) {
                // Pass the directory name as basePath so files include the folder path
                const dirFiles = await readAllDirectoryEntries(entry as FileSystemDirectoryEntry, entry.name);
                files.push(...dirFiles);
              }
            }
          }
        }
      } else {
        // Fallback for browsers that don't support webkitGetAsEntry
        const fileList = e.dataTransfer.files;
        for (const file of Array.from(fileList)) {
          files.push(file);
        }
      }

      await processUpload(files, targetPath);
    } finally {
      setDropTarget(null);
    }
  }, [dropTarget, rootTargetPath, processUpload]);

  // 粘贴上传：从剪贴板取出文件（如截图、Finder/资源管理器复制的文件）上传到当前目录。
  // 仅当剪贴板确有文件时拦截，避免影响普通文本粘贴。
  const handlePaste = useCallback(async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (const item of Array.from(items)) {
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length === 0) return; // 没有文件 → 放行给默认粘贴行为
    e.preventDefault();
    e.stopPropagation();
    await processUpload(files, rootTargetPath || '');
  }, [rootTargetPath, processUpload]);

  const handleItemDragOver = useCallback((e: React.DragEvent, itemPath: string) => {
    if (!Array.from(e.dataTransfer.types).includes('Files')) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    setIsDragOver(true);
    setDropTarget(itemPath);
  }, []);

  const handleItemDrop = useCallback((e: React.DragEvent, itemPath: string) => {
    void handleDrop(e, itemPath);
  }, [handleDrop]);

  return {
    isDragOver,
    dropTarget,
    operationLoading,
    treeRef,
    handleDragEnter,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    handlePaste,
    handleItemDragOver,
    handleItemDrop,
    setDropTarget,
    conflictPrompt,
    resolveConflict,
  };
};
