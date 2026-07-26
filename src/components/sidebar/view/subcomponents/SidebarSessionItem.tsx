import { useState, useRef } from 'react';
import { Badge } from '../../../ui/badge';
import { Button } from '../../../ui/button';
import { Check, Clock, Edit2, FolderInput, Trash2, X } from 'lucide-react';
import type { TFunction } from 'i18next';
import { cn } from '../../../../lib/utils';
import { formatTimeAgo } from '../../../../utils/dateUtils';
import type { Project, ProjectSession, SessionProvider } from '../../../../types/app';
import type { SessionWithProvider, TouchHandlerFactory } from '../../types/types';
import type { FolderNode } from '../../hooks/useProjectFolders';
import { createSessionViewModel } from '../../utils/utils';
import SessionProviderLogo from '../../../llm-logo-provider/SessionProviderLogo';
import SessionMoveMenu from './SessionMoveMenu';
import { resolveCompactContinuationInfoForProject } from '../../../chat/utils/compactContinuations';

type SidebarSessionItemProps = {
  project: Project;
  session: SessionWithProvider;
  selectedSession: ProjectSession | null;
  currentTime: Date;
  editingSession: string | null;
  editingSessionName: string;
  // 当前 session 所在的 folder（null 为根目录），用于 "移动到..." 菜单高亮
  currentFolderId?: number | null;
  flatFolders?: FolderNode[];
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
  // 文件夹功能未启用时（如尚未加载）可不传
  onMoveSession?: (sessionId: string, provider: string, folderId: number | null) => Promise<void>;
  activeSessions?: Set<string>;
  touchHandlerFactory: TouchHandlerFactory;
  t: TFunction;
};

