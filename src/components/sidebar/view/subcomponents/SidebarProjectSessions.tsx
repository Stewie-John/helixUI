import { useEffect, useState, useRef } from 'react';
import { ChevronDown, FolderPlus, Plus } from 'lucide-react';
import type { TFunction } from 'i18next';
import { Button } from '../../../ui/button';
import { cn } from '../../../../lib/utils';
import type { Project, ProjectSession, SessionProvider } from '../../../../types/app';
import type { SessionWithProvider, TouchHandlerFactory } from '../../types/types';
import { useProjectFolders } from '../../hooks/useProjectFolders';
import type { FolderNode } from '../../hooks/useProjectFolders';
import SidebarSessionItem from './SidebarSessionItem';
import SidebarFolderNode from './SidebarFolderNode';
import FolderCreateInput from './FolderCreateInput';
import { getSessionDate } from '../../utils/utils';

const INITIAL_VISIBLE_ITEMS = 5;

type SidebarProjectSessionsProps = {
  project: Project;
  isExpanded: boolean;
  sessions: SessionWithProvider[];
  selectedSession: ProjectSession | null;
  initialSessionsLoaded: boolean;
  isLoadingSessions: boolean;
  currentTime: Date;
  editingSession: string | null;
  editingSessionName: string;
  onEditingSessionNameChange: (value: string) => void;
  onStartEditingSession: (sessionId: string, initialName: string) => void;
  onCancelEditingSession: () => void;
  onSaveEditingSession: (projectName: string, sessionId: string, summary: string, provider: SessionProvider) => void;
  onProjectSelect: (project: Project) => void;
  onSessionSelect: (session: SessionWithProvider, projectName: string) => void;
  onDeleteSession: (
    projectName: string,
    sessionId: string,
    sessionTitle: string,
    provider: SessionProvider,
  ) => void;
  onLoadMoreSessions: (project: Project) => void;
  onNewSession: (project: Project) => void;
  touchHandlerFactory: TouchHandlerFactory;
  activeSessions?: Set<string>;
  t: TFunction;
};

function SessionListSkeleton() {
  return (
    <>
      {Array.from({ length: 3 }).map((_, index) => (
        <div key={index} className="p-2 rounded-md">
          <div className="flex items-start gap-2">
            <div className="w-3 h-3 bg-muted rounded-full animate-pulse mt-0.5" />
            <div className="flex-1 space-y-1">
              <div className="h-3 bg-muted rounded animate-pulse" style={{ width: `${60 + index * 15}%` }} />
              <div className="h-2 bg-muted rounded animate-pulse w-1/2" />
            </div>
          </div>
        </div>
      ))}
    </>
  );
}

