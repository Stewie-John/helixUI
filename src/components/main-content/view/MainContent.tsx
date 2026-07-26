import React, { lazy, Suspense, useEffect, useMemo } from 'react';

import ChatInterface from '../../chat/view/ChatInterface';
import ErrorBoundary from '../../ErrorBoundary';

import MainContentHeader from './subcomponents/MainContentHeader';
import MainContentStateView from './subcomponents/MainContentStateView';
import type { MainContentProps } from '../types/types';

import { useTaskMaster } from '../../../contexts/TaskMasterContext';
import { useTasksSettings } from '../../../contexts/TasksSettingsContext';
import { useUiPreferences } from '../../../hooks/useUiPreferences';
import { useEditorSidebar } from '../../code-editor/hooks/useEditorSidebar';
import type { Project } from '../../../types/app';
import { resolveCompactContinuationInfoForProject } from '../../chat/utils/compactContinuations';

const FileTree = lazy(() => import('../../file-tree/view/FileTree'));
const StandaloneShell = lazy(() => import('../../standalone-shell/view/StandaloneShell'));
const GitPanel = lazy(() => import('../../git-panel/view/GitPanel'));
const TaskMasterPanel = lazy(() => import('./subcomponents/TaskMasterPanel'));
const EditorSidebar = lazy(() => import('../../code-editor/view/EditorSidebar'));

type TaskMasterContextValue = {
  currentProject?: Project | null;
  setCurrentProject?: ((project: Project) => void) | null;
};

type TasksSettingsContextValue = {
  tasksEnabled: boolean;
  isTaskMasterInstalled: boolean | null;
  isTaskMasterReady: boolean | null;
};

