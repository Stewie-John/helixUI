import { useEffect, useState } from 'react';
import { collectExpandedDirectoryPaths, filterFileTree } from '../utils/fileTreeUtils';
import type { FileTreeNode } from '../types/types';
import type { Project } from '../../../types/app';
import { api } from '../../../utils/api';

type UseFileTreeSearchArgs = {
  files: FileTreeNode[];
  expandDirectories: (paths: string[]) => void;
  selectedProject: Project | null;
};

type UseFileTreeSearchResult = {
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  filteredFiles: FileTreeNode[];
};

export function useFileTreeSearch({
  files,
  expandDirectories,
  selectedProject,
}: UseFileTreeSearchArgs): UseFileTreeSearchResult {
  const [searchQuery, setSearchQuery] = useState('');
  const [filteredFiles, setFilteredFiles] = useState<FileTreeNode[]>(files);

  useEffect(() => {
    const query = searchQuery.trim();

    if (!query) {
      setFilteredFiles(files);
      return;
    }

    const controller = new AbortController();
    const immediate = filterFileTree(files, query);
    setFilteredFiles(immediate);
    expandDirectories(collectExpandedDirectoryPaths(immediate));

    const timer = window.setTimeout(async () => {
      if (!selectedProject) return;
      try {
        const response = await (api as any).searchFiles(selectedProject.name, query, {
          signal: controller.signal,
        });
        if (!response.ok) return;
        const results = await response.json() as FileTreeNode[];
        setFilteredFiles(results);
        expandDirectories(collectExpandedDirectoryPaths(results));
      } catch (error) {
        if ((error as Error).name !== 'AbortError') console.error('File search failed:', error);
      }
    }, 180);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [files, searchQuery, expandDirectories, selectedProject]);

  return {
    searchQuery,
    setSearchQuery,
    filteredFiles,
  };
}