export default function SidebarSessionItem({
  project,
  session,
  selectedSession,
  currentTime,
  editingSession,
  editingSessionName,
  currentFolderId = null,
  flatFolders,
  onEditingSessionNameChange,
  onStartEditingSession,
  onCancelEditingSession,
  onSaveEditingSession,
  onProjectSelect,
  onSessionSelect,
  onDeleteSession,
  onMoveSession,
  activeSessions,
  touchHandlerFactory,
  t,
}: SidebarSessionItemProps) {
  const sessionView = createSessionViewModel(session, currentTime, t);
  const isSelected = selectedSession?.id === session.id;
  const runtimeSessionId = resolveCompactContinuationInfoForProject(project, session.id).sessionId;
  const sessionTimeMs = new Date(sessionView.sessionTime).getTime();
  // Keep the recent marker aligned with labels through "3 mins ago". Since
  // relative minutes are floored, that label lasts until just before 4:00.
  const isRecentlyActive = Number.isFinite(sessionTimeMs) &&
    currentTime.getTime() - sessionTimeMs < 4 * 60 * 1000;
  const isActive = Boolean(
    isRecentlyActive ||
    activeSessions?.has(session.id) ||
    (runtimeSessionId && activeSessions?.has(runtimeSessionId)),
  );
  // A local submit marks the session active before the backend has rewritten
  // the rollout/project index. Do not leave the stale disk timestamp visible
  // during that gap.
  const sessionTimeLabel = isActive
    ? formatTimeAgo(currentTime.toISOString(), currentTime, t)
    : formatTimeAgo(sessionView.sessionTime, currentTime, t);
  const [moveMenu, setMoveMenu] = useState<{ top: number; left: number } | null>(null);
  const [mobileActionsOpen, setMobileActionsOpen] = useState(false);
  const moveBtnRef = useRef<HTMLButtonElement>(null);
  const mobileLongPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mobileLongPressTriggeredRef = useRef(false);
  const canMove = typeof onMoveSession === 'function' && Array.isArray(flatFolders);

  const handleDragStart = (e: React.DragEvent<HTMLDivElement>) => {
    e.dataTransfer.setData('application/x-session', `${session.__provider}::${session.id}`);
    e.dataTransfer.effectAllowed = 'move';
  };

  const openMoveMenu = () => {
    const rect = moveBtnRef.current?.getBoundingClientRect();
    if (!rect) return;
    // 显示在按钮下方偏左
    const top = rect.bottom + 4;
    const left = Math.max(8, rect.left - 120);
    setMoveMenu({ top, left });
  };

  const selectMobileSession = () => {
    onProjectSelect(project);
    onSessionSelect(session, project.name);
  };

  const saveEditedSession = () => {
    onSaveEditingSession(project.name, session.id, editingSessionName, session.__provider);
  };

  const requestDeleteSession = () => {
    onDeleteSession(project.name, session.id, sessionView.sessionName, session.__provider);
  };

  const startMobileLongPress = () => {
    mobileLongPressTriggeredRef.current = false;
    if (mobileLongPressTimerRef.current) {
      clearTimeout(mobileLongPressTimerRef.current);
    }
    mobileLongPressTimerRef.current = setTimeout(() => {
      mobileLongPressTriggeredRef.current = true;
      setMobileActionsOpen(true);
    }, 500);
  };

  const cancelMobileLongPress = () => {
    if (mobileLongPressTimerRef.current) {
      clearTimeout(mobileLongPressTimerRef.current);
      mobileLongPressTimerRef.current = null;
    }
  };

  const handleMobileCardClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (mobileLongPressTriggeredRef.current) {
      event.preventDefault();
      mobileLongPressTriggeredRef.current = false;
      return;
    }
    if (mobileActionsOpen) {
      setMobileActionsOpen(false);
      return;
    }
    selectMobileSession();
  };

  const activeDot = isActive ? (
    <span
      className="w-2 h-2 rounded-full bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.85)] animate-pulse flex-shrink-0"
      title="Active session"
      aria-label="Active session"
    />
  ) : null;

  return (
    <div className="group relative">
      <div className="md:hidden">
        <div
          className={cn(
            'p-2 mx-3 my-0.5 rounded-md bg-card border active:scale-[0.98] transition-all duration-150 relative',
            isSelected ? 'bg-primary/5 border-primary/20' : '',
            !isSelected && isActive
              ? 'border-green-500/30 bg-green-50/5 dark:bg-green-900/5'
              : 'border-border/30',
          )}
          onTouchStart={startMobileLongPress}
          onTouchEnd={cancelMobileLongPress}
          onTouchCancel={cancelMobileLongPress}
          onMouseLeave={cancelMobileLongPress}
          onContextMenu={(event) => {
            event.preventDefault();
            setMobileActionsOpen(true);
          }}
          onClick={handleMobileCardClick}
        >
          <div className="flex items-center gap-2">
            {activeDot}
            <div
              className={cn(
                'w-5 h-5 rounded-md flex items-center justify-center flex-shrink-0',
                isSelected ? 'bg-primary/10' : 'bg-muted/50',
              )}
            >
              <SessionProviderLogo provider={session.__provider} className="w-3 h-3" />
            </div>

            <div className="min-w-0 flex-1">
              {editingSession === session.id ? (
                <div className="flex items-center gap-1" onClick={(event) => event.stopPropagation()}>
                  <input
                    type="text"
                    value={editingSessionName}
                    onChange={(event) => onEditingSessionNameChange(event.target.value)}
                    onKeyDown={(event) => {
                      event.stopPropagation();
                      if (event.key === 'Enter') {
                        saveEditedSession();
                      } else if (event.key === 'Escape') {
                        onCancelEditingSession();
                      }
                    }}
                    className="min-w-0 flex-1 px-2 py-1 text-xs border border-border rounded bg-background focus:outline-none focus:ring-1 focus:ring-primary"
                    autoFocus
                  />
                  <button
                    className="w-6 h-6 bg-green-50 dark:bg-green-900/20 rounded flex items-center justify-center"
                    onClick={(event) => {
                      event.stopPropagation();
                      saveEditedSession();
                    }}
                    title={t('tooltips.save')}
                  >
                    <Check className="w-3 h-3 text-green-600 dark:text-green-400" />
                  </button>
                  <button
                    className="w-6 h-6 bg-gray-50 dark:bg-gray-900/20 rounded flex items-center justify-center"
                    onClick={(event) => {
                      event.stopPropagation();
                      onCancelEditingSession();
                    }}
                    title={t('tooltips.cancel')}
                  >
                    <X className="w-3 h-3 text-gray-600 dark:text-gray-400" />
                  </button>
                </div>
              ) : (
                <>
                  <div className="text-xs font-medium truncate text-foreground">{sessionView.sessionName}</div>
                  <div className="flex items-center gap-1 mt-0.5">
                    {sessionView.messageCount > 0 && (
                      <Badge variant="secondary" className="text-xs px-1 py-0">
                        {sessionView.messageCount}
                      </Badge>
                    )}
                    <div className="ml-auto flex items-center gap-1 flex-shrink-0">
                      <Clock className="w-2.5 h-2.5 text-muted-foreground" />
                      <span className="text-xs text-muted-foreground whitespace-nowrap">
                        {sessionTimeLabel}
                      </span>
                    </div>
                    <span className="ml-1 opacity-70">
                      <SessionProviderLogo provider={session.__provider} className="w-3 h-3" />
                    </span>
                  </div>
                </>
              )}
            </div>

            {mobileActionsOpen && editingSession !== session.id && (
              <div
                className="flex items-center gap-1 ml-1"
                onClick={(event) => event.stopPropagation()}
                onTouchStart={(event) => event.stopPropagation()}
              >
                <button
                  className="w-6 h-6 bg-gray-50 dark:bg-gray-900/20 rounded flex items-center justify-center active:scale-95 transition-transform"
                  onClick={(event) => {
                    event.stopPropagation();
                    setMobileActionsOpen(false);
                    onStartEditingSession(session.id, sessionView.sessionName);
                  }}
                  title={t('tooltips.editSessionName')}
                >
                  <Edit2 className="w-3 h-3 text-gray-600 dark:text-gray-400" />
                </button>
                {canMove && (
                  <button
                    ref={moveBtnRef}
                    className="w-6 h-6 bg-blue-50 dark:bg-blue-900/20 rounded flex items-center justify-center active:scale-95 transition-transform"
                    onClick={(event) => {
                      event.stopPropagation();
                      setMobileActionsOpen(false);
                      openMoveMenu();
                    }}
                    title={t('folders.moveToFolder')}
                  >
                    <FolderInput className="w-3 h-3 text-blue-600 dark:text-blue-400" />
                  </button>
                )}
                {!sessionView.isCursorSession && (
                  <button
                    className="w-6 h-6 rounded-md bg-red-50 dark:bg-red-900/20 flex items-center justify-center active:scale-95 transition-transform"
                    onClick={(event) => {
                      event.stopPropagation();
                      setMobileActionsOpen(false);
                      requestDeleteSession();
                    }}
                    title={t('tooltips.deleteSession')}
                  >
                    <Trash2 className="w-3 h-3 text-red-600 dark:text-red-400" />
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="hidden md:block">
        {/* 外层 wrapper：八边形边框（selected 时更亮） */}
        <div
          className={`tech-sidebar-item-wrapper${isSelected ? ' selected' : ''}`}
          draggable={canMove && editingSession !== session.id}
          onDragStart={handleDragStart}
        >
        <Button
          variant="ghost"
          className={cn(
            'tech-sidebar-item-btn session-slide-btn w-full justify-start h-8 px-2 py-1.5 pr-2 group-hover:pr-24 font-normal text-left hover:bg-accent/50',
            isSelected && 'bg-accent text-accent-foreground',
          )}
          onClick={() => onSessionSelect(session, project.name)}
        >
          <div className="flex items-center gap-2 min-w-0 w-full">
            {activeDot}
            <SessionProviderLogo provider={session.__provider} className="w-3 h-3 flex-shrink-0" />
            <div className="min-w-0 flex-1 flex items-center gap-2">
              <div className="text-xs font-medium truncate text-foreground min-w-0 flex-1">{sessionView.sessionName}</div>
              <div className="flex items-center gap-1 flex-shrink-0">
                {sessionView.messageCount > 0 && (
                  <Badge
                    variant="secondary"
                    className="text-xs px-1 py-0"
                  >
                    {sessionView.messageCount}
                  </Badge>
                )}
                <Clock className="w-2.5 h-2.5 text-muted-foreground" />
                <span className="text-xs text-muted-foreground whitespace-nowrap">
                  {sessionTimeLabel}
                </span>
              </div>
            </div>
          </div>
        </Button>
        </div> {/* tech-sidebar-item-wrapper */}

        <div
          className={cn(
            'absolute right-2 top-1/2 transform -translate-y-1/2 flex items-center gap-1 transition-opacity duration-150',
            'opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto',
            'focus-within:opacity-100 focus-within:pointer-events-auto',
            'touch:opacity-100 touch:pointer-events-auto',
          )}
        >
            {editingSession === session.id ? (
              <>
                <input
                  type="text"
                  value={editingSessionName}
                  onChange={(event) => onEditingSessionNameChange(event.target.value)}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === 'Enter') {
                      saveEditedSession();
                    } else if (event.key === 'Escape') {
                      onCancelEditingSession();
                    }
                  }}
                  onClick={(event) => event.stopPropagation()}
                  className="w-32 px-2 py-1 text-xs border border-border rounded bg-background focus:outline-none focus:ring-1 focus:ring-primary"
                  autoFocus
                />
                <button
                  className="w-6 h-6 bg-green-50 hover:bg-green-100 dark:bg-green-900/20 dark:hover:bg-green-900/40 rounded flex items-center justify-center"
                  onClick={(event) => {
                    event.stopPropagation();
                    saveEditedSession();
                  }}
                  title={t('tooltips.save')}
                >
                  <Check className="w-3 h-3 text-green-600 dark:text-green-400" />
                </button>
                <button
                  className="w-6 h-6 bg-gray-50 hover:bg-gray-100 dark:bg-gray-900/20 dark:hover:bg-gray-900/40 rounded flex items-center justify-center"
                  onClick={(event) => {
                    event.stopPropagation();
                    onCancelEditingSession();
                  }}
                  title={t('tooltips.cancel')}
                >
                  <X className="w-3 h-3 text-gray-600 dark:text-gray-400" />
                </button>
              </>
            ) : (
              <>
                <button
                  className="w-6 h-6 bg-gray-50 hover:bg-gray-100 dark:bg-gray-900/20 dark:hover:bg-gray-900/40 rounded flex items-center justify-center"
                  onClick={(event) => {
                    event.stopPropagation();
                    onStartEditingSession(session.id, sessionView.sessionName);
                  }}
                  title={t('tooltips.editSessionName')}
                >
                  <Edit2 className="w-3 h-3 text-gray-600 dark:text-gray-400" />
                </button>
                {canMove && (
                  <button
                    ref={moveBtnRef}
                    className="w-6 h-6 bg-blue-50 hover:bg-blue-100 dark:bg-blue-900/20 dark:hover:bg-blue-900/40 rounded flex items-center justify-center"
                    onClick={(event) => {
                      event.stopPropagation();
                      openMoveMenu();
                    }}
                    title={t('folders.moveToFolder')}
                  >
                    <FolderInput className="w-3 h-3 text-blue-600 dark:text-blue-400" />
                  </button>
                )}
                {!sessionView.isCursorSession && (
                  <button
                    className="w-6 h-6 bg-red-50 hover:bg-red-100 dark:bg-red-900/20 dark:hover:bg-red-900/40 rounded flex items-center justify-center"
                    onClick={(event) => {
                      event.stopPropagation();
                      requestDeleteSession();
                    }}
                    title={t('tooltips.deleteSession')}
                  >
                    <Trash2 className="w-3 h-3 text-red-600 dark:text-red-400" />
                  </button>
                )}
              </>
            )}
          </div>
      </div>

      {moveMenu && canMove && (
        <SessionMoveMenu
          flatFolders={flatFolders!}
          currentFolderId={currentFolderId ?? null}
          onMove={async (folderId) => {
            try {
              await onMoveSession!(session.id, session.__provider, folderId);
            } catch (err) {
              console.warn('Move session failed', err);
            }
          }}
          onClose={() => setMoveMenu(null)}
          anchor={moveMenu}
        />
      )}
    </div>
  );
}
