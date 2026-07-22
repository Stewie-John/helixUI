import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SetStateAction } from 'react';
import type { NavigateFunction } from 'react-router-dom';
import { api } from '../utils/api';
import type {
  AppSocketMessage,
  AppTab,
  LoadingProgress,
  Project,
  ProjectSession,
  ProjectsUpdatedMessage,
} from '../types/app';
import { resolveCompactContinuationInfoForProject } from '../components/chat/utils/compactContinuations';
import { PROJECTS_REFRESH_REQUESTED_EVENT } from '../utils/appEvents';

type UseProjectsStateArgs = {
  sessionId?: string;
  navigate: NavigateFunction;
  latestMessage: AppSocketMessage | null;
  isMobile: boolean;
  activeSessions: Set<string>;
};

const serialize = (value: unknown) => JSON.stringify(value ?? null);

const ACTIVE_TAB_STORAGE_KEY = 'appActiveTab';
const LEGACY_ACTIVE_TAB_STORAGE_KEY = 'activeTab';
const EDITOR_SIDEBAR_STORAGE_KEY = 'codeEditorSidebarState';
const VALID_APP_TABS = new Set<AppTab>(['chat', 'files', 'shell', 'git', 'tasks', 'preview', 'terminal']);

const isValidAppTab = (tab: string | null): tab is AppTab => Boolean(tab && VALID_APP_TABS.has(tab as AppTab));

const hasStoredEditorFile = () => {
  try {
    const raw = window.sessionStorage.getItem(EDITOR_SIDEBAR_STORAGE_KEY);
    if (!raw) {
      return false;
    }

    const parsed = JSON.parse(raw) as { file?: { name?: unknown; path?: unknown } | null };
    return Boolean(
      parsed.file &&
      typeof parsed.file.name === 'string' &&
      typeof parsed.file.path === 'string' &&
      parsed.file.name &&
      parsed.file.path
    );
  } catch {
    return false;
  }
};

const readStoredActiveTab = (): AppTab => {
  if (typeof window === 'undefined') {
    return 'chat';
  }

  try {
    const stored = window.sessionStorage.getItem(ACTIVE_TAB_STORAGE_KEY);
    if (isValidAppTab(stored)) {
      return stored;
    }

    if (hasStoredEditorFile()) {
      return 'files';
    }

    const legacyStored = window.localStorage.getItem(LEGACY_ACTIVE_TAB_STORAGE_KEY);
    if (isValidAppTab(legacyStored)) {
      return legacyStored;
    }
  } catch {
    // ignore storage failures
  }

  return 'chat';
};

const writeStoredActiveTab = (activeTab: AppTab) => {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.sessionStorage.setItem(ACTIVE_TAB_STORAGE_KEY, activeTab);
  } catch {
    // ignore sessionStorage failures
  }
};

const projectsHaveChanges = (
  prevProjects: Project[],
  nextProjects: Project[],
  includeExternalSessions: boolean,
): boolean => {
  if (prevProjects.length !== nextProjects.length) {
    return true;
  }

  return nextProjects.some((nextProject, index) => {
    const prevProject = prevProjects[index];
    if (!prevProject) {
      return true;
    }

    const baseChanged =
      nextProject.name !== prevProject.name ||
      nextProject.displayName !== prevProject.displayName ||
      nextProject.fullPath !== prevProject.fullPath ||
      serialize(nextProject.sessionMeta) !== serialize(prevProject.sessionMeta) ||
      serialize(nextProject.sessions) !== serialize(prevProject.sessions) ||
      serialize(nextProject.taskmaster) !== serialize(prevProject.taskmaster);

    if (baseChanged) {
      return true;
    }

    if (!includeExternalSessions) {
      return false;
    }

    return (
      serialize(nextProject.cursorSessions) !== serialize(prevProject.cursorSessions) ||
      serialize(nextProject.codexSessions) !== serialize(prevProject.codexSessions) ||
      serialize(nextProject.geminiSessions) !== serialize(prevProject.geminiSessions)
    );
  });
};