function MainContent({
  selectedProject,
  selectedSession,
  newSessionNonce,
  activeTab,
  setActiveTab,
  ws,
  sendMessage,
  latestMessage,
  isMobile,
  onMenuClick,
  isLoading,
  onInputFocusChange,
  onSessionActive,
  onSessionInactive,
  onSessionProcessing,
  onSessionNotProcessing,
  processingSessions,
  activeSessions,
  onReplaceTemporarySession,
  onNavigateToSession,
  onShowSettings,
  externalMessageUpdate,
}: MainContentProps) {
  const { preferences } = useUiPreferences();
  const { autoExpandTools, showRawParameters, showThinking, autoScrollToBottom, sendByCtrlEnter } = preferences;

  const { currentProject, setCurrentProject } = useTaskMaster() as TaskMasterContextValue;
  const { tasksEnabled, isTaskMasterInstalled } = useTasksSettings() as TasksSettingsContextValue;

  const shouldShowTasksTab = Boolean(tasksEnabled && isTaskMasterInstalled);

  const {
    editingFile,
    editorWidth,
    editorExpanded,
    hasManualWidth,
    resizeHandleRef,
    handleFileOpen,
    handleCloseEditor,
    handleToggleEditorExpand,
    handleResizeStart,
    handleResizeKeyDown,
  } = useEditorSidebar({
    selectedProject,
    isMobile,
  });

  useEffect(() => {
    if (selectedProject && selectedProject !== currentProject) {
      setCurrentProject?.(selectedProject);
    }
  }, [selectedProject, currentProject, setCurrentProject]);

  useEffect(() => {
    if (!shouldShowTasksTab && activeTab === 'tasks') {
      setActiveTab('chat');
    }
  }, [shouldShowTasksTab, activeTab, setActiveTab]);

  const shellSession = useMemo(() => {
    if (!selectedSession) {
      return null;
    }

    const continuationInfo = resolveCompactContinuationInfoForProject(selectedProject, selectedSession.id);
    if (!continuationInfo.isContinuation || !continuationInfo.sessionId) {
      return selectedSession;
    }

    return {
      ...selectedSession,
      id: continuationInfo.sessionId,
      __provider: continuationInfo.provider || selectedSession.__provider,
    };
  }, [selectedProject, selectedSession]);

  // 切换到 files tab 时更新浏览器标题；离开时恢复 session/project 标题
  useEffect(() => {
    const APP = 'HelixUI';
    if (activeTab === 'files') {
      document.title = `Files - ${APP}`;
      return;
    }
    // 非 files tab：恢复 session/project 标题（与 SidebarProjectList 逻辑保持一致）
    const projectName = selectedProject?.displayName?.trim();
    const sessionName = (
      selectedSession?.summary?.trim() ||
      selectedSession?.title?.trim() ||
      (selectedSession as any)?.name?.trim()
    );
    if (sessionName && projectName) {
      document.title = `${sessionName} · ${projectName} - ${APP}`;
    } else if (projectName) {
      document.title = `${projectName} - ${APP}`;
    } else {
      document.title = APP;
    }
  }, [activeTab, selectedProject, selectedSession]);

  if (isLoading) {
    return <MainContentStateView mode="loading" isMobile={isMobile} onMenuClick={onMenuClick} />;
  }

  if (!selectedProject) {
    return <MainContentStateView mode="empty" isMobile={isMobile} onMenuClick={onMenuClick} />;
  }

  return (
    <div className="relative h-full flex flex-col">
      {/* 四角科技框线装饰：顶格贴边，斜道纹路，仅 tech 主题显示 */}
      <div className="tech-corner-deco" aria-hidden="true">
        <i className="corner tl" />
        <i className="corner tr" />
        <i className="corner bl" />
        <i className="corner br" />
      </div>
      <MainContentHeader
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        selectedProject={selectedProject}
        selectedSession={selectedSession}
        shouldShowTasksTab={shouldShowTasksTab}
        isMobile={isMobile}
        onMenuClick={onMenuClick}
      />

      <div className="flex-1 flex min-h-0 overflow-hidden">
        <div className={`flex flex-col min-h-0 min-w-[200px] overflow-hidden ${editorExpanded ? 'hidden' : ''} flex-1`}>
          <div className={`h-full ${activeTab === 'chat' ? 'block' : 'hidden'}`}>
            <ErrorBoundary showDetails>
              <ChatInterface
                selectedProject={selectedProject}
                selectedSession={selectedSession}
                newSessionNonce={newSessionNonce}
                ws={ws}
                sendMessage={sendMessage}
                latestMessage={latestMessage}
                onFileOpen={handleFileOpen}
                onInputFocusChange={onInputFocusChange}
                onSessionActive={onSessionActive}
                onSessionInactive={onSessionInactive}
                onSessionProcessing={onSessionProcessing}
                onSessionNotProcessing={onSessionNotProcessing}
                processingSessions={processingSessions}
                activeSessions={activeSessions}
                onReplaceTemporarySession={onReplaceTemporarySession}
                onNavigateToSession={onNavigateToSession}
                onShowSettings={onShowSettings}
                autoExpandTools={autoExpandTools}
                showRawParameters={showRawParameters}
                showThinking={showThinking}
                autoScrollToBottom={autoScrollToBottom}
                sendByCtrlEnter={sendByCtrlEnter}
                externalMessageUpdate={externalMessageUpdate}
                onShowAllTasks={tasksEnabled ? () => setActiveTab('tasks') : null}
              />
            </ErrorBoundary>
          </div>

          {activeTab === 'files' && (
            <div className="h-full overflow-hidden">
              <Suspense fallback={null}>
                <FileTree selectedProject={selectedProject} onFileOpen={handleFileOpen} />
              </Suspense>
            </div>
          )}

          {activeTab === 'shell' && (
            <div className="h-full w-full overflow-hidden">
              <Suspense fallback={null}>
                <StandaloneShell project={selectedProject} session={shellSession} showHeader={false} />
              </Suspense>
            </div>
          )}

          {activeTab === 'terminal' && (
            <div className="h-full w-full overflow-hidden">
              <Suspense fallback={null}>
                <StandaloneShell
                  project={selectedProject}
                  session={selectedSession}
                  isPlainShell={true}
                  showHeader={false}
                />
              </Suspense>
            </div>
          )}

          {activeTab === 'git' && (
            <div className="h-full overflow-hidden">
              <Suspense fallback={null}>
                <GitPanel selectedProject={selectedProject} isMobile={isMobile} onFileOpen={handleFileOpen} />
              </Suspense>
            </div>
          )}

          {shouldShowTasksTab && activeTab === 'tasks' && (
            <Suspense fallback={null}>
              <TaskMasterPanel isVisible />
            </Suspense>
          )}

          <div className={`h-full overflow-hidden ${activeTab === 'preview' ? 'block' : 'hidden'}`} />
        </div>

        {editingFile && (
          <Suspense fallback={null}>
            <EditorSidebar
              editingFile={editingFile}
              isMobile={isMobile}
              editorExpanded={editorExpanded}
              editorWidth={editorWidth}
              hasManualWidth={hasManualWidth}
              resizeHandleRef={resizeHandleRef}
              onResizeStart={handleResizeStart}
              onResizeKeyDown={handleResizeKeyDown}
              onCloseEditor={handleCloseEditor}
              onToggleEditorExpand={handleToggleEditorExpand}
              projectPath={selectedProject.path}
              fillSpace={activeTab === 'files'}
            />
          </Suspense>
        )}
      </div>
    </div>
  );
}

export default React.memo(MainContent);
