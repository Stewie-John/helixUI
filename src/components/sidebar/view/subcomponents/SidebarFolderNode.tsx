// 单个文件夹节点（可递归含子文件夹和会话）
// 特性：折叠/展开、内联重命名、新建子文件夹、删除（带确认）、拖拽接收 session 和子 folder
import { useState, useRef } from 'react';
import { ChevronDown, ChevronRight, Edit3, FolderPlus, Trash2, Check, X, Folder, FolderOpen } from 'lucide-react';
import type { TFunction } from 'i18next';
import { cn } from '../../../../lib/utils';
import type { Project, ProjectSession, SessionProvider } from '../../../../types/app';
import type { SessionWithProvider, TouchHandlerFactory } from '../../types/types';
import type { FolderNode } from '../../hooks/useProjectFolders';
import SidebarSessionItem from './SidebarSessionItem';
import SidebarFolderDeleteConfirm from './SidebarFolderDeleteConfirm';
import FolderCreateInput from './FolderCreateInput';
import { getSessionDate } from '../../utils/utils';

type Props = {
  project: Project;
  node: FolderNode;
  sessions: SessionWithProvider[];
  selectedSession: ProjectSession | null;
  currentTime: Date;
  editingSession: string | null;
  editingSessionName: string;
  flatFolders: FolderNode[];
  folderOfSession: (sessionId: string, provider: string) => number | null;
  getFolderSessionCount: (folderId: number) => number;
  onEditingSessionNameChange: (value: string) => void;
  onStartEditingSession: (sessionId: string, initialName: string) => void;
  onCancelEditingSession: () => void;
  onSaveEditingSession: (
    projectName: string,
    sessionId: string,
    summary: string,
    provider: SessionProvider,
  ) => void;
  onProjectSelect: (project: Project) => void;
  onSessionSelect: (session: SessionWithProvider, projectName: string) => void;
  onDeleteSession: (
    projectName: string,
    sessionId: string,
    sessionTitle: string,
    provider: SessionProvider,
  ) => void;
  onCreateFolder: (parentId: number | null, name: string) => Promise<unknown>;
  onRenameFolder: (folderId: number, newName: string) => Promise<void>;
  onDeleteFolder: (folderId: number) => Promise<void>;
  onMoveSession: (sessionId: string, provider: string, folderId: number | null) => Promise<void>;
  onMoveFolder: (folderId: number, parentId: number | null) => Promise<void>;
  fetchContentsCount: (folderId: number) => Promise<{ sessions: number; folders: number }>;
  touchHandlerFactory: TouchHandlerFactory;
  activeSessions?: Set<string>;
  t: TFunction;
};