export default function SidebarProjectSessions({
  project,
  isExpanded,
  sessions,
  selectedSession,
  initialSessionsLoaded,
  isLoadingSessions,
  currentTime,
  editingSession,
  editingSessionName,
  onEditingSessionNameChange,
  onStartEditingSession,
  onCancelEditingSession,
  onSaveEditingSession,
  onProjectSelect,
  onSessionSelect,
  onDeleteSession,
  onLoadMoreSessions,
  onNewSession,
  touchHandlerFactory,
  activeSessions,
  t,
}: SidebarProjectSessionsProps) {
  const folderState = useProjectFolders(project.name, isExpanded);
  const [creatingRoot, setCreatingRoot] = useState(false);
  const [rootDragOver, setRootDragOver] = useState(false);
  const [visibleItemLimit, setVisibleItemLimit] = useState(INITIAL_VISIBLE_ITEMS);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setVisibleItemLimit(INITIAL_VISIBLE_ITEMS);
  }, [project.name]);

  if (!isExpanded) return null;

  const hasSessions = sessions.length > 0;
  const hasMoreSessions = project.sessionMeta?.hasMore === true;

  // 根目录 sessions（不在任何文件夹）
  const rootSessions = sessions.filter(
    (s) => folderState.folderOfSession(s.id, s.__provider) == null,
  );

  const handleRootDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (
      e.dataTransfer.types.includes('application/x-session') ||
      e.dataTransfer.types.includes('application/x-folder')
    ) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (!rootDragOver) setRootDragOver(true);
    }
  };

  const handleRootDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    if (rootRef.current && !rootRef.current.contains(e.relatedTarget as Node | null)) {
      setRootDragOver(false);
    }
  };

  const handleRootDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    setRootDragOver(false);
    const sessionPayload = e.dataTransfer.getData('application/x-session');
    if (sessionPayload) {
      e.preventDefault();
      const [provider, sessionId] = sessionPayload.split('::');
      if (provider && sessionId) {
        try {
          await folderState.moveSession(sessionId, provider, null);
        } catch (err) {
          console.warn('Drop to root (session) failed', err);
        }
      }
      return;
    }
    const folderPayload = e.dataTransfer.getData('application/x-folder');
    if (folderPayload) {
      e.preventDefault();
      const draggedId = parseInt(folderPayload, 10);
      if (Number.isInteger(draggedId)) {
        try {
          await folderState.moveFolder(draggedId, null);
        } catch (err) {
          console.warn('Drop to root (folder) failed', err);
        }
      }
    }
  };

  return (
    <div
      ref={rootRef}
      onDragOver={handleRootDragOver}
      onDragLeave={handleRootDragLeave}
      onDrop={handleRootDrop}
      className={cn(
        'ml-3 space-y-1 border-l border-border pl-3 transition-colors',
        rootDragOver && 'bg-blue-50/40 dark:bg-blue-900/10',
      )}
    >
      {/* 新建文件夹按钮：右上角轻量化呈现，hover 加深 */}
      {initialSessionsLoaded && !creatingRoot && (
        <div className="flex justify-end pt-0.5 px-1 opacity-80 hover:opacity-100 focus-within:opacity-100 transition-opacity">
          <button
            className="text-[10px] flex items-center gap-1 px-1 py-0.5 rounded text-foreground/80 hover:text-foreground hover:bg-accent/40 transition-colors whitespace-nowrap"
            onClick={() => setCreatingRoot(true)}
            title={t('folders.newFolder')}
          >
            <FolderPlus className="w-3 h-3 flex-shrink-0" />
            <span>{t('folders.newFolder')}</span>
          </button>
        </div>
      )}

      {creatingRoot && (
        <FolderCreateInput
          onSubmit={async (name) => {
            try {
              await folderState.createFolder(null, name);
              setCreatingRoot(false);
            } catch (err) {
              console.warn(err);
            }
          }}
          onCancel={() => setCreatingRoot(false)}
        />
      )}

      {/* 顶层文件夹与根目录会话统一排序：按各自最近活跃时间降序混排，
          避免"文件夹永远置顶"导致新 session 被旧文件夹压在下面 */}
      {!initialSessionsLoaded ? (
        <SessionListSkeleton />
      ) : !hasSessions && !isLoadingSessions && folderState.tree.length === 0 ? (
        <div className="py-2 px-3 text-left">
          <p className="text-xs text-muted-foreground">{t('sessions.noSessions')}</p>
        </div>
      ) : (() => {
        // 计算顶层文件夹的最近活跃时间（递归收集所有子文件夹内的 session）
        const collectFolderIds = (node: FolderNode): number[] =>
          [node.id, ...node.children.flatMap(collectFolderIds)];

        const getFolderDate = (node: FolderNode): Date => {
          const folderIdSet = new Set(collectFolderIds(node));
          let best = new Date(0);
          for (const s of sessions) {
            const fid = folderState.folderOfSession(s.id, s.__provider);
            if (fid != null && folderIdSet.has(fid)) {
              const d = getSessionDate(s);
              if (d > best) best = d;
            }
          }
          return best;
        };

        type SortedItem =
          | { kind: 'folder'; node: FolderNode; date: Date }
          | { kind: 'session'; session: SessionWithProvider; date: Date };

        const items: SortedItem[] = [
          ...folderState.tree.map((node) => ({
            kind: 'folder' as const,
            node,
            date: getFolderDate(node),
          })),
          ...rootSessions.map((session) => ({
            kind: 'session' as const,
            session,
            date: getSessionDate(session),
          })),
        ].sort((a, b) => b.date.getTime() - a.date.getTime());

        const selectedIndex = selectedSession?.id
          ? items.findIndex((item) => item.kind === 'session' && item.session.id === selectedSession.id)
          : -1;
        const effectiveLimit = selectedIndex >= visibleItemLimit
          ? selectedIndex + 1
          : visibleItemLimit;
        const visibleItems = items.slice(0, effectiveLimit);
        const hasHiddenLocalItems = items.length > visibleItems.length;

        return (
          <>
            {visibleItems.map((item) =>
              item.kind === 'folder' ? (
                <SidebarFolderNode
                  key={item.node.id}
                  project={project}
                  node={item.node}
                  sessions={sessions}
                  selectedSession={selectedSession}
                  currentTime={currentTime}
                  editingSession={editingSession}
                  editingSessionName={editingSessionName}
                  flatFolders={folderState.flatFolders}
                  folderOfSession={folderState.folderOfSession}
                  getFolderSessionCount={folderState.getFolderSessionCount}
                  onEditingSessionNameChange={onEditingSessionNameChange}
                  onStartEditingSession={onStartEditingSession}
                  onCancelEditingSession={onCancelEditingSession}
                  onSaveEditingSession={onSaveEditingSession}
                  onProjectSelect={onProjectSelect}
                  onSessionSelect={onSessionSelect}
                  onDeleteSession={onDeleteSession}
                  onCreateFolder={folderState.createFolder}
                  onRenameFolder={folderState.renameFolder}
                  onDeleteFolder={folderState.removeFolder}
                  onMoveSession={folderState.moveSession}
                  onMoveFolder={folderState.moveFolder}
                  fetchContentsCount={folderState.fetchContentsCount}
                  touchHandlerFactory={touchHandlerFactory}
                  activeSessions={activeSessions}
                  t={t}
                />
              ) : (
                <SidebarSessionItem
                  key={item.session.id}
                  project={project}
                  session={item.session}
                  selectedSession={selectedSession}
                  currentTime={currentTime}
                  editingSession={editingSession}
                  editingSessionName={editingSessionName}
                  currentFolderId={null}
                  flatFolders={folderState.flatFolders}
                  onEditingSessionNameChange={onEditingSessionNameChange}
                  onStartEditingSession={onStartEditingSession}
                  onCancelEditingSession={onCancelEditingSession}
                  onSaveEditingSession={onSaveEditingSession}
                  onProjectSelect={onProjectSelect}
                  onSessionSelect={onSessionSelect}
                  onDeleteSession={onDeleteSession}
                  onMoveSession={folderState.moveSession}
                  touchHandlerFactory={touchHandlerFactory}
                  activeSessions={activeSessions}
                  t={t}
                />
              ),
            )}
            {hasHiddenLocalItems && (
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-center gap-2 mt-2 text-muted-foreground"
                onClick={() => setVisibleItemLimit((limit) => limit + INITIAL_VISIBLE_ITEMS)}
              >
                <ChevronDown className="w-3 h-3" />
                {t('sessions.showMore')}
              </Button>
            )}
            {/* Expand locally hidden folders/sessions first. Showing both
                controls at once produced two identical pagination buttons. */}
            {hasMoreSessions && !hasHiddenLocalItems && (
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-center gap-2 mt-2 text-muted-foreground"
                onClick={() => onLoadMoreSessions(project)}
                disabled={isLoadingSessions}
              >
                {isLoadingSessions ? (
                  <>
                    <div className="w-3 h-3 animate-spin rounded-full border border-muted-foreground border-t-transparent" />
                    {t('sessions.loading')}
                  </>
                ) : (
                  <>
                    <ChevronDown className="w-3 h-3" />
                    {t('sessions.showMore')}
                  </>
                )}
              </Button>
            )}
          </>
        );
      })()}

      <div className="md:hidden px-3 pb-2">
        <button
          className="w-full h-8 bg-primary hover:bg-primary/90 text-primary-foreground rounded-md flex items-center justify-center gap-2 font-medium text-xs active:scale-[0.98] transition-all duration-150"
          onClick={() => {
            onProjectSelect(project);
            onNewSession(project);
          }}
        >
          <Plus className="w-3 h-3" />
          {t('sessions.newSession')}
        </button>
      </div>

      <Button
        variant="default"
        size="sm"
        className="hidden md:flex w-full justify-start gap-2 mt-1 h-8 text-xs font-medium bg-primary hover:bg-primary/90 text-primary-foreground transition-colors"
        onClick={() => onNewSession(project)}
      >
        <Plus className="w-3 h-3" />
        {t('sessions.newSession')}
      </Button>
    </div>
  );
}
