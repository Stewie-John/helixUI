import { useCallback, useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Check, X, Loader2, Folder, Upload, File } from 'lucide-react';
import { cn } from '../../../lib/utils';
import ImageViewer from './ImageViewer';
import FileConflictDialog from './FileConflictDialog';
import { ICON_SIZE_CLASS, getFileIconData } from '../constants/fileIcons';
import { useExpandedDirectories } from '../hooks/useExpandedDirectories';
import { useFileTreeData, browseDirectory } from '../hooks/useFileTreeData';
import { useFileTreeOperations } from '../hooks/useFileTreeOperations';
import { useFileTreeSearch } from '../hooks/useFileTreeSearch';
import { useFileTreeViewMode } from '../hooks/useFileTreeViewMode';
import { useFileTreeUpload } from '../hooks/useFileTreeUpload';
import type { FileTreeImageSelection, FileTreeNode } from '../types/types';
import { formatFileSize, formatRelativeTime, isImageFile } from '../utils/fileTreeUtils';
import FileContextMenu from '../../FileContextMenu';
import FileTreeBody from './FileTreeBody';
import FileTreeBreadcrumb from './FileTreeBreadcrumb';
import FileTreeDetailedColumns from './FileTreeDetailedColumns';
import FileTreeHeader from './FileTreeHeader';
import FileTreeLoadingState from './FileTreeLoadingState';
import { Project } from '../../../types/app';
import { Input } from '../../ui/input';
import { ScrollArea } from '../../ui/scroll-area';

type FileTreeProps = {
  selectedProject: Project | null;
  onFileOpen?: (filePath: string) => void;
};