const getProjectSessions = (project: Project): ProjectSession[] => {
  return [
    ...(project.sessions ?? []),
    ...(project.codexSessions ?? []),
    ...(project.cursorSessions ?? []),
    ...(project.geminiSessions ?? []),
  ];
};

const isUpdateAdditive = (
  currentProjects: Project[],
  updatedProjects: Project[],
  selectedProject: Project | null,
  selectedSession: ProjectSession | null,
): boolean => {
  if (!selectedProject || !selectedSession) {
    return true;
  }

  const currentSelectedProject = currentProjects.find((project) => project.name === selectedProject.name);
  const updatedSelectedProject = updatedProjects.find((project) => project.name === selectedProject.name);

  if (!currentSelectedProject || !updatedSelectedProject) {
    return false;
  }

  const currentSelectedSession = getProjectSessions(currentSelectedProject).find(
    (session) => session.id === selectedSession.id,
  );
  const updatedSelectedSession = getProjectSessions(updatedSelectedProject).find(
    (session) => session.id === selectedSession.id,
  );

  if (!currentSelectedSession || !updatedSelectedSession) {
    return false;
  }

  return (
    currentSelectedSession.id === updatedSelectedSession.id &&
    currentSelectedSession.title === updatedSelectedSession.title &&
    currentSelectedSession.created_at === updatedSelectedSession.created_at &&
    currentSelectedSession.updated_at === updatedSelectedSession.updated_at
  );
};