export default function SidebarFolderNode({
  project,
  node,
  sessions,
  selectedSession,
  currentTime,
  editingSession,
  editingSessionName,
  flatFolders,
  folderOfSession,
  getFolderSessionCount,
  onEditingSessionNameChange,
  onStartEditingSession,
  onCancelEditingSession,
  onSaveEditingSession,
  onProjectSelect,
  onSessionSelect,
  onDeleteSession,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onMoveSession,
  onMoveFolder,
  fetchContentsCount,
  touchHandlerFactory,
  activeSessions,
  t,
}: Props) {
  const [expanded, setExpanded] = useState(true);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(node.name);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [creatingChild, setCreatingChild] = useState(false);
  const headerRef = useRef<HTMLDivElement>(null);

  // 该文件夹直接包含的 sessions（不含子文件夹的）
  // 必须显式按最近活跃时间降序排序：不能依赖父级 sessions 数组恰好有序，
  // 否则混入 codex（lastActivity=文件 mtime）后或分页注入后，文件夹内顺序会错乱。
  const sessionsInThisFolder = sessions
    .filter((s) => folderOfSession(s.id, s.__provider) === node.id)
    .sort((a, b) => getSessionDate(b).getTime() - getSessionDate(a).getTime());
  const folderSessionCount = getFolderSessionCount(node.id);

  const handleRenameSubmit = async () => {
    const trimmed = renameValue.trim();
    if (!trimmed || trimmed === node.name) {
      setRenaming(false);
      setRenameValue(node.name);
      return;
    }
    try {
      await onRenameFolder(node.id, trimmed);
      setRenaming(false);
    } catch (err) {
      // 失败时保持编辑状态（具体错误暂不展示）
      console.warn(err);
    }
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (
      e.dataTransfer.types.includes('application/x-session') ||
      e.dataTransfer.types.includes('application/x-folder')
    ) {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      if (!dragOver) setDragOver(true);
    }
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    // relatedTarget 仍在内部时不处理
    if (headerRef.current && !headerRef.current.contains(e.relatedTarget as Node | null)) {
      setDragOver(false);
    }
  };

  const handleDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const sessionPayload = e.dataTransfer.getData('application/x-session');
    if (sessionPayload) {
      const [provider, sessionId] = sessionPayload.split('::');
      if (provider && sessionId) {
        try {
          await onMoveSession(sessionId, provider, node.id);
        } catch (err) {
          console.warn('Drop move session failed', err);
        }
      }
      return;
    }
    const folderPayload = e.dataTransfer.getData('application/x-folder');
    if (folderPayload) {
      const draggedId = parseInt(folderPayload, 10);
      if (Number.isInteger(draggedId) && draggedId !== node.id) {
        try {
          await onMoveFolder(draggedId, node.id);
        } catch (err) {
          console.warn('Drop move folder failed', err);
        }
      }
    }
  };

  const handleHeaderDragStart = (e: React.DragEvent<HTMLDivElement>) => {
    e.dataTransfer.setData('application/x-folder', String(node.id));
    e.dataTransfer.effectAllowed = 'move';
  };

  return (
    <div className="space-y-0.5">
      <div
        ref={headerRef}
        draggable={!renaming}
        onDragStart={handleHeaderDragStart}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={cn(
          'group relative flex items-center gap-1 px-1.5 py-1 rounded-md hover:bg-accent/40 cursor-pointer transition-colors',
          !renaming && 'pr-1 group-hover:pr-[4.5rem]',
          dragOver && 'ring-2 ring-blue-400 bg-blue-50/50 dark:bg-blue-900/20',
        )}
        onClick={() => !renaming && setExpanded((v) => !v)}
      >
        <button
          className="w-4 h-4 flex items-center justify-center text-muted-foreground hover:text-foreground"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((v) => !v);
          }}
          tabIndex={-1}
        >
          {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        </button>
        {expanded ? (
          <FolderOpen className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 flex-shrink-0" />
        ) : (
          <Folder className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 flex-shrink-0" />
        )}
        {renaming ? (
          <div className="flex-1 flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
            <input
              type="text"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleRenameSubmit();
                else if (e.key === 'Escape') {
                  setRenaming(false);
                  setRenameValue(node.name);
                }
              }}
              autoFocus
              className="flex-1 min-w-0 px-1.5 py-0.5 text-xs border border-border rounded bg-background focus:outline-none focus:ring-1 focus:ring-primary"
            />
            <button
              className="w-5 h-5 flex items-center justify-center rounded hover:bg-green-100 dark:hover:bg-green-900/30 text-green-600 dark:text-green-400"
              onClick={(e) => {
                e.stopPropagation();
                handleRenameSubmit();
              }}
              title={t('folders.renameActions.save')}
            >
              <Check className="w-3 h-3" />
            </button>
            <button
              className="w-5 h-5 flex items-center justify-center rounded hover:bg-muted text-muted-foreground"
              onClick={(e) => {
                e.stopPropagation();
                setRenaming(false);
                setRenameValue(node.name);
              }}
              title={t('folders.renameActions.cancel')}
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        ) : (
          <>
            <span className="flex-1 min-w-0 text-xs font-medium text-foreground truncate">{node.name}</span>
            <span
              className="min-w-[1.25rem] text-right text-[10px] font-semibold text-cyan-300"
              style={{ textShadow: '0 0 7px rgba(0,217,255,0.75)' }}
            >
              {folderSessionCount || ''}
            </span>
            <div className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto transition-opacity">
              <button
                className="w-5 h-5 flex items-center justify-center rounded hover:bg-accent text-muted-foreground hover:text-foreground"
                onClick={(e) => {
                  e.stopPropagation();
                  setExpanded(true);
                  setCreatingChild(true);
                }}
                title={t('folders.newSubfolder')}
              >
                <FolderPlus className="w-3 h-3" />
              </button>
              <button
                className="w-5 h-5 flex items-center justify-center rounded hover:bg-accent text-muted-foreground hover:text-foreground"
                onClick={(e) => {
                  e.stopPropagation();
                  setRenameValue(node.name);
                  setRenaming(true);
                }}
                title={t('folders.rename')}
              >
                <Edit3 className="w-3 h-3" />
              </button>
              <button
                className="w-5 h-5 flex items-center justify-center rounded hover:bg-red-100 dark:hover:bg-red-900/30 text-red-600 dark:text-red-400"
                onClick={(e) => {
                  e.stopPropagation();
                  setConfirmingDelete(true);
                }}
                title={t('folders.deleteFolder')}
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          </>
        )}
      </div>

      {expanded && (
        <div className="ml-4 pl-2 border-l border-border space-y-0.5">
          {creatingChild && (
            <FolderCreateInput
              onSubmit={async (name) => {
                try {
                  await onCreateFolder(node.id, name);
                  setCreatingChild(false);
                } catch (err) {
                  console.warn(err);
                }
              }}
              onCancel={() => setCreatingChild(false)}
            />
          )}
          {node.children.map((child) => (
            <SidebarFolderNode
              key={child.id}
              project={project}
              node={child}
              sessions={sessions}
              selectedSession={selectedSession}
              currentTime={currentTime}
              editingSession={editingSession}
              editingSessionName={editingSessionName}
              flatFolders={flatFolders}
              folderOfSession={folderOfSession}
              getFolderSessionCount={getFolderSessionCount}
              onEditingSessionNameChange={onEditingSessionNameChange}
              onStartEditingSession={onStartEditingSession}
              onCancelEditingSession={onCancelEditingSession}
              onSaveEditingSession={onSaveEditingSession}
              onProjectSelect={onProjectSelect}
              onSessionSelect={onSessionSelect}
              onDeleteSession={onDeleteSession}
              onCreateFolder={onCreateFolder}
              onRenameFolder={onRenameFolder}
              onDeleteFolder={onDeleteFolder}
              onMoveSession={onMoveSession}
              onMoveFolder={onMoveFolder}
              fetchContentsCount={fetchContentsCount}
              touchHandlerFactory={touchHandlerFactory}
              activeSessions={activeSessions}
              t={t}
            />
          ))}
          {sessionsInThisFolder.map((session) => (
            <SidebarSessionItem
              key={session.id}
              project={project}
              session={session}
              selectedSession={selectedSession}
              currentTime={currentTime}
              editingSession={editingSession}
              editingSessionName={editingSessionName}
              currentFolderId={node.id}
              flatFolders={flatFolders}
              onEditingSessionNameChange={onEditingSessionNameChange}
              onStartEditingSession={onStartEditingSession}
              onCancelEditingSession={onCancelEditingSession}
              onSaveEditingSession={onSaveEditingSession}
              onProjectSelect={onProjectSelect}
              onSessionSelect={onSessionSelect}
              onDeleteSession={onDeleteSession}
              onMoveSession={onMoveSession}
              touchHandlerFactory={touchHandlerFactory}
              activeSessions={activeSessions}
              t={t}
            />
          ))}
        </div>
      )}

      <SidebarFolderDeleteConfirm
        isOpen={confirmingDelete}
        folderName={node.name}
        fetchCounts={() => fetchContentsCount(node.id)}
        onCancel={() => setConfirmingDelete(false)}
        onConfirm={async () => {
          try {
            await onDeleteFolder(node.id);
            setConfirmingDelete(false);
          } catch (err) {
            console.warn(err);
          }
        }}
      />
    </div>
  );
}
