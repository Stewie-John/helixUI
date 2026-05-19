import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../../utils/api';
import type { Project } from '../../../types/app';
import type { FileTreeNode } from '../types/types';

// 浏览项目根目录外的任意路径（使用 /api/browse 接口）
export async function browseDirectory(dirPath: string): Promise<FileTreeNode[]> {
  const token = localStorage.getItem('auth-token') || sessionStorage.getItem('auth-token') || '';
  const res = await fetch(`/api/browse?path=${encodeURIComponent(dirPath)}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`Browse failed: ${res.status}`);
  return res.json() as Promise<FileTreeNode[]>;
}

// 递归更新文件树中指定路径节点的 children
function updateNodeChildren(nodes: FileTreeNode[], targetPath: string, children: FileTreeNode[]): FileTreeNode[] {
  return nodes.map(node => {
    if (node.path === targetPath) {
      return { ...node, children, _loaded: true };
    }
    if (node.children && node.children.length > 0) {
      return { ...node, children: updateNodeChildren(node.children, targetPath, children) };
    }
    return node;
  });
}

type UseFileTreeDataResult = {
  files: FileTreeNode[];
  loading: boolean;
  refreshFiles: () => void;
  loadDirectoryChildren: (item: FileTreeNode) => Promise<void>;
  loadingDirs: Set<string>;
};

export function useFileTreeData(selectedProject: Project | null): UseFileTreeDataResult {
  const [files, setFiles] = useState<FileTreeNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set());
  const abortControllerRef = useRef<AbortController | null>(null);

  const refreshFiles = useCallback(() => {
    setRefreshKey((prev) => prev + 1);
  }, []);

  // 懒加载：按需请求子目录内容
  const loadDirectoryChildren = useCallback(async (item: FileTreeNode) => {
    if (!selectedProject?.name) return;
    // 已加载过或正在加载中则跳过
    if ((item as any)._loaded || loadingDirs.has(item.path)) return;

    setLoadingDirs(prev => new Set(prev).add(item.path));
    try {
      const response = await (api as any).getFilesAtPath(selectedProject.name, item.path);
      if (!response.ok) return;
      const children = await response.json() as FileTreeNode[];
      setFiles(prev => updateNodeChildren(prev, item.path, children));
    } catch (e) {
      // 静默失败，不影响已展示内容
    } finally {
      setLoadingDirs(prev => { const s = new Set(prev); s.delete(item.path); return s; });
    }
  }, [selectedProject?.name, loadingDirs]);

  useEffect(() => {
    const projectName = selectedProject?.name;

    if (!projectName) {
      setFiles([]);
      setLoading(false);
      return;
    }

    // Abort previous request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();

    // Track mount state so aborted or late responses do not enqueue stale state updates.
    let isActive = true;

    const fetchFiles = async () => {
      if (isActive) {
        setLoading(true);
      }
      try {
        const response = await api.getFiles(projectName, { signal: abortControllerRef.current!.signal });

        if (!response.ok) {
          const errorText = await response.text();
          console.error('File fetch failed:', response.status, errorText);
          if (isActive) {
            setFiles([]);
          }
          return;
        }

        const data = (await response.json()) as FileTreeNode[];
        if (isActive) {
          setFiles(data);
        }
      } catch (error) {
        if ((error as { name?: string }).name === 'AbortError') {
          return;
        }

        console.error('Error fetching files:', error);
        if (isActive) {
          setFiles([]);
        }
      } finally {
        if (isActive) {
          setLoading(false);
        }
      }
    };

    void fetchFiles();

    return () => {
      isActive = false;
      abortControllerRef.current?.abort();
    };
  }, [selectedProject?.name, refreshKey]);

  return {
    files,
    loading,
    refreshFiles,
    loadDirectoryChildren,
    loadingDirs,
  };
}