export default function FileTree({ selectedProject, onFileOpen }: FileTreeProps) {
  const { t } = useTranslation();
  const [selectedImage, setSelectedImage] = useState<FileTreeImageSelection | null>(null);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const newItemInputRef = useRef<HTMLInputElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  const projectRootPath = selectedProject?.fullPath || selectedProject?.path || '';
  const [currentBrowsePath, setCurrentBrowsePath] = useState<string>(projectRootPath);
  const [browseFiles, setBrowseFiles] = useState<FileTreeNode[]>([]);
  const [browseLoading, setBrowseLoading] = useState(false);

  // Browse mode: user navigated above the project root
  const isBrowseMode = Boolean(
    currentBrowsePath &&
    projectRootPath &&
    currentBrowsePath !== projectRootPath,
  );

  // Show toast notification
  const showToast = useCallback((message: string, type: 'success' | 'error') => {
    setToast({ message, type });
  }, []);

  // Auto-hide toast
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  const { files, loading, refreshFiles, loadDirectoryChildren, loadingDirs } = useFileTreeData(selectedProject);
  const { viewMode, changeViewMode } = useFileTreeViewMode();
  const { expandedDirs, toggleDirectory, expandDirectories, collapseAll } = useExpandedDirectories();
  const { searchQuery, setSearchQuery, filteredFiles } = useFileTreeSearch({
    files,
    expandDirectories,
    selectedProject,
  });

  const refreshBrowseFiles = useCallback(async () => {
    if (!currentBrowsePath) return;
    setBrowseLoading(true);
    try {
      setBrowseFiles(await browseDirectory(currentBrowsePath));
    } catch {
      setBrowseFiles([]);
    } finally {
      setBrowseLoading(false);
    }
  }, [currentBrowsePath]);

  const refreshCurrentView = useCallback(() => {
    if (isBrowseMode) {
      void refreshBrowseFiles();
      return;
    }
    refreshFiles();
  }, [isBrowseMode, refreshBrowseFiles, refreshFiles]);

  // File operations
  const operations = useFileTreeOperations({
    selectedProject,
    onRefresh: refreshCurrentView,
    showToast,
  });

  // File upload (drag and drop)
  const upload = useFileTreeUpload({
    selectedProject,
    rootTargetPath: isBrowseMode ? currentBrowsePath : '',
    onRefresh: refreshCurrentView,
    showToast,
  });

  // Reset browse path when project changes
  useEffect(() => {
    setCurrentBrowsePath(selectedProject?.fullPath || selectedProject?.path || '');
    setBrowseFiles([]);
  }, [selectedProject?.fullPath, selectedProject?.path]);

  // Fetch directory listing when in browse mode
  useEffect(() => {
    if (!isBrowseMode || !currentBrowsePath) return;
    void refreshBrowseFiles();
  }, [currentBrowsePath, isBrowseMode, refreshBrowseFiles]);

  // Focus input when creating new item
  useEffect(() => {
    if (operations.isCreating && newItemInputRef.current) {
      newItemInputRef.current.focus();
      newItemInputRef.current.select();
    }
  }, [operations.isCreating]);

  // Focus input when renaming
  useEffect(() => {
    if (operations.renamingItem && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [operations.renamingItem]);

  const handleBreadcrumbNavigate = useCallback((targetPath: string) => {
    if (!projectRootPath) return;
    if (targetPath === projectRootPath || targetPath.startsWith(projectRootPath + '/')) {
      setCurrentBrowsePath(projectRootPath);
    } else {
      setCurrentBrowsePath(targetPath);
    }
  }, [projectRootPath]);

  const renderFileIcon = useCallback((filename: string) => {
    const { icon: Icon, color } = getFileIconData(filename);
    return <Icon className={cn(ICON_SIZE_CLASS, color)} />;
  }, []);

  // Centralized click behavior keeps file actions identical across all presentation modes.
  const handleItemClick = useCallback(
    (item: FileTreeNode) => {
      if (item.type === 'directory') {
        toggleDirectory(item.path);
        // 如果子目录未曾加载（children 为空且未标记已加载），触发懒加载
        if (!(item as any)._loaded && (!item.children || item.children.length === 0)) {
          void loadDirectoryChildren(item);
        }
        return;
      }

      if (isImageFile(item.name) && selectedProject) {
        setSelectedImage({
          name: item.name,
          path: item.path,
          projectPath: selectedProject.path,
          projectName: selectedProject.name,
        });
        return;
      }

      onFileOpen?.(item.path);
    },
    [onFileOpen, selectedProject, toggleDirectory],
  );

  const formatRelativeTimeLabel = useCallback(
    (date?: string) => formatRelativeTime(date, t),
    [t],
  );

  if (loading) {
    return <FileTreeLoadingState />;
  }

  return (
    <div
      ref={upload.treeRef}
      className="h-full flex flex-col bg-background relative"
      tabIndex={0}
      onDragEnter={upload.handleDragEnter}
      onDragOver={upload.handleDragOver}
      onDragLeave={upload.handleDragLeave}
      onDrop={upload.handleDrop}
      onPaste={upload.handlePaste}
    >
      {/* 重名冲突对话框（Mac 风格：覆盖 / 两者都保留 / 跳过） */}
      {upload.conflictPrompt && (
        <FileConflictDialog
          conflicts={upload.conflictPrompt.conflicts}
          onResolve={upload.resolveConflict}
        />
      )}

      {/* VS Code-style passive drop hint; rows remain pointer targets. */}
      {upload.isDragOver && (
        <div className="pointer-events-none absolute right-3 top-12 z-50 max-w-[70%] border border-blue-400 bg-background/95 px-2.5 py-1.5 shadow-md flex items-center gap-2">
          <Upload className="w-4 h-4 text-blue-500 flex-none" />
          <span className="truncate text-xs font-medium">
            {upload.dropTarget
              ? `复制到 ${upload.dropTarget.split('/').filter(Boolean).pop()}`
              : t('fileTree.dropToUpload', 'Drop files to upload')}
          </span>
        </div>
      )}

      <FileTreeHeader
        viewMode={viewMode}
        onViewModeChange={changeViewMode}
        searchQuery={searchQuery}
        onSearchQueryChange={setSearchQuery}
        onNewFile={() => operations.handleStartCreate(isBrowseMode ? currentBrowsePath : '', 'file')}
        onNewFolder={() => operations.handleStartCreate(isBrowseMode ? currentBrowsePath : '', 'directory')}
        onRefresh={refreshCurrentView}
        onCollapseAll={collapseAll}
        loading={loading}
        operationLoading={operations.operationLoading}
      />

      {selectedProject && (
        <FileTreeBreadcrumb
          currentPath={currentBrowsePath || projectRootPath}
          projectPath={projectRootPath}
          onNavigate={handleBreadcrumbNavigate}
        />
      )}

      {viewMode === 'detailed' && !isBrowseMode && filteredFiles.length > 0 && <FileTreeDetailedColumns />}

      <ScrollArea className="flex-1 px-2 py-1">
        {isBrowseMode ? (
          <>
            {operations.isCreating && (
              <div className="flex items-center gap-1.5 py-[3px] pr-2 mb-1 pl-1">
                {operations.newItemType === 'directory' ? (
                  <Folder className={cn(ICON_SIZE_CLASS, 'text-blue-500')} />
                ) : (
                  <span className="ml-[18px]">{renderFileIcon(operations.newItemName)}</span>
                )}
                <Input
                  ref={newItemInputRef}
                  type="text"
                  value={operations.newItemName}
                  onChange={(e) => operations.setNewItemName(e.target.value)}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') operations.handleConfirmCreate();
                    if (e.key === 'Escape') operations.handleCancelCreate();
                  }}
                  onBlur={() => {
                    setTimeout(() => {
                      if (operations.isCreating) operations.handleConfirmCreate();
                    }, 100);
                  }}
                  className="h-6 text-sm flex-1"
                  disabled={operations.operationLoading}
                />
              </div>
            )}
            {browseLoading ? (
              <div className="p-4 text-sm text-muted-foreground flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>{t('fileTree.loading', 'Loading...')}</span>
              </div>
            ) : browseFiles.length === 0 ? (
              <div className="p-4 text-sm text-muted-foreground">{t('fileTree.empty', 'Empty directory')}</div>
            ) : (
              <div className="space-y-0 py-1">
                {browseFiles.map((item) => {
                  const isRenaming = operations.renamingItem?.path === item.path;
                  const row = isRenaming ? (
                    <div
                      onClick={(e) => e.stopPropagation()}
                      className="file-tree-selectable flex items-center gap-2 px-2 py-1 rounded bg-accent/30 text-sm"
                    >
                      {item.type === 'directory' ? (
                        <Folder className={cn(ICON_SIZE_CLASS, 'text-blue-400')} />
                      ) : (
                        renderFileIcon(item.name)
                      )}
                      <Input
                        ref={renameInputRef}
                        type="text"
                        value={operations.renameValue}
                        onChange={(e) => operations.setRenameValue(e.target.value)}
                        onKeyDown={(e) => {
                          e.stopPropagation();
                          if (e.key === 'Enter') operations.handleConfirmRename();
                          if (e.key === 'Escape') operations.handleCancelRename();
                        }}
                        onBlur={() => {
                          setTimeout(() => {
                            if (operations.renamingItem?.path === item.path) {
                              operations.handleConfirmRename();
                            }
                          }, 100);
                        }}
                        className="h-6 text-sm flex-1"
                        disabled={operations.operationLoading}
                      />
                    </div>
                  ) : (
                    <div
                      onClick={() => {
                        if (item.type === 'directory') handleBreadcrumbNavigate(item.path);
                        else onFileOpen?.(item.path);
                      }}
                      onDragOver={(e) => {
                        upload.handleItemDragOver(
                          e,
                          item.type === 'directory' ? item.path : currentBrowsePath,
                        );
                      }}
                      onDrop={(e) => {
                        upload.handleItemDrop(
                          e,
                          item.type === 'directory' ? item.path : currentBrowsePath,
                        );
                      }}
                      className="file-tree-selectable flex items-center gap-2 px-2 py-1 rounded hover:bg-accent cursor-pointer text-sm"
                    >
                      {item.type === 'directory' ? (
                        <Folder className={cn(ICON_SIZE_CLASS, 'text-blue-400')} />
                      ) : (
                        renderFileIcon(item.name)
                      )}
                      <span className={cn(item.type === 'directory' ? 'text-foreground' : 'text-muted-foreground', 'select-text')}>
                        {item.name}
                      </span>
                    </div>
                  );
                  if (isRenaming) {
                    return (
                      <div key={item.path}>
                        {row}
                      </div>
                    );
                  }
                  return (
                    <div key={item.path}>
                      <FileContextMenu
                        item={item}
                        onRename={() => operations.handleStartRename(item)}
                        onDelete={() => operations.handleStartDelete(item)}
                        onCopyPath={() => operations.handleCopyPath(item)}
                        onDownload={() => operations.handleDownload(item)}
                        onNewFile={() => operations.handleStartCreate(item.type === 'directory' ? item.path : currentBrowsePath, 'file')}
                        onNewFolder={() => operations.handleStartCreate(item.type === 'directory' ? item.path : currentBrowsePath, 'directory')}
                        onRefresh={refreshCurrentView}
                      >
                        {row}
                      </FileContextMenu>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        ) : (
          <>
        {/* New item input */}
        {operations.isCreating && (
          <div
            className="flex items-center gap-1.5 py-[3px] pr-2 mb-1"
            style={{ paddingLeft: `${(operations.newItemParent.split('/').length - 1) * 16 + 4}px` }}
          >
            {operations.newItemType === 'directory' ? (
              <Folder className={cn(ICON_SIZE_CLASS, 'text-blue-500')} />
            ) : (
              <span className="ml-[18px]">{renderFileIcon(operations.newItemName)}</span>
            )}
            <Input
              ref={newItemInputRef}
              type="text"
              value={operations.newItemName}
              onChange={(e) => operations.setNewItemName(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') operations.handleConfirmCreate();
                if (e.key === 'Escape') operations.handleCancelCreate();
              }}
              onBlur={() => {
                setTimeout(() => {
                  if (operations.isCreating) operations.handleConfirmCreate();
                }, 100);
              }}
              className="h-6 text-sm flex-1"
              disabled={operations.operationLoading}
            />
          </div>
        )}

        <FileTreeBody
          files={files}
          filteredFiles={filteredFiles}
          searchQuery={searchQuery}
          viewMode={viewMode}
          expandedDirs={expandedDirs}
          loadingDirs={loadingDirs}
          onItemClick={handleItemClick}
          renderFileIcon={renderFileIcon}
          formatFileSize={formatFileSize}
          formatRelativeTime={formatRelativeTimeLabel}
          onRename={operations.handleStartRename}
          onDelete={operations.handleStartDelete}
          onNewFile={(path) => operations.handleStartCreate(path, 'file')}
          onNewFolder={(path) => operations.handleStartCreate(path, 'directory')}
          onMove={operations.handleMove}
          rootPath=""
          externalDropTarget={upload.dropTarget}
          onExternalDragOver={upload.handleItemDragOver}
          onExternalDrop={upload.handleItemDrop}
          onCopyPath={operations.handleCopyPath}
          onDownload={operations.handleDownload}
          onRefresh={refreshCurrentView}
          // Pass rename state and handlers for inline editing
          renamingItem={operations.renamingItem}
          renameValue={operations.renameValue}
          setRenameValue={operations.setRenameValue}
          handleConfirmRename={operations.handleConfirmRename}
          handleCancelRename={operations.handleCancelRename}
          renameInputRef={renameInputRef}
          operationLoading={operations.operationLoading}
        />
          </>
        )}
      </ScrollArea>

      {selectedImage && (
        <ImageViewer
          file={selectedImage}
          onClose={() => setSelectedImage(null)}
        />
      )}

      {/* Delete Confirmation Dialog */}
      {operations.deleteConfirmation.isOpen && operations.deleteConfirmation.item && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50">
          <div className="bg-background border border-border rounded-lg shadow-lg p-4 max-w-sm mx-4">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 rounded-full bg-red-100 dark:bg-red-900/30">
                <AlertTriangle className="w-5 h-5 text-red-600 dark:text-red-400" />
              </div>
              <div>
                <h3 className="font-medium text-foreground">
                  {t('fileTree.delete.title', 'Delete {{type}}', {
                    type: operations.deleteConfirmation.item.type === 'directory' ? 'Folder' : 'File'
                  })}
                </h3>
                <p className="text-sm text-muted-foreground">
                  {operations.deleteConfirmation.item.name}
                </p>
              </div>
            </div>
            <p className="text-sm text-muted-foreground mb-4">
              {operations.deleteConfirmation.item.type === 'directory'
                ? t('fileTree.delete.folderWarning', 'This folder and all its contents will be permanently deleted.')
                : t('fileTree.delete.fileWarning', 'This file will be permanently deleted.')}
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={operations.handleCancelDelete}
                disabled={operations.operationLoading}
                className="px-3 py-1.5 text-sm rounded-md hover:bg-accent transition-colors"
              >
                {t('common.cancel', 'Cancel')}
              </button>
              <button
                onClick={operations.handleConfirmDelete}
                disabled={operations.operationLoading}
                className="px-3 py-1.5 text-sm rounded-md bg-red-600 text-white hover:bg-red-700 transition-colors disabled:opacity-50 flex items-center gap-2"
              >
                {operations.operationLoading && <Loader2 className="w-4 h-4 animate-spin" />}
                {t('fileTree.delete.confirm', 'Delete')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast Notification */}
      {toast && (
        <div
          className={cn(
            'fixed bottom-4 right-4 z-[9999] px-4 py-2 rounded-lg shadow-lg flex items-center gap-2 animate-in slide-in-from-bottom-2',
            toast.type === 'success'
              ? 'bg-green-600 text-white'
              : 'bg-red-600 text-white'
          )}
        >
          {toast.type === 'success' ? (
            <Check className="w-4 h-4" />
          ) : (
            <X className="w-4 h-4" />
          )}
          <span className="text-sm">{toast.message}</span>
        </div>
      )}
    </div>
  );
}