export function useProjectsState({
  sessionId,
  navigate,
  latestMessage,
  isMobile,
  activeSessions,
}: UseProjectsStateArgs) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [selectedSession, setSelectedSession] = useState<ProjectSession | null>(null);
  // 「新建会话」点击计数器：每次点击自增。即使 selectedSession 已是 null（例如刚在
  // 全新会话里发过一轮消息、currentSessionId 已被设值），bump 这个 nonce 也能强制
  // 下游 ChatInterface 重置聊天状态，避免「点新建会话没反应」。
  const [newSessionNonce, setNewSessionNonce] = useState(0);
  const [activeTab, setActiveTabState] = useState<AppTab>(() => readStoredActiveTab());

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isLoadingProjects, setIsLoadingProjects] = useState(true);
  const [loadingProgress, setLoadingProgress] = useState<LoadingProgress | null>(null);
  const [isInputFocused, setIsInputFocused] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState('agents');
  const [externalMessageUpdate, setExternalMessageUpdate] = useState(0);
  const [projectLoadFailed, setProjectLoadFailed] = useState(false);

  const loadingProgressTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const projectLoadAttemptsRef = useRef(0);
  const projectsRef = useRef<Project[]>([]);
  // 静默重试计数，防止 session 找不到时无限循环触发全屏 loading
  const sessionRetryCountRef = useRef(0);
  // 记录在 session 活跃期间发生了文件变更的 sessionId 集合。
  // 用于修复竞态条件：changedFile 事件到达时 session 仍在 activeSessions 中，
  // 但稍后 session 变为非活跃时需要补偿触发消息重载。
  const pendingFileChangeRef = useRef<Set<string>>(new Set());

  const fetchProjects = useCallback(async () => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 12000);
    try {
      setProjectLoadFailed(false);
      if (projectsRef.current.length === 0) setIsLoadingProjects(true);
      const response = await api.projects({ signal: controller.signal });
      if (!response.ok) throw new Error(`Projects request failed (${response.status})`);
      const projectData = (await response.json()) as Project[];
      if (!Array.isArray(projectData)) throw new Error('Projects response is not an array');

      setProjects((prevProjects) => {
        if (prevProjects.length === 0) {
          return projectData;
        }

        return projectsHaveChanges(prevProjects, projectData, true)
          ? projectData
          : prevProjects;
      });
      projectsRef.current = projectData;
      projectLoadAttemptsRef.current = 0;
    } catch (error) {
      console.error('Error fetching projects:', error);
      projectLoadAttemptsRef.current += 1;
      setProjectLoadFailed(true);
    } finally {
      window.clearTimeout(timeout);
      setIsLoadingProjects(false);
    }
  }, []);

  // 静默刷新：不触发全屏 loading，仅在后台更新 projects 数据
  const fetchProjectsSilently = useCallback(async () => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 12000);
    try {
      const response = await api.projects({ signal: controller.signal });
      if (!response.ok) throw new Error(`Projects request failed (${response.status})`);
      const projectData = (await response.json()) as Project[];
      if (!Array.isArray(projectData)) throw new Error('Projects response is not an array');
      setProjects((prevProjects) =>
        projectsHaveChanges(prevProjects, projectData, true) ? projectData : prevProjects,
      );
      projectsRef.current = projectData;
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        console.error('Error fetching projects (silent):', error);
      }
    } finally {
      window.clearTimeout(timeout);
    }
  }, []);

  useEffect(() => {
    projectsRef.current = projects;
  }, [projects]);

  const openSettings = useCallback((tab = 'tools') => {
    setSettingsInitialTab(tab);
    setShowSettings(true);
  }, []);

  useEffect(() => {
    void fetchProjects();
  }, [fetchProjects]);

  useEffect(() => {
    const requestRefresh = () => void fetchProjectsSilently();
    window.addEventListener(PROJECTS_REFRESH_REQUESTED_EVENT, requestRefresh);
    return () => window.removeEventListener(PROJECTS_REFRESH_REQUESTED_EVENT, requestRefresh);
  }, [fetchProjectsSilently]);

  // A refresh can coincide with a server restart or a long session scan. The
  // previous implementation performed one request and then left the app on an
  // empty SYSTEM INIT shell forever. Retry in place without reloading the page
  // or discarding an already rendered project list.
  useEffect(() => {
    if (!projectLoadFailed) return;
    const attempt = projectLoadAttemptsRef.current;
    const delay = Math.min(30000, 1500 * (2 ** Math.min(attempt - 1, 4)));
    const timer = window.setTimeout(() => void fetchProjects(), delay);
    return () => window.clearTimeout(timer);
  }, [fetchProjects, projectLoadFailed]);

  const setActiveTab = useCallback((nextActiveTab: SetStateAction<AppTab>) => {
    setActiveTabState((previousActiveTab) => {
      const resolvedActiveTab =
        typeof nextActiveTab === 'function'
          ? nextActiveTab(previousActiveTab)
          : nextActiveTab;
      writeStoredActiveTab(resolvedActiveTab);
      return resolvedActiveTab;
    });
  }, []);

  useEffect(() => {
    writeStoredActiveTab(activeTab);
  }, [activeTab]);

  // URL 有 sessionId 但 projects 加载完毕后仍找不到对应 session 时（高负载下扫描不完整），
  // 静默重试最多 2 次，避免触发全屏 loading 循环
  useEffect(() => {
    if (!sessionId || isLoadingProjects || projects.length === 0) return;
    const found = projects.some(p =>
      p.sessions?.some(s => s.id === sessionId) ||
      p.cursorSessions?.some(s => s.id === sessionId) ||
      p.codexSessions?.some(s => s.id === sessionId) ||
      p.geminiSessions?.some(s => s.id === sessionId)
    );
    if (found) {
      // session 找到后重置计数器，为下次导航做准备
      sessionRetryCountRef.current = 0;
      return;
    }
    // 最多重试 2 次，使用静默刷新避免全屏 loading 闪烁
    if (sessionRetryCountRef.current >= 2) return;
    sessionRetryCountRef.current += 1;
    const t = setTimeout(() => void fetchProjectsSilently(), 1500);
    return () => clearTimeout(t);
  }, [sessionId, isLoadingProjects, projects, fetchProjectsSilently]);

  // 启动时如果 URL 无 sessionId，尝试跳回上次活跃的 session
  useEffect(() => {
    if (sessionId) return; // URL 已有 sessionId，无需恢复
    try {
      const last = localStorage.getItem('lastActiveSessionId');
      if (last) navigate(`/session/${last}`, { replace: true });
    } catch { /* ignore */ }
  // 仅在挂载时执行一次
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-select the project when there is only one, so the user lands on the new session page
  useEffect(() => {
    if (!isLoadingProjects && projects.length === 1 && !selectedProject && !sessionId) {
      setSelectedProject(projects[0]);
    }
  }, [isLoadingProjects, projects, selectedProject, sessionId]);

  useEffect(() => {
    if (!latestMessage) {
      return;
    }

    if (latestMessage.type === 'loading_progress') {
      if (loadingProgressTimeoutRef.current) {
        clearTimeout(loadingProgressTimeoutRef.current);
        loadingProgressTimeoutRef.current = null;
      }

      setLoadingProgress(latestMessage as LoadingProgress);

      if (latestMessage.phase === 'complete') {
        loadingProgressTimeoutRef.current = setTimeout(() => {
          setLoadingProgress(null);
          loadingProgressTimeoutRef.current = null;
        }, 500);
      }

      return;
    }

    // 手机/网络断连后 WS 重连场景：
    // claude-complete 在断连期间丢失 → 重连后服务器发 session-status(isProcessing=false)
    // 此时需主动重载消息，否则 Claude 完成的工作不会显示。
    if (latestMessage.type === 'session-status') {
      const statusMsg = latestMessage as any;
      const selectedRuntimeSessionId = selectedSession?.id
        ? (resolveCompactContinuationInfoForProject(selectedProject, selectedSession.id).sessionId || selectedSession.id)
        : null;
      if (
        !statusMsg.isProcessing &&
        statusMsg.sessionId &&
        selectedSession &&
        (statusMsg.sessionId === selectedSession.id || statusMsg.sessionId === selectedRuntimeSessionId)
        // 注意：不检查 !activeSessions.has(...)——该值在同一 render cycle 内是旧状态
        // (markSessionAsInactive 队列中尚未应用)，条件会错误地阻止 JSONL 重载。
        // isProcessing=false 是服务端权威状态，应无条件触发重载。
      ) {
        setExternalMessageUpdate((prev) => prev + 1);
      }
      return;
    }

    if (latestMessage.type !== 'projects_updated') {
      return;
    }

    const projectsMessage = latestMessage as ProjectsUpdatedMessage;

    if (projectsMessage.changedFile && selectedSession && selectedProject) {
      const selectedRuntimeSessionId =
        resolveCompactContinuationInfoForProject(selectedProject, selectedSession.id).sessionId ||
        selectedSession.id;
      const normalized = projectsMessage.changedFile.replace(/\\/g, '/');
      const changedFileParts = normalized.split('/');

      if (changedFileParts.length >= 2) {
        const filename = changedFileParts[changedFileParts.length - 1];
        const changedSessionId = filename.replace('.jsonl', '');

        if (changedSessionId === selectedSession.id || changedSessionId === selectedRuntimeSessionId) {
          const isSessionActive =
            activeSessions.has(selectedSession.id) ||
            activeSessions.has(selectedRuntimeSessionId);

          if (!isSessionActive) {
            setExternalMessageUpdate((prev) => prev + 1);
            // 清除可能残留的待处理标记
            pendingFileChangeRef.current.delete(changedSessionId);
          } else {
            // session 仍活跃时记录文件变更，等 session 变为非活跃后补偿触发
            pendingFileChangeRef.current.add(changedSessionId);
          }
        }
      }
    }

    const selectedRuntimeSessionId = selectedSession?.id
      ? (resolveCompactContinuationInfoForProject(selectedProject, selectedSession.id).sessionId || selectedSession.id)
      : null;
    const hasActiveSession =
      (selectedSession && (
        activeSessions.has(selectedSession.id) ||
        (selectedRuntimeSessionId ? activeSessions.has(selectedRuntimeSessionId) : false)
      )) ||
      (activeSessions.size > 0 && Array.from(activeSessions).some((id) => id.startsWith('new-session-')));

    const updatedProjects = projectsMessage.projects;

    if (
      hasActiveSession &&
      !isUpdateAdditive(projects, updatedProjects, selectedProject, selectedSession)
    ) {
      return;
    }

    setProjects(updatedProjects);

    if (!selectedProject) {
      return;
    }

    const updatedSelectedProject = updatedProjects.find(
      (project) => project.name === selectedProject.name,
    );

    if (!updatedSelectedProject) {
      return;
    }

    if (serialize(updatedSelectedProject) !== serialize(selectedProject)) {
      setSelectedProject(updatedSelectedProject);
    }

    if (!selectedSession) {
      return;
    }

    const updatedSelectedSession = getProjectSessions(updatedSelectedProject).find(
      (session) => session.id === selectedSession.id,
    );

    if (!updatedSelectedSession) {
      // 只有在没有 URL sessionId 的情况下才清空 selectedSession。
      // 有 URL sessionId 时，sessionId 恢复 effect 会负责维护正确的 session，
      // 此处清空会造成刷新后 session 跳变的竞态条件。
      if (!sessionId) {
        setSelectedSession(null);
      }
    }
  }, [latestMessage, selectedProject, selectedSession, activeSessions, projects, sessionId]);

  // 竞态条件补偿：当 session 从 activeSessions 中移除（变为非活跃）时，
  // 若之前记录过该 session 的文件变更（因活跃被跳过），立即触发消息重载。
  // 延迟 600ms 确保 isLoading 等流式状态已完全重置，避免覆盖正在渲染的消息。
  //
  // 关键修复：delete 必须在 timer 内部执行，而非 timer 启动前。
  // 原因：activeSessions Set 每次状态更新都是新对象，会触发 effect 重跑：
  //   旧逻辑 → 重跑时 cleanup 取消 timer + 已 delete → has() 返回 false → timer 永不重启
  //   新逻辑 → 重跑时 cleanup 取消 timer + 未 delete → has() 仍为 true → 重新启动 timer ✓
  useEffect(() => {
    const currentSessionId = selectedSession?.id;
    if (!currentSessionId) return;
    const runtimeSessionId =
      resolveCompactContinuationInfoForProject(selectedProject, currentSessionId).sessionId ||
      currentSessionId;
    const candidateSessionIds = Array.from(new Set([currentSessionId, runtimeSessionId]));
    if (candidateSessionIds.some((candidateId) => activeSessions.has(candidateId))) return; // session 仍活跃，等待
    if (!candidateSessionIds.some((candidateId) => pendingFileChangeRef.current.has(candidateId))) return; // 无待处理变更

    const timer = setTimeout(() => {
      // timer 执行时再 delete，保证 effect 重跑时 has() 仍为 true 可重新计时
      if (!candidateSessionIds.some((candidateId) => pendingFileChangeRef.current.has(candidateId))) return;
      candidateSessionIds.forEach((candidateId) => pendingFileChangeRef.current.delete(candidateId));
      setExternalMessageUpdate((prev) => prev + 1);
    }, 600);
    return () => clearTimeout(timer);
  }, [activeSessions, selectedProject, selectedSession?.id]);

  useEffect(() => {
    return () => {
      if (loadingProgressTimeoutRef.current) {
        clearTimeout(loadingProgressTimeoutRef.current);
        loadingProgressTimeoutRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!sessionId || projects.length === 0) {
      return;
    }

    for (const project of projects) {
      const claudeSession = project.sessions?.find((session) => session.id === sessionId);
      if (claudeSession) {
        const shouldUpdateProject = selectedProject?.name !== project.name;
        const shouldUpdateSession =
          selectedSession?.id !== sessionId || selectedSession.__provider !== 'claude';

        if (shouldUpdateProject) {
          setSelectedProject(project);
        }
        if (shouldUpdateSession) {
          setSelectedSession({ ...claudeSession, __provider: 'claude' });
        }
        // 确保 localStorage 与当前 URL session 同步，防止刷新后跳到其他会话
        try { localStorage.setItem('lastActiveSessionId', sessionId); } catch { /* ignore */ }
        return;
      }

      const cursorSession = project.cursorSessions?.find((session) => session.id === sessionId);
      if (cursorSession) {
        const shouldUpdateProject = selectedProject?.name !== project.name;
        const shouldUpdateSession =
          selectedSession?.id !== sessionId || selectedSession.__provider !== 'cursor';

        if (shouldUpdateProject) {
          setSelectedProject(project);
        }
        if (shouldUpdateSession) {
          setSelectedSession({ ...cursorSession, __provider: 'cursor' });
        }
        return;
      }

      const codexSession = project.codexSessions?.find((session) => session.id === sessionId);
      if (codexSession) {
        const shouldUpdateProject = selectedProject?.name !== project.name;
        const shouldUpdateSession =
          selectedSession?.id !== sessionId || selectedSession.__provider !== 'codex';

        if (shouldUpdateProject) {
          setSelectedProject(project);
        }
        if (shouldUpdateSession) {
          setSelectedSession({ ...codexSession, __provider: 'codex' });
        }
        return;
      }

      const geminiSession = project.geminiSessions?.find((session) => session.id === sessionId);
      if (geminiSession) {
        const shouldUpdateProject = selectedProject?.name !== project.name;
        const shouldUpdateSession =
          selectedSession?.id !== sessionId || selectedSession.__provider !== 'gemini';

        if (shouldUpdateProject) {
          setSelectedProject(project);
        }
        if (shouldUpdateSession) {
          setSelectedSession({ ...geminiSession, __provider: 'gemini' });
        }
        return;
      }
    }
  }, [sessionId, projects, selectedProject?.name, selectedSession?.id, selectedSession?.__provider]);

  const handleProjectSelect = useCallback(
    (project: Project) => {
      setSelectedProject(project);
      setSelectedSession(null);
      navigate('/');

      if (isMobile) {
        setSidebarOpen(false);
      }
    },
    [isMobile, navigate],
  );

  const handleSessionSelect = useCallback(
    (session: ProjectSession) => {
      setSelectedSession(session);

      if (activeTab === 'tasks' || activeTab === 'preview') {
        setActiveTab('chat');
      }

      const provider = localStorage.getItem('selected-provider') || 'claude';
      if (provider === 'cursor') {
        sessionStorage.setItem('cursorSessionId', session.id);
      }

      // 持久化最后活跃的 session ID，刷新后可恢复
      try { localStorage.setItem('lastActiveSessionId', session.id); } catch { /* ignore */ }

      if (isMobile) {
        const sessionProjectName = session.__projectName;
        const currentProjectName = selectedProject?.name;

        if (sessionProjectName !== currentProjectName) {
          setSidebarOpen(false);
        }
      }

      navigate(`/session/${session.id}`);
    },
    [activeTab, isMobile, navigate, selectedProject?.name],
  );

  const handleNewSession = useCallback(
    (project: Project) => {
      setSelectedProject(project);
      setSelectedSession(null);
      setActiveTab('chat');
      // 始终自增 nonce：即便 selectedSession 已是 null（React 会 bail-out 不触发
      // 加载 effect），也能让 ChatInterface 监听 nonce 变化后强制清空当前会话。
      setNewSessionNonce((n) => n + 1);
      navigate('/');

      if (isMobile) {
        setSidebarOpen(false);
      }
    },
    [isMobile, navigate],
  );

  const handleSessionDelete = useCallback(
    (sessionIdToDelete: string) => {
      if (selectedSession?.id === sessionIdToDelete) {
        setSelectedSession(null);
        navigate('/');
      }

      setProjects((prevProjects) =>
        prevProjects.map((project) => ({
          ...project,
          sessions: project.sessions?.filter((session) => session.id !== sessionIdToDelete) ?? [],
          sessionMeta: {
            ...project.sessionMeta,
            total: Math.max(0, (project.sessionMeta?.total as number | undefined ?? 0) - 1),
          },
        })),
      );
    },
    [navigate, selectedSession?.id],
  );

  const handleSidebarRefresh = useCallback(async () => {
    try {
      const response = await api.projects();
      const freshProjects = (await response.json()) as Project[];

      setProjects((prevProjects) =>
        projectsHaveChanges(prevProjects, freshProjects, true) ? freshProjects : prevProjects,
      );

      if (!selectedProject) {
        return;
      }

      const refreshedProject = freshProjects.find((project) => project.name === selectedProject.name);
      if (!refreshedProject) {
        return;
      }

      if (serialize(refreshedProject) !== serialize(selectedProject)) {
        setSelectedProject(refreshedProject);
      }

      if (!selectedSession) {
        return;
      }

      const refreshedSession = getProjectSessions(refreshedProject).find(
        (session) => session.id === selectedSession.id,
      );

      if (refreshedSession) {
        // Keep provider metadata stable when refreshed payload doesn't include __provider.
        const normalizedRefreshedSession =
          refreshedSession.__provider || !selectedSession.__provider
            ? refreshedSession
            : { ...refreshedSession, __provider: selectedSession.__provider };

        if (serialize(normalizedRefreshedSession) !== serialize(selectedSession)) {
          setSelectedSession(normalizedRefreshedSession);
        }
      }
    } catch (error) {
      console.error('Error refreshing sidebar:', error);
    }
  }, [selectedProject, selectedSession]);

  const handleProjectDelete = useCallback(
    (projectName: string) => {
      if (selectedProject?.name === projectName) {
        setSelectedProject(null);
        setSelectedSession(null);
        navigate('/');
      }

      setProjects((prevProjects) => prevProjects.filter((project) => project.name !== projectName));
    },
    [navigate, selectedProject?.name],
  );

  const sidebarSharedProps = useMemo(
    () => ({
      projects,
      selectedProject,
      selectedSession,
      activeTab,
      onProjectSelect: handleProjectSelect,
      onSessionSelect: handleSessionSelect,
      onNewSession: handleNewSession,
      onSessionDelete: handleSessionDelete,
      onProjectDelete: handleProjectDelete,
      isLoading: isLoadingProjects,
      loadingProgress,
      onRefresh: handleSidebarRefresh,
      onShowSettings: () => setShowSettings(true),
      showSettings,
      settingsInitialTab,
      onCloseSettings: () => setShowSettings(false),
      isMobile,
      activeSessions,
    }),
    [
      handleNewSession,
      handleProjectDelete,
      handleProjectSelect,
      handleSessionDelete,
      handleSessionSelect,
      handleSidebarRefresh,
      isLoadingProjects,
      isMobile,
      loadingProgress,
      projects,
      settingsInitialTab,
      selectedProject,
      selectedSession,
      showSettings,
      activeSessions,
      activeTab,
    ],
  );

  return {
    projects,
    selectedProject,
    selectedSession,
    newSessionNonce,
    activeTab,
    sidebarOpen,
    isLoadingProjects,
    loadingProgress,
    isInputFocused,
    showSettings,
    settingsInitialTab,
    externalMessageUpdate,
    setActiveTab,
    setSidebarOpen,
    setIsInputFocused,
    setShowSettings,
    openSettings,
    fetchProjects,
    sidebarSharedProps,
    handleProjectSelect,
    handleSessionSelect,
    handleNewSession,
    handleSessionDelete,
    handleProjectDelete,
    handleSidebarRefresh,
  };
}
