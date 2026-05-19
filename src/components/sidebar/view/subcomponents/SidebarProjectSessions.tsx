import { useState, useRef } from 'react';
import { ChevronDown, FolderPlus, Plus } from 'lucide-react';
import type { TFunction } from 'i18next';
import { Button } from '../../../ui/button';
import { cn } from '../../../../lib/utils';
import type { Project, ProjectSession, SessionProvider } from '../../../../types/app';
import type { SessionWithProvider, TouchHandlerFactory } from '../../types/types';
import { useProjectFolders } from '../../hooks/useProjectFolders';
import SidebarSessionItem from './SidebarSessionItem';
import SidebarFolderNode from './SidebarFolderNode';
import FolderCreateInput from './FolderCreateInput';

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
  const rootRef = useRef<HTMLDivElement>(null);

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

      {/* 顶层文件夹（递归） */}
      {folderState.tree.map((node) => (
        <SidebarFolderNode
          key={node.id}
          project={project}
          node={node}
          sessions={sessions}
          selectedSession={selectedSession}
          currentTime={currentTime}
          editingSession={editingSession}
          editingSessionName={editingSessionName}
          flatFolders={folderState.flatFolders}
          folderOfSession={folderState.folderOfSession}
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
      ))}

      {/* 根目录会话 */}
      {!initialSessionsLoaded ? (
        <SessionListSkeleton />
      ) : !hasSessions && !isLoadingSessions ? (
        <div className="py-2 px-3 text-left">
          <p className="text-xs text-muted-foreground">{t('sessions.noSessions')}</p>
        </div>
      ) : (
        rootSessions.map((session) => (
          <SidebarSessionItem
            key={session.id}
            project={project}
            session={session}
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
        ))
      )}

      {hasSessions && hasMoreSessions && (
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
